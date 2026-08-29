/**
 * `AdsApiClient`: one advertiser grant, one region, no state beyond an access
 * token and a throttle counter.
 *
 * What it deliberately does not do is as important as what it does. It does not
 * poll — Reporting v3 can take three hours and a client that blocks for three
 * hours is a worker that cannot be killed, so `createReport` and `getReport`
 * are separate calls and the worker owns the waiting (`report.request` →
 * `report.poll` → `report.fetch` in the job contract). It does not touch a
 * database, does not read the filesystem, and does not know what a tenant is:
 * profile ids go in as arguments, and rows come out without the `profileId` the
 * contract's fact and mirror shapes carry, because that field is our database's
 * uuid and only the worker holds both halves of that join.
 *
 * Ported from `SPAdsApiDataSource` (amazon-agent), whose live-verified parts
 * are marked at each method.
 */
import type {
  AdGroupRow,
  AdProduct,
  AmazonId,
  CampaignRow,
  KeywordRow,
  NegativeRow,
  ProductAdRow,
  Region,
  TargetRow,
} from '@wizard-ads/shared';
import { TokenProvider } from './auth.js';
import {
  BUDGET_USAGE_MEDIA_TYPE,
  BUDGET_USAGE_PATH,
  batchCampaignIds,
  buildBudgetUsageBody,
  parseBudgetUsageResponse,
  type BudgetUsage,
  type BudgetUsageFailure,
  type BudgetUsageResult,
} from './budgets.js';
import { createHttpContext, type EffectOptions } from './context.js';
import {
  DEFAULT_PAGE_SIZE,
  LIST_ENDPOINTS,
  SB_LIST_MAX_PAGE_SIZE,
  SP_WRITE_ENDPOINTS,
  buildListBody,
  buildOffsetQuery,
  type EntityKind,
  type SpWriteKind,
} from './endpoints.js';
import {
  AdsApiNotImplementedError,
  AdsApiParseError,
  DuplicateReportError,
  DuplicateWriteError,
} from './errors.js';
import {
  EXPORT_ENDPOINTS,
  type ExportKind,
  buildExportBody,
  type CreateExportInput,
  type ExportMetadata,
} from './exports.js';
import { adsHeaders } from './headers.js';
import { decodeText, httpRequest, type HttpContext, type HttpResult } from './http.js';
import { decodeJsonArray, type DecodedPayload } from './gzip.js';
import {
  mapAdGroups,
  mapCampaigns,
  mapKeywords,
  mapNegativeKeywords,
  mapNegativeTargets,
  mapProductAds,
  mapTargets,
  type MapResult,
  type MirrorRow,
  type SkippedEntity,
} from './mappers.js';
import { fetchProfiles, type AdsProfile } from './profiles.js';
import { hostFor } from './regions.js';
import { isRecord, readId, readNumber, readString } from './read.js';
import {
  CREATE_REPORT_CONTENT_TYPE,
  buildReportRequestBody,
  type CreateReportInput,
  type ReportMetadata,
} from './reports.js';
import {
  CREATIVE_ASSET_SEARCH_PATH,
  SB_AD_LIST_PATH,
  SB_AD_MEDIA_TYPE,
  parseCreativeAssetProbePage,
  parseSbAdProbePage,
  type CreativeAssetProbePage,
  type SbAdProbePage,
} from './sb-ad-assets.js';
import {
  SB_CREATIVE_LIST_PATH,
  SB_CREATIVE_MEDIA_TYPE,
  SB_CREATIVE_PATH,
  SB_MEDIA_DESCRIBE_PATH,
  SB_MEDIA_UPLOAD_PATH,
  batchSbCreatives,
  buildSbCreativeListBody,
  buildSbCreativeMutationBody,
  buildSbMediaUploadBody,
  parseSbCreativeListPage,
  parseSbCreativeMutationResponse,
  parseSbMediaAsset,
  type SbCreativeBatchResult,
  type SbCreativeListOptions,
  type SbCreativeListResult,
  type SbCreative,
  type SbCreativeCreateInput,
  type SbCreativeUpdateInput,
  type SbMediaAsset,
  type SbMediaUploadInput,
  type SbV4MediaCreativeApi,
} from './sb-media.js';
import {
  SP_BID_RECOMMENDATION_ENDPOINTS,
  batchSpBidRecommendationIds,
  buildSpBidRecommendationBody,
  parseSpBidRecommendationResponse,
  type SpBidRecommendationKind,
  type SpBidRecommendationResult,
} from './suggested-bids.js';
import type { AdsApiClientOptions, ListOptions, ListResult, ThrottleState } from './types.js';
import {
  batchSpWrites,
  buildSpArchiveBody,
  buildSpWriteBody,
  parseSpWriteResponse,
  type SpAdGroupCreateInput,
  type SpAdGroupUpdateInput,
  type SpBatchWriteResult,
  type SpCampaignCreateInput,
  type SpCampaignNegativeKeywordCreateInput,
  type SpCampaignNegativeKeywordUpdateInput,
  type SpCampaignNegativeTargetCreateInput,
  type SpCampaignNegativeTargetUpdateInput,
  type SpCampaignPlacementUpdateInput,
  type SpCampaignUpdateInput,
  type SpKeywordCreateInput,
  type SpKeywordUpdateInput,
  type SpNegativeKeywordCreateInput,
  type SpNegativeKeywordUpdateInput,
  type SpNegativeTargetCreateInput,
  type SpNegativeTargetUpdateInput,
  type SpProductAdCreateInput,
  type SpProductAdUpdateInput,
  type SpTargetCreateInput,
  type SpTargetUpdateInput,
} from './writes.js';

/** A page walk plus what mapping made of it. The two counts are the Rule 4 assertion. */
export interface MappedListResult<T> extends ListResult<T> {
  /** Objects Amazon returned, before mapping. `items + skipped` accounts for all of them. */
  raw: Record<string, unknown>[];
  skipped: SkippedEntity[];
}

export interface ReportDownload {
  rows: Record<string, unknown>[];
  /** Byte counts either side of decompression, for the report ledger. */
  payload: DecodedPayload;
}

export type ExportDownload = ReportDownload;

const AD_PRODUCT_NAMES: Readonly<Record<AdProduct, string>> = {
  SP: 'SPONSORED_PRODUCTS',
  SB: 'SPONSORED_BRANDS',
  SD: 'SPONSORED_DISPLAY',
};

/** Amazon's ad-product vocabulary for the ad products the contract names. */
export function amazonAdProduct(adProduct: AdProduct): string {
  return AD_PRODUCT_NAMES[adProduct];
}

export class AdsApiClient implements SbV4MediaCreativeApi {
  readonly region: Region;

  private readonly ctx: HttpContext;
  private readonly tokens: TokenProvider;
  private readonly clientId: string;
  private readonly userAgent: string | undefined;

  constructor(options: AdsApiClientOptions) {
    this.region = options.region;
    this.clientId = options.credentials.clientId;
    this.userAgent = options.userAgent;

    const effects: EffectOptions = {
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.random === undefined ? {} : { random: options.random }),
      ...(options.retry === undefined ? {} : { retry: options.retry }),
      ...(options.onRetry === undefined ? {} : { onRetry: options.onRetry }),
    };
    this.ctx = createHttpContext(options.region, effects);
    this.tokens = new TokenProvider(options.credentials, effects);
  }

  /**
   * What throttling this client has seen. The worker reads it between jobs to
   * decide whether to slow the whole profile down; the client itself only ever
   * retries the request in its hand.
   */
  get throttleState(): ThrottleState {
    return this.ctx.throttle.snapshot();
  }

  private readonly getAccessToken = (force: boolean): Promise<string> =>
    force ? this.tokens.forceRefresh() : this.tokens.getAccessToken();

  private headers(input: { profileId?: string; contentType?: string; accept?: string }) {
    return adsHeaders(this.getAccessToken, {
      clientId: this.clientId,
      ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
      ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
      ...(input.accept === undefined ? {} : { accept: input.accept }),
      ...(this.userAgent === undefined ? {} : { userAgent: this.userAgent }),
    });
  }

  private json(result: HttpResult, what: string): unknown {
    const text = decodeText(result.body);
    if (text.trim() === '') return null;
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new AdsApiParseError(`${what} returned a body that is not JSON`, cause);
    }
  }

  // -- profiles ---------------------------------------------------------

  /**
   * Every advertiser profile this grant can see on this client's region.
   * Live-verified in the reference (`exchange_token.py test`).
   */
  async getProfiles(): Promise<AdsProfile[]> {
    return fetchProfiles(this.ctx, this.region, this.clientId, this.getAccessToken, this.userAgent);
  }

  // -- entity lists -----------------------------------------------------

  /**
   * Walk one list endpoint to the end, or to `maxPages`.
   *
   * The page loop stops on an absent `nextToken` *and* on an empty page: a
   * token that keeps coming back with nothing behind it is a documented way for
   * a paginated API to loop forever, and a worker that loops forever on one
   * profile starves the other 210.
   */
  async listRaw(
    profileId: string,
    kind: EntityKind,
    options: ListOptions = {},
  ): Promise<ListResult<Record<string, unknown>>> {
    const endpoint = LIST_ENDPOINTS[kind];
    // Clamp to the endpoint's own ceiling: SB v4 list 400s on maxResults > 100,
    // and the shared DEFAULT_PAGE_SIZE (500) is what aborted the first live sync.
    const requested = options.maxResults ?? DEFAULT_PAGE_SIZE;
    const pageSize = endpoint.maxPageSize === undefined ? requested : Math.min(requested, endpoint.maxPageSize);
    const items: Record<string, unknown>[] = [];
    const seenTokens = new Set<string>();
    let pages = 0;
    let nextToken: string | null = null;
    let startIndex = 0;

    for (;;) {
      if (options.maxPages !== undefined && pages >= options.maxPages) {
        return { items, pages, truncated: true, nextToken };
      }

      const isOffset = endpoint.paging === 'offset';
      const url = isOffset
        ? `${hostFor(this.region)}${endpoint.path}?${buildOffsetQuery(endpoint, {
            startIndex,
            count: pageSize,
            ...(options.stateFilter === undefined ? {} : { stateFilter: options.stateFilter }),
            ...(options.campaignIdFilter === undefined ? {} : { campaignIdFilter: options.campaignIdFilter }),
          })}`
        : `${hostFor(this.region)}${endpoint.path}`;

      const body = isOffset
        ? undefined
        : JSON.stringify(
            buildListBody(endpoint, {
              maxResults: pageSize,
              nextToken,
              ...(options.stateFilter === undefined ? {} : { stateFilter: options.stateFilter }),
              ...(options.campaignIdFilter === undefined ? {} : { campaignIdFilter: options.campaignIdFilter }),
              ...(options.adGroupIdFilter === undefined ? {} : { adGroupIdFilter: options.adGroupIdFilter }),
            }),
          );

      const result: HttpResult = await httpRequest(this.ctx, {
        method: endpoint.method,
        url,
        path: endpoint.path,
        headers: this.headers({
          profileId,
          contentType: endpoint.method === 'POST' ? endpoint.mediaType : undefined,
          accept: endpoint.mediaType,
        }),
        ...(body === undefined ? {} : { body }),
        // A list call is a read whatever verb it uses, so a 5xx is safe to retry.
        idempotent: true,
      });
      pages += 1;

      const parsed = this.json(result, `${endpoint.method} ${endpoint.path}`);
      const page = this.readPage(parsed, endpoint.responseKey, endpoint.path);
      items.push(...page.rows);

      if (isOffset) {
        if (page.rows.length < pageSize) return { items, pages, truncated: false, nextToken: null };
        startIndex += page.rows.length;
        continue;
      }

      nextToken = page.nextToken;
      if (nextToken === null || page.rows.length === 0) {
        return { items, pages, truncated: false, nextToken: null };
      }
      // A token that repeats is a page that never advances. Failing beats
      // looping: a worker stuck on one profile starves the other 210.
      if (seenTokens.has(nextToken)) {
        throw new AdsApiParseError(
          `${endpoint.path} returned the same nextToken twice after ${pages} pages`,
        );
      }
      seenTokens.add(nextToken);
    }
  }

  private readPage(
    parsed: unknown,
    responseKey: string,
    path: string,
  ): { rows: Record<string, unknown>[]; nextToken: string | null } {
    // Sponsored Display answers with a bare array and no pagination envelope.
    if (Array.isArray(parsed)) {
      return { rows: parsed.filter(isRecord), nextToken: null };
    }
    if (!isRecord(parsed)) {
      throw new AdsApiParseError(`${path} returned neither an array nor an object`);
    }
    const raw = parsed[responseKey];
    if (raw === undefined) {
      // An unknown key is not an empty page. Saying so is the difference between
      // a mirror that is empty and a mirror that looks synced and is not.
      throw new AdsApiParseError(
        `${path} response has no '${responseKey}' array (keys: ${Object.keys(parsed).sort().join(', ')})`,
      );
    }
    if (!Array.isArray(raw)) {
      throw new AdsApiParseError(`${path} response field '${responseKey}' is not an array`);
    }
    return { rows: raw.filter(isRecord), nextToken: readString(parsed, 'nextToken') };
  }

  private async listMapped<T>(
    profileId: string,
    kind: EntityKind,
    options: ListOptions,
    map: (raw: readonly unknown[]) => MapResult<T>,
  ): Promise<MappedListResult<T>> {
    const listed = await this.listRaw(profileId, kind, options);
    const mapped = map(listed.items);
    return {
      items: mapped.rows,
      pages: listed.pages,
      truncated: listed.truncated,
      nextToken: listed.nextToken,
      raw: listed.items,
      skipped: mapped.skipped,
    };
  }

  listSpCampaigns(profileId: string, options: ListOptions = {}): Promise<MappedListResult<MirrorRow<CampaignRow>>> {
    return this.listMapped(profileId, 'sp.campaigns', options, (raw) => mapCampaigns('SP', raw));
  }

  listSpAdGroups(profileId: string, options: ListOptions = {}): Promise<MappedListResult<MirrorRow<AdGroupRow>>> {
    return this.listMapped(profileId, 'sp.adGroups', options, (raw) => mapAdGroups('SP', raw));
  }

  listSpKeywords(profileId: string, options: ListOptions = {}): Promise<MappedListResult<MirrorRow<KeywordRow>>> {
    return this.listMapped(profileId, 'sp.keywords', options, mapKeywords);
  }

  listSpTargets(profileId: string, options: ListOptions = {}): Promise<MappedListResult<MirrorRow<TargetRow>>> {
    return this.listMapped(profileId, 'sp.targets', options, mapTargets);
  }

  listSpNegativeKeywords(
    profileId: string,
    options: ListOptions = {},
  ): Promise<MappedListResult<MirrorRow<NegativeRow>>> {
    return this.listMapped(profileId, 'sp.negativeKeywords', options, (raw) =>
      mapNegativeKeywords(raw, 'ad_group'),
    );
  }

  listSpCampaignNegativeKeywords(
    profileId: string,
    options: ListOptions = {},
  ): Promise<MappedListResult<MirrorRow<NegativeRow>>> {
    return this.listMapped(profileId, 'sp.campaignNegativeKeywords', options, (raw) =>
      mapNegativeKeywords(raw, 'campaign'),
    );
  }

  listSpNegativeTargets(
    profileId: string,
    options: ListOptions = {},
  ): Promise<MappedListResult<MirrorRow<NegativeRow>>> {
    return this.listMapped(profileId, 'sp.negativeTargets', options, (raw) =>
      mapNegativeTargets(raw, 'ad_group'),
    );
  }

  listSpProductAds(profileId: string, options: ListOptions = {}): Promise<MappedListResult<MirrorRow<ProductAdRow>>> {
    return this.listMapped(profileId, 'sp.productAds', options, mapProductAds);
  }

  /** Sponsored Brands campaign management is v4 only; v3 was shut off in 2024. */
  listSbCampaigns(profileId: string, options: ListOptions = {}): Promise<MappedListResult<MirrorRow<CampaignRow>>> {
    return this.listMapped(profileId, 'sb.campaigns', options, (raw) => mapCampaigns('SB', raw));
  }

  listSbAdGroups(profileId: string, options: ListOptions = {}): Promise<MappedListResult<MirrorRow<AdGroupRow>>> {
    return this.listMapped(profileId, 'sb.adGroups', options, (raw) => mapAdGroups('SB', raw));
  }

  listSdCampaigns(profileId: string, options: ListOptions = {}): Promise<MappedListResult<MirrorRow<CampaignRow>>> {
    return this.listMapped(profileId, 'sd.campaigns', options, (raw) => mapCampaigns('SD', raw));
  }

  listSdAdGroups(profileId: string, options: ListOptions = {}): Promise<MappedListResult<MirrorRow<AdGroupRow>>> {
    return this.listMapped(profileId, 'sd.adGroups', options, (raw) => mapAdGroups('SD', raw));
  }

  // -- Sponsored Products v3 writes -----------------------------------

  private async mutateSp<K extends SpWriteKind>(
    profileId: string,
    kind: K,
    operation: 'create' | 'update' | 'archive',
    values: readonly unknown[],
  ): Promise<SpBatchWriteResult<K>> {
    const endpoint = SP_WRITE_ENDPOINTS[kind];
    const items: SpBatchWriteResult<K>['items'] = [];
    const errors: SpBatchWriteResult<K>['errors'] = [];
    const batches = batchSpWrites(values);
    let indexOffset = 0;

    for (const batch of batches) {
      const path = operation === 'archive' ? `${endpoint.path}/delete` : endpoint.path;
      const method = operation === 'update' ? 'PUT' : 'POST';
      const body =
        operation === 'archive'
          ? buildSpArchiveBody(endpoint, batch as readonly AmazonId[])
          : buildSpWriteBody(endpoint, batch);
      const result = await httpRequest(this.ctx, {
        method,
        url: `${hostFor(this.region)}${path}`,
        path,
        headers: this.headers({
          profileId,
          contentType: endpoint.mediaType,
          accept: endpoint.mediaType,
        }),
        body: JSON.stringify(body),
        // An explicit 429 means Amazon rejected the request before mutation.
        // Ambiguous transport and 5xx failures are never re-sent.
        idempotent: false,
        expectedStatuses: [425],
      });

      if (result.status === 425) {
        throw new DuplicateWriteError(
          `Amazon identified ${operation} ${endpoint.path} as a duplicate write`,
          result.status,
          decodeText(result.body),
          result.attempts,
          operation,
          endpoint.path,
        );
      }

      const parsed = parseSpWriteResponse(
        this.json(result, `${method} ${path}`),
        kind,
        endpoint,
        batch.length,
        indexOffset,
      );
      items.push(...parsed.items);
      errors.push(...parsed.errors);
      indexOffset += batch.length;
    }

    if (items.length + errors.length !== values.length) {
      throw new AdsApiParseError(
        `${operation} ${endpoint.path} accounted for ${items.length + errors.length} of ${values.length} submitted items`,
      );
    }
    return { items, errors, submitted: values.length, batches: batches.length };
  }

  createSpCampaigns(profileId: string, items: readonly SpCampaignCreateInput[]): Promise<SpBatchWriteResult<'campaigns'>> {
    return this.mutateSp(profileId, 'campaigns', 'create', items);
  }

  updateSpCampaigns(profileId: string, items: readonly SpCampaignUpdateInput[]): Promise<SpBatchWriteResult<'campaigns'>> {
    return this.mutateSp(profileId, 'campaigns', 'update', items);
  }

  archiveSpCampaigns(profileId: string, campaignIds: readonly AmazonId[]): Promise<SpBatchWriteResult<'campaigns'>> {
    return this.mutateSp(profileId, 'campaigns', 'archive', campaignIds);
  }

  updateSpCampaignPlacementBidding(
    profileId: string,
    items: readonly SpCampaignPlacementUpdateInput[],
  ): Promise<SpBatchWriteResult<'campaigns'>> {
    return this.updateSpCampaigns(
      profileId,
      items.map((item) => ({
        campaignId: item.campaignId,
        dynamicBidding: {
          strategy: item.strategy,
          placementBidding: item.placementBidding,
        },
        ...(item.offAmazonSettings === undefined ? {} : { offAmazonSettings: item.offAmazonSettings }),
      })),
    );
  }

  createSpAdGroups(profileId: string, items: readonly SpAdGroupCreateInput[]): Promise<SpBatchWriteResult<'adGroups'>> {
    return this.mutateSp(profileId, 'adGroups', 'create', items);
  }

  updateSpAdGroups(profileId: string, items: readonly SpAdGroupUpdateInput[]): Promise<SpBatchWriteResult<'adGroups'>> {
    return this.mutateSp(profileId, 'adGroups', 'update', items);
  }

  archiveSpAdGroups(profileId: string, ids: readonly AmazonId[]): Promise<SpBatchWriteResult<'adGroups'>> {
    return this.mutateSp(profileId, 'adGroups', 'archive', ids);
  }

  createSpKeywords(profileId: string, items: readonly SpKeywordCreateInput[]): Promise<SpBatchWriteResult<'keywords'>> {
    return this.mutateSp(profileId, 'keywords', 'create', items);
  }

  updateSpKeywords(profileId: string, items: readonly SpKeywordUpdateInput[]): Promise<SpBatchWriteResult<'keywords'>> {
    return this.mutateSp(profileId, 'keywords', 'update', items);
  }

  archiveSpKeywords(profileId: string, ids: readonly AmazonId[]): Promise<SpBatchWriteResult<'keywords'>> {
    return this.mutateSp(profileId, 'keywords', 'archive', ids);
  }

  createSpTargets(profileId: string, items: readonly SpTargetCreateInput[]): Promise<SpBatchWriteResult<'targets'>> {
    return this.mutateSp(profileId, 'targets', 'create', items);
  }

  updateSpTargets(profileId: string, items: readonly SpTargetUpdateInput[]): Promise<SpBatchWriteResult<'targets'>> {
    return this.mutateSp(profileId, 'targets', 'update', items);
  }

  archiveSpTargets(profileId: string, ids: readonly AmazonId[]): Promise<SpBatchWriteResult<'targets'>> {
    return this.mutateSp(profileId, 'targets', 'archive', ids);
  }

  createSpNegativeKeywords(
    profileId: string,
    items: readonly SpNegativeKeywordCreateInput[],
  ): Promise<SpBatchWriteResult<'negativeKeywords'>> {
    return this.mutateSp(profileId, 'negativeKeywords', 'create', items);
  }

  updateSpNegativeKeywords(
    profileId: string,
    items: readonly SpNegativeKeywordUpdateInput[],
  ): Promise<SpBatchWriteResult<'negativeKeywords'>> {
    return this.mutateSp(profileId, 'negativeKeywords', 'update', items);
  }

  archiveSpNegativeKeywords(profileId: string, ids: readonly AmazonId[]): Promise<SpBatchWriteResult<'negativeKeywords'>> {
    return this.mutateSp(profileId, 'negativeKeywords', 'archive', ids);
  }

  createSpCampaignNegativeKeywords(
    profileId: string,
    items: readonly SpCampaignNegativeKeywordCreateInput[],
  ): Promise<SpBatchWriteResult<'campaignNegativeKeywords'>> {
    return this.mutateSp(profileId, 'campaignNegativeKeywords', 'create', items);
  }

  updateSpCampaignNegativeKeywords(
    profileId: string,
    items: readonly SpCampaignNegativeKeywordUpdateInput[],
  ): Promise<SpBatchWriteResult<'campaignNegativeKeywords'>> {
    return this.mutateSp(profileId, 'campaignNegativeKeywords', 'update', items);
  }

  archiveSpCampaignNegativeKeywords(
    profileId: string,
    ids: readonly AmazonId[],
  ): Promise<SpBatchWriteResult<'campaignNegativeKeywords'>> {
    return this.mutateSp(profileId, 'campaignNegativeKeywords', 'archive', ids);
  }

  createSpNegativeTargets(
    profileId: string,
    items: readonly SpNegativeTargetCreateInput[],
  ): Promise<SpBatchWriteResult<'negativeTargets'>> {
    return this.mutateSp(profileId, 'negativeTargets', 'create', items);
  }

  updateSpNegativeTargets(
    profileId: string,
    items: readonly SpNegativeTargetUpdateInput[],
  ): Promise<SpBatchWriteResult<'negativeTargets'>> {
    return this.mutateSp(profileId, 'negativeTargets', 'update', items);
  }

  archiveSpNegativeTargets(profileId: string, ids: readonly AmazonId[]): Promise<SpBatchWriteResult<'negativeTargets'>> {
    return this.mutateSp(profileId, 'negativeTargets', 'archive', ids);
  }

  createSpCampaignNegativeTargets(
    profileId: string,
    items: readonly SpCampaignNegativeTargetCreateInput[],
  ): Promise<SpBatchWriteResult<'campaignNegativeTargets'>> {
    return this.mutateSp(profileId, 'campaignNegativeTargets', 'create', items);
  }

  updateSpCampaignNegativeTargets(
    profileId: string,
    items: readonly SpCampaignNegativeTargetUpdateInput[],
  ): Promise<SpBatchWriteResult<'campaignNegativeTargets'>> {
    return this.mutateSp(profileId, 'campaignNegativeTargets', 'update', items);
  }

  archiveSpCampaignNegativeTargets(
    profileId: string,
    ids: readonly AmazonId[],
  ): Promise<SpBatchWriteResult<'campaignNegativeTargets'>> {
    return this.mutateSp(profileId, 'campaignNegativeTargets', 'archive', ids);
  }

  createSpProductAds(profileId: string, items: readonly SpProductAdCreateInput[]): Promise<SpBatchWriteResult<'productAds'>> {
    return this.mutateSp(profileId, 'productAds', 'create', items);
  }

  updateSpProductAds(profileId: string, items: readonly SpProductAdUpdateInput[]): Promise<SpBatchWriteResult<'productAds'>> {
    return this.mutateSp(profileId, 'productAds', 'update', items);
  }

  archiveSpProductAds(profileId: string, ids: readonly AmazonId[]): Promise<SpBatchWriteResult<'productAds'>> {
    return this.mutateSp(profileId, 'productAds', 'archive', ids);
  }

  // -- Sponsored Products suggested bids ------------------------------

  private async getSpBidRecommendations(
    profileId: string,
    kind: SpBidRecommendationKind,
    ids: readonly AmazonId[],
  ): Promise<SpBidRecommendationResult> {
    const endpoint = SP_BID_RECOMMENDATION_ENDPOINTS[kind];
    const items: SpBidRecommendationResult['items'] = [];
    const errors: SpBidRecommendationResult['errors'] = [];
    const batches = batchSpBidRecommendationIds(ids);
    let indexOffset = 0;

    for (const batch of batches) {
      const result = await httpRequest(this.ctx, {
        method: 'POST',
        url: `${hostFor(this.region)}${endpoint.path}`,
        path: endpoint.path,
        headers: this.headers({
          profileId,
          contentType: endpoint.mediaType,
          accept: endpoint.mediaType,
        }),
        body: JSON.stringify(buildSpBidRecommendationBody(endpoint, batch)),
        // This POST only reads Amazon's current daily recommendation.
        idempotent: true,
      });
      const parsed = parseSpBidRecommendationResponse(
        this.json(result, `POST ${endpoint.path}`),
        kind,
        endpoint,
        batch,
        indexOffset,
      );
      items.push(...parsed.items);
      errors.push(...parsed.errors);
      indexOffset += batch.length;
    }

    if (items.length + errors.length !== ids.length) {
      throw new AdsApiParseError(
        `${endpoint.path} accounted for ${items.length + errors.length} of ${ids.length} submitted ids`,
      );
    }
    return { items, errors, submitted: ids.length, batches: batches.length };
  }

  getSpKeywordBidRecommendations(
    profileId: string,
    keywordIds: readonly AmazonId[],
  ): Promise<SpBidRecommendationResult> {
    return this.getSpBidRecommendations(profileId, 'keywords', keywordIds);
  }

  getSpProductTargetBidRecommendations(
    profileId: string,
    targetIds: readonly AmazonId[],
  ): Promise<SpBidRecommendationResult> {
    return this.getSpBidRecommendations(profileId, 'targets', targetIds);
  }

  /** Short alias for callers whose SP target mirror already implies product targeting. */
  getSpTargetBidRecommendations(
    profileId: string,
    targetIds: readonly AmazonId[],
  ): Promise<SpBidRecommendationResult> {
    return this.getSpProductTargetBidRecommendations(profileId, targetIds);
  }

  // -- Sponsored Brands v4 media/creative -----------------------------

  async uploadSbMedia(profileId: string, input: SbMediaUploadInput): Promise<SbMediaAsset> {
    const multipart = buildSbMediaUploadBody(input);
    const result = await httpRequest(this.ctx, {
      method: 'POST',
      url: `${hostFor(this.region)}${SB_MEDIA_UPLOAD_PATH}`,
      path: SB_MEDIA_UPLOAD_PATH,
      headers: this.headers({ profileId, contentType: multipart.contentType, accept: 'application/json' }),
      body: multipart.body,
      // A 429 explicitly means the upload was rejected before mutation. Other
      // ambiguous failures are not re-sent by the HTTP layer.
      idempotent: false,
      expectedStatuses: [425],
    });
    if (result.status === 425) {
      throw new DuplicateWriteError(
        'Amazon identified the media upload as a duplicate write',
        result.status,
        decodeText(result.body),
        result.attempts,
        'upload',
        SB_MEDIA_UPLOAD_PATH,
      );
    }
    return parseSbMediaAsset(this.json(result, `POST ${SB_MEDIA_UPLOAD_PATH}`), `POST ${SB_MEDIA_UPLOAD_PATH}`, input.mediaType);
  }

  async getSbMedia(profileId: string, mediaId: AmazonId): Promise<SbMediaAsset> {
    const query = new URLSearchParams({ mediaId }).toString();
    const result = await httpRequest(this.ctx, {
      method: 'GET',
      url: `${hostFor(this.region)}${SB_MEDIA_DESCRIBE_PATH}?${query}`,
      path: SB_MEDIA_DESCRIBE_PATH,
      headers: this.headers({ profileId, accept: 'application/json' }),
      idempotent: true,
    });
    return parseSbMediaAsset(this.json(result, `GET ${SB_MEDIA_DESCRIBE_PATH}`), `GET ${SB_MEDIA_DESCRIBE_PATH}`);
  }

  private async mutateSbCreatives(
    profileId: string,
    operation: 'create' | 'update',
    inputs: readonly (SbCreativeCreateInput | SbCreativeUpdateInput)[],
  ): Promise<SbCreativeBatchResult> {
    const items: SbCreativeBatchResult['items'] = [];
    const errors: SbCreativeBatchResult['errors'] = [];
    const batches = batchSbCreatives(inputs);
    let indexOffset = 0;

    for (const batch of batches) {
      const method = operation === 'create' ? 'POST' : 'PUT';
      const result = await httpRequest(this.ctx, {
        method,
        url: `${hostFor(this.region)}${SB_CREATIVE_PATH}`,
        path: SB_CREATIVE_PATH,
        headers: this.headers({
          profileId,
          contentType: SB_CREATIVE_MEDIA_TYPE,
          accept: SB_CREATIVE_MEDIA_TYPE,
        }),
        body: JSON.stringify(buildSbCreativeMutationBody(batch)),
        idempotent: false,
        expectedStatuses: [425],
      });
      if (result.status === 425) {
        throw new DuplicateWriteError(
          `Amazon identified SB creative ${operation} as a duplicate write`,
          result.status,
          decodeText(result.body),
          result.attempts,
          operation,
          SB_CREATIVE_PATH,
        );
      }
      const parsed = parseSbCreativeMutationResponse(
        this.json(result, `${method} ${SB_CREATIVE_PATH}`),
        batch.length,
        indexOffset,
      );
      items.push(...parsed.items);
      errors.push(...parsed.errors);
      indexOffset += batch.length;
    }

    if (items.length + errors.length !== inputs.length) {
      throw new AdsApiParseError(
        `${operation} ${SB_CREATIVE_PATH} accounted for ${items.length + errors.length} of ${inputs.length} submitted items`,
      );
    }
    return { items, errors, submitted: inputs.length, batches: batches.length };
  }

  createSbCreatives(
    profileId: string,
    inputs: readonly SbCreativeCreateInput[],
  ): Promise<SbCreativeBatchResult> {
    return this.mutateSbCreatives(profileId, 'create', inputs);
  }

  updateSbCreatives(
    profileId: string,
    inputs: readonly SbCreativeUpdateInput[],
  ): Promise<SbCreativeBatchResult> {
    return this.mutateSbCreatives(profileId, 'update', inputs);
  }

  async createSbCreative(profileId: string, input: SbCreativeCreateInput): Promise<SbCreative> {
    const result = await this.createSbCreatives(profileId, [input]);
    const item = result.items[0];
    if (item?.creative === null || item?.creative === undefined) {
      throw new AdsApiParseError(`${SB_CREATIVE_PATH} create response did not return the creative representation`);
    }
    return item.creative;
  }

  async updateSbCreative(profileId: string, input: SbCreativeUpdateInput): Promise<SbCreative> {
    const result = await this.updateSbCreatives(profileId, [input]);
    const item = result.items[0];
    if (item?.creative === null || item?.creative === undefined) {
      throw new AdsApiParseError(`${SB_CREATIVE_PATH} update response did not return the creative representation`);
    }
    return item.creative;
  }

  async listSbCreatives(
    profileId: string,
    options: SbCreativeListOptions = {},
  ): Promise<SbCreativeListResult> {
    const items: SbCreative[] = [];
    const seenTokens = new Set<string>();
    // SB v4 list endpoints cap maxResults at 100 (see SB_LIST_MAX_PAGE_SIZE);
    // DEFAULT_PAGE_SIZE (500) would 400 exactly as the campaign list did.
    const maxResults = Math.min(options.maxResults ?? DEFAULT_PAGE_SIZE, SB_LIST_MAX_PAGE_SIZE);
    let nextToken = options.nextToken ?? null;
    let pages = 0;

    for (;;) {
      if (options.maxPages !== undefined && pages >= options.maxPages) {
        return { items, pages, truncated: true, nextToken };
      }
      const result = await httpRequest(this.ctx, {
        method: 'POST',
        url: `${hostFor(this.region)}${SB_CREATIVE_LIST_PATH}`,
        path: SB_CREATIVE_LIST_PATH,
        headers: this.headers({
          profileId,
          contentType: SB_CREATIVE_MEDIA_TYPE,
          accept: SB_CREATIVE_MEDIA_TYPE,
        }),
        body: JSON.stringify(buildSbCreativeListBody(maxResults, nextToken, options)),
        idempotent: true,
      });
      pages += 1;
      const page = parseSbCreativeListPage(this.json(result, `POST ${SB_CREATIVE_LIST_PATH}`));
      items.push(...page.items);
      nextToken = page.nextToken;
      if (nextToken === null || page.items.length === 0) {
        return { items, pages, truncated: false, nextToken: null };
      }
      if (seenTokens.has(nextToken)) {
        throw new AdsApiParseError(`${SB_CREATIVE_LIST_PATH} returned the same nextToken twice after ${pages} pages`);
      }
      seenTokens.add(nextToken);
    }
  }

  /**
   * Fetch exactly one Sponsored Brands ads page for a non-persisting contract
   * probe. Pagination and promotion stay disabled until a live response proves
   * the provider's current token and identity fields.
   */
  async probeSbAdsPage(profileId: string): Promise<SbAdProbePage> {
    const result = await httpRequest(this.ctx, {
      method: 'POST',
      url: `${hostFor(this.region)}${SB_AD_LIST_PATH}`,
      path: SB_AD_LIST_PATH,
      headers: this.headers({
        profileId,
        contentType: SB_AD_MEDIA_TYPE,
        accept: SB_AD_MEDIA_TYPE,
      }),
      body: JSON.stringify({ maxResults: SB_LIST_MAX_PAGE_SIZE }),
      idempotent: true,
    });
    return parseSbAdProbePage(this.json(result, `POST ${SB_AD_LIST_PATH}`));
  }

  /** One Creative Asset Library page, read-only and deliberately unpaginated. */
  async probeCreativeAssetsPage(profileId: string): Promise<CreativeAssetProbePage> {
    const result = await httpRequest(this.ctx, {
      method: 'POST',
      url: `${hostFor(this.region)}${CREATIVE_ASSET_SEARCH_PATH}`,
      path: CREATIVE_ASSET_SEARCH_PATH,
      headers: this.headers({
        profileId,
        contentType: 'application/json',
        accept: 'application/json',
      }),
      body: '{}',
      idempotent: true,
    });
    return parseCreativeAssetProbePage(
      this.json(result, `POST ${CREATIVE_ASSET_SEARCH_PATH}`),
    );
  }

  /**
   * Deliberate stub: WP-27 covers SB creative create/update/list. Amazon's
   * archive/delete route is ad-type-specific and the generic v4 creative
   * contract does not define one, so choosing a path here would be a write to
   * an unverified endpoint rather than a safe model.
   */
  archiveSbCreative(_profileId: string, _creativeId: AmazonId): Promise<void> {
    throw new AdsApiNotImplementedError(
      'Sponsored Brands v4 creative archive remains unavailable: no generic archive endpoint is defined',
    );
  }

  // -- reporting v3 -----------------------------------------------------

  /**
   * Mint a report. Returns as soon as Amazon accepts it; generation takes
   * minutes to three hours, and waiting is the worker's job.
   *
   * A 425 means Amazon already has an identical request in flight. That is a
   * success, not an error — the right response is to adopt the existing report
   * id — so it is raised as its own type carrying whatever id the body held.
   * Live-verified through acceptance (2026-08-13); 425 handling is not.
   */
  async createReport(profileId: string, input: CreateReportInput): Promise<ReportMetadata> {
    const result = await httpRequest(this.ctx, {
      method: 'POST',
      url: `${hostFor(this.region)}/reporting/reports`,
      path: '/reporting/reports',
      headers: this.headers({
        profileId,
        contentType: CREATE_REPORT_CONTENT_TYPE,
        accept: 'application/json',
      }),
      body: JSON.stringify(buildReportRequestBody(input)),
      // Never re-sent blind: a duplicate report costs quota and Amazon answers
      // 425 for exactly this case, which the caller handles deliberately.
      idempotent: false,
      expectedStatuses: [425],
    });

    const parsed = this.json(result, 'POST /reporting/reports');

    if (result.status === 425) {
      const existing = isRecord(parsed) ? (readId(parsed, 'reportId') ?? this.reportIdFromDetail(parsed)) : null;
      throw new DuplicateReportError(
        'Amazon already has an identical report request in flight',
        result.status,
        decodeText(result.body),
        result.attempts,
        existing,
      );
    }

    return this.reportMetadata(parsed, 'POST /reporting/reports');
  }

  /**
   * Amazon sometimes puts the in-flight report id in a prose `detail` field
   * rather than a `reportId` property. Pulling it out is worth one regex: the
   * alternative is minting a duplicate report every poll cycle.
   */
  private reportIdFromDetail(parsed: Record<string, unknown>): string | null {
    const detail = readString(parsed, 'detail') ?? readString(parsed, 'message');
    if (detail === null) return null;
    const match = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(detail);
    return match === null ? null : match[0];
  }

  /** Poll one report. Live-verified through PENDING (2026-08-13). */
  async getReport(profileId: string, reportId: string): Promise<ReportMetadata> {
    const result = await httpRequest(this.ctx, {
      method: 'GET',
      url: `${hostFor(this.region)}/reporting/reports/${encodeURIComponent(reportId)}`,
      path: '/reporting/reports/{reportId}',
      headers: this.headers({
        profileId,
        contentType: CREATE_REPORT_CONTENT_TYPE,
        accept: 'application/json',
      }),
      idempotent: true,
    });
    return this.reportMetadata(this.json(result, 'GET /reporting/reports/{reportId}'), 'GET /reporting/reports/{reportId}');
  }

  private reportMetadata(parsed: unknown, what: string): ReportMetadata {
    if (!isRecord(parsed)) throw new AdsApiParseError(`${what} returned no object`);
    const reportId = readId(parsed, 'reportId');
    const status = readString(parsed, 'status');
    if (reportId === null || status === null) {
      throw new AdsApiParseError(`${what} response is missing reportId or status`);
    }
    return {
      reportId,
      status,
      url: readString(parsed, 'url'),
      urlExpiresAt: readString(parsed, 'urlExpiresAt'),
      failureReason: readString(parsed, 'failureReason'),
      fileSize: readNumber(parsed, 'fileSize'),
      name: readString(parsed, 'name'),
      createdAt: readString(parsed, 'createdAt'),
      updatedAt: readString(parsed, 'updatedAt'),
    };
  }

  /**
   * Download a completed report from its pre-signed URL.
   *
   * No Amazon Ads headers: the URL is an S3 object with its signature in the
   * query string, and an `Authorization` header on top of that is at best
   * ignored and at worst a 400. Bodies arrive gzipped, and occasionally
   * already decompressed by the transport; both are handled (see `gzip.ts`).
   */
  async downloadReport(url: string): Promise<ReportDownload> {
    const result = await httpRequest(this.ctx, {
      method: 'GET',
      url,
      path: 'report-download',
      headers: async () => ({}),
      idempotent: true,
    });
    const { rows, payload } = decodeJsonArray(result.body, 'report');
    return { rows, payload };
  }

  // -- exports ----------------------------------------------------------

  /** Mint an entity export. Same async shape as a report. NOT live-verified. */
  async createExport(profileId: string, input: CreateExportInput): Promise<ExportMetadata> {
    const endpoint = EXPORT_ENDPOINTS[input.kind];
    const result = await httpRequest(this.ctx, {
      method: 'POST',
      url: `${hostFor(this.region)}${endpoint.path}`,
      path: endpoint.path,
      headers: this.headers({
        profileId,
        contentType: endpoint.mediaType,
        accept: endpoint.mediaType,
      }),
      body: JSON.stringify(buildExportBody(input)),
      idempotent: false,
    });
    return this.exportMetadata(this.json(result, `POST ${endpoint.path}`), `POST ${endpoint.path}`);
  }

  async getExport(
    profileId: string,
    exportId: string,
    kind: ExportKind,
  ): Promise<ExportMetadata> {
    const result = await httpRequest(this.ctx, {
      method: 'GET',
      url: `${hostFor(this.region)}/exports/${encodeURIComponent(exportId)}`,
      path: '/exports/{exportId}',
      headers: this.headers({ profileId, accept: EXPORT_ENDPOINTS[kind].mediaType }),
      idempotent: true,
    });
    return this.exportMetadata(this.json(result, 'GET /exports/{exportId}'), 'GET /exports/{exportId}');
  }

  private exportMetadata(parsed: unknown, what: string): ExportMetadata {
    if (!isRecord(parsed)) throw new AdsApiParseError(`${what} returned no object`);
    const exportId = readId(parsed, 'exportId');
    const status = readString(parsed, 'status');
    if (exportId === null || status === null) {
      throw new AdsApiParseError(`${what} response is missing exportId or status`);
    }
    return {
      exportId,
      status,
      url: readString(parsed, 'url'),
      urlExpiresAt: readString(parsed, 'urlExpiresAt'),
      fileSize: readNumber(parsed, 'fileSize'),
      generatedAt: readString(parsed, 'generatedAt'),
      error: readString(parsed, 'error') ?? readString(parsed, 'failureReason'),
    };
  }

  /** Download a completed export. Pre-signed URL, no headers, gzipped JSON. */
  async downloadExport(url: string): Promise<ExportDownload> {
    const result = await httpRequest(this.ctx, {
      method: 'GET',
      url,
      path: 'export-download',
      headers: async () => ({}),
      idempotent: true,
    });
    const { rows, payload } = decodeJsonArray(result.body, 'export');
    return { rows, payload };
  }

  // -- budgets ----------------------------------------------------------

  /**
   * How much of each campaign's budget is spent.
   *
   * Batched at Amazon's documented limit and reassembled, with both halves of
   * the response kept: Amazon reports per-campaign failures inside a 200, so a
   * caller reading only `success` would lose campaigns and never know.
   */
  async getBudgetUsage(
    profileId: string,
    adProduct: AdProduct,
    campaignIds: readonly string[],
  ): Promise<BudgetUsageResult> {
    const usage: BudgetUsage[] = [];
    const failures: BudgetUsageFailure[] = [];

    for (const batch of batchCampaignIds(campaignIds)) {
      const result = await httpRequest(this.ctx, {
        method: 'POST',
        url: `${hostFor(this.region)}${BUDGET_USAGE_PATH}`,
        path: BUDGET_USAGE_PATH,
        headers: this.headers({
          profileId,
          contentType: BUDGET_USAGE_MEDIA_TYPE,
          accept: BUDGET_USAGE_MEDIA_TYPE,
        }),
        body: JSON.stringify(buildBudgetUsageBody(amazonAdProduct(adProduct), batch)),
        // A usage read changes nothing, whatever the verb says.
        idempotent: true,
      });
      const parsed = parseBudgetUsageResponse(this.json(result, `POST ${BUDGET_USAGE_PATH}`));
      usage.push(...parsed.usage);
      failures.push(...parsed.failures);
    }

    return { usage, failures, requested: campaignIds.length };
  }
}
