import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { SP_WRITE_BATCH_SIZE } from '@wizard-ads/ads-api';
import {
  getAmazonWriteInversePreview,
  listAmazonWriteObservationRows,
  markAmazonWriteRowsDispatched,
  prepareAmazonWriteExecution,
  recordAmazonWriteObservations,
  recordAmazonWriteOutcomes,
  releaseAmazonWriteExecutionForRetry,
  refuseAmazonWriteExecution,
  resolveCurrentApplyStates,
  type AmazonWriteObservation,
  type AmazonWriteRowOutcome,
  type DbHandle,
} from '@wizard-ads/db';
import {
  AmazonWriteProviderEvidence,
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
  }): Promise<void>;
  markDispatched(input: {
    orgId: string;
    profileId: string;
    executionId: string;
    leaseToken: string;
    rowIds: readonly string[];
    dispatchedAt: Date;
    leaseExpiresAt: Date;
  }): Promise<void>;
  recordOutcomes(input: {
    orgId: string;
    profileId: string;
    executionId: string;
    attemptedAt: Date;
    outcomes: readonly AmazonWriteRowOutcome[];
  }): ReturnType<typeof recordAmazonWriteOutcomes>;
  observationRows(input: {
    orgId: string;
    profileId: string;
    executionId: string;
  }): ReturnType<typeof listAmazonWriteObservationRows>;
  syncEntities(profile: AdsProfileContext, entities: readonly EntityRow[]): Promise<{
    listed: number;
    upserted: number;
  }>;
  resolveObservation(input: {
    orgId: string;
    profileId: string;
    actions: readonly { writeRowId: string; action: AmazonWriteAction; rowStatus: string }[];
    finalAttempt: boolean;
  }): Promise<AmazonWriteObservation[]>;
  recordObservations(input: {
    orgId: string;
    profileId: string;
    executionId: string;
    observedAt: Date;
    attempt: number;
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
    const targets = input.actions.map(({ writeRowId, action }) => ({
      key: writeRowId,
      entityType: action.actionType === 'sp_campaign_placement' ? 'placement' as const
        : action.actionType === 'sp_keyword_bid' ? 'keyword' as const : 'target' as const,
      entityId: action.amazonEntityId,
      field: action.field,
    }));
    const resolved = await resolveCurrentApplyStates(
      this.handle,
      { orgId: input.orgId, profileId: input.profileId, targets },
    );
    if (resolved.length !== input.actions.length) {
      throw new Error(`Amazon observation offered ${input.actions.length} rows but resolved ${resolved.length}`);
    }
    const actionByRow = new Map(input.actions.map((row) => [row.writeRowId, row] as const));
    const placementCampaigns = [...new Set(input.actions
      .filter((row) => row.action.actionType === 'sp_campaign_placement')
      .map((row) => row.action.amazonEntityId))];
    const contexts = placementCampaigns.length === 0 ? [] : await this.handle.sql<{
      amazon_id: string;
      campaign_write_context: CampaignWriteContext | null;
    }[]>`
      select amazon_id, campaign_write_context from public.campaigns
       where org_id = ${input.orgId} and profile_id = ${input.profileId}
         and amazon_id = any(${placementCampaigns}::text[])
    `;
    const contextByCampaign = new Map(contexts.map((row) => [row.amazon_id, row.campaign_write_context] as const));
    const expectedContextByCampaign = new Map<string, CampaignWriteContext>();
    for (const campaignId of placementCampaigns) {
      const actions = input.actions.filter((row): row is typeof row & {
        action: Extract<AmazonWriteAction, { actionType: 'sp_campaign_placement' }>;
      } => row.action.actionType === 'sp_campaign_placement' && row.action.amazonEntityId === campaignId);
      const first = actions[0];
      if (!first) continue;
      expectedContextByCampaign.set(campaignId, placementProviderStateAfter(first.action.campaignContext.providerState, actions));
    }
    return resolved.map((state) => {
      const row = actionByRow.get(state.key);
      if (!row) throw new Error(`Amazon observation resolved unknown row ${state.key}`);
      const action = row.action;
      const contextObserved = action.actionType === 'sp_campaign_placement'
        ? isDeepStrictEqual(
          contextByCampaign.get(action.amazonEntityId) ?? null,
          expectedContextByCampaign.get(action.amazonEntityId) ?? null,
        )
        : null;
      const observed = contextObserved ?? (typeof state.currentValue === 'number'
        && Object.is(state.currentValue, action.requestedValue));
      const stillOriginal = action.actionType === 'sp_campaign_placement'
        ? isDeepStrictEqual(
          contextByCampaign.get(action.amazonEntityId) ?? null,
          action.campaignContext.providerState,
        )
        : typeof state.currentValue === 'number' && Object.is(state.currentValue, action.expectedValue);
      return {
        writeRowId: state.key,
        state: observed ? 'observed'
          : row.rowStatus === 'dispatched' && stillOriginal ? 'not_applied'
            : input.finalAttempt ? 'conflict' : 'pending',
        currentValue: state.currentValue,
      };
    });
  }

  recordObservations(input: Parameters<AmazonWriteRuntimeStore['recordObservations']>[0]) {
    return recordAmazonWriteObservations(this.handle, input);
  }

  enqueue(payload: AmazonObserveJob | AmazonApplyJob, runAt: Date, dedupeKey: string): Promise<boolean> {
    return this.workerStore.enqueue(payload, runAt, dedupeKey);
  }
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
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
  dispatchToken: string,
): AmazonWriteRowOutcome {
  return {
    writeRowId: row.writeRowId,
    attemptNumber: row.attemptNumber,
    requestFingerprint: fingerprint(executionId, row.writeRowId, row.attemptNumber, row.action),
    evidence,
    dispatchToken,
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
    const now = this.now();
    const leaseToken = randomUUID();
    const prepared = await this.store.prepare({
      orgId: payload.orgId,
      profileId: payload.profileId,
      executionId: payload.executionId,
      now,
      maxConcurrentMutations: authorization.constraints.max_concurrent_mutations,
      authorizationId: authorization.authorization_id,
      maxRowsPerExecution: authorization.constraints.max_rows_per_execution,
      maxTotalExecutions: authorization.constraints.max_total_executions,
      dispatchLeaseToken: leaseToken,
      dispatchLeaseExpiresAt: new Date(now.getTime() + 5 * 60_000),
    });
    if (prepared.recoveryObservation) {
      const observationEnqueued = await this.enqueueObservation(payload, 0, now);
      return {
        status: 'awaiting_sync', requested: prepared.requested, replayed: true,
        amazonApiCalls: 0, observationEnqueued, recoveryObservation: true,
      };
    }
    if (prepared.rows.length === 0) {
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
    const boundedRefusal = this.boundedRefusal(prepared.rows, prepared.inversePreapproved, authorization, allowed);
    if (boundedRefusal !== null) {
      const accounting = await this.store.refuse({ ...payload, reason: boundedRefusal });
      return { status: 'refused', ...accounting, amazonApiCalls: 0 };
    }

    let amazonApiCalls = 0;
    let retryRequested = false;
    let retryAfterSeconds: number | undefined;
    let shouldObserve = false;
    let latestAccounting: AmazonWriteAccounting | null = null;
    let latestStatus = prepared.status;
    const groups = this.providerGroups(profile, prepared.rows);
    for (const group of groups) {
      const refreshed = await this.authorized(profile);
      const refreshedRefusal = 'reason' in refreshed
        ? refreshed.reason
        : refreshed.authorization.authorization_id !== authorization.authorization_id
          ? 'bounded Amazon write authorization was replaced during execution'
          : this.boundedRefusal(group.rows, prepared.inversePreapproved, refreshed.authorization, refreshed.allowed);
      if (refreshedRefusal !== null) {
        latestAccounting = await this.store.refuse({ ...payload, reason: refreshedRefusal });
        latestStatus = latestAccounting.succeeded > 0 ? 'partial' : 'refused';
        shouldObserve ||= latestAccounting.resyncRequested > latestAccounting.resynchronized;
        break;
      }
      const dispatchedAt = this.now();
      await this.store.markDispatched({
        orgId: payload.orgId, profileId: payload.profileId,
        executionId: payload.executionId, leaseToken,
        rowIds: group.rows.map((row) => row.writeRowId), dispatchedAt,
        leaseExpiresAt: new Date(dispatchedAt.getTime() + 5 * 60_000),
      });
      try {
        const providerResult = await group.run();
        amazonApiCalls += providerResult.apiCalls;
        const evidences = providerResult.evidence;
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
        const outcomes = group.expandEvidence(evidences).map(({ row, evidence }) =>
          outcomeFor(prepared.executionId, row, evidence, leaseToken),
        );
        const recorded = await this.store.recordOutcomes({
          orgId: payload.orgId, profileId: payload.profileId,
          executionId: payload.executionId, attemptedAt: now, outcomes,
        });
        shouldObserve ||= recorded.shouldObserve;
        latestAccounting = recorded.accounting;
        latestStatus = recorded.status;
      } catch (error) {
        amazonApiCalls += error instanceof SpWriteRetryableError
          || error instanceof SpWriteAmbiguousError
          || error instanceof SpWriteFailedError
          ? error.apiCalls : 0;
        if (error instanceof SpWriteRetryableError) {
          await this.store.releaseForRetry({
            ...payload, leaseToken, rowIds: group.rows.map((row) => row.writeRowId),
          });
          retryRequested = true;
          retryAfterSeconds = error.retryAfterSeconds;
          break;
        }
        const ambiguous = error instanceof SpWriteAmbiguousError;
        const evidence = failureEvidence(
          error,
          ambiguous ? 'ambiguous' : 'failed',
        );
        const outcomes = group.rows.map((row) => outcomeFor(prepared.executionId, row, evidence, leaseToken));
        const recorded = await this.store.recordOutcomes({
          orgId: payload.orgId, profileId: payload.profileId,
          executionId: payload.executionId, attemptedAt: now, outcomes,
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
      }
    }
    if (retryRequested) {
      throw new SpWriteRetryableError(
        'Amazon rejected the mutation before applying it',
        retryAfterSeconds,
        amazonApiCalls,
      );
    }
    if (shouldObserve) {
      await this.enqueueObservation(payload, 0, now);
    }
    return {
      status: shouldObserve ? 'awaiting_sync' : latestStatus,
      ...(latestAccounting ?? {}),
      amazonApiCalls,
      observationEnqueued: shouldObserve,
    };
  }

  async observe(payload: AmazonObserveJob, profile: AdsProfileContext): Promise<Record<string, unknown>> {
    const rows = await this.store.observationRows(payload);
    if (rows.length === 0) {
      return { status: 'settled', requested: 0, amazonApiCalls: 0, replayed: true };
    }
    const request: SpWriteObservationRequest = {
      keywordIds: [...new Set(rows.filter((row) => row.action.actionType === 'sp_keyword_bid').map((row) => row.action.amazonEntityId))],
      targetIds: [...new Set(rows.filter((row) => row.action.actionType === 'sp_target_bid').map((row) => row.action.amazonEntityId))],
      campaignIds: [...new Set(rows.filter((row) => row.action.actionType === 'sp_campaign_placement').map((row) => row.action.amazonEntityId))],
    };
    const expectedEntities = request.keywordIds.length + request.targetIds.length + request.campaignIds.length;
    const observed = await this.provider.observeSpWriteEntities(profile, request);
    if (observed.requested !== expectedEntities || observed.returned !== observed.rows.length) {
      throw new Error('targeted Sponsored Products observation count assertion failed');
    }
    const synced = await this.store.syncEntities(profile, observed.rows);
    if (synced.listed !== observed.rows.length || synced.upserted !== observed.rows.length) {
      throw new Error(`targeted sync offered ${observed.rows.length} rows but upserted ${synced.upserted}`);
    }
    const finalAttempt = payload.attempt >= OBSERVATION_DELAYS_SECONDS.length;
    const classifications = await this.store.resolveObservation({
      orgId: payload.orgId, profileId: payload.profileId, actions: rows, finalAttempt,
    });
    const recorded = await this.store.recordObservations({
      orgId: payload.orgId, profileId: payload.profileId,
      executionId: payload.executionId, observedAt: this.now(),
      attempt: payload.attempt, observations: classifications,
    });
    let requeued = false;
    if (recorded.pending > 0 && !finalAttempt) {
      requeued = await this.enqueueObservation(payload, payload.attempt + 1, this.now());
    }
    const applyRequeued = recorded.retryApply
      ? await this.store.enqueue(
          { type: 'amazon.apply', orgId: payload.orgId, profileId: payload.profileId, executionId: payload.executionId },
          this.now(),
          `amazon.apply:${payload.executionId}:recovery:${payload.attempt}`,
        )
      : false;
    return {
      status: recorded.status,
      ...recorded.accounting,
      pending: recorded.pending,
      inverseReady: recorded.inverseReady,
      targetedEntities: expectedEntities,
      returnedEntities: observed.returned,
      upsertedEntities: synced.upserted,
      amazonApiCalls: observed.apiCalls,
      requeued,
      applyRequeued,
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
      const delta = Number(Math.abs(action.requestedValue - action.expectedValue).toFixed(6));
      if (action.actionType === 'sp_campaign_placement') {
        if (!authorization.allowed_tests.placement.enabled) return 'placement mutation is not authorized';
        if (delta > authorization.allowed_tests.placement.max_absolute_percentage_points) {
          return 'placement mutation exceeds the bounded authorization';
        }
        if (authorization.allowed_tests.placement.require_immediate_inverse && !inversePreapproved) {
          return 'placement test requires a preapproved inverse';
        }
      } else {
        if (!authorization.allowed_tests.bid.enabled) return 'bid mutation is not authorized';
        if (delta > authorization.allowed_tests.bid.max_absolute_delta) {
          return 'bid mutation exceeds the bounded authorization';
        }
        if (authorization.allowed_tests.bid.require_immediate_inverse && !inversePreapproved) {
          return 'bid test requires a preapproved inverse';
        }
      }
    }
    return null;
  }

  private providerGroups(
    profile: AdsProfileContext,
    rows: readonly { writeRowId: string; attemptNumber: number; action: AmazonWriteAction }[],
  ) {
    const groups: Array<{
      rows: typeof rows;
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
      groups.push({ rows: chunk, providerRows, expectedEntityIds: chunk.map((row) => row.action.amazonEntityId),
        run: () => this.provider.updateSpKeywordBids(profile, providerRows),
        expandEvidence: (evidence) => chunk.map((row, index) => ({ row, evidence: evidence[index] as AmazonWriteProviderEvidence })),
      });
    }
    const targets = rows.filter((row) => row.action.actionType === 'sp_target_bid');
    for (const chunk of chunks(targets, SP_WRITE_BATCH_SIZE)) {
      const providerRows = chunk.map((row) => ({ targetId: row.action.amazonEntityId, bid: row.action.requestedValue }));
      groups.push({ rows: chunk, providerRows, expectedEntityIds: chunk.map((row) => row.action.amazonEntityId),
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
        groups.push({ rows: chunkRows, providerRows, expectedEntityIds: campaignChunk.map(([campaignId]) => campaignId),
          run: () => this.provider.updateSpCampaignPlacements(profile, providerRows),
          expandEvidence: (evidence) => campaignChunk.flatMap(([, campaignRows], index) =>
            campaignRows.map((row) => ({ row, evidence: evidence[index] as AmazonWriteProviderEvidence })),
          ),
        });
      }
    }
    return groups;
  }

  private async enqueueObservation(
    payload: Pick<AmazonApplyJob | AmazonObserveJob, 'orgId' | 'profileId' | 'executionId'>,
    attempt: number,
    now: Date,
  ): Promise<boolean> {
    const delaySeconds = attempt === 0 ? 0 : OBSERVATION_DELAYS_SECONDS[Math.min(attempt - 1, OBSERVATION_DELAYS_SECONDS.length - 1)] ?? 1_800;
    return this.store.enqueue(
      { type: 'amazon.observe', orgId: payload.orgId, profileId: payload.profileId, executionId: payload.executionId, attempt },
      new Date(now.getTime() + delaySeconds * 1_000),
      `amazon.observe:${payload.executionId}:${attempt}`,
    );
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
