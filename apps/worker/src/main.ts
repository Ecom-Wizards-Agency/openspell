import { createDb } from '@wizard-ads/db';
import { createAdsApiClientFromEnv } from './ads-api.js';
import { configFromEnv } from './config.js';
import { createCrosscheckIngest } from './crosscheck.js';
import { closeServer, startHealthServer } from './health.js';
import { PostgresWorkerStore } from './store.js';
import { AuthHealthMonitor, ScheduleProvisioner, StaleClaimReaper, SyncWorker } from './worker.js';

const config = configFromEnv();
const handle = createDb({ connectionString: config.databaseUrl, max: config.maxConcurrentJobs + 2 });
const store = new PostgresWorkerStore(handle);
const worker = new SyncWorker({
  workerId: config.workerId,
  store,
  adsApi: createAdsApiClientFromEnv(),
  crosscheckIngest: createCrosscheckIngest(handle, { inboxDir: config.crosscheckInboxDir }),
  claimBatchSize: config.claimBatchSize,
  maxConcurrentJobs: config.maxConcurrentJobs,
  pollIntervalMs: config.pollIntervalMs,
});
const health = await startHealthServer(worker, config.port);
const authHealth = new AuthHealthMonitor(worker, config.authHealthcheckIntervalMs);
const reaper = new StaleClaimReaper(store, config.staleClaimAfter);
const provisioner = new ScheduleProvisioner(store);
authHealth.start();
reaper.start();
provisioner.start();

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  authHealth.stop();
  reaper.stop();
  provisioner.stop();
  await worker.shutdown();
  await closeServer(health);
  await handle.close();
}

process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));
process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
await worker.start();
