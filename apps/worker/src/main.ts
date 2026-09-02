import { createDb } from '@wizard-ads/db';
import { createAdsApiClientFromEnv } from './ads-api.js';
import { configFromEnv } from './config.js';
import { createCrosscheckIngest } from './crosscheck.js';
import { createDataDiveRankSyncHandler } from './datadive.js';
import { closeServer, startHealthServer } from './health.js';
import { PostgresBidSeriesStore } from './bid-series.js';
import { createKeepaSyncHandler } from './keepa.js';
import { createMarketingStreamSqsConsumer } from './marketing-stream-sqs.js';
import { createMarketingStreamNormalizeHandler } from './marketing-stream-normalize.js';
import { createSpApiSqpRequestHandler } from './spapi-sqp.js';
import { PostgresWeeklySqpScheduler } from './sqp-scheduler.js';
import {
  PostgresRecommendationRunStore,
  createRecommendationsRunner,
} from './recommendations-run.js';
import { RecommendationObservationPass } from './recommendation-observer.js';
import { PostgresWorkerStore } from './store.js';
import { WorkerUnifiedDualRun } from './unified-reporting.js';
import { PostgresUnifiedDualRunStore } from './unified-reporting-store.js';
import {
  ObservedSbVideoIngestion,
  PostgresSbVideoIngestionStore,
} from './sb-video-ingestion.js';
import { createMrpEconomicsSync } from './mrp.js';
import {
  AuthHealthMonitor,
  BidSeriesSyncPass,
  QueueSettlementError,
  ScheduleProvisioner,
  StaleClaimReaper,
  SyncWorker,
  type WorkerShutdownEvidence,
} from './worker.js';
import type { JobType } from '@wizard-ads/shared';

const AMAZON_JOB_TYPES: ReadonlySet<JobType> = new Set([
  'entity.sync',
  'report.request',
  'report.poll',
  'report.fetch',
  'report.unified.advance',
  'creative.sync',
]);

const config = configFromEnv();
const handle = createDb({ connectionString: config.databaseUrl, max: config.maxConcurrentJobs + 2 });
const store = new PostgresWorkerStore(handle, undefined, {
  claimProtocol: config.claimProtocol,
});
const marketingStream = config.startsBackgroundPasses && config.marketingStreamQueueUrl
  ? createMarketingStreamSqsConsumer({
      handle,
      queueUrl: config.marketingStreamQueueUrl,
      scheduler: {
        enqueue: ({ orgId, profileId, messageIds, runAt, dedupeKey }) => store.enqueue({
          type: 'marketing_stream.normalize',
          orgId,
          profileId,
          messageIds: [...messageIds],
        }, runAt, dedupeKey),
      },
    })
  : undefined;
// Integration-only deployments do not read ADS_* at boot. Amazon wiring exists
// only when this runtime's claim policy includes an Amazon job type (or all).
const runsAmazonJobs = config.jobTypes === undefined
  || config.jobTypes.some((jobType) => AMAZON_JOB_TYPES.has(jobType));
// One client instance serves both the queue worker and bid-corridor sync.
const adsApi = runsAmazonJobs ? createAdsApiClientFromEnv(handle) : undefined;
const unifiedReporting = adsApi && config.unifiedReporting.enabled
  ? new WorkerUnifiedDualRun({
      policy: config.unifiedReporting,
      store: new PostgresUnifiedDualRunStore(handle),
      provider: adsApi,
    })
  : undefined;
const recommendationRuns = new PostgresRecommendationRunStore(handle);
const sbVideo = adsApi
  ? new ObservedSbVideoIngestion(
      adsApi,
      new PostgresSbVideoIngestionStore(handle, store),
    )
  : undefined;
const runsSqpJobs = config.jobTypes === undefined || config.jobTypes.includes('sqp.request');
const sqpRequest = runsSqpJobs && config.spApiClientId && config.spApiClientSecret
  ? createSpApiSqpRequestHandler({
      handle,
      lwaClientId: config.spApiClientId,
      lwaClientSecret: config.spApiClientSecret,
      minimumProviderIntervalMs: config.spApiReportMinIntervalMs,
    })
  : undefined;
const sqpSchedules = sqpRequest
  ? new PostgresWeeklySqpScheduler(handle, store)
  : undefined;
const worker = new SyncWorker({
  workerId: config.workerId,
  store,
  adsApi,
  jobTypes: config.jobTypes,
  crosscheckIngest: createCrosscheckIngest(handle, { inboxDir: config.crosscheckInboxDir }),
  recommendationsRun: createRecommendationsRunner(recommendationRuns),
  sbVideo,
  unifiedReporting,
  integrations: {
    economicsSync: createMrpEconomicsSync(handle),
    rankSync: createDataDiveRankSyncHandler({ handle }),
    keepaSync: createKeepaSyncHandler(handle),
    ...(sqpRequest === undefined ? {} : { sqpRequest }),
    marketingStreamNormalize: createMarketingStreamNormalizeHandler({ handle, queue: store }),
  },
  claimBatchSize: config.claimBatchSize,
  maxConcurrentJobs: config.maxConcurrentJobs,
  pollIntervalMs: config.pollIntervalMs,
});
marketingStream?.start();
const health = await startHealthServer(worker, config.port, {
  deployment: {
    revision: config.revision,
    role: config.deploymentRole,
    claimProtocol: config.claimProtocol,
    jobTypes: config.jobTypes ?? 'all',
  },
  marketingStream,
}, config.healthHost);
const authHealth = config.startsBackgroundPasses && adsApi
  ? new AuthHealthMonitor(worker, config.authHealthcheckIntervalMs)
  : undefined;
const reaper = config.startsBackgroundPasses
  ? new StaleClaimReaper(store, config.staleClaimAfter)
  : undefined;
const provisioner = config.startsBackgroundPasses
  ? new ScheduleProvisioner(
      store,
      undefined,
      undefined,
      recommendationRuns,
      sqpSchedules,
    )
  : undefined;
const bidSeries = config.startsBackgroundPasses && adsApi
  ? new BidSeriesSyncPass({ store: new PostgresBidSeriesStore(handle), client: adsApi })
  : undefined;
const recommendationObserver = config.startsBackgroundPasses
  ? new RecommendationObservationPass(handle, console)
  : undefined;
authHealth?.start();
reaper?.start();
provisioner?.start();
bidSeries?.start();
recommendationObserver?.start();

const CUSTODY_EXIT_CODE = 78;
let shutdownPromise: Promise<WorkerShutdownEvidence> | null = null;

function shutdown(): Promise<WorkerShutdownEvidence> {
  shutdownPromise ??= performShutdown();
  return shutdownPromise;
}

async function performShutdown(): Promise<WorkerShutdownEvidence> {
  authHealth?.stop();
  reaper?.stop();
  provisioner?.stop();
  bidSeries?.stop();
  recommendationObserver?.stop();
  await marketingStream?.stop();
  const evidence = await worker.shutdown();
  console.info('report worker shutdown evidence', evidence);
  await closeServer(health);
  await handle.close();
  return evidence;
}

async function shutdownForSignal(): Promise<void> {
  try {
    const evidence = await shutdown();
    process.exit(evidence.unresolved === 0 ? 0 : CUSTODY_EXIT_CODE);
  } catch {
    console.error('report worker shutdown evidence unavailable');
    process.exit(CUSTODY_EXIT_CODE);
  }
}

process.once('SIGTERM', () => void shutdownForSignal());
process.once('SIGINT', () => void shutdownForSignal());

try {
  await worker.start();
} catch (error) {
  const failureKind = error instanceof QueueSettlementError ? error.kind : 'unexpected';
  console.error('report worker stopped after fatal failure', { failureKind });
  let evidence: WorkerShutdownEvidence = { released: 0, unresolved: 1 };
  try {
    evidence = await shutdown();
  } catch {
    console.error('report worker fatal shutdown evidence unavailable');
  }
  process.exitCode = error instanceof QueueSettlementError || evidence.unresolved > 0
    ? CUSTODY_EXIT_CODE
    : 1;
}
