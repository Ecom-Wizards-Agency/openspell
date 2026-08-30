/**
 * `@wizard-ads/ads-api` (owned by WP-02).
 *
 * The Amazon Ads API, typed: LWA token handling, profiles, entity lists,
 * Exports, Reporting v3, budget usage and Sponsored Products v3 writes, with
 * regional hosts, throttle-aware retry and one parser per report schema.
 *
 * A pure client. It never touches the database, never schedules anything, and
 * never waits for a report — Reporting v3 takes up to three hours, so polling
 * belongs to `apps/worker`, which is also the only place allowed to import
 * this package (`apps/web` may import the LWA code exchange and profile fetch
 * for its OAuth callback, and nothing else; eslint enforces it).
 *
 * Ported from `amazon-agent`'s `SPAdsApiDataSource` and `exchange_token.py`,
 * which are read-only ground truth: their live-verified behaviour is
 * reproduced, and the two gaps they document — the campaign-name join and
 * budget usage — are closed here.
 */
export const PACKAGE_NAME = '@wizard-ads/ads-api' as const;

// Client
export { AdsApiClient, amazonAdProduct } from './client.js';
export type { MappedListResult, ReportDownload, ExportDownload } from './client.js';

// Auth: the surface WP-04's OAuth callback consumes.
export {
  ADS_SCOPE,
  TOKEN_REFRESH_MARGIN_SECONDS,
  TokenProvider,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
} from './auth.js';
export type { AuthorizationUrlParams, CodeExchangeParams, LwaTokenSet } from './auth.js';

// Profiles
export {
  fetchProfiles,
  listProfiles,
  listProfilesAcrossRegions,
  parseProfiles,
} from './profiles.js';
export type {
  AdsProfile,
  CrossRegionProfiles,
  ProfileAccountType,
  RegionFailure,
} from './profiles.js';

// Regions
export { ALL_REGIONS, LWA_AUTHORIZE_URL, LWA_TOKEN_URL, REGION_HOSTS, assertRegion, hostFor } from './regions.js';

// Entity endpoints and mirror mapping
export {
  DEFAULT_PAGE_SIZE,
  LIST_ENDPOINTS,
  SP_WRITE_ENDPOINTS,
  buildListBody,
  buildOffsetQuery,
} from './endpoints.js';
export type { EntityKind, ListEndpoint, SpWriteEndpoint, SpWriteKind } from './endpoints.js';
export {
  mapAdGroups,
  mapCampaigns,
  mapExpressionType,
  mapKeywords,
  mapMatchType,
  mapNegativeKeywords,
  mapNegativeTargets,
  mapProductAds,
  mapState,
  mapTargets,
} from './mappers.js';
export type { MapResult, MirrorRow, SkippedEntity } from './mappers.js';

// Reporting v3
export {
  CREATE_REPORT_CONTENT_TYPE,
  MAX_REPORT_RANGE_DAYS,
  REPORT_SPECS,
  buildReportRequestBody,
  defaultReportName,
  isReportComplete,
  isTerminalFailure,
  reportRangeDays,
} from './reports.js';
export type { AmazonAdProduct, CreateReportInput, ReportMetadata, ReportSpec, ReportStatus } from './reports.js';
export {
  mapPlacement,
  parseSbCampaignReport,
  parseSdCampaignReport,
  parseSpCampaignReport,
  parseSpPlacementReport,
  parseSpSearchTermReport,
  parseSpTargetingReport,
} from './parsers.js';
export type {
  ParseResult,
  ReportFact,
  SbCampaignReportRow,
  SdCampaignReportRow,
  SkippedReportRow,
  SpCampaignReportRow,
} from './parsers.js';

// Exports API
export {
  EXPORT_ENDPOINTS,
  adGroupNameIndex,
  buildExportBody,
  campaignNameIndex,
  isExportComplete,
  isExportFailed,
} from './exports.js';
export type { CreateExportInput, ExportKind, ExportMetadata, ExportStatus } from './exports.js';

// Budgets
export {
  BUDGET_USAGE_BATCH_SIZE,
  BUDGET_USAGE_ENDPOINTS,
  batchCampaignIds,
  buildBudgetUsageBody,
  parseBudgetUsageResponse,
} from './budgets.js';
export type { BudgetUsage, BudgetUsageEndpoint, BudgetUsageFailure, BudgetUsageResult } from './budgets.js';

// Sponsored Products v3 writes
export {
  SP_WRITE_BATCH_SIZE,
  batchSpWrites,
  buildSpArchiveBody,
  buildSpWriteBody,
  parseSpWriteResponse,
} from './writes.js';
export type {
  SpAdGroupCreateInput,
  SpAdGroupUpdateInput,
  SpBatchWriteResult,
  SpBudget,
  SpCampaignCreateInput,
  SpCampaignNegativeKeywordCreateInput,
  SpCampaignNegativeKeywordUpdateInput,
  SpCampaignNegativeTargetCreateInput,
  SpCampaignNegativeTargetUpdateInput,
  SpCampaignPlacementUpdateInput,
  SpCampaignUpdateInput,
  SpDynamicBidding,
  SpEntityState,
  SpKeywordCreateInput,
  SpKeywordMatchType,
  SpKeywordUpdateInput,
  SpNegativeKeywordCreateInput,
  SpNegativeKeywordMatchType,
  SpNegativeKeywordUpdateInput,
  SpNegativeTargetCreateInput,
  SpNegativeTargetUpdateInput,
  SpOffAmazonSettings,
  SpPlacementBidAdjustment,
  SpProductAdCreateInput,
  SpProductAdUpdateInput,
  SpShopperCohortBidAdjustment,
  SpSiteRestriction,
  SpTargetCreateInput,
  SpTargetExpression,
  SpTargetExpressionType,
  SpTargetUpdateInput,
  SpWriteError,
  SpWriteErrorDetail,
  SpWriteItem,
} from './writes.js';

// Sponsored Products suggested bids
export {
  SP_BID_RECOMMENDATION_BATCH_SIZE,
  SP_BID_RECOMMENDATION_ENDPOINTS,
  batchSpBidRecommendationIds,
  buildSpBidRecommendationBody,
  parseSpBidRecommendationResponse,
} from './suggested-bids.js';
export type {
  SpBidRecommendationEndpoint,
  SpBidRecommendationError,
  SpBidRecommendationKind,
  SpBidRecommendationResult,
  SpSuggestedBid,
} from './suggested-bids.js';

// Sponsored Brands v4 media/creative
export {
  SB_CREATIVE_BATCH_SIZE,
  SB_CREATIVE_LIST_PATH,
  SB_CREATIVE_MEDIA_TYPE,
  SB_CREATIVE_PATH,
  SB_MEDIA_DESCRIBE_PATH,
  SB_MEDIA_MULTIPART_BOUNDARY,
  SB_MEDIA_UPLOAD_PATH,
  batchSbCreatives,
  buildSbCreativeListBody,
  buildSbCreativeMutationBody,
  buildSbMediaUploadBody,
  parseSbCreative,
  parseSbCreativeListPage,
  parseSbCreativeMutationResponse,
  parseSbMediaAsset,
} from './sb-media.js';
export type {
  SbCreative,
  SbCreativeAssetRef,
  SbCreativeBatchResult,
  SbCreativeCreateInput,
  SbCreativeListOptions,
  SbCreativeListResult,
  SbCreativeMutationError,
  SbCreativeMutationItem,
  SbCreativeType,
  SbCreativeUpdateInput,
  SbMediaAsset,
  SbMediaType,
  SbMediaUploadBody,
  SbMediaUploadInput,
  SbV4MediaCreativeApi,
} from './sb-media.js';

// Sponsored Brands read-only ad/asset contract probe
export {
  CREATIVE_ASSET_SEARCH_MEDIA_TYPE,
  CREATIVE_ASSET_SEARCH_PATH,
  SB_AD_LIST_PATH,
  SB_AD_MEDIA_TYPE,
  buildCreativeAssetProbeBody,
  buildSbAdProbeBody,
  parseCreativeAssetProbePage,
  parseCreativeAssetProbeRow,
  parseSbAdProbePage,
  parseSbAdProbeRow,
  parseSbAssetReference,
} from './sb-ad-assets.js';
export { parseSbAdsReportProbe } from './sb-ads-report.js';
export type {
  SbAdsReportProbeParseResult,
  SbAdsReportProbeRefusal,
  SbAdsReportProbeRow,
} from './sb-ads-report.js';
export type {
  CreativeAssetProbeOptions,
  CreativeAssetProbePage,
  CreativeAssetProbeRow,
  CreativeAssetRange,
  CreativeAssetRangeFilter,
  CreativeAssetValueFilter,
  SbAdAssetReference,
  SbAdNameFilter,
  SbAdProbeOptions,
  SbAdProbePage,
  SbAdProbeRow,
} from './sb-ad-assets.js';

// Payload decoding
export { decodeJsonArray, decodePayload, looksGzipped } from './gzip.js';
export type { DecodedPayload } from './gzip.js';

// Retry surface
export { backoffCeiling, backoffDelay, parseRetryAfter } from './http.js';
export { DEFAULT_RETRY_POLICY } from './types.js';
export type {
  AdsApiClientOptions,
  AdsCredentials,
  FetchLike,
  ListOptions,
  ListResult,
  RetryEvent,
  RetryPolicy,
  RetryReason,
  ThrottleState,
} from './types.js';
export type { EffectOptions } from './context.js';

// Errors
export {
  AdsApiConfigError,
  AdsApiError,
  AdsApiHttpError,
  AdsApiNotImplementedError,
  AdsApiParseError,
  AdsApiTimeoutError,
  AdsAuthError,
  AdsThrottleError,
  DuplicateReportError,
  DuplicateWriteError,
  ExportFailedError,
  ReportFailedError,
} from './errors.js';
