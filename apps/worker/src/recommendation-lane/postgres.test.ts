import { describe, expect, it } from 'vitest';
import type {
  RecommendationWorkerAuthority,
  RecommendationWorkerDatabase,
  RecommendationWorkerDatabaseOptions,
} from '@wizard-ads/db/recommendation-worker';
import type { RecommendationLaneConfig } from './config.js';
import { RecommendationHealthMonitor } from './health.js';
import { createRecommendationLaneRuntime } from './postgres.js';

const REVISION = 'a'.repeat(40);
const CONFIG: RecommendationLaneConfig = {
  databaseUrl: 'postgres://fixture.invalid/database',
  workerId: 'recommendation-runtime-fixture',
  revision: REVISION,
  role: 'evo-recommendation-lane',
  claimProtocol: 'recommendation-fenced-v1',
  jobTypes: ['recommendations.run'],
  claimBatchSize: 1,
  maxConcurrentJobs: 1,
  claimArmed: true,
  pollIntervalMs: 1_000,
  shutdownDrainMs: 25_000,
  healthHost: '127.0.0.1',
  healthPort: 3_002,
};
const AUTHORITY: RecommendationWorkerAuthority = {
  protocol: 'fenced',
  admission: 'scoped',
  epoch: 3,
  authorizedRevision: REVISION,
};

describe('recommendation lane PostgreSQL isolation', () => {
  it('reads health through a bounded independent handle while execution is blocked', async () => {
    let releaseExecution = (): void => undefined;
    let executionSettled = false;
    const executionGate = new Promise<readonly []>((resolve) => {
      releaseExecution = () => resolve([]);
    }).finally(() => { executionSettled = true; });
    let healthReads = 0;
    const executionDatabase = {
      async resumeOwned() { return executionGate; },
      async claim() { return []; },
      async close() {},
    };
    const healthDatabase = {
      async getAuthority() {
        healthReads += 1;
        return AUTHORITY;
      },
      async close() {},
    };
    const options: RecommendationWorkerDatabaseOptions[] = [];
    const databases = [executionDatabase, healthDatabase];
    const runtime = createRecommendationLaneRuntime(CONFIG, (input) => {
      options.push(input);
      return databases.shift() as unknown as RecommendationWorkerDatabase;
    });
    expect(runtime.database).not.toBe(runtime.healthDatabase);
    expect(options.map((input) => input.statementTimeoutSeconds)).toEqual([300, 3]);

    const execution = runtime.claimant.drainOnce();
    await Promise.resolve();
    const monitor = new RecommendationHealthMonitor(
      CONFIG,
      runtime.healthDatabase,
      runtime.claimant,
      AUTHORITY,
    );
    await expect(monitor.snapshot()).resolves.toMatchObject({
      body: { authority: { revisionMatches: true } },
    });
    expect(healthReads).toBe(1);
    expect(executionSettled).toBe(false);

    releaseExecution();
    await expect(execution).resolves.toBe(0);
    await runtime.close();
  });
});
