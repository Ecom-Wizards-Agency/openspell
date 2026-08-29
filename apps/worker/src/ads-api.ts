import {
  AdsApiClient as UnderlyingAdsApiClient,
  AdsApiHttpError,
  AdsApiParseError,
  AdsApiWriteResponseError,
  AdsApiTimeoutError,
  AdsThrottleError,
  DuplicateReportError,
  DuplicateWriteError,
  SP_WRITE_BATCH_SIZE,
  type CreativeAssetProbePage,
  type ReportMetadata,
  type SbAdProbePage,
  type SpBatchWriteResult,
  toSpWriteEvidence,
  type SpKeywordUpdateInput,
  type SpTargetUpdateInput,
  type SpCampaignPlacementUpdateInput,
} from '@wizard-ads/ads-api';
import {
  getAdsRefreshToken,
  getProfileConnectionId,
  listActiveConnectionIdsForRegion,
  type DbHandle,
} from '@wizard-ads/db';
import {
  AmazonWriteProviderEvidence,
  type EntityRow,
  type Region,
  type WorkerReportType,
} from '@wizard-ads/shared';

/** The profile routing information every Amazon call needs. */
export interface AdsProfileContext {
  id: string;
  orgId: string;
  amazonProfileId: string;
  region: Region;
  currencyCode: string;
  timezone: string;
  /** Used only for an exact gitignored live-test allowlist match. */
  accountName?: string | null;
  countryCode?: string;
}

export interface CreateReportInput {
  profile: AdsProfileContext;
  reportType: WorkerReportType;
  startDate: string;
  endDate: string;
}

export interface AdsReportStatus {
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILURE' | 'CANCELLED';
  downloadUrl?: string;
  downloadExpiresAt?: Date;
  failureReason?: string;
}

/** The three ad products, each listed and mirrored independently. */
export type AdProductCode = 'SP' | 'SB' | 'SD';

/** One ad product's listing failed. The others are unaffected. */
export interface EntityListFailure {
  adProduct: AdProductCode;
  message: string;
  /** The original (already error-mapped) throwable, kept so the caller can
   * preserve retry typing when it decides the whole job failed. */
  error: unknown;
}

/**
 * The outcome of an entity listing, isolated per ad product.
 *
 * A 400 from Sponsored Brands must not cost the Sponsored Products rows that
 * listed cleanly — the first live sync lost all 3 products to one SB 400. So
 * the listing reports which products succeeded (their rows are in `rows`,
 * tagged by `EntityRow.adProduct`) and which failed, and the caller commits the
 * winners and records the losers rather than throwing everything away.
 */
export interface EntityListing {
  rows: readonly EntityRow[];
  succeeded: readonly AdProductCode[];
  failures: readonly EntityListFailure[];
}

/**
 * Narrow worker-owned boundary for WP-02. Tests implement this interface; the
 * production adapter will be a mechanical mapping onto the final client.
 */
export interface AdsApiClient {
  listEntities(profile: AdsProfileContext, full: boolean): Promise<EntityListing>;
  createReport(input: CreateReportInput): Promise<{ reportId: string }>;
  getReport(profile: AdsProfileContext, reportId: string): Promise<AdsReportStatus>;
  downloadReport(url: string): Promise<AsyncIterable<Uint8Array>>;
  listProfiles(region: Region): Promise<readonly string[]>;
}

/** One target's Amazon suggested-bid corridor for the day (WP-27 read). */
export interface SuggestedBidRead {
  targetId: string;
  low: number;
  median: number;
  high: number;
}

/** The SP keyword and product-target ids to read a suggested-bid corridor for. */
export interface SuggestedBidRequest {
  keywordIds: readonly string[];
  targetIds: readonly string[];
}

export interface SuggestedBidResult {
  /** By Amazon target id, the corridor Amazon answered with. */
  byTarget: Map<string, SuggestedBidRead>;
  /** Ids submitted across both endpoints. */
  submitted: number;
  /** Ids Amazon returned a corridor for. */
  returned: number;
  /** Ids Amazon returned an error for (still counted, just not corridors). */
  errors: number;
}

/**
 * The suggested-bid read capability, kept as its own interface rather than
 * folded into `AdsApiClient`.
 *
 * INTEGRATE (WP-28): the bid-series sync (`bid-series.ts`) depends on this, not
 * on the whole `AdsApiClient`, so the report/entity worker's own test doubles
 * stay untouched and this can be mocked in isolation. `DbAdsApiClient`
 * implements both, so one instance serves the worker and the sync.
 */
export interface SuggestedBidClient {
  getSpSuggestedBids(
    profile: AdsProfileContext,
    ids: SuggestedBidRequest,
  ): Promise<SuggestedBidResult>;
}

export interface SpWriteObservationRequest {
  keywordIds: readonly string[];
  targetIds: readonly string[];
  campaignIds: readonly string[];
}

export interface SpWriteObservationResult {
  rows: readonly EntityRow[];
  requested: number;
  returned: number;
  /** Logical Amazon list requests made across keywords, targets, and campaigns. */
  apiCalls: number;
}

export interface SpWriteMutationResult {
  evidence: AmazonWriteProviderEvidence[];
  apiCalls: number;
}

/** Worker-only mutation and targeted observation surface. */
export interface SpWriteClient {
  updateSpKeywordBids(
    profile: AdsProfileContext,
    items: readonly SpKeywordUpdateInput[],
  ): Promise<SpWriteMutationResult>;
  updateSpTargetBids(
    profile: AdsProfileContext,
    items: readonly SpTargetUpdateInput[],
  ): Promise<SpWriteMutationResult>;
  updateSpCampaignPlacements(
    profile: AdsProfileContext,
    items: readonly SpCampaignPlacementUpdateInput[],
  ): Promise<SpWriteMutationResult>;
  observeSpWriteEntities(
    profile: AdsProfileContext,
    request: SpWriteObservationRequest,
  ): Promise<SpWriteObservationResult>;
}

/** A throttle explicitly rejected the mutation before Amazon applied it. */
export class SpWriteRetryableError extends Error {
  constructor(message: string, readonly retryAfterSeconds?: number, readonly apiCalls = 1) {
    super(message);
    this.name = 'SpWriteRetryableError';
  }
}

/** A timeout or 5xx cannot prove whether Amazon applied the request. */
export class SpWriteAmbiguousError extends Error {
  constructor(message: string, readonly apiCalls = 1) {
    super(message);
    this.name = 'SpWriteAmbiguousError';
  }
}

/** Amazon deterministically rejected the whole HTTP mutation request. */
export class SpWriteFailedError extends Error {
  constructor(message: string, readonly apiCalls = 1) {
    super(message);
    this.name = 'SpWriteFailedError';
  }
}

/** Read-only, page-scoped seam used by the non-persisting SB Video probe. */
export interface SbVideoContractProbeClient {
  probeSbAdsPage(profile: AdsProfileContext): Promise<SbAdProbePage>;
  probeCreativeAssetsPage(profile: AdsProfileContext): Promise<CreativeAssetProbePage>;
}

export class AdsApiRetryableError extends Error {
  constructor(message: string, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = 'AdsApiRetryableError';
  }
}

export class DownloadUrlExpiredError extends AdsApiRetryableError {
  constructor(message = 'report download URL expired') {
    super(message);
    this.name = 'DownloadUrlExpiredError';
  }
}

/**
 * The methods this adapter drives on the real `@wizard-ads/ads-api` client.
 * A `Pick` rather than the whole class so a unit test can supply a mock that
 * implements only these, with no HTTP and no credentials.
 */
export type UnderlyingClient = Pick<
  UnderlyingAdsApiClient,
  | 'listSpCampaigns'
  | 'listSpAdGroups'
  | 'listSpKeywords'
  | 'listSpTargets'
  | 'listSpNegativeKeywords'
  | 'listSpCampaignNegativeKeywords'
  | 'listSpNegativeTargets'
  | 'listSpProductAds'
  | 'listSbCampaigns'
  | 'listSbAdGroups'
  | 'listSdCampaigns'
  | 'listSdAdGroups'
  | 'getProfiles'
  | 'createReport'
  | 'getReport'
  // INTEGRATE (WP-28): the two WP-27 suggested-bid reads the bid-series sync
  // drives. Added to the Pick so a unit test can mock only these without HTTP.
  | 'getSpKeywordBidRecommendations'
  | 'getSpTargetBidRecommendations'
> & Partial<Pick<
  UnderlyingAdsApiClient,
  | 'probeSbAdsPage'
  | 'probeCreativeAssetsPage'
  | 'updateSpKeywords'
  | 'updateSpTargets'
  | 'updateSpCampaignPlacementBidding'
>>;

/** The subset of `fetch` the report download needs. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AdsApiAdapterDeps {
  /** Amazon's connection id for one of our profile uuids, or null when it has none. */
  resolveConnectionId(profileId: string): Promise<string | null>;
  /** Active, credentialed connections that own a profile in the region. */
  listConnectionIds(region: Region): Promise<readonly string[]>;
  /** The Vault-backed refresh token for a connection. Never logged. */
  getRefreshToken(connectionId: string): Promise<string | null>;
  /** Build one region-scoped client for one connection's grant. */
  createClient(input: { connectionId: string; region: Region; refreshToken: string }): UnderlyingClient;
  /** Download transport. Defaults to the global `fetch`. */
  fetch?: FetchLike;
}

const KNOWN_REPORT_STATUSES = new Set<AdsReportStatus['status']>([
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILURE',
  'CANCELLED',
]);

/**
 * The worker's `AdsApiClient`, backed by the real Amazon client.
 *
 * One underlying client per `(connection, region)` pair, built lazily: the
 * refresh token is read from Vault the first time a connection is touched and
 * the client cached, because minting an access token per job would refresh the
 * grant hundreds of times an hour. An auth failure evicts the cache entry so a
 * rotated credential is picked up on the next attempt rather than never.
 *
 * Every Amazon error is narrowed to what the worker's retry policy can act on:
 * a 429 or 5xx (or a timeout) becomes `AdsApiRetryableError` so the job is
 * requeued with backoff, a stale download URL becomes `DownloadUrlExpiredError`
 * so the fetch re-polls, and everything else is left as-is for the generic
 * attempt counter to age out into the dead-letter.
 */
export class DbAdsApiClient implements AdsApiClient, SuggestedBidClient, SbVideoContractProbeClient, SpWriteClient {
  private readonly clients = new Map<string, UnderlyingClient>();
  private readonly fetch: FetchLike;

  constructor(private readonly deps: AdsApiAdapterDeps) {
    this.fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  }

  async listEntities(profile: AdsProfileContext, _full: boolean): Promise<EntityListing> {
    const client = await this.clientForProfile(profile);
    const p = profile.amazonProfileId;
    // Grouped by ad product so one product's failure is contained to that
    // product. Within a group the steps stay sequential: a single profile
    // firing a dozen simultaneous requests would defeat the region concurrency
    // cap the worker wraps this call in, and Amazon throttles a whole grant at
    // once.
    const groups: Array<{ product: AdProductCode; steps: Array<() => Promise<{ items: readonly unknown[] }>> }> = [
      {
        product: 'SP',
        steps: [
          () => client.listSpCampaigns(p),
          () => client.listSpAdGroups(p),
          () => client.listSpKeywords(p),
          () => client.listSpTargets(p),
          () => client.listSpProductAds(p),
          () => client.listSpNegativeKeywords(p),
          () => client.listSpCampaignNegativeKeywords(p),
          () => client.listSpNegativeTargets(p),
        ],
      },
      { product: 'SB', steps: [() => client.listSbCampaigns(p), () => client.listSbAdGroups(p)] },
      { product: 'SD', steps: [() => client.listSdCampaigns(p), () => client.listSdAdGroups(p)] },
    ];

    const rows: EntityRow[] = [];
    const succeeded: AdProductCode[] = [];
    const failures: EntityListFailure[] = [];
    for (const group of groups) {
      // Collect this product's rows into a scratch list first: if any step in
      // the group fails, the whole product is dropped, so a half-listed product
      // never reaches the mirror (where a `full` sync would tombstone the rest).
      const productRows: EntityRow[] = [];
      try {
        for (const step of group.steps) {
          const listed = await this.guard(profile.region, step);
          for (const item of listed.items) {
            // The mapper drops `profileId` (its own value is Amazon's id, not
            // our uuid); the worker owns the join, so we add ours back here.
            productRows.push({ ...(item as object), profileId: profile.id } as EntityRow);
          }
        }
        // A loop, not `push(...productRows)`: spreading a whole profile's SP
        // rows passes them as call arguments, and past ~65k that overflows the
        // stack — which is exactly how large profiles failed to sync at all.
        for (const row of productRows) rows.push(row);
        succeeded.push(group.product);
      } catch (error) {
        failures.push({ adProduct: group.product, message: errorText(error), error });
      }
    }
    return { rows, succeeded, failures };
  }

  async createReport(input: CreateReportInput): Promise<{ reportId: string }> {
    const client = await this.clientForProfile(input.profile);
    try {
      const meta = await client.createReport(input.profile.amazonProfileId, {
        reportType: input.reportType,
        startDate: input.startDate,
        endDate: input.endDate,
      });
      return { reportId: meta.reportId };
    } catch (error) {
      // A 425 is Amazon saying it already has this exact report in flight. The
      // right move is to adopt that report id, not mint a second copy.
      if (error instanceof DuplicateReportError) {
        if (error.existingReportId) return { reportId: error.existingReportId };
        throw new AdsApiRetryableError('duplicate report in flight with no id to adopt; retrying');
      }
      throw this.mapError(error);
    }
  }

  async getReport(profile: AdsProfileContext, reportId: string): Promise<AdsReportStatus> {
    const client = await this.clientForProfile(profile);
    const meta = await this.guard(profile.region, () => client.getReport(profile.amazonProfileId, reportId));
    return this.toReportStatus(meta);
  }

  async downloadReport(url: string): Promise<AsyncIterable<Uint8Array>> {
    let response: Response;
    try {
      response = await this.fetch(url);
    } catch (error) {
      // A dropped connection mid-download is worth retrying.
      throw new AdsApiRetryableError(errorText(error));
    }
    // A pre-signed S3 URL answers 403 once its signature has expired, and 410
    // once the object is gone. Both mean "the URL is stale" — re-poll for a
    // fresh one rather than retry the same dead link.
    if (response.status === 403 || response.status === 410) throw new DownloadUrlExpiredError();
    if (response.status === 429 || response.status >= 500) {
      throw new AdsApiRetryableError(`report download failed with ${response.status}`);
    }
    if (!response.ok) throw new Error(`report download failed with ${response.status}`);
    const body = response.body;
    if (!body) return emptyStream();
    return toByteStream(body);
  }

  /**
   * Read Amazon's daily suggested-bid corridor for a profile's SP keywords and
   * product targets (WP-27 endpoints). A read, despite being a POST: the client
   * marks it idempotent, so a transport failure retries safely.
   *
   * Errored ids are counted but not corridors — Amazon can answer some ids in a
   * batch and error others, and the sync writes a corridor only where one came
   * back. The two endpoints are hit sequentially for the same reason
   * `listEntities` is: one profile must not fire simultaneous requests past the
   * region concurrency cap the caller wraps this in.
   */
  async getSpSuggestedBids(
    profile: AdsProfileContext,
    ids: SuggestedBidRequest,
  ): Promise<SuggestedBidResult> {
    const client = await this.clientForProfile(profile);
    const byTarget = new Map<string, SuggestedBidRead>();
    let submitted = 0;
    let returned = 0;
    let errors = 0;

    const reads: Array<{ ids: readonly string[]; run: () => Promise<{ items: readonly { targetId: string; low: number; median: number; high: number }[]; errors: readonly unknown[] }> }> = [
      { ids: ids.keywordIds, run: () => client.getSpKeywordBidRecommendations(profile.amazonProfileId, ids.keywordIds) },
      { ids: ids.targetIds, run: () => client.getSpTargetBidRecommendations(profile.amazonProfileId, ids.targetIds) },
    ];

    for (const read of reads) {
      if (read.ids.length === 0) continue;
      submitted += read.ids.length;
      const result = await this.guard(profile.region, read.run);
      for (const item of result.items) {
        byTarget.set(item.targetId, {
          targetId: item.targetId,
          low: item.low,
          median: item.median,
          high: item.high,
        });
        returned += 1;
      }
      errors += result.errors.length;
    }

    return { byTarget, submitted, returned, errors };
  }

  async listProfiles(region: Region): Promise<readonly string[]> {
    const connectionIds = await this.deps.listConnectionIds(region);
    const profileIds: string[] = [];
    for (const connectionId of connectionIds) {
      const client = await this.clientFor(connectionId, region);
      if (!client) continue;
      const profiles = await this.guard(region, () => client.getProfiles(), connectionId);
      for (const profile of profiles) profileIds.push(profile.profileId);
    }
    return profileIds;
  }

  async updateSpKeywordBids(
    profile: AdsProfileContext,
    items: readonly SpKeywordUpdateInput[],
  ): Promise<SpWriteMutationResult> {
    const client = await this.clientForProfile(profile);
    if (!client.updateSpKeywords) throw new Error('Sponsored Products keyword writes are unavailable');
    return this.writeEvidence(() => client.updateSpKeywords!(profile.amazonProfileId, items));
  }

  async updateSpTargetBids(
    profile: AdsProfileContext,
    items: readonly SpTargetUpdateInput[],
  ): Promise<SpWriteMutationResult> {
    const client = await this.clientForProfile(profile);
    if (!client.updateSpTargets) throw new Error('Sponsored Products target writes are unavailable');
    return this.writeEvidence(() => client.updateSpTargets!(profile.amazonProfileId, items));
  }

  async updateSpCampaignPlacements(
    profile: AdsProfileContext,
    items: readonly SpCampaignPlacementUpdateInput[],
  ): Promise<SpWriteMutationResult> {
    const client = await this.clientForProfile(profile);
    if (!client.updateSpCampaignPlacementBidding) throw new Error('Sponsored Products placement writes are unavailable');
    return this.writeEvidence(() => client.updateSpCampaignPlacementBidding!(profile.amazonProfileId, items));
  }

  async observeSpWriteEntities(
    profile: AdsProfileContext,
    request: SpWriteObservationRequest,
  ): Promise<SpWriteObservationResult> {
    const client = await this.clientForProfile(profile);
    const keywordIds = [...new Set(request.keywordIds)];
    const targetIds = [...new Set(request.targetIds)];
    const campaignIds = [...new Set(request.campaignIds)];
    const requested = keywordIds.length + targetIds.length + campaignIds.length;
    const rows: EntityRow[] = [];
    let apiCalls = 0;
    const collect = async <T extends { amazonId: string }>(
      run: () => Promise<{ items: T[]; truncated: boolean; skipped: unknown[] }>,
      expectedIds: ReadonlySet<string>,
    ): Promise<void> => {
      apiCalls += 1;
      const listed = await this.guard(profile.region, run);
      if (listed.truncated || listed.skipped.length > 0) {
        throw new Error('targeted Sponsored Products observation was truncated or refused provider rows');
      }
      for (const item of listed.items) {
        if (!expectedIds.has(item.amazonId)) {
          throw new Error('targeted Sponsored Products observation returned an unrequested entity');
        }
        rows.push({ ...item, profileId: profile.id } as unknown as EntityRow);
      }
    };
    for (const ids of batchSpObservationIds(keywordIds)) {
      await collect(() => client.listSpKeywords(profile.amazonProfileId, {
        entityIdFilter: ids,
      }), new Set(ids));
    }
    for (const ids of batchSpObservationIds(targetIds)) {
      await collect(() => client.listSpTargets(profile.amazonProfileId, {
        entityIdFilter: ids,
      }), new Set(ids));
    }
    for (const ids of batchSpObservationIds(campaignIds)) {
      await collect(() => client.listSpCampaigns(profile.amazonProfileId, {
        entityIdFilter: ids,
      }), new Set(ids));
    }
    const uniqueReturned = new Set(rows.map((row) => `${row.entityType}:${row.amazonId}`));
    if (uniqueReturned.size !== rows.length) {
      throw new Error('targeted Sponsored Products observation returned duplicate entities');
    }
    return { rows, requested, returned: rows.length, apiCalls };
  }

  private async writeEvidence(
    run: () => Promise<SpBatchWriteResult>,
  ): Promise<SpWriteMutationResult> {
    try {
      const result = toSpWriteEvidence(await run());
      const evidence = result.evidence.map((evidence) => {
        const parsed = AmazonWriteProviderEvidence.safeParse({
          outcome: evidence.outcome,
          providerEntityId: evidence.providerEntityId,
          code: evidence.code,
          message: evidence.message,
        });
        if (!parsed.success) {
          throw new AdsApiParseError('Amazon write response contains invalid sanitized evidence');
        }
        return parsed.data;
      });
      return { evidence, apiCalls: result.apiCalls };
    } catch (error) {
      if (error instanceof AdsThrottleError) {
        throw new SpWriteRetryableError(
          error.message,
          error.retryAfterMs === null ? undefined : Math.ceil(error.retryAfterMs / 1_000),
          error.attempts,
        );
      }
      if (error instanceof AdsApiHttpError && error.status === 429) {
        throw new SpWriteRetryableError(error.message, undefined, error.attempts);
      }
      if (
        error instanceof AdsApiTimeoutError
        || error instanceof AdsApiParseError
        || error instanceof DuplicateWriteError
        || (error instanceof AdsApiHttpError && (error.status === 0 || error.status >= 500))
      ) {
        throw new SpWriteAmbiguousError(
          error instanceof Error ? error.message : String(error),
          error instanceof AdsApiWriteResponseError ? error.apiCalls
            : error instanceof AdsApiHttpError ? error.attempts : 1,
        );
      }
      if (error instanceof AdsApiHttpError) {
        throw new SpWriteFailedError(error.message, error.attempts);
      }
      throw error;
    }
  }

  async probeSbAdsPage(profile: AdsProfileContext): Promise<SbAdProbePage> {
    const client = await this.clientForProfile(profile);
    const probe = client.probeSbAdsPage;
    if (probe === undefined) {
      throw new Error('Sponsored Brands ad contract probe is not available on this client');
    }
    return this.guard(profile.region, () => probe.call(client, profile.amazonProfileId));
  }

  async probeCreativeAssetsPage(
    profile: AdsProfileContext,
  ): Promise<CreativeAssetProbePage> {
    const client = await this.clientForProfile(profile);
    const probe = client.probeCreativeAssetsPage;
    if (probe === undefined) {
      throw new Error('Creative Asset Library contract probe is not available on this client');
    }
    return this.guard(
      profile.region,
      () => probe.call(client, profile.amazonProfileId),
    );
  }

  private toReportStatus(meta: ReportMetadata): AdsReportStatus {
    const status = KNOWN_REPORT_STATUSES.has(meta.status as AdsReportStatus['status'])
      ? (meta.status as AdsReportStatus['status'])
      // An unrecognised status is treated as still-running: keep polling rather
      // than fail a report that may yet complete.
      : 'PROCESSING';
    const result: AdsReportStatus = { status };
    if (meta.url) result.downloadUrl = meta.url;
    if (meta.urlExpiresAt) {
      const expires = new Date(meta.urlExpiresAt);
      if (!Number.isNaN(expires.getTime())) result.downloadExpiresAt = expires;
    }
    if (meta.failureReason) result.failureReason = meta.failureReason;
    return result;
  }

  private async clientForProfile(profile: AdsProfileContext): Promise<UnderlyingClient> {
    const connectionId = await this.deps.resolveConnectionId(profile.id);
    if (!connectionId) throw new Error(`profile ${profile.id} has no Amazon connection`);
    const client = await this.clientFor(connectionId, profile.region);
    if (!client) throw new Error(`connection ${connectionId} has no stored refresh token`);
    return client;
  }

  private async clientFor(connectionId: string, region: Region): Promise<UnderlyingClient | null> {
    const key = `${connectionId}:${region}`;
    const cached = this.clients.get(key);
    if (cached) return cached;
    const refreshToken = await this.deps.getRefreshToken(connectionId);
    if (!refreshToken) return null;
    const client = this.deps.createClient({ connectionId, region, refreshToken });
    this.clients.set(key, client);
    return client;
  }

  private async guard<T>(region: Region, run: () => Promise<T>, evictConnectionId?: string): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw this.mapError(error, region, evictConnectionId);
    }
  }

  private mapError(error: unknown, region?: Region, evictConnectionId?: string): Error {
    if (error instanceof DownloadUrlExpiredError || error instanceof AdsApiRetryableError) return error;
    // Throttle first: it is a subclass of the generic HTTP error.
    if (error instanceof AdsThrottleError) {
      const retryAfter = error.retryAfterMs === null ? undefined : Math.ceil(error.retryAfterMs / 1000);
      return new AdsApiRetryableError(error.message, retryAfter);
    }
    if (error instanceof AdsApiHttpError) {
      // 401/403 mean the grant is dead: drop the cached client so a rotated
      // credential is refetched on the next attempt.
      if ((error.status === 401 || error.status === 403) && region && evictConnectionId) {
        this.clients.delete(`${evictConnectionId}:${region}`);
      }
      if (error.status === 429 || error.status >= 500) return new AdsApiRetryableError(error.message);
      return error;
    }
    if (error instanceof AdsApiTimeoutError) return new AdsApiRetryableError(error.message);
    return error instanceof Error ? error : new Error(String(error));
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function batchSpObservationIds(ids: readonly string[]): string[][] {
  const batches: string[][] = [];
  for (let index = 0; index < ids.length; index += SP_WRITE_BATCH_SIZE) {
    batches.push(ids.slice(index, index + SP_WRITE_BATCH_SIZE));
  }
  return batches;
}

async function* emptyStream(): AsyncGenerator<Uint8Array> {
  // nothing
}

/** Normalise a web `ReadableStream` or an already-async-iterable body to bytes. */
function toByteStream(body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in body) return body as AsyncIterable<Uint8Array>;
  return readWebStream(body);
}

async function* readWebStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Wire the adapter to the real database and the real Amazon client.
 *
 * The LWA app identity (`LWA_CLIENT_ID` / `LWA_CLIENT_SECRET`) is the same for
 * every connection — it is our application. The per-advertiser grant is the
 * refresh token, read from Vault per connection. The service-role database
 * handle is what makes `get_ads_refresh_token` callable at all.
 */
export function createAdsApiClientFromEnv(
  handle: DbHandle,
  env: NodeJS.ProcessEnv = process.env,
): DbAdsApiClient {
  // The web app (and therefore the Vercel-cron drain) already carries these as
  // AMAZON_-prefixed names for the OAuth flow; accept them as fallbacks so the
  // worker needs no second copy of the same LWA app identity.
  const clientId = env['LWA_CLIENT_ID'] ?? env['AMAZON_LWA_CLIENT_ID'];
  const clientSecret = env['LWA_CLIENT_SECRET'] ?? env['AMAZON_LWA_CLIENT_SECRET'];
  if (!clientId) throw new Error('LWA_CLIENT_ID (or AMAZON_LWA_CLIENT_ID) is not set');
  if (!clientSecret) throw new Error('LWA_CLIENT_SECRET (or AMAZON_LWA_CLIENT_SECRET) is not set');
  const userAgent = env['AMAZON_ADS_USER_AGENT'];

  return new DbAdsApiClient({
    resolveConnectionId: (profileId) => getProfileConnectionId(handle, profileId),
    listConnectionIds: (region) => listActiveConnectionIdsForRegion(handle, region),
    getRefreshToken: (connectionId) => getAdsRefreshToken(handle, connectionId),
    createClient: ({ region, refreshToken }) =>
      new UnderlyingAdsApiClient({
        region,
        credentials: { clientId, clientSecret, refreshToken },
        ...(userAgent ? { userAgent } : {}),
      }),
  });
}
