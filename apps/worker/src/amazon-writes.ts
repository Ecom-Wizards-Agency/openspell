import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SP_WRITE_BATCH_SIZE } from '@wizard-ads/ads-api';
import {
  getAmazonWriteInversePreview,
  listAmazonWriteObservationRows,
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
  type EntityRow,
} from '@wizard-ads/shared';
import type {
  AdsProfileContext,
  SpWriteClient,
  SpWriteObservationRequest,
} from './ads-api.js';
import {
  SpWriteAmbiguousError,
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
  authorization: BoundedAuthorization | null;
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
    actions: readonly { writeRowId: string; action: AmazonWriteAction }[];
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
  enqueueObservation(payload: AmazonObserveJob, runAt: Date, dedupeKey: string): Promise<boolean>;
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
    const actionByRow = new Map(input.actions.map((row) => [row.writeRowId, row.action] as const));
    return resolved.map((state) => {
      const action = actionByRow.get(state.key);
      if (!action) throw new Error(`Amazon observation resolved unknown row ${state.key}`);
      const observed = typeof state.currentValue === 'number'
        && Object.is(state.currentValue, action.requestedValue);
      return {
        writeRowId: state.key,
        state: observed ? 'observed' : input.finalAttempt ? 'conflict' : 'pending',
        currentValue: state.currentValue,
      };
    });
  }

  recordObservations(input: Parameters<AmazonWriteRuntimeStore['recordObservations']>[0]) {
    return recordAmazonWriteObservations(this.handle, input);
  }

  enqueueObservation(payload: AmazonObserveJob, runAt: Date, dedupeKey: string): Promise<boolean> {
    return this.workerStore.enqueue(payload, runAt, dedupeKey);
  }
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function profileAllowed(profile: AdsProfileContext, authorization: BoundedAuthorization): boolean {
  if (!profile.accountName || !profile.countryCode) return false;
  return authorization.profiles.some((allowed) =>
    normalized(allowed.account_label) === normalized(profile.accountName ?? '')
      && normalized(allowed.marketplace) === normalized(profile.countryCode ?? ''),
  );
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

const AMAZON_STRATEGY = {
  legacy_for_sales: 'LEGACY_FOR_SALES',
  auto_for_sales: 'AUTO_FOR_SALES',
  manual: 'MANUAL',
  rule_based: 'RULE_BASED',
} as const;

export class GuardedAmazonWriteRuntime {
  private readonly enabled: boolean;
  private readonly authorization: BoundedAuthorization | null;
  private readonly provider: SpWriteClient;
  private readonly store: AmazonWriteRuntimeStore;
  private readonly now: () => Date;

  constructor(options: AmazonWriteRuntimeOptions) {
    this.enabled = options.enabled;
    this.authorization = options.authorization;
    this.provider = options.provider;
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
  }

  async apply(payload: AmazonApplyJob, profile: AdsProfileContext): Promise<Record<string, unknown>> {
    const refusal = this.gateRefusal(profile);
    if (refusal !== null) {
      const accounting = await this.store.refuse({ ...payload, executionId: payload.executionId, reason: refusal });
      return { status: 'refused', ...accounting, amazonApiCalls: 0 };
    }
    const authorization = this.authorization;
    if (authorization === null) throw new Error('Amazon write authorization unexpectedly missing');
    const now = this.now();
    const prepared = await this.store.prepare({
      orgId: payload.orgId,
      profileId: payload.profileId,
      executionId: payload.executionId,
      now,
      maxConcurrentMutations: authorization.constraints.max_concurrent_mutations,
    });
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
    const boundedRefusal = this.boundedRefusal(prepared.rows, prepared.inversePreapproved, authorization);
    if (boundedRefusal !== null) {
      const accounting = await this.store.refuse({ ...payload, reason: boundedRefusal });
      return { status: 'refused', ...accounting, amazonApiCalls: 0 };
    }

    let amazonApiCalls = 0;
    let retryRequested = false;
    let retryAfterSeconds: number | undefined;
    let shouldObserve = false;
    let latestAccounting: AmazonWriteAccounting | null = null;
    const groups = this.providerGroups(profile, prepared.rows);
    for (const group of groups) {
      try {
        amazonApiCalls += 1;
        const evidences = await group.run();
        if (evidences.length !== group.providerRows.length) {
          throw new SpWriteAmbiguousError(
            `provider accounted for ${evidences.length} of ${group.providerRows.length} mutations`,
          );
        }
        const outcomes = group.expandEvidence(evidences).map(({ row, evidence }) =>
          outcomeFor(prepared.executionId, row, evidence),
        );
        const recorded = await this.store.recordOutcomes({
          orgId: payload.orgId, profileId: payload.profileId,
          executionId: payload.executionId, attemptedAt: now, outcomes,
        });
        shouldObserve ||= recorded.shouldObserve;
        latestAccounting = recorded.accounting;
      } catch (error) {
        if (error instanceof SpWriteRetryableError) {
          await this.store.releaseForRetry(payload);
          retryRequested = true;
          retryAfterSeconds = error.retryAfterSeconds;
          break;
        }
        const ambiguous = error instanceof SpWriteAmbiguousError;
        const evidence = failureEvidence(
          error,
          ambiguous ? 'ambiguous' : 'failed',
        );
        const outcomes = group.rows.map((row) => outcomeFor(prepared.executionId, row, evidence));
        const recorded = await this.store.recordOutcomes({
          orgId: payload.orgId, profileId: payload.profileId,
          executionId: payload.executionId, attemptedAt: now, outcomes,
        });
        shouldObserve ||= recorded.shouldObserve;
        latestAccounting = recorded.accounting;
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
      throw new SpWriteRetryableError('Amazon rejected the mutation before applying it', retryAfterSeconds);
    }
    if (shouldObserve) {
      await this.enqueueObservation(payload, 0, now);
    }
    return {
      status: shouldObserve ? 'awaiting_sync' : latestAccounting?.failed ? 'partial' : 'failed',
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
    };
  }

  private gateRefusal(profile: AdsProfileContext): string | null {
    if (!this.enabled) return 'deployment Amazon write gate is disabled';
    if (this.authorization === null) return 'bounded Amazon write authorization is missing';
    if (new Date(this.authorization.expires_at).getTime() <= this.now().getTime()) {
      return 'bounded Amazon write authorization expired';
    }
    if (!profileAllowed(profile, this.authorization)) return 'profile is absent from the Amazon write allowlist';
    return null;
  }

  private boundedRefusal(
    rows: readonly { action: AmazonWriteAction }[],
    inversePreapproved: boolean,
    authorization: BoundedAuthorization,
  ): string | null {
    for (const { action } of rows) {
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
      run: () => Promise<AmazonWriteProviderEvidence[]>;
      expandEvidence: (evidence: readonly AmazonWriteProviderEvidence[]) => Array<{
        row: (typeof rows)[number]; evidence: AmazonWriteProviderEvidence;
      }>;
    }> = [];
    const keyword = rows.filter((row) => row.action.actionType === 'sp_keyword_bid');
    for (const chunk of chunks(keyword, SP_WRITE_BATCH_SIZE)) {
      const providerRows = chunk.map((row) => ({ keywordId: row.action.amazonEntityId, bid: row.action.requestedValue }));
      groups.push({ rows: chunk, providerRows,
        run: () => this.provider.updateSpKeywordBids(profile, providerRows),
        expandEvidence: (evidence) => chunk.map((row, index) => ({ row, evidence: evidence[index] as AmazonWriteProviderEvidence })),
      });
    }
    const targets = rows.filter((row) => row.action.actionType === 'sp_target_bid');
    for (const chunk of chunks(targets, SP_WRITE_BATCH_SIZE)) {
      const providerRows = chunk.map((row) => ({ targetId: row.action.amazonEntityId, bid: row.action.requestedValue }));
      groups.push({ rows: chunk, providerRows,
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
        const placement = { ...first.action.campaignContext.placementBidding };
        for (const row of campaignRows) {
          if (JSON.stringify(row.action.campaignContext) !== JSON.stringify(first.action.campaignContext)) {
            throw new Error('placement rows for one campaign carry different current contexts');
          }
          if (row.action.field === 'top_of_search') placement.topOfSearch = row.action.requestedValue;
          if (row.action.field === 'product_pages') placement.productPages = row.action.requestedValue;
          if (row.action.field === 'rest_of_search') placement.restOfSearch = row.action.requestedValue;
        }
        const values = [
          ['top_of_search', placement.topOfSearch],
          ['product_pages', placement.productPages],
          ['rest_of_search', placement.restOfSearch],
        ] as const;
        return {
          campaignId,
          strategy: AMAZON_STRATEGY[first.action.campaignContext.strategy],
          placementBidding: values.flatMap(([field, percentage]) =>
            percentage === null ? [] : [{ placement: placementName(field), percentage }],
          ),
        };
        });
        const chunkRows = campaignChunk.flatMap(([, campaignRows]) => campaignRows);
        groups.push({ rows: chunkRows, providerRows,
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
    return this.store.enqueueObservation(
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
  authorization: BoundedAuthorization | null;
}): GuardedAmazonWriteRuntime {
  const postgresStore = input.workerStore instanceof PostgresWorkerStore
    ? input.workerStore
    : undefined;
  return new GuardedAmazonWriteRuntime({
    enabled: input.enabled,
    authorization: input.authorization,
    provider: input.provider,
    store: new PostgresAmazonWriteStore(input.handle, postgresStore),
  });
}
