/**
 * One cron tick: what the always-on worker's timers did, in one request.
 *
 * The route (`app/api/cron/sync/route.ts`) owns the door — the shared secret,
 * the handle, the wiring — and this owns the work, so the tick can be tested
 * against a real database with fake work instead of only through HTTP.
 *
 * The order is the interesting part:
 *
 *  1. **Take the tick lock.** Vercel Cron does not promise a tick has finished
 *     before it starts the next one, and a slow tick is exactly when the next
 *     one arrives. Two ticks draining at once double-claim nothing (the claim
 *     is atomic) but they do double the Amazon concurrency the region buckets
 *     were sized for, and they race each other's `release()` at the end. A
 *     session-scoped advisory lock on a reserved connection is the cheapest
 *     honest answer: the second tick returns `skipped: 'overlap'` immediately.
 *  2. **Repair** the schedule lookbacks Amazon refuses. Unconditional, because
 *     the rows that need it belong to profiles that are already provisioned.
 *  3. **Provision** defaults for any newly enabled profile, before the enqueue,
 *     so a profile switched on in the UI syncs this tick.
 *  4. **Enqueue** due recommendation runs in TypeScript (their required run id
 *     is minted first), then the remaining SQL schedules; finally **requeue**
 *     jobs a killed tick stranded.
 *  5. **Drain** until the queue is empty or the budget runs out.
 *  6. **Bid series**, if the budget survived the drain: the daily corridor sync
 *     has no queue job of its own (its payload type is a `packages/shared`
 *     contract change), so without this it never ran in this deployment at all.
 *     It gates itself per profile-local day, so calling it every tick is safe.
 *  7. **Release** anything still running back to `queued`, and unlock.
 */
import type { Sql } from '@wizard-ads/db';
import type { JobType } from '@wizard-ads/shared';

/** Queue work owned by Vercel cron; integration jobs stay on the always-on host. */
export const CRON_SYNC_JOB_TYPES = [
  'entity.sync',
  'report.request',
  'report.poll',
  'report.fetch',
  'recommendations.run',
] as const satisfies readonly JobType[];

/**
 * The advisory-lock key for the sync tick. Arbitrary but fixed: any other
 * advisory lock in this database must not reuse it.
 */
export const SYNC_TICK_LOCK_KEY = 4_812_397_100_113;

export interface SyncTickStore {
  unscheduledProfiles(): Promise<{ orgId: string; profileId: string }[]>;
  provisionSchedules(orgId: string, profileId: string): Promise<number>;
  repairOverlongLookbacks(profileId?: string): Promise<number>;
  ensureIntegrationSchedules(): Promise<number>;
  release(workerId: string): Promise<number>;
}

export interface SyncTickWorker {
  readonly workerId: string;
  drainOnce(maxJobs?: number, deadlineMs?: number): Promise<number>;
}

export interface SyncTickDeps {
  sql: Sql;
  store: SyncTickStore;
  worker: SyncTickWorker;
  /** Weekly recommendation run/job minting; optional for narrow tests. */
  recommendationSchedules?: () => Promise<number>;
  /**
   * The daily bid-corridor sync, given the tick's own deadline so it stops
   * between profiles rather than being cut off mid-request. Optional: absent,
   * step 6 is simply not attempted.
   */
  bidSeries?: (deadlineMs: number) => Promise<Record<string, number>>;
  /** How long the whole tick may spend before it releases and returns. */
  budgetMs?: number;
  /** Time the bid-series step needs left on the clock to be worth starting. */
  bidSeriesReserveMs?: number;
  now?: () => number;
  logger?: { info(message: string, details?: Record<string, unknown>): void };
}

export interface SyncTickResult {
  ok: boolean;
  skipped?: 'overlap';
  provisioned: number;
  repaired: number;
  integrationSchedules: number;
  enqueued: number;
  requeued: number;
  drained: number;
  released: number;
  budgetHit: boolean;
  bidSeries?: Record<string, number>;
  /** The bid-series step's failure. It never fails the tick: the drain did run. */
  bidSeriesError?: string;
  error?: string;
  ms: number;
}

const DEFAULT_BUDGET_MS = 240_000;
const DEFAULT_BID_SERIES_RESERVE_MS = 45_000;

export async function runSyncTick(deps: SyncTickDeps): Promise<SyncTickResult> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const deadline = startedAt + (deps.budgetMs ?? DEFAULT_BUDGET_MS);
  const reserveMs = deps.bidSeriesReserveMs ?? DEFAULT_BID_SERIES_RESERVE_MS;

  // A reserved connection, not the pool: an advisory lock lives on the session
  // that took it, and postgres.js would happily unlock on a different one.
  const locked = await deps.sql.reserve();
  const [lock] = await locked<{ locked: boolean }[]>`
    select pg_try_advisory_lock(${SYNC_TICK_LOCK_KEY}::bigint) as locked
  `;
  if (!lock?.locked) {
    locked.release();
    return {
      ok: true, skipped: 'overlap', provisioned: 0, repaired: 0, integrationSchedules: 0,
      enqueued: 0,
      requeued: 0, drained: 0, released: 0, budgetHit: false, ms: now() - startedAt,
    };
  }

  let provisioned = 0;
  let repaired = 0;
  let integrationSchedules = 0;
  let enqueued = 0;
  let requeued = 0;
  let drained = 0;
  let budgetHit = false;
  let bidSeries: Record<string, number> | undefined;
  let bidSeriesError: string | undefined;

  try {
    repaired = await deps.store.repairOverlongLookbacks();

    const unscheduled = await deps.store.unscheduledProfiles();
    for (const profile of unscheduled) {
      provisioned += await deps.store.provisionSchedules(profile.orgId, profile.profileId);
    }

    if (now() < deadline) {
      integrationSchedules = await deps.store.ensureIntegrationSchedules();
      if (now() >= deadline) budgetHit = true;
    } else {
      budgetHit = true;
    }

    if (!budgetHit) {
      enqueued += await deps.recommendationSchedules?.() ?? 0;
      const enqueuedRows = await deps.sql<{ enqueued: boolean }[]>`
        select enqueued from public.enqueue_due_schedules()
      `;
      enqueued += enqueuedRows.filter((row) => row.enqueued).length;
      const [requeuedRow] = await deps.sql<{ requeue_stale_sync_jobs: number }[]>`
        select public.requeue_stale_sync_jobs() as requeue_stale_sync_jobs
      `;
      requeued = Number(requeuedRow?.requeue_stale_sync_jobs ?? 0);

      for (;;) {
        if (now() >= deadline) {
          budgetHit = true;
          break;
        }
        const claimed = await deps.worker.drainOnce(undefined, deadline);
        if (claimed === 0) break;
        drained += claimed;
      }
    }

    // Only with real time left: a corridor sync started at the edge of the
    // budget is a request the platform kills mid-flight.
    if (deps.bidSeries && now() + reserveMs < deadline) {
      try {
        bidSeries = await deps.bidSeries(deadline);
      } catch (error) {
        bidSeriesError = error instanceof Error ? error.message : String(error);
      }
    }
  } catch (error) {
    const released = await deps.store.release(deps.worker.workerId).catch(() => 0);
    await unlock(locked);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'sync tick failed',
      provisioned, repaired, integrationSchedules, enqueued, requeued, drained, released, budgetHit,
      ...(bidSeries ? { bidSeries } : {}),
      ...(bidSeriesError ? { bidSeriesError } : {}),
      ms: now() - startedAt,
    };
  }

  const released = await deps.store.release(deps.worker.workerId);
  await unlock(locked);

  if (budgetHit) {
    deps.logger?.info('cron sync hit the drain budget with work possibly still queued', {
      drained, released, ms: now() - startedAt,
    });
  }

  return {
    ok: true,
    provisioned, repaired, integrationSchedules, enqueued, requeued, drained, released, budgetHit,
    ...(bidSeries ? { bidSeries } : {}),
    ...(bidSeriesError ? { bidSeriesError } : {}),
    ms: now() - startedAt,
  };
}

async function unlock(locked: Awaited<ReturnType<Sql['reserve']>>): Promise<void> {
  try {
    await locked`select pg_advisory_unlock(${SYNC_TICK_LOCK_KEY}::bigint)`;
  } finally {
    locked.release();
  }
}
