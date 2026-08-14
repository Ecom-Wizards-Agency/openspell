import { createDb } from '@wizard-ads/db';
import { createAdsApiClientFromEnv } from './ads-api.js';
import { configFromEnv } from './config.js';
import { closeServer, startHealthServer } from './health.js';
import { PostgresWorkerStore } from './store.js';
import { AuthHealthMonitor, SyncWorker } from './worker.js';

const config = configFromEnv();
const handle = createDb({ connectionString: config.databaseUrl, max: config.maxConcurrentJobs + 2 });
const worker = new SyncWorker({
  workerId: config.workerId,
  store: new PostgresWorkerStore(handle),
  adsApi: createAdsApiClientFromEnv(),
  claimBatchSize: config.claimBatchSize,
  maxConcurrentJobs: config.maxConcurrentJobs,
  pollIntervalMs: config.pollIntervalMs,
});
const health = await startHealthServer(worker, config.port);
const authHealth = new AuthHealthMonitor(worker);
authHealth.start();

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  authHealth.stop();
  await worker.shutdown();
  await closeServer(health);
  await handle.close();
}

process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));
process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
await worker.start();
