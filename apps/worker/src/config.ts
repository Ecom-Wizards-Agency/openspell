import { connectionStringFromEnv } from '@wizard-ads/db';
import { JobType, type JobType as JobTypeValue } from '@wizard-ads/shared';
import { isIP } from 'node:net';
import {
  resolveWorkerDeploymentPolicy,
  resolveUnifiedReportingDualRunPolicy,
  type UnifiedReportingDualRunPolicy,
  type WorkerClaimProtocol,
  type WorkerDeploymentRole,
} from './deployment-role.js';

export interface WorkerConfig {
  databaseUrl: string;
  workerId: string;
  port: number;
  /** Literal interface address for the health listener. */
  healthHost: string;
  pollIntervalMs: number;
  claimBatchSize: number;
  maxConcurrentJobs: number;
  /** Queue types this runtime may claim. Undefined means the whole queue. */
  jobTypes: readonly JobTypeValue[] | undefined;
  /** Sanitized deployment identity; never derived from a hostname or secret. */
  deploymentRole: WorkerDeploymentRole;
  /** Queue custody advertised by health and selected by the database store. */
  claimProtocol: WorkerClaimProtocol;
  /** Sanitized Git object id; public health never echoes arbitrary environment values. */
  revision: string;
  /** Whether this process hosts timers and independent background consumers. */
  startsBackgroundPasses: boolean;
  /** Default-off WP-181 cohort. Account bindings remain database-owned. */
  unifiedReporting: UnifiedReportingDualRunPolicy;
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
  /** Enables the independent long-poll consumer when present. Never logged. */
  marketingStreamQueueUrl: string | undefined;
  /** Deployment-owned LWA application credentials. Tenant refresh values stay in Vault. */
  spApiClientId: string | undefined;
  spApiClientSecret: string | undefined;
  /** Serial floor between Reports API operations; provider 429s still control retries. */
  spApiReportMinIntervalMs: number;
}

export function workerRevisionFromEnv(env: NodeJS.ProcessEnv): string {
  const raw = env['OPENSPELL_WORKER_REVISION'];
  if (raw === undefined || raw.trim() === '') return 'unknown';
  const revision = raw.trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(revision)) {
    throw new Error(
      'OPENSPELL_WORKER_REVISION must be a 7-64 character hexadecimal Git object id',
    );
  }
  return revision;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function workerHealthHostFromEnv(value: string | undefined): string {
  const host = value?.trim() || '0.0.0.0';
  if (isIP(host) === 0) {
    throw new Error('WORKER_HEALTH_HOST must be a literal IPv4 or IPv6 address');
  }
  return host;
}

export function workerJobTypesFromEnv(value: string | undefined): readonly JobTypeValue[] | undefined {
  if (value === undefined) return undefined;
  const tokens = value.split(',').map((token) => token.trim());
  if (tokens.length === 0 || tokens.some((token) => token.length === 0)) {
    throw new Error('WORKER_JOB_TYPES must be a comma-separated list of job types');
  }

  const parsed = tokens.map((token) => {
    const result = JobType.safeParse(token);
    if (!result.success) throw new Error(`WORKER_JOB_TYPES contains unknown job type ${token}`);
    return result.data;
  });
  return [...new Set(parsed)];
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const spApiClientId = env['SP_API_LWA_CLIENT_ID']?.trim() || undefined;
  const spApiClientSecret = env['SP_API_LWA_CLIENT_SECRET']?.trim() || undefined;
  if ((spApiClientId === undefined) !== (spApiClientSecret === undefined)) {
    throw new Error('SP_API_LWA_CLIENT_ID and SP_API_LWA_CLIENT_SECRET must be configured together');
  }
  const unifiedReady = env['OPENSPELL_UNIFIED_REPORTING_DUAL_RUN_READY'] === '1';
  const deployment = resolveWorkerDeploymentPolicy(
    env['WORKER_DEPLOYMENT_ROLE'],
    workerJobTypesFromEnv(env['WORKER_JOB_TYPES']),
    unifiedReady,
  );
  const unifiedReporting = resolveUnifiedReportingDualRunPolicy(env, deployment);
  return {
    databaseUrl: connectionStringFromEnv(env),
    workerId: env['WORKER_ID'] ?? `worker-${process.pid}`,
    port: positiveInteger(env['PORT'], 3000, 'PORT'),
    healthHost: workerHealthHostFromEnv(env['WORKER_HEALTH_HOST']),
    pollIntervalMs: positiveInteger(env['WORKER_POLL_INTERVAL_MS'], 1_000, 'WORKER_POLL_INTERVAL_MS'),
    claimBatchSize: positiveInteger(env['WORKER_CLAIM_BATCH_SIZE'], 10, 'WORKER_CLAIM_BATCH_SIZE'),
    maxConcurrentJobs: positiveInteger(env['WORKER_MAX_CONCURRENT_JOBS'], 10, 'WORKER_MAX_CONCURRENT_JOBS'),
    jobTypes: deployment.jobTypes,
    deploymentRole: deployment.role,
    claimProtocol: deployment.claimProtocol,
    revision: workerRevisionFromEnv(env),
    startsBackgroundPasses: deployment.startsBackgroundPasses,
    unifiedReporting,
    crosscheckInboxDir: env['CROSSCHECK_INBOX_DIR'] || undefined,
    authHealthcheckIntervalMs:
      positiveInteger(env['WORKER_AUTH_HEALTHCHECK_MINUTES'], 60, 'WORKER_AUTH_HEALTHCHECK_MINUTES') * 60_000,
    staleClaimAfter: env['WORKER_STALE_CLAIM_AFTER'] ?? '30 minutes',
    marketingStreamQueueUrl: env['MARKETING_STREAM_SQS_QUEUE_URL']?.trim() || undefined,
    spApiClientId,
    spApiClientSecret,
    spApiReportMinIntervalMs: positiveInteger(
      env['SP_API_REPORT_MIN_INTERVAL_MS'],
      1_000,
      'SP_API_REPORT_MIN_INTERVAL_MS',
    ),
  };
}
