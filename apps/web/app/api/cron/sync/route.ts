/**
 * `GET /api/cron/sync` — the daily pull, hosted on Vercel Cron.
 *
 * The Vercel worker is one-shot: Vercel Cron hits this route every five minutes
 * and one tick runs under a wall-clock budget. After the explicit report-lane
 * handoff, the separate always-on Evo process owns Creative and report queue
 * jobs while this route retains entity and recommendation claims. The tick
 * itself — lock, repair, provision/enqueue/requeue/drain/bid-series/release —
 * lives in `src/server/sync-tick.ts`; this file is the door.
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
import {
  connectionStringFromEnv,
  createDb,
  enqueueDailyCreativeSyncJobs,
} from '@wizard-ads/db';
import {
  PostgresBidSeriesStore,
  PostgresRecommendationRunStore,
  PostgresWorkerStore,
  SyncWorker,
  createAdsApiClientFromEnv,
  createRecommendationsRunner,
  runBidSeriesSync,
} from '@wizard-ads/worker';
import {
  creativeSyncPilotFromEnv,
  cronSyncJobTypesFromEnv,
  runSyncTick,
} from '../../../../src/server/sync-tick';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The tick spends up to DRAIN_BUDGET_MS (240s) before it releases and returns;
// the platform function gets 300s, so the release and the unlock still happen
// inside the request rather than being cut off with jobs left `running`.
export const maxDuration = 300;

/** How long one tick spends working before it releases and returns. */
const DRAIN_BUDGET_MS = 240_000;

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

  let jobTypes;
  let creativeSyncPilot;
  try {
    jobTypes = cronSyncJobTypesFromEnv();
    creativeSyncPilot = creativeSyncPilotFromEnv();
  } catch {
    return NextResponse.json(
      { error: 'cron queue ownership is not configured safely' },
      { status: 503 },
    );
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

  // A few connections: the worker claims a batch and runs it concurrently, and
  // one of them is reserved for the tick lock.
  const handle = createDb({ connectionString, max: 7 });
  const store = new PostgresWorkerStore(handle);
  const recommendationRuns = new PostgresRecommendationRunStore(handle);
  const adsApi = createAdsApiClientFromEnv(handle);
  const worker = new SyncWorker({
    workerId: `vercel-cron-${randomUUID()}`,
    store,
    adsApi,
    jobTypes,
    recommendationsRun: createRecommendationsRunner(recommendationRuns),
  });

  try {
    const result = await runSyncTick({
      sql: handle.sql,
      store,
      worker,
      // Operator rule (2026-08-27): no automation without approval. Weekly
      // recommendation runs stay off until explicitly opted in; Run now is
      // unaffected.
      ...(process.env['WIZARD_ADS_WEEKLY_RECOMMENDATION_RUNS'] === '1'
        ? { recommendationSchedules: () => recommendationRuns.enqueueDueRecommendationRuns() }
        : {}),
      ...(creativeSyncPilot.enabled
        ? {
            creativeSyncSchedules: () =>
              enqueueDailyCreativeSyncJobs(handle, creativeSyncPilot.profileIds),
          }
        : {}),
      budgetMs: DRAIN_BUDGET_MS,
      // One client serves both roles: DbAdsApiClient is an AdsApiClient for the
      // queue and a SuggestedBidClient for the corridor.
      bidSeries: async (deadlineMs) => ({
        ...(await runBidSeriesSync({
          store: new PostgresBidSeriesStore(handle),
          client: adsApi,
          deadlineMs,
        })),
      }),
      logger: console,
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  } finally {
    await handle.close();
  }
}
