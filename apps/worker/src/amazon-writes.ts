import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { SP_WRITE_BATCH_SIZE } from '@wizard-ads/ads-api';
import {
  getAmazonWriteInversePreview,
  listAmazonWriteObservationRows,
  markAmazonWriteRowsDispatched,
  prepareAmazonWriteExecution,
  recheckAmazonWriteCurrentState,
  recordAmazonWriteObservations,
  recordAmazonWriteOutcomes,
  releaseAmazonWriteExecutionForRetry,
  refuseAmazonWriteExecution,
  type AmazonWriteObservation,
  type AmazonWriteRowOutcome,
  type DbHandle,
} from '@wizard-ads/db';
import {
  AmazonWriteProviderEvidence,
  AmazonWriteProviderCallEvidence,
  BoundedAmazonWriteAuthorization,
  type AmazonApplyJob,
  type AmazonObserveJob,
  type AmazonWriteAccounting,
  type AmazonWriteAction,
  type BoundedAmazonWriteAuthorization as BoundedAuthorization,
  type CampaignWriteContext,
  type EntityRow,
} from '@wizard-ads/shared';
import type {
  AdsProfileContext,
  SpWriteClient,
  SpWriteObservationRequest,
} from './ads-api.js';
import {
  SpWriteAmbiguousError,
  SpWriteFailedError,
  SpWriteRetryableError,
} from './ads-api.js';
import { PostgresWorkerStore, type WorkerStore } from './store.js';

const OBSERVATION_DELAYS_SECONDS = [15, 60, 300, 900, 1_800] as const;
const LONG_TAIL_OBSERVATION_ATTEMPT = OBSERVATION_DELAYS_SECONDS.length + 1;
// Covers two complete ~51.5-minute observation windows (forward + inverse),
// plus bounded queue, Retry-After, and provider-call delay. Forward dispatch
// fails closed when either approval or operator authorization lacks this runway.
export const MINIMUM_FORWARD_REVERSAL_RUNWAY_MS = 4 * 60 * 60_000;
export const MINIMUM_INVERSE_OBSERVATION_RUNWAY_MS = 2 * 60 * 60_000;
// Longer than the Ads client timeout and its maximum honored Retry-After.
const WRITE_DISPATCH_LEASE_MS = 5 * 60_000;

export async function loadBoundedAmazonWriteAuthorization(
  path: string | undefined,
): Promise<BoundedAuthorization | null> {
  if (path === undefined) return null;
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  return BoundedAmazonWriteAuthorization.parse(parsed);
}

export interface AmazonWriteRuntimeOptions {
  enabled: boolean;
  loadAuthorization: () => Promise<BoundedAuthorization | null>;
  provider: SpWriteClient;
  store: AmazonWriteRuntimeStore;
  now?: () => Date;
}

export interface AmazonWriteRuntimeStore {
  prepare(input: {
    orgId: string;
    profileId: string;
    executionId: string;
    now: Date;
    maxConcurrentMutations: number;
    authorizationId: string | null;
    authorizationSha256: string | null;
    maxRowsPerExecution: number;
    maxTotalExecutions: number;
    dispatchLeaseToken: string;
    dispatchLeaseExpiresAt: Date;
  }): ReturnType<typeof prepareAmazonWriteExecution>;
  refuse(input: {
    orgId: string;
    profileId: string;
    executionId: string;
    reason: string;
  }): Promise<AmazonWriteAccounting>;
  releaseForRetry(input: {
    orgId: string;
    profileId: string;
    executionId: string;
    leaseToken: string;
    rowIds: readonly string[];
    callId: string;
    callEvidence: AmazonWriteProviderCallEvidence;
  }): Promise<void>;
  markDispatched(input: {
    orgId: string;
    profileId: string;
    executionId: string;
    leaseToken: string;
    rowIds: readonly string[];
    callId: string;
    providerOperation: AmazonWriteAction['actionType'];
    requestFingerprint: string;
    requestedEntityIds: readonly string[];
    authorizationId: string;
    authorizationSha256: string;
    leaseExpiresAt: Date;
    minimumExecutionExpiresAt: Date;
  }): Promise<boolean>;
  recheckCurrentState(input: {
    orgId: string;
    profileId: string;
    executionId: string;
    leaseToken: string;
    rowIds: readonly string[];
  }): Promise<boolean>;
  recordOutcomes(input: {
    orgId: string;
    profileId: string;
    executionId: string;
    callId: string;
    callEvidence: AmazonWriteProviderCallEvidence;
    attemptedAt: Date;
    outcomes: readonly AmazonWriteRowOutcome[];
  }): ReturnType<typeof recordAmazonWriteOutcomes>;
  observationRows(input: {
    orgId: string;
    profileId: string;
    executionId: string;
    generation: string;
  }): ReturnType<typeof listAmazonWriteObservationRows>;
  syncEntities(profile: AdsProfileContext, entities: readonly EntityRow[]): Promise<{
    listed: number;
    upserted: number;
  }>;
  resolveObservation(input: {
    orgId: string;
    profileId: string;
    actions: readonly { writeRowId: string; action: AmazonWriteAction; rowStatus: string }[];
    observedRows: readonly EntityRow[];
    finalAttempt: boolean;
  }): Promise<AmazonWriteObservation[]>;
  recordObservations(input: {
    orgId: string;
    profileId: string;
    executionId: string;
    generation: string;
    observedAt: Date;
    attempt: number;
    nextObservationAt: Date | null;
    observations: readonly AmazonWriteObservation[];
  }): ReturnType<typeof recordAmazonWriteObservations>;
  enqueue(payload: AmazonObserveJob | AmazonApplyJob, runAt: Date, dedupeKey: string): Promise<boolean>;
}

export class PostgresAmazonWriteStore implements AmazonWriteRuntimeStore {
  private readonly workerStore: PostgresWorkerStore;

  constructor(private readonly handle: DbHandle, workerStore?: PostgresWorkerStore) {
    this.workerStore = workerStore ?? new PostgresWorkerStore(handle);
  }

  prepare(input: Parameters<AmazonWriteRuntimeStore['prepare']>[0]) {
    return prepareAmazonWriteExecution(this.handle, input);
  }

  refuse(input: Parameters<AmazonWriteRuntimeStore['refuse']>[0]) {
    return refuseAmazonWriteExecution(this.handle, input);
  }

  releaseForRetry(input: Parameters<AmazonWriteRuntimeStore['releaseForRetry']>[0]) {
    return releaseAmazonWriteExecutionForRetry(this.handle, input);
  }

  markDispatched(input: Parameters<AmazonWriteRuntimeStore['markDispatched']>[0]) {
    return markAmazonWriteRowsDispatched(this.handle, input);
  }

  recheckCurrentState(input: Parameters<AmazonWriteRuntimeStore['recheckCurrentState']>[0]) {
    return recheckAmazonWriteCurrentState(this.handle, input);
  }

  recordOutcomes(input: Parameters<AmazonWriteRuntimeStore['recordOutcomes']>[0]) {
    return recordAmazonWriteOutcomes(this.handle, input);
  }

  observationRows(input: Parameters<AmazonWriteRuntimeStore['observationRows']>[0]) {
    return listAmazonWriteObservationRows(this.handle, input);
  }

  async syncEntities(profile: AdsProfileContext, entities: readonly EntityRow[]) {
    return this.workerStore.syncEntities(profile, entities, { adProduct: 'SP', full: false });
  }

  async resolveObservation(
    input: Parameters<AmazonWriteRuntimeStore['resolveObservation']>[0],
  ): Promise<AmazonWriteObservation[]> {
    return classifyAmazonWriteObservations(input);
  }

  recordObservations(input: Parameters<AmazonWriteRuntimeStore['recordObservations']>[0]) {
    return recordAmazonWriteObservations(this.handle, input);
  }

  enqueue(payload: AmazonObserveJob | AmazonApplyJob, runAt: Date, dedupeKey: string): Promise<boolean> {
    return this.workerStore.enqueue(payload, runAt, dedupeKey);
  }
}

export function classifyAmazonWriteObservations(
  input: Parameters<AmazonWriteRuntimeStore['resolveObservation']>[0],
): AmazonWriteObservation[] {
    const observedByEntity = new Map(input.observedRows.map((row) => [
      `${row.entityType}:${row.amazonId}`, row,
    ] as const));
    const placementCampaigns = [...new Set(input.actions
      .filter((row) => row.action.actionType === 'sp_campaign_placement')
      .map((row) => row.action.amazonEntityId))];
    const expectedContextByCampaign = new Map<string, CampaignWriteContext>();
    for (const campaignId of placementCampaigns) {
      const actions = input.actions.filter((row): row is typeof row & {
        action: Extract<AmazonWriteAction, { actionType: 'sp_campaign_placement' }>;
      } => row.action.actionType === 'sp_campaign_placement' && row.action.amazonEntityId === campaignId);
      const first = actions[0];
      if (!first) continue;
      expectedContextByCampaign.set(campaignId, placementProviderStateAfter(first.action.campaignContext.providerState, actions));
    }
    return input.actions.map((row) => {
      const { action } = row;
      const entityType = action.actionType === 'sp_campaign_placement' ? 'campaign'
        : action.actionType === 'sp_keyword_bid' ? 'keyword' : 'target';
      const providerRow = observedByEntity.get(`${entityType}:${action.amazonEntityId}`);
      if (!providerRow) {
        return {
          writeRowId: row.writeRowId,
          state: input.finalAttempt ? 'conflict' : 'pending',
          currentValue: null,
        };
      }
      const contextObserved = action.actionType === 'sp_campaign_placement'
        ? isDeepStrictEqual(
          providerRow.entityType === 'campaign' ? providerRow.campaignWriteContext ?? null : null,
          expectedContextByCampaign.get(action.amazonEntityId) ?? null,
        )
        : null;
      const currentValue = action.actionType === 'sp_campaign_placement'
        ? (providerRow.entityType === 'campaign'
            ? providerRow.placementBidding?.[
                action.field === 'top_of_search' ? 'topOfSearch'
                  : action.field === 'product_pages' ? 'productPages' : 'restOfSearch'
              ] ?? null
            : null)
        : action.actionType === 'sp_keyword_bid'
          ? (providerRow.entityType === 'keyword' ? providerRow.bid : null)
          : (providerRow.entityType === 'target' ? providerRow.bid : null);
      const observed = contextObserved ?? (typeof currentValue === 'number'
        && Object.is(currentValue, action.requestedValue));
      const stillOriginal = action.actionType === 'sp_campaign_placement'
        ? isDeepStrictEqual(
          providerRow.entityType === 'campaign' ? providerRow.campaignWriteContext ?? null : null,
          action.campaignContext.providerState,
        )
        : typeof currentValue === 'number' && Object.is(currentValue, action.expectedValue);
      return {
        writeRowId: row.writeRowId,
        state: observed ? 'observed'
          : row.rowStatus === 'dispatched' && stillOriginal && input.finalAttempt ? 'not_applied'
            : input.finalAttempt ? 'conflict' : 'pending',
        currentValue,
      };
    });
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

/** Stable across harmless JSON array reordering; binds every authorization rule. */
export function boundedAmazonWriteAuthorizationFingerprint(
  authorization: BoundedAuthorization,
): string {
  const profiles = authorization.profiles
    .map((profile) => ({
      ...profile,
      allowed_entities: [...profile.allowed_entities].sort((left, right) =>
        `${left.action_type}:${left.amazon_entity_id}:${left.field}`
          .localeCompare(`${right.action_type}:${right.amazon_entity_id}:${right.field}`)),
    }))
    .sort((left, right) => `${left.org_id}:${left.profile_id}`.localeCompare(`${right.org_id}:${right.profile_id}`));
  return createHash('sha256').update(JSON.stringify({ ...authorization, profiles })).digest('hex');
}

function allowedProfile(profile: AdsProfileContext, authorization: BoundedAuthorization) {
  if (!profile.accountName || !profile.countryCode) return false;
  return authorization.profiles.find((allowed) =>
    allowed.org_id === profile.orgId
      && allowed.profile_id === profile.id
      && normalized(allowed.account_label) === normalized(profile.accountName ?? '')
      && normalized(allowed.marketplace) === normalized(profile.countryCode ?? ''),
  ) ?? null;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'provider mutation failed';
  return message
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[A-Za-z0-9_=-]{40,}/g, '[redacted]')
    .trim()
    .slice(0, 512);
}

function fingerprint(executionId: string, writeRowId: string, attempt: number, action: AmazonWriteAction): string {
  return createHash('sha256')
    .update(JSON.stringify({ executionId, writeRowId, attempt, action }))
    .digest('hex');
}

function outcomeFor(
  executionId: string,
  row: { writeRowId: string; attemptNumber: number; action: AmazonWriteAction },
  evidence: AmazonWriteProviderEvidence,
): AmazonWriteRowOutcome {
  return {
    writeRowId: row.writeRowId,
    attemptNumber: row.attemptNumber,
    requestFingerprint: fingerprint(executionId, row.writeRowId, row.attemptNumber, row.action),
    evidence,
  };
}

function failureEvidence(error: unknown, outcome: 'failed' | 'ambiguous'): AmazonWriteProviderEvidence {
  return AmazonWriteProviderEvidence.parse({
    outcome,
    providerEntityId: null,
    code: error instanceof Error ? error.name.slice(0, 160) : 'ProviderError',
    message: safeMessage(error),
  });
}

function placementName(field: Extract<AmazonWriteAction, { actionType: 'sp_campaign_placement' }>['field']) {
  if (field === 'top_of_search') return 'PLACEMENT_TOP' as const;
  if (field === 'product_pages') return 'PLACEMENT_PRODUCT_PAGE' as const;
  return 'PLACEMENT_REST_OF_SEARCH' as const;
}

function placementProviderStateAfter(
  initial: CampaignWriteContext,
  rows: readonly { action: Extract<AmazonWriteAction, { actionType: 'sp_campaign_placement' }> }[],
): CampaignWriteContext {
  let providerState = initial;
  for (const row of rows) {
    const placement = placementName(row.action.field);
    let found = false;
    const placementBidding = providerState.placementBidding.map((entry) => {
      if (entry.placement !== placement) return entry;
      found = true;
      return { ...entry, percentage: row.action.requestedValue };
    });
    if (!found) placementBidding.push({ placement, percentage: row.action.requestedValue });
    placementBidding.sort((left, right) => left.placement.localeCompare(right.placement));
    providerState = { ...providerState, placementBidding };
  }
  return providerState;
}

const AMAZON_STRATEGY = {
  legacy_for_sales: 'LEGACY_FOR_SALES',
  auto_for_sales: 'AUTO_FOR_SALES',
  manual: 'MANUAL',
  rule_based: 'RULE_BASED',
} as const;

export class GuardedAmazonWriteRuntime {
  private readonly enabled: boolean;
  private readonly loadAuthorization: () => Promise<BoundedAuthorization | null>;
  private readonly provider: SpWriteClient;
  private readonly store: AmazonWriteRuntimeStore;
  private readonly now: () => Date;

  constructor(options: AmazonWriteRuntimeOptions) {
    this.enabled = options.enabled;
    this.loadAuthorization = options.loadAuthorization;
    this.provider = options.provider;
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
  }

  async apply(payload: AmazonApplyJob, profile: AdsProfileContext): Promise<Record<string, unknown>> {
    const initial = await this.authorized(profile);
    if ('reason' in initial) {
      const accounting = await this.store.refuse({ ...payload, executionId: payload.executionId, reason: initial.reason });
      return { status: 'refused', ...accounting, amazonApiCalls: 0 };
    }
    const authorization = initial.authorization;
    const allowed = initial.allowed;
    const authorizationSha256 = boundedAmazonWriteAuthorizationFingerprint(authorization);
    const now = this.now();
    const leaseToken = randomUUID();
    const prepared = await this.store.prepare({
      orgId: payload.orgId,
      profileId: payload.profileId,
      executionId: payload.executionId,
      now,
      maxConcurrentMutations: authorization.constraints.max_concurrent_mutations,
      authorizationId: authorization.authorization_id,
      authorizationSha256,
      maxRowsPerExecution: authorization.constraints.max_rows_per_execution,
      maxTotalExecutions: authorization.constraints.max_total_executions,
      dispatchLeaseToken: leaseToken,
      dispatchLeaseExpiresAt: new Date(now.getTime() + WRITE_DISPATCH_LEASE_MS),
    });
    if (prepared.recoveryObservation) {
      return {
        status: 'awaiting_sync', requested: prepared.requested, replayed: true,
        amazonApiCalls: 0, observationEnqueued: true, recoveryObservation: true,
      };
    }
    if (prepared.rows.length === 0) {
      if (prepared.status === 'running' && prepared.replayed) {
        throw new SpWriteRetryableError(
          'Amazon write execution is held by a live pre-dispatch lease',
          prepared.retryAfterSeconds,
          0,
        );
      }
      return {
        status: prepared.status,
        requested: prepared.requested,
        replayed: prepared.replayed,
        amazonApiCalls: 0,
      };
    }
    if (prepared.expiresAt.getTime() <= now.getTime()) {
      const accounting = await this.store.refuse({ ...payload, reason: 'approval expired before execution' });
      return { status: 'refused', ...accounting, amazonApiCalls: 0 };
    }
    const boundedRefusal = this.boundedRefusal(
      prepared.rows, prepared.direction, prepared.inversePreapproved, authorization, allowed,
    );
    const initialRefusal = boundedRefusal ?? this.reversalRunwayRefusal(
      prepared.direction,
      prepared.expiresAt,
      authorization,
      now,
    );
    if (initialRefusal !== null) {
      const accounting = await this.store.refuse({ ...payload, reason: initialRefusal });
      return { status: 'refused', ...accounting, amazonApiCalls: 0 };
    }

    let amazonApiCalls = 0;
    const freshnessRequest = this.observationRequest(prepared.rows);
    const freshness = await this.provider.observeSpWriteEntities(profile, freshnessRequest);
    amazonApiCalls += freshness.apiCalls;
    if (!this.isExactObservationResult(freshnessRequest, freshness)) {
      const accounting = await this.store.refuse({
        ...payload,
        reason: 'targeted Amazon freshness response omitted or changed an exact entity identity',
      });
      return { status: 'refused', ...accounting, amazonApiCalls };
    }
    const freshnessSync = await this.store.syncEntities(profile, freshness.rows);
    if (freshnessSync.listed !== freshness.rows.length
      || freshnessSync.upserted !== freshness.rows.length) {
      throw new Error(`targeted pre-dispatch sync offered ${freshness.rows.length} rows but upserted ${freshnessSync.upserted}`);
    }
    const fresh = await this.store.recheckCurrentState({
      orgId: payload.orgId,
      profileId: payload.profileId,
      executionId: payload.executionId,
      leaseToken,
      rowIds: prepared.rows.map((row) => row.writeRowId),
    });
    if (!fresh) {
      const accounting = await this.store.refuse({
        ...payload,
        reason: 'targeted Amazon refresh changed synchronized state before mutation',
      });
      return { status: 'refused', ...accounting, amazonApiCalls };
    }
    let retryRequested = false;
    let retryAfterSeconds: number | undefined;
    let shouldObserve = false;
    let latestAccounting: AmazonWriteAccounting | null = null;
    let latestStatus = prepared.status;
    let durableObservation = false;
    const groups = this.providerGroups(profile, prepared.rows);
    for (const group of groups) {
      const refreshed = await this.authorized(profile);
      const refreshedRefusal = 'reason' in refreshed
        ? refreshed.reason
        : (refreshed.authorization.authorization_id !== authorization.authorization_id
          || boundedAmazonWriteAuthorizationFingerprint(refreshed.authorization) !== authorizationSha256)
          ? 'bounded Amazon write authorization was replaced during execution'
          : this.boundedRefusal(
              group.rows, prepared.direction, prepared.inversePreapproved,
              refreshed.authorization, refreshed.allowed,
            ) ?? this.reversalRunwayRefusal(
              prepared.direction,
              prepared.expiresAt,
              refreshed.authorization,
              this.now(),
            );
      if (refreshedRefusal !== null) {
        latestAccounting = await this.store.refuse({ ...payload, reason: refreshedRefusal });
        latestStatus = latestAccounting.succeeded > 0 ? 'partial' : 'refused';
        shouldObserve ||= latestAccounting.resyncRequested > latestAccounting.resynchronized;
        break;
      }
      const dispatchedAt = this.now();
      const callId = randomUUID();
      const requestFingerprint = createHash('sha256').update(JSON.stringify({
        executionId: prepared.executionId,
        callId,
        providerOperation: group.providerOperation,
        entityIds: group.expectedEntityIds,
        actions: group.rows.map((row) => row.action),
      })).digest('hex');
      const dispatched = await this.store.markDispatched({
        orgId: payload.orgId, profileId: payload.profileId,
        executionId: payload.executionId, leaseToken,
        rowIds: group.rows.map((row) => row.writeRowId), callId,
        providerOperation: group.providerOperation, requestFingerprint,
        requestedEntityIds: group.expectedEntityIds,
        authorizationId: authorization.authorization_id, authorizationSha256,
        leaseExpiresAt: new Date(dispatchedAt.getTime() + WRITE_DISPATCH_LEASE_MS),
        minimumExecutionExpiresAt: new Date(
          dispatchedAt.getTime() + this.minimumRunway(prepared.direction),
        ),
      });
      if (!dispatched) {
        latestAccounting = await this.store.refuse({
          ...payload,
          reason: 'current synchronized state changed at final dispatch',
        });
        latestStatus = latestAccounting.succeeded > 0 ? 'partial' : 'refused';
        shouldObserve ||= latestAccounting.resyncRequested > latestAccounting.resynchronized;
        break;
      }
      durableObservation = true;
      let providerResult: Awaited<ReturnType<typeof group.run>> | null = null;
      let providerError: unknown = null;
      try {
        providerResult = await group.run();
      } catch (error) {
        providerError = error;
      }
      if (providerError !== null) {
        const providerCalls = providerError instanceof SpWriteRetryableError
          || providerError instanceof SpWriteAmbiguousError
          || providerError instanceof SpWriteFailedError
          ? providerError.apiCalls : 1;
        amazonApiCalls += providerCalls;
        const callEvidence = this.providerErrorCallEvidence(providerError, group.providerRows.length);
        if (providerError instanceof SpWriteRetryableError) {
          await this.store.releaseForRetry({
            ...payload, leaseToken, callId, callEvidence,
            rowIds: group.rows.map((row) => row.writeRowId),
          });
          retryRequested = true;
          retryAfterSeconds = providerError.retryAfterSeconds;
          break;
        }
        const ambiguous = providerError instanceof SpWriteAmbiguousError
          || !(providerError instanceof SpWriteFailedError);
        const evidence = failureEvidence(providerError, ambiguous ? 'ambiguous' : 'failed');
        const outcomes = group.rows.map((row) => outcomeFor(
          prepared.executionId, row, evidence,
        ));
        const recorded = await this.store.recordOutcomes({
          orgId: payload.orgId, profileId: payload.profileId,
          executionId: payload.executionId, callId, callEvidence,
          attemptedAt: this.now(), outcomes,
        });
        shouldObserve ||= recorded.shouldObserve;
        latestAccounting = recorded.accounting;
        latestStatus = recorded.status;
        if (ambiguous) {
          latestAccounting = await this.store.refuse({
            ...payload,
            reason: 'later rows refused after an ambiguous Amazon mutation outcome',
          });
          break;
        }
        continue;
      }

      if (providerResult === null) throw new Error('Amazon mutation returned no result');
      amazonApiCalls += providerResult.apiCalls;
      let evidences = providerResult.evidence;
      try {
        if (providerResult.apiCalls !== 1) {
          throw new SpWriteAmbiguousError('one durable provider call must make exactly one HTTP request', 0);
        }
        if (evidences.length !== group.providerRows.length) {
          throw new SpWriteAmbiguousError(
            `provider accounted for ${evidences.length} of ${group.providerRows.length} mutations`,
            0,
          );
        }
        evidences.forEach((evidence, index) => {
          if (evidence.outcome === 'accepted'
            && evidence.providerEntityId !== group.expectedEntityIds[index]) {
            throw new SpWriteAmbiguousError('provider returned a different entity identity', 0);
          }
        });
      } catch (error) {
        evidences = group.providerRows.map(() => failureEvidence(error, 'ambiguous'));
      }
      const callEvidence = this.providerResultCallEvidence(evidences);
      const outcomes = group.expandEvidence(evidences).map(({ row, evidence }) =>
        outcomeFor(prepared.executionId, row, evidence),
      );
      // Deliberately outside the provider try/catch: a persistence failure after
      // Amazon answered leaves the durable dispatch ambiguous and observation-led.
      const recorded = await this.store.recordOutcomes({
        orgId: payload.orgId, profileId: payload.profileId,
        executionId: payload.executionId, callId, callEvidence,
        attemptedAt: this.now(), outcomes,
      });
      shouldObserve ||= recorded.shouldObserve;
      latestAccounting = recorded.accounting;
      latestStatus = recorded.status;
      if (evidences.some((evidence) => evidence.outcome === 'ambiguous')) {
        latestAccounting = await this.store.refuse({
          ...payload,
          reason: 'later rows refused after an ambiguous Amazon mutation result',
        });
        latestStatus = latestAccounting.succeeded > 0 ? 'partial' : 'awaiting_sync';
        break;
      }
    }
    if (retryRequested) {
      throw new SpWriteRetryableError(
        'Amazon rejected the mutation before applying it',
        retryAfterSeconds,
        amazonApiCalls,
      );
    }
    return {
      status: shouldObserve ? 'awaiting_sync' : latestStatus,
      ...(latestAccounting ?? {}),
      amazonApiCalls,
      observationEnqueued: shouldObserve || durableObservation,
    };
  }

  async observe(payload: AmazonObserveJob, profile: AdsProfileContext): Promise<Record<string, unknown>> {
    const rows = await this.store.observationRows(payload);
    if (rows.length === 0) {
      return { status: 'settled', requested: 0, amazonApiCalls: 0, replayed: true };
    }
    const request = this.observationRequest(rows);
    const expectedEntities = request.keywordIds.length + request.targetIds.length + request.campaignIds.length;
    let observed: Awaited<ReturnType<SpWriteClient['observeSpWriteEntities']>> | null = null;
    let observationError: unknown = null;
    try {
      observed = await this.provider.observeSpWriteEntities(profile, request);
    } catch (error) {
      observationError = error;
    }
    const identityComplete = observed !== null && this.isExactObservationResult(request, observed);
    const trustedRows = identityComplete && observed !== null ? observed.rows : [];
    const synced = trustedRows.length === 0
      ? { listed: 0, upserted: 0 }
      : await this.store.syncEntities(profile, trustedRows);
    if (synced.listed !== trustedRows.length || synced.upserted !== trustedRows.length) {
      throw new Error(`targeted sync offered ${trustedRows.length} rows but upserted ${synced.upserted}`);
    }
    const finalAttempt = payload.attempt >= OBSERVATION_DELAYS_SECONDS.length;
    const classifications = await this.store.resolveObservation({
      orgId: payload.orgId, profileId: payload.profileId, actions: rows,
      observedRows: trustedRows, finalAttempt,
    });
    const recorded = await this.store.recordObservations({
      orgId: payload.orgId, profileId: payload.profileId,
      executionId: payload.executionId, observedAt: this.now(),
      generation: payload.generation, attempt: payload.attempt,
      nextObservationAt: this.nextObservationAt(payload.attempt, this.now()),
      observations: classifications,
    });
    return {
      status: recorded.status,
      ...recorded.accounting,
      pending: recorded.pending,
      inverseReady: recorded.inverseReady,
      targetedEntities: expectedEntities,
      returnedEntities: observed?.returned ?? 0,
      upsertedEntities: synced.upserted,
      observationIdentityComplete: identityComplete,
      ...(observationError === null ? {} : { observationError: safeMessage(observationError) }),
      amazonApiCalls: observed?.apiCalls ?? 1,
      requeued: recorded.observationRequeued,
      applyRequeued: recorded.applyRequeued,
    };
  }

  private async authorized(profile: AdsProfileContext): Promise<
    { authorization: BoundedAuthorization; allowed: BoundedAuthorization['profiles'][number] }
    | { reason: string }
  > {
    if (!this.enabled) return { reason: 'deployment Amazon write gate is disabled' };
    let authorization: BoundedAuthorization | null;
    try {
      authorization = await this.loadAuthorization();
    } catch {
      return { reason: 'bounded Amazon write authorization could not be reloaded' };
    }
    if (authorization === null) return { reason: 'bounded Amazon write authorization is missing' };
    if (new Date(authorization.expires_at).getTime() <= this.now().getTime()) {
      return { reason: 'bounded Amazon write authorization expired' };
    }
    const allowed = allowedProfile(profile, authorization);
    if (allowed === null || allowed === false) return { reason: 'profile is absent from the Amazon write allowlist' };
    return { authorization, allowed };
  }

  private boundedRefusal(
    rows: readonly { action: AmazonWriteAction }[],
    direction: 'forward' | 'inverse',
    inversePreapproved: boolean,
    authorization: BoundedAuthorization,
    allowed: BoundedAuthorization['profiles'][number],
  ): string | null {
    if (rows.length > authorization.constraints.max_rows_per_execution) {
      return 'mutation exceeds the bounded row budget';
    }
    for (const { action } of rows) {
      const entityAllowed = allowed.allowed_entities.some((entity) =>
        entity.action_type === action.actionType
          && entity.amazon_entity_id === action.amazonEntityId
          && entity.field === action.field,
      );
      if (!entityAllowed) return 'entity field is absent from the exact Amazon write allowlist';
      const delta = action.actionType === 'sp_campaign_placement'
        ? Math.abs(action.requestedValue - action.expectedValue)
        : Math.abs(action.requestedValue * 100 - action.expectedValue * 100);
      if (action.actionType === 'sp_campaign_placement') {
        if (!authorization.allowed_tests.placement.enabled) return 'placement mutation is not authorized';
        if (delta > authorization.allowed_tests.placement.max_absolute_percentage_points) {
          return 'placement mutation exceeds the bounded authorization';
        }
        if (direction === 'forward'
          && authorization.allowed_tests.placement.require_immediate_inverse
          && !inversePreapproved) {
          return 'placement test requires a preapproved inverse';
        }
      } else {
        if (![action.expectedValue, action.requestedValue].every((value) =>
          Math.abs(value * 100 - Math.round(value * 100)) <= 1e-8)) {
          return 'bid mutation is not expressed in exact currency minor units';
        }
        if (!authorization.allowed_tests.bid.enabled) return 'bid mutation is not authorized';
        if (delta > authorization.allowed_tests.bid.max_absolute_delta * 100 + 1e-8) {
          return 'bid mutation exceeds the bounded authorization';
        }
        if (direction === 'forward'
          && authorization.allowed_tests.bid.require_immediate_inverse
          && !inversePreapproved) {
          return 'bid test requires a preapproved inverse';
        }
      }
    }
    return null;
  }

  private reversalRunwayRefusal(
    direction: 'forward' | 'inverse',
    approvalExpiresAt: Date,
    authorization: BoundedAuthorization,
    now: Date,
  ): string | null {
    const requiredUntil = now.getTime() + this.minimumRunway(direction);
    if (approvalExpiresAt.getTime() < requiredUntil
      || new Date(authorization.expires_at).getTime() < requiredUntil) {
      return direction === 'forward'
        ? 'forward mutation lacks the full synchronized reversal runway'
        : 'inverse mutation lacks a complete synchronization observation runway';
    }
    return null;
  }

  private minimumRunway(direction: 'forward' | 'inverse'): number {
    return direction === 'forward'
      ? MINIMUM_FORWARD_REVERSAL_RUNWAY_MS
      : MINIMUM_INVERSE_OBSERVATION_RUNWAY_MS;
  }

  private providerErrorCallEvidence(
    error: unknown,
    requested: number,
  ): AmazonWriteProviderCallEvidence {
    const outcome = error instanceof SpWriteRetryableError ? 'throttled'
      : error instanceof SpWriteFailedError ? 'rejected' : 'ambiguous';
    return AmazonWriteProviderCallEvidence.parse({
      outcome,
      requested,
      accepted: 0,
      failed: outcome === 'rejected' ? requested : 0,
      code: error instanceof Error ? error.name.slice(0, 160) : 'ProviderError',
      message: safeMessage(error),
    });
  }

  private observationRequest(
    rows: readonly { action: AmazonWriteAction }[],
  ): SpWriteObservationRequest {
    return {
      keywordIds: [...new Set(rows.filter((row) => row.action.actionType === 'sp_keyword_bid').map((row) => row.action.amazonEntityId))],
      targetIds: [...new Set(rows.filter((row) => row.action.actionType === 'sp_target_bid').map((row) => row.action.amazonEntityId))],
      campaignIds: [...new Set(rows.filter((row) => row.action.actionType === 'sp_campaign_placement').map((row) => row.action.amazonEntityId))],
    };
  }

  private isExactObservationResult(
    request: SpWriteObservationRequest,
    observed: Awaited<ReturnType<SpWriteClient['observeSpWriteEntities']>>,
  ): boolean {
    const expected = [
      ...request.keywordIds.map((id) => `keyword:${id}`),
      ...request.targetIds.map((id) => `target:${id}`),
      ...request.campaignIds.map((id) => `campaign:${id}`),
    ].sort();
    const returned = observed.rows.map((row) => `${row.entityType}:${row.amazonId}`).sort();
    return observed.identityComplete !== false
      && observed.requested === expected.length
      && observed.returned === observed.rows.length
      && isDeepStrictEqual(returned, expected);
  }

  private providerResultCallEvidence(
    evidence: readonly AmazonWriteProviderEvidence[],
  ): AmazonWriteProviderCallEvidence {
    const accepted = evidence.filter((row) => row.outcome === 'accepted').length;
    const deterministicFailed = evidence.filter((row) => row.outcome === 'failed').length;
    const uncertain = evidence.length - accepted - deterministicFailed;
    const outcome = uncertain > 0 ? 'ambiguous'
      : accepted === evidence.length ? 'accepted'
        : accepted > 0 ? 'mixed' : 'rejected';
    const firstFailure = evidence.find((row) => row.outcome !== 'accepted');
    return AmazonWriteProviderCallEvidence.parse({
      outcome,
      requested: evidence.length,
      accepted,
      failed: uncertain > 0 ? deterministicFailed : evidence.length - accepted,
      code: firstFailure?.code ?? null,
      message: firstFailure?.message ?? null,
    });
  }

  private providerGroups(
    profile: AdsProfileContext,
    rows: readonly { writeRowId: string; attemptNumber: number; action: AmazonWriteAction }[],
  ) {
    const groups: Array<{
      rows: typeof rows;
      providerOperation: AmazonWriteAction['actionType'];
      providerRows: readonly unknown[];
      expectedEntityIds: readonly string[];
      run: () => Promise<{ evidence: AmazonWriteProviderEvidence[]; apiCalls: number }>;
      expandEvidence: (evidence: readonly AmazonWriteProviderEvidence[]) => Array<{
        row: (typeof rows)[number]; evidence: AmazonWriteProviderEvidence;
      }>;
    }> = [];
    const keyword = rows.filter((row) => row.action.actionType === 'sp_keyword_bid');
    for (const chunk of chunks(keyword, SP_WRITE_BATCH_SIZE)) {
      const providerRows = chunk.map((row) => ({ keywordId: row.action.amazonEntityId, bid: row.action.requestedValue }));
      groups.push({ rows: chunk, providerOperation: 'sp_keyword_bid', providerRows, expectedEntityIds: chunk.map((row) => row.action.amazonEntityId),
        run: () => this.provider.updateSpKeywordBids(profile, providerRows),
        expandEvidence: (evidence) => chunk.map((row, index) => ({ row, evidence: evidence[index] as AmazonWriteProviderEvidence })),
      });
    }
    const targets = rows.filter((row) => row.action.actionType === 'sp_target_bid');
    for (const chunk of chunks(targets, SP_WRITE_BATCH_SIZE)) {
      const providerRows = chunk.map((row) => ({ targetId: row.action.amazonEntityId, bid: row.action.requestedValue }));
      groups.push({ rows: chunk, providerOperation: 'sp_target_bid', providerRows, expectedEntityIds: chunk.map((row) => row.action.amazonEntityId),
        run: () => this.provider.updateSpTargetBids(profile, providerRows),
        expandEvidence: (evidence) => chunk.map((row, index) => ({ row, evidence: evidence[index] as AmazonWriteProviderEvidence })),
      });
    }
    const placementRows = rows.filter((row): row is typeof rows[number] & {
      action: Extract<AmazonWriteAction, { actionType: 'sp_campaign_placement' }>;
    } => row.action.actionType === 'sp_campaign_placement');
    if (placementRows.length > 0) {
      const byCampaign = new Map<string, typeof placementRows>();
      for (const row of placementRows) {
        const campaignRows = byCampaign.get(row.action.amazonEntityId) ?? [];
        campaignRows.push(row);
        byCampaign.set(row.action.amazonEntityId, campaignRows);
      }
      const campaigns = [...byCampaign.entries()];
      for (const campaignChunk of chunks(campaigns, SP_WRITE_BATCH_SIZE)) {
        const providerRows = campaignChunk.map(([campaignId, campaignRows]) => {
          const first = campaignRows[0];
          if (!first) throw new Error('placement campaign has no rows');
          for (const row of campaignRows) {
            if (!isDeepStrictEqual(row.action.campaignContext, first.action.campaignContext)) {
              throw new Error('placement rows for one campaign carry different current contexts');
            }
          }
          const providerState = placementProviderStateAfter(
            first.action.campaignContext.providerState,
            campaignRows,
          );
          return {
            campaignId,
            strategy: AMAZON_STRATEGY[providerState.strategy],
            placementBidding: providerState.placementBidding,
            ...(providerState.shopperCohortBidding === null ? {} : {
              shopperCohortBidding: providerState.shopperCohortBidding,
            }),
            ...(providerState.offAmazonSettings === null ? {} : {
              offAmazonSettings: providerState.offAmazonSettings,
            }),
          };
        });
        const chunkRows = campaignChunk.flatMap(([, campaignRows]) => campaignRows);
        groups.push({ rows: chunkRows, providerOperation: 'sp_campaign_placement', providerRows, expectedEntityIds: campaignChunk.map(([campaignId]) => campaignId),
          run: () => this.provider.updateSpCampaignPlacements(profile, providerRows),
          expandEvidence: (evidence) => campaignChunk.flatMap(([, campaignRows], index) =>
            campaignRows.map((row) => ({ row, evidence: evidence[index] as AmazonWriteProviderEvidence })),
          ),
        });
      }
    }
    return groups;
  }

  private nextObservationAt(attempt: number, now: Date): Date | null {
    if (attempt >= LONG_TAIL_OBSERVATION_ATTEMPT) return null;
    const nextAttempt = attempt + 1;
    const delaySeconds = OBSERVATION_DELAYS_SECONDS[
      Math.min(nextAttempt - 1, OBSERVATION_DELAYS_SECONDS.length - 1)
    ] ?? 1_800;
    return new Date(now.getTime() + delaySeconds * 1_000);
  }

}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

// Keep the inverse query reachable from the worker package without making the
// runtime execute it. A new approval/execution is still required for reversion.
export { getAmazonWriteInversePreview };

/** Factory keeps the concrete queue store out of tests. */
export function createPostgresAmazonWriteRuntime(input: {
  handle: DbHandle;
  workerStore: WorkerStore;
  provider: SpWriteClient;
  enabled: boolean;
  loadAuthorization: () => Promise<BoundedAuthorization | null>;
}): GuardedAmazonWriteRuntime {
  const postgresStore = input.workerStore instanceof PostgresWorkerStore
    ? input.workerStore
    : undefined;
  return new GuardedAmazonWriteRuntime({
    enabled: input.enabled,
    loadAuthorization: input.loadAuthorization,
    provider: input.provider,
    store: new PostgresAmazonWriteStore(input.handle, postgresStore),
  });
}
