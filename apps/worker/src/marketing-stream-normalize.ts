/** Durable Marketing Stream replay and settling-state transitions. */
import { createHash } from 'node:crypto';
import {
  clearMarketingStreamProjectionBlock,
  enqueueMarketingStreamBlockedProfileRecovery,
  markMarketingStreamProjectionBlocked,
  marketingStreamBlockedRecoveryDedupeKey,
  marketingStreamScopeKey,
  marketingStreamScopesForMessageIds,
  readMarketingStreamProjectionBlock,
  type DbHandle,
  type MarketingStreamProjectionBlock,
  type MarketingStreamProjectionBlockCompletion,
  type MarketingStreamScope,
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

const CONFIGURATION_RETRY_LIMIT = 24;

interface MarketingStreamProjectionBlockStore {
  mark(input: {
    orgId: string;
    profileId: string;
    scopes: readonly MarketingStreamScope[];
    blockedAt: Date;
    retryAttempt: number;
    retryLimit: number;
    reason: string;
  }): Promise<MarketingStreamProjectionBlock>;
  read(input: { orgId: string; profileId: string }): Promise<MarketingStreamProjectionBlock | null>;
  clear(input: {
    orgId: string;
    profileId: string;
    expectedBlockToken: string;
    processedScopes: readonly MarketingStreamScope[];
  }): Promise<MarketingStreamProjectionBlockCompletion>;
}

export function createMarketingStreamNormalizeHandler(input: {
  handle: DbHandle;
  queue: MarketingStreamNormalizeQueue;
  now?: () => Date;
  store?: MarketingStreamStore;
  contexts?: MarketingStreamRuntimeContextLoader;
  resolveScopes?: typeof marketingStreamScopesForMessageIds;
  blocks?: MarketingStreamProjectionBlockStore;
}): (payload: MarketingStreamNormalizeJob) => Promise<Record<string, unknown>> {
  const store = input.store ?? new DbMarketingStreamStore(input.handle);
  const contexts = input.contexts ?? new DbMarketingStreamRuntimeContextLoader(input.handle);
  const resolveScopes = input.resolveScopes ?? marketingStreamScopesForMessageIds;
  const blocks: MarketingStreamProjectionBlockStore = input.blocks ?? {
    mark: (block) => markMarketingStreamProjectionBlocked(input.handle, block),
    read: (scope) => readMarketingStreamProjectionBlock(input.handle, scope),
    clear: (scope) => clearMarketingStreamProjectionBlock(input.handle, scope),
  };
  const now = input.now ?? (() => new Date());

  return async (payload) => {
    const resolved = payload.messageIds.length === 0
      ? { requestedMessages: 0, foundMessages: 0, scopes: [] }
      : await resolveScopes(input.handle, payload);
    const observedAt = now();
    let context: Awaited<ReturnType<MarketingStreamRuntimeContextLoader['load']>>;
    try {
      context = await contexts.load(payload);
    } catch (error) {
      if (!(error instanceof MarketingStreamConfigurationError)) throw error;
      const block = await blocks.mark({
        orgId: payload.orgId,
        profileId: payload.profileId,
        scopes: resolved.scopes,
        blockedAt: observedAt,
        retryAttempt: payload.configurationRetryAttempt ?? 0,
        retryLimit: CONFIGURATION_RETRY_LIMIT,
        reason: error.message,
      });
      const nextAttempt = block.retryCount + 1;
      const retryAt = new Date(observedAt.getTime() + 3_600_000);
      const retryCreated = nextAttempt <= CONFIGURATION_RETRY_LIMIT
        ? await input.queue.enqueue(
            { ...payload, configurationRetryAttempt: nextAttempt },
            retryAt,
            configurationRetryDedupeKey(payload, retryAt),
          )
        : false;
      return {
        requestedMessages: resolved.requestedMessages,
        foundMessages: resolved.foundMessages,
        requestedScopes: resolved.scopes.length,
        projectionDeferred: true,
        retryCreated,
        configurationRetryAttempt: block.retryCount,
        configurationRetryLimit: CONFIGURATION_RETRY_LIMIT,
        alertRequired: block.alertState === 'alerted',
        blockedScopes: block.scopes.length,
      };
    }
    const policy: MarketingStreamNormalizationPolicy = { ...context, now: observedAt };
    const blocked = await blocks.read(payload);
    const replayScopes = uniqueScopes([
      ...resolved.scopes,
      ...(blocked?.scopes ?? []),
    ]);
    const snapshot = await store.snapshot({
      orgId: payload.orgId,
      profileId: payload.profileId,
      scopes: replayScopes,
    });
    const normalized = normalizeMarketingStreamSnapshot(snapshot, policy);
    if (normalized.refusals.length > 0 || normalized.scopes.length !== replayScopes.length) {
      throw new MarketingStreamNormalizationError(
        `replay refused ${normalized.refusals.length} rows across `
        + `${replayScopes.length - normalized.scopes.length} scopes`,
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
    const completion = blocked === null ? null : await blocks.clear({
      orgId: payload.orgId,
      profileId: payload.profileId,
      expectedBlockToken: blocked.blockToken,
      processedScopes: blocked.scopes,
    });
    const recoveryCreated = completion !== null && completion.matched && completion.remainingScopes > 0
      ? await input.queue.enqueue(
          { type: 'marketing_stream.normalize', orgId: payload.orgId, profileId: payload.profileId,
            messageIds: [], replayBlockedProfile: true },
          observedAt,
          marketingStreamBlockedRecoveryDedupeKey(
            payload.orgId, payload.profileId, blocked!.blockToken, completion.remainingScopes,
          ),
        )
      : false;

    const transitionAt = nextMarketingStreamTransitionAt(snapshot, policy);
    let transitionCreated = false;
    if (transitionAt !== null) {
      const transitionPayload: MarketingStreamNormalizeJob = {
        type: 'marketing_stream.normalize',
        orgId: payload.orgId,
        profileId: payload.profileId,
        messageIds: [...new Set(snapshot.events.map((event) => event.messageId))].sort(),
      };
      transitionCreated = await input.queue.enqueue(
        transitionPayload,
        transitionAt,
        transitionDedupeKey(
          transitionPayload,
          normalized.scopes.map(marketingStreamScopeKey),
          transitionAt,
        ),
      );
    }

    return {
      requestedMessages: resolved.requestedMessages,
      foundMessages: resolved.foundMessages,
      requestedScopes: replayScopes.length,
      recoveredBlockedScopes: blocked?.scopes.length ?? 0,
      blockedProjectionCleared: completion?.cleared ?? false,
      blockedProjectionMatched: completion?.matched ?? false,
      remainingBlockedScopes: completion?.remainingScopes ?? 0,
      recoveryCreated,
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

/** Explicit recovery entrypoint for an alerted quiet profile with no new Stream traffic. */
export async function requeueMarketingStreamBlockedProfile(input: {
  handle: DbHandle;
  orgId: string;
  profileId: string;
  runAt?: Date;
  enqueueRecovery?: typeof enqueueMarketingStreamBlockedProfileRecovery;
}) {
  return (input.enqueueRecovery ?? enqueueMarketingStreamBlockedProfileRecovery)(input.handle, {
    orgId: input.orgId, profileId: input.profileId, runAt: input.runAt ?? new Date(),
  });
}

function configurationRetryDedupeKey(
  payload: MarketingStreamNormalizeJob,
  retryAt: Date,
): string {
  return [
    'marketing-stream:configuration',
    payload.orgId,
    payload.profileId,
    retryAt.toISOString().slice(0, 13),
  ].join(':');
}

function uniqueScopes(scopes: readonly MarketingStreamScope[]): MarketingStreamScope[] {
  const byKey = new Map(scopes.map((scope) => [marketingStreamScopeKey(scope), scope]));
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, scope]) => scope);
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
