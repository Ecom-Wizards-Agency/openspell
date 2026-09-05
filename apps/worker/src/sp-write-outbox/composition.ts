import type { DbHandle } from '@wizard-ads/db';
import { mergeKeywordMirror, readKeywordMirrorStart, reconcileSpWriteObservation } from '@wizard-ads/db/sp-write-worker';
import type { KeywordMirrorCapability } from '../store.js';
import { createSpWriteOutboxLoop } from './loop.js';
import { createSpWriteProviderPreparation } from './providers.js';

/** Configure on every entity-sync owner before enabling the first native bid write. */
export function createKeywordMirrorCapability(database: DbHandle): KeywordMirrorCapability {
  return { readStartedAt: () => readKeywordMirrorStart(database), merge: (request) => mergeKeywordMirror(database, request) };
}

/** Default capabilities, still inert: the activation slice alone registers and ticks this worker. */
export function createSpWriteWorker(
  database: DbHandle,
  options: Pick<Parameters<typeof createSpWriteOutboxLoop>[0], 'claimantId' | 'policy'>,
  env: NodeJS.ProcessEnv = process.env,
) {
  return createSpWriteOutboxLoop({ database, ...options,
    prepareProviders: createSpWriteProviderPreparation(database, env),
    reconcileObservation: async (observation) => {
      await reconcileSpWriteObservation(database, observation);
      // Every outcome is a durable reconciliation fact; the status projection separately
      // counts promotions, already-current values, superseded evidence and missing mirrors.
      return true;
    },
  });
}
