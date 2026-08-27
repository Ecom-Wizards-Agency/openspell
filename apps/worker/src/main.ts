import { createDb } from '@wizard-ads/db';
import { createAdsApiClientFromEnv } from './ads-api.js';
import { configFromEnv } from './config.js';
import { createCrosscheckIngest } from './crosscheck.js';
import { createDataDiveRankSyncHandler } from './datadive.js';
import { closeServer, startHealthServer } from './health.js';
import { PostgresBidSeriesStore } from './bid-series.js';
import { createKeepaSyncHandler } from './keepa.js';
import {
  PostgresRecommendationRunStore,
  createRecommendationsRunner,
} from './recommendations-run.js';
import { PostgresWorkerStore } from './store.js';
import { createMrpEconomicsSync } from './mrp.js';
import {
  AuthHealthMonitor,
  BidSeriesSyncPass,
  ScheduleProvisioner,
  StaleClaimReaper,
  SyncWorker,
} from './worker.js';
import type { JobType } from '@wizard-ads/shared';

const AMAZON_JOB_TYPES: ReadonlySet<JobType> = new Set([
  'entity.sync',
  'report.request',
  'report.poll',
  'report.fetch',
]);

const config = configFromEnv();
const handle = createDb({ connectionString: config.databaseUrl, max: config.maxConcurrentJobs + 2 });
const store = new PostgresWorkerStore(handle);
// Integration-only deployments do not read ADS_* at boot. Amazon wiring exists
// only when this runtime's claim policy includes an Amazon job type (or all).
const runsAmazonJobs = config.jobTypes === undefined
  || config.jobTypes.some((jobType) => AMAZON_JOB_TYPES.has(jobType));
// One client instance serves both the queue worker and bid-corridor sync.
const adsApi = runsAmazonJobs ? createAdsApiClientFromEnv(handle) : undefined;
const recommendationRuns = new PostgresRecommendationRunStore(handle);
const worker = new SyncWorker({
  workerId: config.workerId,
  store,
  adsApi,
  jobTypes: config.jobTypes,
  crosscheckIngest: createCrosscheckIngest(handle, { inboxDir: config.crosscheckInboxDir }),
  recommendationsRun: createRecommendationsRunner(recommendationRuns),
  integrations: {
    economicsSync: createMrpEconomicsSync(handle),
    rankSync: createDataDiveRankSyncHandler({ handle }),
    keepaSync: createKeepaSyncHandler(handle),
  },
  claimBatchSize: config.claimBatchSize,
  maxConcurrentJobs: config.maxConcurrentJobs,
  pollIntervalMs: config.pollIntervalMs,
});
const health = await startHealthServer(worker, config.port);
const authHealth = adsApi
  ? new AuthHealthMonitor(worker, config.authHealthcheckIntervalMs)
  : undefined;
const reaper = new StaleClaimReaper(store, config.staleClaimAfter);
const provisioner = new ScheduleProvisioner(store, undefined, undefined, recommendationRuns);
const bidSeries = adsApi
  ? new BidSeriesSyncPass({ store: new PostgresBidSeriesStore(handle), client: adsApi })
  : undefined;
authHealth?.start();
reaper.start();
provisioner.start();
bidSeries?.start();

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  authHealth?.stop();
  reaper.stop();
  provisioner.stop();
  bidSeries?.stop();
  await worker.shutdown();
  await closeServer(health);
  await handle.close();
}

process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));
process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
await worker.start();
