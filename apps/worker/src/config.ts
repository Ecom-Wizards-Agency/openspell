import { connectionStringFromEnv } from '@wizard-ads/db';

export interface WorkerConfig {
  databaseUrl: string;
  workerId: string;
  port: number;
  pollIntervalMs: number;
  claimBatchSize: number;
  maxConcurrentJobs: number;
  /**
   * Root of the crosscheck export inbox (WP-10). A path, so a mounted bucket
   * works. Never a tracked default: a schedule's payload carries only the
   * profile-night directory under it.
   */
  crosscheckInboxDir: string | undefined;
  /** Hours between `/v2/profiles` auth probes. See `AuthHealthMonitor`. */
  authHealthcheckIntervalMs: number;
  /** How long a `running` job may hold its claim before another worker may take it. */
  staleClaimAfter: string;
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
    crosscheckInboxDir: env['CROSSCHECK_INBOX_DIR'] || undefined,
    authHealthcheckIntervalMs:
      positiveInteger(env['WORKER_AUTH_HEALTHCHECK_MINUTES'], 60, 'WORKER_AUTH_HEALTHCHECK_MINUTES') * 60_000,
    staleClaimAfter: env['WORKER_STALE_CLAIM_AFTER'] ?? '30 minutes',
  };
}
