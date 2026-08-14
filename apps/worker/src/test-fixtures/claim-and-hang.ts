import { claimSyncJobs, createDb, connectionStringFromEnv } from '@wizard-ads/db';

const handle = createDb({ connectionString: connectionStringFromEnv() });
const jobs = await claimSyncJobs(handle, 'killed-worker', 1);
if (jobs.length !== 1) throw new Error(`expected to claim one job, claimed ${jobs.length}`);
process.stdout.write(`CLAIMED ${jobs[0]?.id ?? ''}\n`);
await new Promise(() => {});
