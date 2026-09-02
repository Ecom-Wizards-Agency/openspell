import {
  RecommendationWorkerDatabase,
  type RecommendationWorkerDatabaseOptions,
} from '@wizard-ads/db/recommendation-worker';
import {
  createRecommendationsRunner,
  FencedRecommendationRunStore,
  type RecommendationRunResult,
} from '../recommendations-run.js';
import { RecommendationClaimant } from './claimant.js';
import type { RecommendationLaneConfig } from './config.js';

export interface RecommendationLaneRuntime {
  database: RecommendationWorkerDatabase;
  healthDatabase: RecommendationWorkerDatabase;
  claimant: RecommendationClaimant<RecommendationRunResult>;
  close(): Promise<void>;
}

export type RecommendationWorkerDatabaseFactory = (
  options: RecommendationWorkerDatabaseOptions,
) => RecommendationWorkerDatabase;

/** Compose the lane without importing the broad service-role worker/store. */
export function createRecommendationLaneRuntime(
  config: RecommendationLaneConfig,
  createDatabase: RecommendationWorkerDatabaseFactory =
    (options) => new RecommendationWorkerDatabase(options),
): RecommendationLaneRuntime {
  const database = createDatabase({
    connectionString: config.databaseUrl,
    workerId: config.workerId,
    revision: config.revision,
    statementTimeoutSeconds: 300,
  });
  // Health must never queue behind a multi-minute input or completion RPC.
  const healthDatabase = createDatabase({
    connectionString: config.databaseUrl,
    workerId: config.workerId,
    revision: config.revision,
    statementTimeoutSeconds: 3,
  });
  const store = new FencedRecommendationRunStore(database);
  const execute = createRecommendationsRunner(store);
  const claimant = new RecommendationClaimant({
    identity: { workerId: config.workerId, revision: config.revision },
    queue: database,
    execute,
    pollIntervalMs: config.pollIntervalMs,
    shutdownDrainMs: config.shutdownDrainMs,
  });
  return {
    database,
    healthDatabase,
    claimant,
    close: async () => {
      await Promise.all([database.close(), healthDatabase.close()]);
    },
  };
}
