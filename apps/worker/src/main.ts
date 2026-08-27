import { createDb } from '@wizard-ads/db';
import { createAdsApiClientFromEnv } from './ads-api.js';
import { configFromEnv } from './config.js';
import { createCrosscheckIngest } from './crosscheck.js';
import { closeServer, startHealthServer } from './health.js';
import { PostgresBidSeriesStore } from './bid-series.js';
import {
  PostgresRecommendationRunStore,
  createRecommendationsRunner,
} from './recommendations-run.js';
import { PostgresWorkerStore } from './store.js';
import {
  AuthHealthMonitor,
  BidSeriesSyncPass,
  ScheduleProvisioner,
  StaleClaimReaper,
  SyncWorker,
} from './worker.js';

const config = configFromEnv();
const handle = createDb({ connectionString: config.databaseUrl, max: config.maxConcurrentJobs + 2 });
const store = new PostgresWorkerStore(handle);
// One client instance serves both the queue worker (as an AdsApiClient) and the
// bid-corridor sync (as a SuggestedBidClient); DbAdsApiClient implements both.
const adsApi = createAdsApiClientFromEnv(handle);
const recommendationRuns = new PostgresRecommendationRunStore(handle);
const worker = new SyncWorker({
  workerId: config.workerId,
  store,
  adsApi,
  crosscheckIngest: createCrosscheckIngest(handle, { inboxDir: config.crosscheckInboxDir }),
  recommendationsRun: createRecommendationsRunner(recommendationRuns),
  claimBatchSize: config.claimBatchSize,
  maxConcurrentJobs: config.maxConcurrentJobs,
  pollIntervalMs: config.pollIntervalMs,
});
const health = await startHealthServer(worker, config.port);
const authHealth = new AuthHealthMonitor(worker, config.authHealthcheckIntervalMs);
const reaper = new StaleClaimReaper(store, config.staleClaimAfter);
const provisioner = new ScheduleProvisioner(store, undefined, undefined, recommendationRuns);
const bidSeries = new BidSeriesSyncPass({
  store: new PostgresBidSeriesStore(handle),
  client: adsApi,
});
authHealth.start();
reaper.start();
provisioner.start();
bidSeries.start();

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  authHealth.stop();
  reaper.stop();
  provisioner.stop();
  bidSeries.stop();
  await worker.shutdown();
  await closeServer(health);
  await handle.close();
}

process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));
process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
await worker.start();
