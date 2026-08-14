/**
 * `GET /api/cron/sync` — the daily pull, hosted on Vercel Cron.
 *
 * There is no always-on worker process in this deployment: no Fly machine, no
 * laptop left running. Instead Vercel Cron hits this route every five minutes,
 * and one tick does exactly what the old always-on worker's timers did, in one
 * request under a wall-clock budget:
 *
 *  1. **Provision** default schedules for any newly enabled profile (what
 *     `ScheduleProvisioner` did), so a profile switched on in the UI starts
 *     syncing this tick rather than after someone remembers to seed it.
 *  2. **Enqueue** every due schedule into `sync_jobs` (`enqueue_due_schedules`).
 *  3. **Requeue** jobs a previous tick claimed but a killed request never
 *     finished (`requeue_stale_sync_jobs`, what `StaleClaimReaper` did).
 *  4. **Drain** the queue by looping the worker's own `drainOnce()` until it
 *     comes up empty or the ~50s budget runs out — the same claim/execute/retry
 *     path the process worker runs, just pumped by a request instead of a loop.
 *  5. **Release** anything still running back to `queued` and close the handle,
 *     so a job this tick started but could not finish is picked up next tick
 *     rather than stranded as `running`.
 *
 * Auth is the shared secret Vercel Cron sends in the `Authorization` header
 * (`Bearer $CRON_SECRET`). Without a configured secret, or with the wrong one,
 * the route is a 401 and does nothing: an unauthenticated caller must never be
 * able to make us spend Amazon quota.
 *
 * The handle is dedicated to this request and closed at the end — draining wants
 * several connections at once, and it must never close the shared web pool
 * (`src/data/db.ts`) that the rest of the app renders through.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { connectionStringFromEnv, createDb } from '@wizard-ads/db';
import {
  PostgresWorkerStore,
  SyncWorker,
  createAdsApiClientFromEnv,
} from '@wizard-ads/worker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The drain runs to a ~50s budget; give the platform function room past it.
export const maxDuration = 60;

/** How long one tick spends draining before it releases and returns. */
const DRAIN_BUDGET_MS = 50_000;

export async function GET(request: Request): Promise<Response> {
  const expected = process.env['CRON_SECRET'];
  if (!expected) {
    return NextResponse.json(
      { error: 'CRON_SECRET is not configured on this deployment.' },
      { status: 401 },
    );
  }
  const authorization = request.headers.get('authorization');
  if (authorization !== `Bearer ${expected}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let connectionString: string;
  try {
    connectionString = connectionStringFromEnv();
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'database not configured' },
      { status: 500 },
    );
  }

  // A few connections: the worker claims a batch and runs it concurrently.
  const handle = createDb({ connectionString, max: 6 });
  const store = new PostgresWorkerStore(handle);
  const worker = new SyncWorker({
    workerId: `vercel-cron-${randomUUID()}`,
    store,
    adsApi: createAdsApiClientFromEnv(handle),
  });

  const startedAt = Date.now();
  const deadline = startedAt + DRAIN_BUDGET_MS;
  let provisioned = 0;
  let enqueued = 0;
  let requeued = 0;
  let drained = 0;
  let budgetHit = false;

  try {
    // 1. Provision before enqueue, so a profile enabled since the last tick gets
    //    its default schedules and they are enqueued and drained this same tick.
    const unscheduled = await store.unscheduledProfiles();
    for (const profile of unscheduled) {
      provisioned += await store.provisionSchedules(profile.orgId, profile.profileId);
    }

    // 2 + 3. Both idempotent service-role RPCs.
    const enqueuedRows = await handle.sql<{ enqueued: boolean }[]>`
      select enqueued from public.enqueue_due_schedules()
    `;
    enqueued = enqueuedRows.filter((row) => row.enqueued).length;
    const [requeuedRow] = await handle.sql<{ requeue_stale_sync_jobs: number }[]>`
      select public.requeue_stale_sync_jobs() as requeue_stale_sync_jobs
    `;
    requeued = Number(requeuedRow?.requeue_stale_sync_jobs ?? 0);

    // 4. Drain until empty or out of budget.
    for (;;) {
      if (Date.now() >= deadline) {
        budgetHit = true;
        break;
      }
      const claimed = await worker.drainOnce(undefined, deadline);
      if (claimed === 0) break;
      drained += claimed;
    }
  } catch (error) {
    // 5. Release whatever this worker still holds even on failure, then report.
    const released = await store.release(worker.workerId).catch(() => 0);
    await handle.close();
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'sync tick failed',
        provisioned,
        enqueued,
        requeued,
        drained,
        released,
      },
      { status: 500 },
    );
  }

  // 5. Anything still running (a job started but not finished within budget)
  //    goes back to queued for the next tick, then the handle is closed.
  const released = await store.release(worker.workerId);
  await handle.close();

  if (budgetHit) {
    console.info('cron sync hit the drain budget with work possibly still queued', {
      drained,
      released,
      ms: Date.now() - startedAt,
    });
  }

  return NextResponse.json({
    ok: true,
    provisioned,
    enqueued,
    requeued,
    drained,
    released,
    budgetHit,
    ms: Date.now() - startedAt,
  });
}
