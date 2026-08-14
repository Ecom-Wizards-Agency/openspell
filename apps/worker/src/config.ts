import { connectionStringFromEnv } from '@wizard-ads/db';

export interface WorkerConfig {
  databaseUrl: string;
  workerId: string;
  port: number;
  pollIntervalMs: number;
  claimBatchSize: number;
  maxConcurrentJobs: number;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    databaseUrl: connectionStringFromEnv(env),
    workerId: env['WORKER_ID'] ?? `worker-${process.pid}`,
    port: positiveInteger(env['PORT'], 3000, 'PORT'),
    pollIntervalMs: positiveInteger(env['WORKER_POLL_INTERVAL_MS'], 1_000, 'WORKER_POLL_INTERVAL_MS'),
    claimBatchSize: positiveInteger(env['WORKER_CLAIM_BATCH_SIZE'], 10, 'WORKER_CLAIM_BATCH_SIZE'),
    maxConcurrentJobs: positiveInteger(env['WORKER_MAX_CONCURRENT_JOBS'], 10, 'WORKER_MAX_CONCURRENT_JOBS'),
  };
}

export const DEFAULT_SCHEDULES = {
  entity: { cadence: '1 day' },
  reportRecent: { cadence: '1 day', lookbackDays: 3 },
  reportRestatement: { cadence: '7 days', lookbackDays: 35 },
} as const;
