import { isIP } from 'node:net';

export const RECOMMENDATION_LANE_ROLE = 'evo-recommendation-lane' as const;
export const RECOMMENDATION_LANE_CLAIM_PROTOCOL = 'recommendation-fenced-v1' as const;
export const RECOMMENDATION_LANE_JOB_TYPE = 'recommendations.run' as const;
export const RECOMMENDATION_LANE_BATCH_SIZE = 1 as const;
export const RECOMMENDATION_LANE_MAX_CONCURRENCY = 1 as const;

export const MIN_RECOMMENDATION_POLL_INTERVAL_MS = 250;
export const MAX_RECOMMENDATION_POLL_INTERVAL_MS = 60_000;
export const MIN_RECOMMENDATION_SHUTDOWN_DRAIN_MS = 1_000;
export const MAX_RECOMMENDATION_SHUTDOWN_DRAIN_MS = 300_000;

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_SHUTDOWN_DRAIN_MS = 25_000;
const DEFAULT_HEALTH_HOST = '127.0.0.1';
const DEFAULT_HEALTH_PORT = 3_002;
const WORKER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const FULL_GIT_OBJECT_ID = /^[0-9a-f]{40}$/;

export interface RecommendationLaneConfig {
  databaseUrl: string;
  workerId: string;
  revision: string;
  role: typeof RECOMMENDATION_LANE_ROLE;
  claimProtocol: typeof RECOMMENDATION_LANE_CLAIM_PROTOCOL;
  jobTypes: readonly [typeof RECOMMENDATION_LANE_JOB_TYPE];
  claimBatchSize: typeof RECOMMENDATION_LANE_BATCH_SIZE;
  maxConcurrentJobs: typeof RECOMMENDATION_LANE_MAX_CONCURRENCY;
  claimArmed: boolean;
  pollIntervalMs: number;
  shutdownDrainMs: number;
  healthHost: '127.0.0.1' | '::1';
  healthPort: number;
}

/** Parse the recommendation-only runtime without reading any provider setting. */
export function recommendationLaneConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RecommendationLaneConfig {
  const databaseUrl = required(env['DATABASE_URL'], 'DATABASE_URL');
  if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL');
  }

  const workerId = required(env['WORKER_ID'], 'WORKER_ID');
  if (!WORKER_ID.test(workerId)) {
    throw new Error('WORKER_ID must be a stable 1-128 character runtime identity');
  }

  const revision = required(env['OPENSPELL_WORKER_REVISION'], 'OPENSPELL_WORKER_REVISION')
    .toLowerCase();
  if (!FULL_GIT_OBJECT_ID.test(revision)) {
    throw new Error('OPENSPELL_WORKER_REVISION must be a full 40-character Git object id');
  }

  exact(env['WORKER_DEPLOYMENT_ROLE'], RECOMMENDATION_LANE_ROLE, 'WORKER_DEPLOYMENT_ROLE');
  exact(env['WORKER_CLAIM_PROTOCOL'], RECOMMENDATION_LANE_CLAIM_PROTOCOL, 'WORKER_CLAIM_PROTOCOL');
  exact(env['WORKER_JOB_TYPES'], RECOMMENDATION_LANE_JOB_TYPE, 'WORKER_JOB_TYPES');
  exactInteger(env['WORKER_CLAIM_BATCH_SIZE'], RECOMMENDATION_LANE_BATCH_SIZE, 'WORKER_CLAIM_BATCH_SIZE');
  exactInteger(
    env['WORKER_MAX_CONCURRENT_JOBS'],
    RECOMMENDATION_LANE_MAX_CONCURRENCY,
    'WORKER_MAX_CONCURRENT_JOBS',
  );
  const claimArmed = exactBoolean(env['WORKER_CLAIM_ARMED'], 'WORKER_CLAIM_ARMED');

  const healthHost = (env['WORKER_HEALTH_HOST']?.trim() || DEFAULT_HEALTH_HOST);
  if (isIP(healthHost) === 0 || (healthHost !== '127.0.0.1' && healthHost !== '::1')) {
    throw new Error('WORKER_HEALTH_HOST must be the IPv4 or IPv6 loopback address');
  }

  return Object.freeze({
    databaseUrl,
    workerId,
    revision,
    role: RECOMMENDATION_LANE_ROLE,
    claimProtocol: RECOMMENDATION_LANE_CLAIM_PROTOCOL,
    jobTypes: Object.freeze([RECOMMENDATION_LANE_JOB_TYPE] as const),
    claimBatchSize: RECOMMENDATION_LANE_BATCH_SIZE,
    maxConcurrentJobs: RECOMMENDATION_LANE_MAX_CONCURRENCY,
    claimArmed,
    pollIntervalMs: boundedInteger(
      env['WORKER_POLL_INTERVAL_MS'],
      DEFAULT_POLL_INTERVAL_MS,
      MIN_RECOMMENDATION_POLL_INTERVAL_MS,
      MAX_RECOMMENDATION_POLL_INTERVAL_MS,
      'WORKER_POLL_INTERVAL_MS',
    ),
    shutdownDrainMs: boundedInteger(
      env['WORKER_SHUTDOWN_DRAIN_MS'],
      DEFAULT_SHUTDOWN_DRAIN_MS,
      MIN_RECOMMENDATION_SHUTDOWN_DRAIN_MS,
      MAX_RECOMMENDATION_SHUTDOWN_DRAIN_MS,
      'WORKER_SHUTDOWN_DRAIN_MS',
    ),
    healthHost,
    healthPort: boundedInteger(env['PORT'], DEFAULT_HEALTH_PORT, 1, 65_535, 'PORT'),
  });
}

function exactBoolean(value: string | undefined, name: string): boolean {
  if (value === '1') return true;
  if (value === undefined || value === '0') return false;
  throw new Error(`${name} must be absent, 0, or 1`);
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function exact(value: string | undefined, expected: string, name: string): void {
  if (value?.trim() !== expected) throw new Error(`${name} must be exactly ${expected}`);
}

function exactInteger(value: string | undefined, expected: number, name: string): void {
  if (value === undefined || value.trim() === '') return;
  if (Number(value) !== expected || !Number.isInteger(Number(value))) {
    throw new Error(`${name} must be exactly ${expected}`);
  }
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const parsed = value === undefined || value.trim() === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}
