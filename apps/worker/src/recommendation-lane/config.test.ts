import { describe, expect, it } from 'vitest';
import {
  MAX_RECOMMENDATION_POLL_INTERVAL_MS,
  MAX_RECOMMENDATION_SHUTDOWN_DRAIN_MS,
  MIN_RECOMMENDATION_POLL_INTERVAL_MS,
  MIN_RECOMMENDATION_SHUTDOWN_DRAIN_MS,
  recommendationLaneConfigFromEnv,
} from './config.js';

const REVISION = 'a'.repeat(40);

function validEnv(): Record<string, string> {
  return {
    DATABASE_URL: 'postgresql://runtime@db.invalid/runtime',
    WORKER_ID: 'evo-recommendation-1',
    OPENSPELL_WORKER_REVISION: REVISION,
    WORKER_DEPLOYMENT_ROLE: 'evo-recommendation-lane',
    WORKER_CLAIM_PROTOCOL: 'recommendation-fenced-v1',
    WORKER_JOB_TYPES: 'recommendations.run',
    WORKER_CLAIM_BATCH_SIZE: '1',
    WORKER_MAX_CONCURRENT_JOBS: '1',
  };
}

describe('recommendationLaneConfigFromEnv', () => {
  it('returns an exact, frozen DB-only single-flight policy', () => {
    const config = recommendationLaneConfigFromEnv({
      ...validEnv(),
      WORKER_HEALTH_HOST: '::1',
      PORT: '4321',
      WORKER_POLL_INTERVAL_MS: '250',
      WORKER_SHUTDOWN_DRAIN_MS: '300000',
      UNRELATED_SETTING: 'ignored',
    });

    expect(config).toEqual({
      databaseUrl: validEnv().DATABASE_URL,
      workerId: 'evo-recommendation-1',
      revision: REVISION,
      role: 'evo-recommendation-lane',
      claimProtocol: 'recommendation-fenced-v1',
      jobTypes: ['recommendations.run'],
      claimBatchSize: 1,
      maxConcurrentJobs: 1,
      claimArmed: false,
      pollIntervalMs: 250,
      shutdownDrainMs: 300_000,
      healthHost: '::1',
      healthPort: 4321,
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.jobTypes)).toBe(true);
  });

  it('uses bounded operational defaults without widening custody', () => {
    const config = recommendationLaneConfigFromEnv(validEnv());
    expect(config).toMatchObject({
      pollIntervalMs: 1_000,
      shutdownDrainMs: 25_000,
      healthHost: '127.0.0.1',
      healthPort: 3_002,
      claimBatchSize: 1,
      maxConcurrentJobs: 1,
      claimArmed: false,
    });
  });

  it.each([
    ['DATABASE_URL', ''],
    ['DATABASE_URL', 'https://db.invalid'],
    ['WORKER_ID', ''],
    ['WORKER_ID', 'contains a space'],
    ['OPENSPELL_WORKER_REVISION', 'a'.repeat(39)],
    ['OPENSPELL_WORKER_REVISION', 'g'.repeat(40)],
    ['WORKER_DEPLOYMENT_ROLE', 'general'],
    ['WORKER_CLAIM_PROTOCOL', 'fenced'],
    ['WORKER_JOB_TYPES', 'recommendations.run,entity.sync'],
    ['WORKER_CLAIM_BATCH_SIZE', '2'],
    ['WORKER_MAX_CONCURRENT_JOBS', '2'],
    ['WORKER_CLAIM_ARMED', 'true'],
    ['WORKER_HEALTH_HOST', '0.0.0.0'],
    ['WORKER_HEALTH_HOST', 'localhost'],
    ['PORT', '0'],
  ])('refuses invalid %s', (name, value) => {
    expect(() => recommendationLaneConfigFromEnv({ ...validEnv(), [name]: value }))
      .toThrow();
  });

  it.each([
    ['WORKER_POLL_INTERVAL_MS', String(MIN_RECOMMENDATION_POLL_INTERVAL_MS - 1)],
    ['WORKER_POLL_INTERVAL_MS', String(MAX_RECOMMENDATION_POLL_INTERVAL_MS + 1)],
    ['WORKER_SHUTDOWN_DRAIN_MS', String(MIN_RECOMMENDATION_SHUTDOWN_DRAIN_MS - 1)],
    ['WORKER_SHUTDOWN_DRAIN_MS', String(MAX_RECOMMENDATION_SHUTDOWN_DRAIN_MS + 1)],
    ['WORKER_POLL_INTERVAL_MS', '1.5'],
  ])('refuses out-of-bound %s', (name, value) => {
    expect(() => recommendationLaneConfigFromEnv({ ...validEnv(), [name]: value }))
      .toThrow();
  });
});
