/** Durable Marketing Stream replay and settling-state transitions. */
import { createHash } from 'node:crypto';
import {
  marketingStreamScopeKey,
  marketingStreamScopesForMessageIds,
  type DbHandle,
} from '@wizard-ads/db';
import type { MarketingStreamNormalizeJob } from '@wizard-ads/shared';
import {
  DbMarketingStreamStore,
  MarketingStreamNormalizationError,
  nextMarketingStreamTransitionAt,
  normalizeMarketingStreamSnapshot,
  type MarketingStreamNormalizationPolicy,
  type MarketingStreamStore,
} from './dayparting.js';
import {
  DbMarketingStreamRuntimeContextLoader,
  MarketingStreamConfigurationError,
  type MarketingStreamRuntimeContextLoader,
} from './marketing-stream-sqs.js';

export interface MarketingStreamNormalizeQueue {
  enqueue(
    payload: MarketingStreamNormalizeJob,
    runAt: Date,
    dedupeKey: string,
  ): Promise<boolean>;
}

export function createMarketingStreamNormalizeHandler(input: {
  handle: DbHandle;
  queue: MarketingStreamNormalizeQueue;
  now?: () => Date;
  store?: MarketingStreamStore;
  contexts?: MarketingStreamRuntimeContextLoader;
  resolveScopes?: typeof marketingStreamScopesForMessageIds;
}): (payload: MarketingStreamNormalizeJob) => Promise<Record<string, unknown>> {
  const store = input.store ?? new DbMarketingStreamStore(input.handle);
  const contexts = input.contexts ?? new DbMarketingStreamRuntimeContextLoader(input.handle);
  const resolveScopes = input.resolveScopes ?? marketingStreamScopesForMessageIds;
  const now = input.now ?? (() => new Date());

  return async (payload) => {
    const resolved = await resolveScopes(input.handle, payload);
    const observedAt = now();
    let context: Awaited<ReturnType<MarketingStreamRuntimeContextLoader['load']>>;
    try {
      context = await contexts.load(payload);
    } catch (error) {
      if (!(error instanceof MarketingStreamConfigurationError)) throw error;
      const retryAt = new Date(observedAt.getTime() + 3_600_000);
      const retryCreated = await input.queue.enqueue(
        payload,
        retryAt,
        configurationRetryDedupeKey(payload, retryAt),
      );
      return {
        requestedMessages: resolved.requestedMessages,
        foundMessages: resolved.foundMessages,
        requestedScopes: resolved.scopes.length,
        projectionDeferred: true,
        retryCreated,
      };
    }
    const policy: MarketingStreamNormalizationPolicy = { ...context, now: observedAt };
    const snapshot = await store.snapshot({
      orgId: payload.orgId,
      profileId: payload.profileId,
      scopes: resolved.scopes,
    });
    const normalized = normalizeMarketingStreamSnapshot(snapshot, policy);
    if (normalized.refusals.length > 0 || normalized.scopes.length !== resolved.scopes.length) {
      throw new MarketingStreamNormalizationError(
        `replay refused ${normalized.refusals.length} rows across `
        + `${resolved.scopes.length - normalized.scopes.length} scopes`,
      );
    }
    const projection = await store.replace({
      orgId: payload.orgId,
      profileId: payload.profileId,
      scopes: normalized.scopes,
      expectedSourceEventIds: normalized.expectedSourceEventIds,
      facts: normalized.facts,
    });
    if (
      projection.factsInserted !== normalized.facts.length
      || projection.factsReadBack !== normalized.facts.length
      || projection.scopesReplaced !== normalized.scopes.length
    ) {
      throw new MarketingStreamNormalizationError('replay projection counts do not reconcile');
    }

    const transitionAt = nextMarketingStreamTransitionAt(snapshot, policy);
    let transitionCreated = false;
    if (transitionAt !== null) {
      transitionCreated = await input.queue.enqueue(
        payload,
        transitionAt,
        transitionDedupeKey(payload, normalized.scopes.map(marketingStreamScopeKey), transitionAt),
      );
    }

    return {
      requestedMessages: resolved.requestedMessages,
      foundMessages: resolved.foundMessages,
      requestedScopes: resolved.scopes.length,
      sourceRows: snapshot.events.length,
      refusedRows: normalized.refusals.length,
      replacedScopes: projection.scopesReplaced,
      deletedFacts: projection.factsDeleted,
      insertedFacts: projection.factsInserted,
      readBackFacts: projection.factsReadBack,
      transitionScheduled: transitionAt !== null,
      transitionCreated,
    };
  };
}

function configurationRetryDedupeKey(
  payload: MarketingStreamNormalizeJob,
  retryAt: Date,
): string {
  const messages = createHash('sha256')
    .update(JSON.stringify([...payload.messageIds].sort()))
    .digest('hex');
  return `marketing-stream:configuration:${payload.profileId}:${retryAt.toISOString().slice(0, 13)}:${messages}`;
}

function transitionDedupeKey(
  payload: MarketingStreamNormalizeJob,
  scopes: readonly string[],
  transitionAt: Date,
): string {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({
      profileId: payload.profileId,
      scopes: [...scopes].sort(),
      transitionAt: transitionAt.toISOString(),
    }))
    .digest('hex');
  return `marketing-stream:transition:${fingerprint}`;
}
