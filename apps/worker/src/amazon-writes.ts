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
  recordAmazonWritePredispatchObservations,
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
  serializeAmazonWriteAttemptFingerprint,
  serializeAmazonWriteProviderCallFingerprint,
  serializeBoundedAmazonWriteAuthorization,
  type AmazonApplyJob,
  type AmazonObserveJob,
  type AmazonWriteAccounting,
  type AmazonWriteAction,
  type AmazonWritePredispatchObservation,
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
  SpWriteObservationError,
  SpWriteRetryableError,
} from './ads-api.js';
import { PostgresWorkerStore, type WorkerStore } from './store.js';

const OBSERVATION_DELAYS_SECONDS = [15, 60, 300, 900, 1_800] as const;
const LONG_TAIL_OBSERVATION_ATTEMPT = OBSERVATION_DELAYS_SECONDS.length + 1;
const FINAL_RECONCILIATION_DELAY_SECONDS = 24 * 60 * 60;
// Covers two complete ~51.5-minute observation windows (forward + inverse),
// plus bounded queue, Retry-After, and provider-call delay. Forward dispatch
// fails closed when either approval or operator authorization lacks this runway.
export const MINIMUM_FORWARD_REVERSAL_RUNWAY_MS = 4 * 60 * 60_000;
export const MINIMUM_INVERSE_OBSERVATION_RUNWAY_MS = 2 * 60 * 60_000;
// Longer than the Ads client timeout and its maximum honored Retry-After.
const WRITE_DISPATCH_LEASE_MS = 5 * 60_000;
const WRITE_PROVIDER_OPERATION_TIMEOUT_MS = 35_000;
const WRITE_EXACT_READ_TIMEOUT_MS = 30_000;
const MAX_WRITE_RETRY_AFTER_SECONDS = 120;

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
    amazonProfileId: string;
    connectionId: string | null;
    region: 'NA' | 'EU' | 'FE';
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
    apiCallCount: number;
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
    amazonProfileId: string;
    connectionId: string | null;
    region: 'NA' | 'EU' | 'FE';
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
  recordFreshness(input: {
    orgId: string;
    profileId: string;
    executionId: string;
    leaseToken: string;
    callId: string;
    observedAt: Date;
    observations: readonly AmazonWritePredispatchObservation[];
  }): Promise<void>;
  recordOutcomes(input: {
    orgId: string;
    profileId: string;
    executionId: string;
    callId: string;
    callEvidence: AmazonWriteProviderCallEvidence;
    apiCallCount: number;
    attemptedAt: Date;
    outcomes: readonly AmazonWriteRowOutcome[];
  }): ReturnType<typeof recordAmazonWriteOutcomes>;
  observationRows(input: {
    orgId: string;
    profileId: string;
    executionId: string;
    generation: string;
  }): ReturnType<typeof listAmazonWriteObservationRows>;
  syncEntities(profile: AdsProfileContext, entities: readonly EntityRow[], observedAt: Date): Promise<{
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

  recordFreshness(input: Parameters<AmazonWriteRuntimeStore['recordFreshness']>[0]) {
    return recordAmazonWritePredispatchObservations(this.handle, input);
  }

  recordOutcomes(input: Parameters<AmazonWriteRuntimeStore['recordOutcomes']>[0]) {
    return recordAmazonWriteOutcomes(this.handle, input);
  }

  observationRows(input: Parameters<AmazonWriteRuntimeStore['observationRows']>[0]) {
    return listAmazonWriteObservationRows(this.handle, input);
  }

  async syncEntities(profile: AdsProfileContext, entities: readonly EntityRow[], observedAt: Date) {
    return this.workerStore.syncEntities(profile, entities, {
      adProduct: 'SP', full: false, observedAt, recordChanges: false,
    });
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
          providerRow.entityType === 'campaign' && providerRow.campaignWriteContext != null
            ? canonicalCampaignWriteContext(providerRow.campaignWriteContext) : null,
          expectedContextByCampaign.has(action.amazonEntityId)
            ? canonicalCampaignWriteContext(expectedContextByCampaign.get(action.amazonEntityId)!) : null,
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
      return {
        writeRowId: row.writeRowId,
        // Seeing the original value after an ambiguous durable dispatch is not
        // proof that Amazon never accepted it: another actor may have restored
        // the old value between the send and this observation. Never resend an
        // uncertain call automatically; require visible manual reconciliation.
        state: observed ? 'observed' : input.finalAttempt ? 'conflict' : 'pending',
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
  return createHash('sha256')
    .update(serializeBoundedAmazonWriteAuthorization(authorization))
    .digest('hex');
}

function allowedProfile(profile: AdsProfileContext, authorization: BoundedAuthorization) {
  if (!profile.accountName || !profile.countryCode) return false;
  return authorization.profiles.find((allowed) =>
    allowed.org_id === profile.orgId
      && allowed.profile_id === profile.id
      && allowed.amazon_profile_id === profile.amazonProfileId
      && allowed.connection_id === profile.connectionId
      && allowed.region === profile.region
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

function fingerprint(
  executionId: string,
  callId: string,
  writeRowId: string,
  attempt: number,
  action: AmazonWriteAction,
): string {
  return createHash('sha256')
    .update(serializeAmazonWriteAttemptFingerprint({
      executionId, callId, writeRowId, attemptNumber: attempt, action,
    }))
    .digest('hex');
}

function outcomeFor(
  executionId: string,
  callId: string,
  row: { writeRowId: string; attemptNumber: number; action: AmazonWriteAction },
  evidence: AmazonWriteProviderEvidence,
): AmazonWriteRowOutcome {
  return {
    writeRowId: row.writeRowId,
    attemptNumber: row.attemptNumber,
    requestFingerprint: fingerprint(
      executionId, callId, row.writeRowId, row.attemptNumber, row.action,
    ),
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

function canonicalCampaignWriteContext(context: CampaignWriteContext): CampaignWriteContext {
  return {
    ...context,
    placementBidding: [...context.placementBidding]
      .sort((left, right) => left.placement.localeCompare(right.placement)),
    shopperCohortBidding: context.shopperCohortBidding === null
      ? null
      : context.shopperCohortBidding.map((cohort) => ({
          ...cohort,
          ...(cohort.audienceSegments === undefined ? {} : {
            audienceSegments: [...cohort.audienceSegments].sort((left, right) =>
              left.audienceId.localeCompare(right.audienceId)
                || left.audienceSegmentType.localeCompare(right.audienceSegmentType)),
          }),
        })).sort((left, right) =>
          left.shopperCohortType.localeCompare(right.shopperCohortType)
            || left.percentage - right.percentage
            || JSON.stringify(left.audienceSegments ?? []).localeCompare(
              JSON.stringify(right.audienceSegments ?? []),
            )),
  };
}

function targetedFreshnessMatchesPrepared(
  rows: readonly { action: AmazonWriteAction }[],
  entities: readonly EntityRow[],
): boolean {
  const byIdentity = new Map(entities.map((entity) => [
    `${entity.entityType}:${entity.amazonId}`,
    entity,
  ] as const));
  return rows.every(({ action }) => {
    if (action.actionType === 'sp_keyword_bid') {
      const entity = byIdentity.get(`keyword:${action.amazonEntityId}`);
      return entity?.entityType === 'keyword' && entity.bid === action.expectedValue;
    }
    if (action.actionType === 'sp_target_bid') {
      const entity = byIdentity.get(`target:${action.amazonEntityId}`);
      return entity?.entityType === 'target' && entity.bid === action.expectedValue;
    }
    const entity = byIdentity.get(`campaign:${action.amazonEntityId}`);
    return entity?.entityType === 'campaign'
      && entity.campaignWriteContext != null
      && isDeepStrictEqual(
        canonicalCampaignWriteContext(entity.campaignWriteContext),
        canonicalCampaignWriteContext(action.campaignContext.providerState),
      );
  });
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
      if (initial.retryable) {
        throw new SpWriteRetryableError(initial.reason, 60, 0);
      }
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
      amazonProfileId: profile.amazonProfileId,
      connectionId: profile.connectionId,
      region: profile.region,
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
      if ((prepared.status === 'running' || prepared.status === 'queued')
        && prepared.replayed && prepared.retryAfterSeconds !== undefined) {
        throw new SpWriteRetryableError(
          prepared.status === 'running'
            ? 'Amazon write execution is held by a live pre-dispatch lease'
            : 'Amazon write execution is waiting for an earlier bounded mutation cycle',
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
    let retryRequested = false;
    let retryAfterSeconds: number | undefined;
    let shouldObserve = false;
    let latestAccounting: AmazonWriteAccounting | null = null;
    let latestStatus = prepared.status;
    let durableObservation = false;
    const groups = this.providerGroups(profile, prepared.rows);
    for (const group of groups) {
      const refreshed = await this.authorized(profile);
      if ('reason' in refreshed && refreshed.retryable) {
        throw new SpWriteRetryableError(refreshed.reason, 60, amazonApiCalls);
      }
      const refreshedAuthorizationReplaced = !('reason' in refreshed)
        && (refreshed.authorization.authorization_id !== authorization.authorization_id
          || boundedAmazonWriteAuthorizationFingerprint(refreshed.authorization) !== authorizationSha256);
      if (prepared.direction === 'inverse' && refreshedAuthorizationReplaced) {
        throw new SpWriteRetryableError(
          'reserved inverse is paused until its exact bounded authorization is restored',
          60,
          amazonApiCalls,
        );
      }
      const refreshedRefusal = 'reason' in refreshed
        ? refreshed.reason
        : refreshedAuthorizationReplaced
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
      // Refresh and compare the exact provider-owned state for this group
      // immediately before dispatch. One aggregate read before the loop is
      // insufficient: an operator can change group 2 while group 1 is in
      // flight. The in-memory comparison is authoritative even if a stale
      // concurrent full sync later loses the mirror upsert race.
      const freshnessRequest = this.observationRequest(group.rows);
      const freshnessObservedAt = this.now();
      const callId = randomUUID();
      const freshness = await this.provider.observeSpWriteEntities(profile, freshnessRequest, {
        signal: AbortSignal.timeout(WRITE_EXACT_READ_TIMEOUT_MS),
        timeoutMs: WRITE_EXACT_READ_TIMEOUT_MS,
      });
      amazonApiCalls += freshness.apiCalls;
      const exactFreshnessIdentity = this.isExactObservationResult(freshnessRequest, freshness);
      if (exactFreshnessIdentity) {
        await this.store.recordFreshness({
          orgId: payload.orgId,
          profileId: payload.profileId,
          executionId: payload.executionId,
          leaseToken,
          callId,
          observedAt: freshnessObservedAt,
          observations: this.predispatchObservations(group.rows, freshness.rows),
        });
      }
      if (!exactFreshnessIdentity
        || !targetedFreshnessMatchesPrepared(group.rows, freshness.rows)) {
        latestAccounting = await this.store.refuse({
          ...payload,
          reason: 'targeted Amazon freshness values changed before provider dispatch',
        });
        latestStatus = latestAccounting.succeeded > 0 ? 'partial' : 'refused';
        shouldObserve ||= latestAccounting.resyncRequested > latestAccounting.resynchronized;
        break;
      }
      const freshnessSync = await this.store.syncEntities(
        profile,
        freshness.rows,
        freshnessObservedAt,
      );
      if (freshnessSync.listed !== freshness.rows.length
        || freshnessSync.upserted !== freshness.rows.length) {
        throw new Error(`targeted pre-dispatch sync offered ${freshness.rows.length} rows but upserted ${freshnessSync.upserted}`);
      }
      const fresh = await this.store.recheckCurrentState({
        orgId: payload.orgId,
        profileId: payload.profileId,
        executionId: payload.executionId,
        leaseToken,
        rowIds: group.rows.map((row) => row.writeRowId),
      });
      if (!fresh) {
        latestAccounting = await this.store.refuse({
          ...payload,
          reason: 'targeted Amazon refresh changed synchronized state before mutation',
        });
        latestStatus = latestAccounting.succeeded > 0 ? 'partial' : 'refused';
        shouldObserve ||= latestAccounting.resyncRequested > latestAccounting.resynchronized;
        break;
      }
      // The targeted read can itself take tens of seconds. Re-bind the exact
      // local authorization immediately before the durable dispatch intent so
      // a revocation/rotation cannot race the provider call.
      const finalAuthorization = await this.authorized(profile);
      if ('reason' in finalAuthorization) {
        if (finalAuthorization.retryable) {
          throw new SpWriteRetryableError(finalAuthorization.reason, 60, amazonApiCalls);
        }
        latestAccounting = await this.store.refuse({ ...payload, reason: finalAuthorization.reason });
        latestStatus = latestAccounting.succeeded > 0 ? 'partial' : 'refused';
        shouldObserve ||= latestAccounting.resyncRequested > latestAccounting.resynchronized;
        break;
      }
      const finalAuthorizationSha256 = boundedAmazonWriteAuthorizationFingerprint(
        finalAuthorization.authorization,
      );
      const finalAuthorizationReplaced = finalAuthorization.authorization.authorization_id
          !== authorization.authorization_id
        || finalAuthorizationSha256 !== authorizationSha256;
      if (prepared.direction === 'inverse' && finalAuthorizationReplaced) {
        throw new SpWriteRetryableError(
          'reserved inverse is paused until its exact bounded authorization is restored',
          60,
          amazonApiCalls,
        );
      }
      const finalRefusal = finalAuthorizationReplaced
        ? 'bounded Amazon write authorization was replaced before provider dispatch'
        : this.boundedRefusal(
            group.rows,
            prepared.direction,
            prepared.inversePreapproved,
            finalAuthorization.authorization,
            finalAuthorization.allowed,
          ) ?? this.reversalRunwayRefusal(
            prepared.direction,
            prepared.expiresAt,
            finalAuthorization.authorization,
            this.now(),
          );
      if (finalRefusal !== null) {
        latestAccounting = await this.store.refuse({ ...payload, reason: finalRefusal });
        latestStatus = latestAccounting.succeeded > 0 ? 'partial' : 'refused';
        shouldObserve ||= latestAccounting.resyncRequested > latestAccounting.resynchronized;
        break;
      }
      const dispatchedAt = this.now();
      const requestFingerprint = createHash('sha256')
        .update(serializeAmazonWriteProviderCallFingerprint({
          executionId: prepared.executionId,
          callId,
          providerOperation: group.providerOperation,
          requestedEntityIds: group.expectedEntityIds,
          actions: group.rows.map((row) => row.action),
        }))
        .digest('hex');
      const dispatched = await this.store.markDispatched({
        orgId: payload.orgId, profileId: payload.profileId,
        executionId: payload.executionId, leaseToken,
        rowIds: group.rows.map((row) => row.writeRowId), callId,
        providerOperation: group.providerOperation, requestFingerprint,
        requestedEntityIds: group.expectedEntityIds,
        authorizationId: authorization.authorization_id, authorizationSha256,
        amazonProfileId: profile.amazonProfileId,
        connectionId: profile.connectionId,
        region: profile.region,
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
        providerResult = await group.run(AbortSignal.timeout(WRITE_PROVIDER_OPERATION_TIMEOUT_MS));
      } catch (error) {
        providerError = error;
      }
      if (providerError !== null) {
        const providerCalls = providerError instanceof SpWriteRetryableError
          || providerError instanceof SpWriteAmbiguousError
          || providerError instanceof SpWriteFailedError
          ? providerError.apiCalls : 0;
        amazonApiCalls += providerCalls;
        const classifiedError = providerError instanceof SpWriteRetryableError && providerCalls === 0
          ? new SpWriteAmbiguousError(providerError.message, 0)
          : providerError;
        const callEvidence = this.providerErrorCallEvidence(
          classifiedError,
          group.providerRows.length,
        );
        if (classifiedError instanceof SpWriteRetryableError) {
          await this.store.releaseForRetry({
            ...payload, leaseToken, callId, callEvidence,
            apiCallCount: providerCalls,
            rowIds: group.rows.map((row) => row.writeRowId),
          });
          retryRequested = true;
          retryAfterSeconds = Math.min(
            classifiedError.retryAfterSeconds ?? 60,
            MAX_WRITE_RETRY_AFTER_SECONDS,
          );
          break;
        }
        const ambiguous = classifiedError instanceof SpWriteAmbiguousError
          || !(classifiedError instanceof SpWriteFailedError);
        const evidence = failureEvidence(classifiedError, ambiguous ? 'ambiguous' : 'failed');
        const outcomes = group.rows.map((row) => outcomeFor(
          prepared.executionId, callId, row, evidence,
        ));
        const recorded = await this.store.recordOutcomes({
          orgId: payload.orgId, profileId: payload.profileId,
          executionId: payload.executionId, callId, callEvidence,
          apiCallCount: providerCalls,
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
        outcomeFor(prepared.executionId, callId, row, evidence),
      );
      // Deliberately outside the provider try/catch: a persistence failure after
      // Amazon answered leaves the durable dispatch ambiguous and observation-led.
      const recorded = await this.store.recordOutcomes({
        orgId: payload.orgId, profileId: payload.profileId,
        executionId: payload.executionId, callId, callEvidence,
        apiCallCount: providerResult.apiCalls,
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
    let providerReadAttempted = false;
    const observedAt = this.now();
    const observationAuthorization = await this.authorized(profile);
    if ('reason' in observationAuthorization) {
      if (observationAuthorization.retryable) {
        throw new SpWriteRetryableError(observationAuthorization.reason, 60, 0);
      }
      observationError = new Error(observationAuthorization.reason);
    } else {
      providerReadAttempted = true;
      try {
        observed = await this.provider.observeSpWriteEntities(profile, request, {
          signal: AbortSignal.timeout(WRITE_EXACT_READ_TIMEOUT_MS),
          timeoutMs: WRITE_EXACT_READ_TIMEOUT_MS,
        });
      } catch (error) {
        observationError = error;
      }
    }
    const identityComplete = observed !== null && this.isExactObservationResult(request, observed);
    const trustedRows = identityComplete && observed !== null ? observed.rows : [];
    const synced = trustedRows.length === 0
      ? { listed: 0, upserted: 0 }
      : await this.store.syncEntities(profile, trustedRows, observedAt);
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
      executionId: payload.executionId, observedAt,
      generation: payload.generation, attempt: payload.attempt,
      nextObservationAt: this.nextObservationAt(payload.attempt, observedAt),
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
      amazonApiCalls: observed?.apiCalls
        ?? (observationError instanceof SpWriteObservationError
          ? observationError.apiCallsLowerBound : 0),
      amazonApiCallAccounting: observed !== null ? 'exact'
        : providerReadAttempted ? 'lower_bound_unknown' : 'none',
      requeued: recorded.observationRequeued,
      applyRequeued: recorded.applyRequeued,
    };
  }

  private async authorized(profile: AdsProfileContext): Promise<
    { authorization: BoundedAuthorization; allowed: BoundedAuthorization['profiles'][number] }
    | { reason: string; retryable: boolean }
  > {
    if (!this.enabled) return { reason: 'deployment Amazon write gate is disabled', retryable: true };
    let authorization: BoundedAuthorization | null;
    try {
      authorization = await this.loadAuthorization();
    } catch (error) {
      return {
        reason: error instanceof Error && error.name === 'ZodError'
          ? 'bounded Amazon write authorization is invalid'
          : 'bounded Amazon write authorization could not be reloaded',
        // A schema-validity failure is a stable invalid authorization. File
        // read/JSON rotation failures are transient and must not terminally
        // refuse a reserved exact inverse.
        retryable: true,
      };
    }
    if (authorization === null) return { reason: 'bounded Amazon write authorization is missing', retryable: true };
    if (new Date(authorization.expires_at).getTime() <= this.now().getTime()) {
      return { reason: 'bounded Amazon write authorization expired', retryable: true };
    }
    const allowed = allowedProfile(profile, authorization);
    if (allowed === null || allowed === false) {
      return {
        reason: 'profile is absent from the Amazon write allowlist',
        // A removed or rotating entry is an explicit fail-closed pause. Keep
        // the immutable execution recoverable so restoring the same exact
        // authorization can still complete a preapproved inverse.
        retryable: true,
      };
    }
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

  private predispatchObservations(
    rows: readonly { writeRowId: string; action: AmazonWriteAction }[],
    entities: readonly EntityRow[],
  ): AmazonWritePredispatchObservation[] {
    const byIdentity = new Map(entities.map((entity) => [
      `${entity.entityType}:${entity.amazonId}`,
      entity,
    ] as const));
    return rows.map((row) => {
      const { action } = row;
      if (action.actionType === 'sp_keyword_bid') {
        const entity = byIdentity.get(`keyword:${action.amazonEntityId}`);
        if (entity?.entityType !== 'keyword' || entity.bid === null) {
          throw new Error('exact keyword freshness response omitted its bid');
        }
        return { writeRowId: row.writeRowId, currentValue: entity.bid, providerState: null };
      }
      if (action.actionType === 'sp_target_bid') {
        const entity = byIdentity.get(`target:${action.amazonEntityId}`);
        if (entity?.entityType !== 'target' || entity.bid === null) {
          throw new Error('exact target freshness response omitted its bid');
        }
        return { writeRowId: row.writeRowId, currentValue: entity.bid, providerState: null };
      }
      const entity = byIdentity.get(`campaign:${action.amazonEntityId}`);
      if (entity?.entityType !== 'campaign' || entity.campaignWriteContext === null
        || entity.campaignWriteContext === undefined) {
        throw new Error('exact campaign freshness response omitted complete bidding state');
      }
      const currentValue = entity.placementBidding?.[
        action.field === 'top_of_search' ? 'topOfSearch'
          : action.field === 'product_pages' ? 'productPages' : 'restOfSearch'
      ];
      if (currentValue === null || currentValue === undefined) {
        throw new Error('exact campaign freshness response omitted its placement value');
      }
      return {
        writeRowId: row.writeRowId,
        currentValue,
        providerState: canonicalCampaignWriteContext(entity.campaignWriteContext),
      };
    });
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
      run: (signal: AbortSignal) => Promise<{ evidence: AmazonWriteProviderEvidence[]; apiCalls: number }>;
      expandEvidence: (evidence: readonly AmazonWriteProviderEvidence[]) => Array<{
        row: (typeof rows)[number]; evidence: AmazonWriteProviderEvidence;
      }>;
    }> = [];
    const keyword = rows.filter((row) => row.action.actionType === 'sp_keyword_bid');
    for (const chunk of chunks(keyword, SP_WRITE_BATCH_SIZE)) {
      const providerRows = chunk.map((row) => ({ keywordId: row.action.amazonEntityId, bid: row.action.requestedValue }));
      groups.push({ rows: chunk, providerOperation: 'sp_keyword_bid', providerRows, expectedEntityIds: chunk.map((row) => row.action.amazonEntityId),
        run: (signal) => this.provider.updateSpKeywordBids(profile, providerRows, {
          signal, timeoutMs: WRITE_PROVIDER_OPERATION_TIMEOUT_MS,
        }),
        expandEvidence: (evidence) => chunk.map((row, index) => ({ row, evidence: evidence[index] as AmazonWriteProviderEvidence })),
      });
    }
    const targets = rows.filter((row) => row.action.actionType === 'sp_target_bid');
    for (const chunk of chunks(targets, SP_WRITE_BATCH_SIZE)) {
      const providerRows = chunk.map((row) => ({ targetId: row.action.amazonEntityId, bid: row.action.requestedValue }));
      groups.push({ rows: chunk, providerOperation: 'sp_target_bid', providerRows, expectedEntityIds: chunk.map((row) => row.action.amazonEntityId),
        run: (signal) => this.provider.updateSpTargetBids(profile, providerRows, {
          signal, timeoutMs: WRITE_PROVIDER_OPERATION_TIMEOUT_MS,
        }),
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
          run: (signal) => this.provider.updateSpCampaignPlacements(profile, providerRows, {
            signal, timeoutMs: WRITE_PROVIDER_OPERATION_TIMEOUT_MS,
          }),
          expandEvidence: (evidence) => campaignChunk.flatMap(([, campaignRows], index) =>
            campaignRows.map((row) => ({ row, evidence: evidence[index] as AmazonWriteProviderEvidence })),
          ),
        });
      }
    }
    return groups;
  }

  private nextObservationAt(attempt: number, now: Date): Date | null {
    if (attempt >= LONG_TAIL_OBSERVATION_ATTEMPT) {
      return new Date(now.getTime() + FINAL_RECONCILIATION_DELAY_SECONDS * 1_000);
    }
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
