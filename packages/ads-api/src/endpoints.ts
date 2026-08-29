/**
 * The entity list endpoints, as data.
 *
 * Three generations of API live side by side and none of them can be guessed
 * from the others, so they are written down once instead of being spread
 * across a dozen methods:
 *
 *  - Sponsored Products v3: `POST /sp/{kind}/list`, a vendor media type per
 *    resource, `nextToken` pagination, filters as `{include: [...]}` objects.
 *  - Sponsored Brands v4: the same shape on a different path and media type.
 *    v3 was shut off in 2024, so v4 is the only SB campaign management API.
 *  - Sponsored Display: still `GET` with `startIndex`/`count` offsets, plain
 *    JSON, a bare array response and lower-case states.
 *
 * `responseKey` matters more than it looks: SP targets come back under
 * `targetingClauses`, not `targets`, and reading the wrong key yields an empty
 * page that looks exactly like the end of pagination.
 */

export type EntityKind =
  | 'sp.campaigns'
  | 'sp.adGroups'
  | 'sp.keywords'
  | 'sp.targets'
  | 'sp.negativeKeywords'
  | 'sp.campaignNegativeKeywords'
  | 'sp.negativeTargets'
  | 'sp.productAds'
  | 'sb.campaigns'
  | 'sb.adGroups'
  | 'sd.campaigns'
  | 'sd.adGroups';

export type SpWriteKind =
  | 'campaigns'
  | 'adGroups'
  | 'keywords'
  | 'targets'
  | 'negativeKeywords'
  | 'campaignNegativeKeywords'
  | 'negativeTargets'
  | 'campaignNegativeTargets'
  | 'productAds';

export interface SpWriteEndpoint {
  path: string;
  mediaType: string;
  requestKey: string;
  responseKey: string;
  idKey: string;
  entityKey: string;
  idFilterKey: string;
}

export interface ListEndpoint {
  method: 'POST' | 'GET';
  path: string;
  /** Sent as both `Content-Type` and `Accept`; Amazon versions on both. */
  mediaType: string;
  /** Property of the response object holding the page. Unused when `paging` is `offset`. */
  responseKey: string;
  paging: 'token' | 'offset';
  /**
   * Largest page this endpoint accepts. Sponsored Products lets a list ask for
   * far more than {@link DEFAULT_PAGE_SIZE}, but Sponsored Brands v4 caps
   * `maxResults` at 100 and answers a larger value with HTTP 400
   * `LIST_REQUEST_MAX_RESULTS_OUT_OF_RANGE` — the exact failure that aborted the
   * first live entity sync. A caller's page size is clamped to this. Absent
   * means the shared default is already within range.
   */
  maxPageSize?: number;
  /** Which `{include: [...]}` filters this endpoint accepts. */
  filters: {
    state?: string;
    campaignId?: string;
    adGroupId?: string;
    entityId?: string;
  };
}

const spFilters = {
  state: 'stateFilter',
  campaignId: 'campaignIdFilter',
  adGroupId: 'adGroupIdFilter',
} as const;

/**
 * The largest page every Sponsored Brands v4 list endpoint accepts.
 *
 * Live-verified 2026-08-14: `POST /sb/v4/campaigns/list` and `/sb/v4/adGroups/list`
 * answer HTTP 400 `LIST_REQUEST_MAX_RESULTS_OUT_OF_RANGE` (`upperLimit: 100`) for
 * anything larger. The SB creative list shares the same v4 pagination contract.
 */
export const SB_LIST_MAX_PAGE_SIZE = 100;

export const LIST_ENDPOINTS: Readonly<Record<EntityKind, ListEndpoint>> = {
  'sp.campaigns': {
    method: 'POST',
    path: '/sp/campaigns/list',
    mediaType: 'application/vnd.spCampaign.v3+json',
    responseKey: 'campaigns',
    paging: 'token',
    filters: { state: spFilters.state, campaignId: spFilters.campaignId, entityId: 'campaignIdFilter' },
  },
  'sp.adGroups': {
    method: 'POST',
    path: '/sp/adGroups/list',
    mediaType: 'application/vnd.spAdGroup.v3+json',
    responseKey: 'adGroups',
    paging: 'token',
    filters: { ...spFilters, entityId: 'adGroupIdFilter' },
  },
  'sp.keywords': {
    method: 'POST',
    path: '/sp/keywords/list',
    mediaType: 'application/vnd.spKeyword.v3+json',
    responseKey: 'keywords',
    paging: 'token',
    filters: { ...spFilters, entityId: 'keywordIdFilter' },
  },
  'sp.targets': {
    method: 'POST',
    path: '/sp/targets/list',
    mediaType: 'application/vnd.spTargetingClause.v3+json',
    responseKey: 'targetingClauses',
    paging: 'token',
    filters: { ...spFilters, entityId: 'targetIdFilter' },
  },
  'sp.negativeKeywords': {
    method: 'POST',
    path: '/sp/negativeKeywords/list',
    mediaType: 'application/vnd.spNegativeKeyword.v3+json',
    responseKey: 'negativeKeywords',
    paging: 'token',
    filters: spFilters,
  },
  'sp.campaignNegativeKeywords': {
    method: 'POST',
    path: '/sp/campaignNegativeKeywords/list',
    mediaType: 'application/vnd.spCampaignNegativeKeyword.v3+json',
    responseKey: 'campaignNegativeKeywords',
    paging: 'token',
    filters: { state: spFilters.state, campaignId: spFilters.campaignId },
  },
  'sp.negativeTargets': {
    method: 'POST',
    path: '/sp/negativeTargets/list',
    mediaType: 'application/vnd.spNegativeTargetingClause.v3+json',
    responseKey: 'negativeTargetingClauses',
    paging: 'token',
    filters: spFilters,
  },
  'sp.productAds': {
    method: 'POST',
    path: '/sp/productAds/list',
    mediaType: 'application/vnd.spProductAd.v3+json',
    responseKey: 'productAds',
    paging: 'token',
    filters: spFilters,
  },
  'sb.campaigns': {
    method: 'POST',
    path: '/sb/v4/campaigns/list',
    mediaType: 'application/vnd.sbcampaignresource.v4+json',
    responseKey: 'campaigns',
    paging: 'token',
    // SB v4 list rejects maxResults > 100 (live-verified 2026-08-14).
    maxPageSize: SB_LIST_MAX_PAGE_SIZE,
    filters: { state: spFilters.state, campaignId: spFilters.campaignId },
  },
  'sb.adGroups': {
    method: 'POST',
    path: '/sb/v4/adGroups/list',
    mediaType: 'application/vnd.sbadgroupresource.v4+json',
    responseKey: 'adGroups',
    paging: 'token',
    // SB v4 list rejects maxResults > 100 (live-verified 2026-08-14).
    maxPageSize: SB_LIST_MAX_PAGE_SIZE,
    filters: spFilters,
  },
  'sd.campaigns': {
    method: 'GET',
    path: '/sd/campaigns',
    mediaType: 'application/json',
    responseKey: '',
    paging: 'offset',
    filters: { state: 'stateFilter' },
  },
  'sd.adGroups': {
    method: 'GET',
    path: '/sd/adGroups',
    mediaType: 'application/json',
    responseKey: '',
    paging: 'offset',
    filters: { state: 'stateFilter', campaignId: 'campaignIdFilter' },
  },
};

/**
 * SP v3 uses POST for create, PUT for sparse update, and POST to `/delete` for
 * batch archive. The resource-specific nouns and media types are shared by all
 * three operations and live here beside the read endpoint table.
 */
export const SP_WRITE_ENDPOINTS: Readonly<Record<SpWriteKind, SpWriteEndpoint>> = {
  campaigns: {
    path: '/sp/campaigns',
    mediaType: 'application/vnd.spCampaign.v3+json',
    requestKey: 'campaigns',
    responseKey: 'campaigns',
    idKey: 'campaignId',
    entityKey: 'campaign',
    idFilterKey: 'campaignIdFilter',
  },
  adGroups: {
    path: '/sp/adGroups',
    mediaType: 'application/vnd.spAdGroup.v3+json',
    requestKey: 'adGroups',
    responseKey: 'adGroups',
    idKey: 'adGroupId',
    entityKey: 'adGroup',
    idFilterKey: 'adGroupIdFilter',
  },
  keywords: {
    path: '/sp/keywords',
    mediaType: 'application/vnd.spKeyword.v3+json',
    requestKey: 'keywords',
    responseKey: 'keywords',
    idKey: 'keywordId',
    entityKey: 'keyword',
    idFilterKey: 'keywordIdFilter',
  },
  targets: {
    path: '/sp/targets',
    mediaType: 'application/vnd.spTargetingClause.v3+json',
    requestKey: 'targetingClauses',
    responseKey: 'targetingClauses',
    idKey: 'targetId',
    entityKey: 'targetingClause',
    idFilterKey: 'targetIdFilter',
  },
  negativeKeywords: {
    path: '/sp/negativeKeywords',
    mediaType: 'application/vnd.spNegativeKeyword.v3+json',
    requestKey: 'negativeKeywords',
    responseKey: 'negativeKeywords',
    idKey: 'negativeKeywordId',
    entityKey: 'negativeKeyword',
    idFilterKey: 'negativeKeywordIdFilter',
  },
  campaignNegativeKeywords: {
    path: '/sp/campaignNegativeKeywords',
    mediaType: 'application/vnd.spCampaignNegativeKeyword.v3+json',
    requestKey: 'campaignNegativeKeywords',
    responseKey: 'campaignNegativeKeywords',
    idKey: 'campaignNegativeKeywordId',
    entityKey: 'campaignNegativeKeyword',
    idFilterKey: 'campaignNegativeKeywordIdFilter',
  },
  negativeTargets: {
    path: '/sp/negativeTargets',
    mediaType: 'application/vnd.spNegativeTargetingClause.v3+json',
    requestKey: 'negativeTargetingClauses',
    responseKey: 'negativeTargetingClauses',
    idKey: 'targetId',
    entityKey: 'negativeTargetingClause',
    idFilterKey: 'negativeTargetIdFilter',
  },
  campaignNegativeTargets: {
    path: '/sp/campaignNegativeTargets',
    mediaType: 'application/vnd.spCampaignNegativeTargetingClause.v3+json',
    requestKey: 'campaignNegativeTargetingClauses',
    responseKey: 'campaignNegativeTargetingClauses',
    idKey: 'campaignNegativeTargetingClauseId',
    entityKey: 'campaignNegativeTargetingClauses',
    idFilterKey: 'campaignNegativeTargetIdFilter',
  },
  productAds: {
    path: '/sp/productAds',
    mediaType: 'application/vnd.spProductAd.v3+json',
    requestKey: 'productAds',
    responseKey: 'productAds',
    idKey: 'adId',
    entityKey: 'productAd',
    idFilterKey: 'adIdFilter',
  },
};

/** Default page size. Amazon caps SP list calls well above this. */
export const DEFAULT_PAGE_SIZE = 500;

export interface ListRequestInput {
  maxResults: number;
  nextToken: string | null;
  stateFilter?: readonly string[];
  campaignIdFilter?: readonly string[];
  adGroupIdFilter?: readonly string[];
  entityIdFilter?: readonly string[];
}

/** Body for a token-paginated list POST. Empty filters are omitted, not sent as `[]`. */
export function buildListBody(
  endpoint: ListEndpoint,
  input: ListRequestInput,
): Record<string, unknown> {
  const body: Record<string, unknown> = { maxResults: input.maxResults };
  if (input.nextToken !== null) body['nextToken'] = input.nextToken;

  const include = (values: readonly string[] | undefined): { include: string[] } | undefined =>
    values === undefined || values.length === 0 ? undefined : { include: [...values] };

  const state = include(input.stateFilter);
  if (endpoint.filters.state !== undefined && state !== undefined) {
    body[endpoint.filters.state] = state;
  }
  const campaign = include(input.campaignIdFilter);
  if (endpoint.filters.campaignId !== undefined && campaign !== undefined) {
    body[endpoint.filters.campaignId] = campaign;
  }
  const adGroup = include(input.adGroupIdFilter);
  if (endpoint.filters.adGroupId !== undefined && adGroup !== undefined) {
    body[endpoint.filters.adGroupId] = adGroup;
  }
  const entity = include(input.entityIdFilter);
  if (endpoint.filters.entityId !== undefined && entity !== undefined) {
    body[endpoint.filters.entityId] = entity;
  }
  return body;
}

/**
 * Query string for an offset-paginated (Sponsored Display) list GET.
 *
 * SD wants lower-case states and a comma-joined list, where SP wants upper-case
 * strings inside an object. Normalising here keeps every caller speaking one
 * vocabulary.
 */
export function buildOffsetQuery(
  endpoint: ListEndpoint,
  input: { startIndex: number; count: number; stateFilter?: readonly string[]; campaignIdFilter?: readonly string[] },
): string {
  const query = new URLSearchParams({
    startIndex: String(input.startIndex),
    count: String(input.count),
  });
  if (endpoint.filters.state !== undefined && input.stateFilter !== undefined && input.stateFilter.length > 0) {
    query.set(endpoint.filters.state, input.stateFilter.map((s) => s.toLowerCase()).join(','));
  }
  if (
    endpoint.filters.campaignId !== undefined &&
    input.campaignIdFilter !== undefined &&
    input.campaignIdFilter.length > 0
  ) {
    query.set(endpoint.filters.campaignId, input.campaignIdFilter.join(','));
  }
  return query.toString();
}
