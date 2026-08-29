/**
 * Amazon's entity payloads to the mirror rows in `@wizard-ads/shared`.
 *
 * `packages/shared` says WP-02 owns this translation, and it is the only place
 * Amazon's per-endpoint spellings (`EXACT`, `NEGATIVE_EXACT`, `asinSameAs`,
 * `PLACEMENT_TOP`, lower-case Sponsored Display states) are allowed to exist.
 * Downstream, one vocabulary.
 *
 * Two rules run through all of it:
 *
 *  - Nothing is invented. A campaign whose payload carries no budget is
 *    reported as skipped, not stored with a budget of zero — a fabricated zero
 *    would flow into pacing and quietly propose cuts against a budget nobody set.
 *  - Nothing is dropped silently. Every mapper returns the rows it produced and
 *    the inputs it could not map, so the caller can assert one count against
 *    the other (Rule 4).
 *
 * The rows omit `profileId`: this package knows Amazon's profile id, while the
 * contract's `profileId` is our own database uuid. The worker owns that join
 * and adds the field on the way in.
 */
import type {
  AdGroupRow,
  AdProduct,
  BiddingStrategy,
  BudgetType,
  CampaignRow,
  EntityState,
  KeywordRow,
  MatchType,
  NegativeRow,
  PlacementBidding,
  ProductAdRow,
  TargetExpression,
  TargetRow,
  TargetingType,
} from '@wizard-ads/shared';
import { CampaignWriteContext } from '@wizard-ads/shared';
import {
  isRecord,
  normalizeEnum,
  readId,
  readNumber,
  readRecord,
  readRecordArray,
  readString,
} from './read.js';

/**
 * A mirror row minus the field only the database can supply.
 *
 * `syncedAt` is left to the writer too: it records when *our* pass saw the row,
 * which the API cannot tell us.
 */
export type MirrorRow<T> = Omit<T, 'profileId' | 'syncedAt'>;

export interface SkippedEntity {
  /** Position in the input array, so a fixture failure points at a row. */
  index: number;
  id: string | null;
  reason: string;
}

export interface MapResult<T> {
  rows: T[];
  skipped: SkippedEntity[];
  /** Rows handed in. `rows.length + skipped.length` must equal it. */
  input: number;
}

function result<T>(rows: T[], skipped: SkippedEntity[], input: number): MapResult<T> {
  return { rows, skipped, input };
}

/** Amazon's transient states collapse into the three the mirror stores. */
export function mapState(value: string | null): EntityState | null {
  if (value === null) return null;
  switch (normalizeEnum(value)) {
    case 'enabled':
    case 'enabling':
    case 'running':
      return 'enabled';
    case 'paused':
    case 'pausing':
      return 'paused';
    case 'archived':
    case 'archiving':
      return 'archived';
    default:
      return null;
  }
}

const MATCH_TYPES: Readonly<Record<string, MatchType>> = {
  exact: 'exact',
  phrase: 'phrase',
  broad: 'broad',
  negativeexact: 'negative_exact',
  negativephrase: 'negative_phrase',
  campaignnegativeexact: 'negative_exact',
  campaignnegativephrase: 'negative_phrase',
};

/** Keyword match types, positive and negative, in every spelling Amazon uses. */
export function mapMatchType(value: string | null): MatchType | null {
  if (value === null) return null;
  return MATCH_TYPES[normalizeEnum(value)] ?? null;
}

const EXPRESSION_TYPES: Readonly<Record<string, MatchType>> = {
  asinsameas: 'asin_same_as',
  asinexpandedfrom: 'asin_expanded_from',
  asinbrandsameas: 'asin_brand_same_as',
  asincategorysameas: 'asin_category_same_as',
  queryhighrelmatches: 'close_match',
  querybroadrelmatches: 'loose_match',
  asinsubstituterelated: 'substitutes',
  asinaccessoryrelated: 'complements',
  // Negative product targeting reuses the positive vocabulary with a prefix.
  asinsameasnegative: 'asin_same_as',
  asinbrandsameasnegative: 'asin_brand_same_as',
};

/** Product-targeting expression clauses, including the auto-targeting four. */
export function mapExpressionType(value: string | null): MatchType | null {
  if (value === null) return null;
  return EXPRESSION_TYPES[normalizeEnum(value)] ?? null;
}

function mapExpressions(raw: Record<string, unknown>, key: string): TargetExpression[] {
  return readRecordArray(raw, key).flatMap((clause) => {
    const type = mapExpressionType(readString(clause, 'type'));
    if (type === null) return [];
    return [{ type, value: readString(clause, 'value') }];
  });
}

/**
 * `resolvedExpression` is what the grid shows, so it is kept as Amazon renders
 * it rather than re-derived. It arrives as an array of clauses or, on older
 * payloads, as a plain string.
 */
function readResolvedExpression(raw: Record<string, unknown>): string | null {
  const direct = readString(raw, 'resolvedExpression');
  if (direct !== null) return direct;
  const clauses = readRecordArray(raw, 'resolvedExpression');
  if (clauses.length === 0) return null;
  return clauses
    .map((clause) => {
      const type = readString(clause, 'type') ?? '';
      const value = readString(clause, 'value');
      return value === null ? type : `${type}="${value}"`;
    })
    .join(' ');
}

function mapBudgetType(value: string | null): BudgetType | null {
  if (value === null) return null;
  switch (normalizeEnum(value)) {
    case 'daily':
      return 'daily';
    case 'lifetime':
      return 'lifetime';
    default:
      return null;
  }
}

const BIDDING_STRATEGIES: Readonly<Record<string, BiddingStrategy>> = {
  legacyforsales: 'legacy_for_sales',
  autoforsales: 'auto_for_sales',
  manual: 'manual',
  rulebased: 'rule_based',
};

function mapTargetingType(value: string | null): TargetingType | null {
  if (value === null) return null;
  const normalized = normalizeEnum(value);
  if (normalized === 'manual') return 'manual';
  if (normalized === 'auto') return 'auto';
  return null;
}

/**
 * Budget lives in three shapes across the three ad products: SP nests it under
 * `budget`, SB v4 sends either shape depending on the field set, SD keeps a
 * flat number with a sibling type.
 */
function readBudget(raw: Record<string, unknown>): { amount: number; type: BudgetType } | null {
  const nested = readRecord(raw, 'budget');
  if (nested !== null) {
    const amount = readNumber(nested, 'budget') ?? readNumber(nested, 'amount');
    const type = mapBudgetType(readString(nested, 'budgetType'));
    if (amount !== null && type !== null) return { amount, type };
    if (amount !== null) return { amount, type: 'daily' };
    return null;
  }
  const flat = readNumber(raw, 'budget') ?? readNumber(raw, 'dailyBudget');
  if (flat === null) return null;
  const type = mapBudgetType(readString(raw, 'budgetType'));
  return { amount: flat, type: type ?? 'daily' };
}

const PLACEMENT_KEYS: Readonly<Record<string, keyof PlacementBidding>> = {
  placementtop: 'topOfSearch',
  placementproductpage: 'productPages',
  placementrestofsearch: 'restOfSearch',
};

function readPlacementBidding(raw: Record<string, unknown>): PlacementBidding | null {
  const dynamic = readRecord(raw, 'dynamicBidding');
  if (dynamic === null) return null;
  const entries = readRecordArray(dynamic, 'placementBidding');
  if (entries.length === 0) return null;
  const bidding: PlacementBidding = { topOfSearch: null, productPages: null, restOfSearch: null };
  for (const entry of entries) {
    const placement = readString(entry, 'placement');
    if (placement === null) continue;
    const key = PLACEMENT_KEYS[normalizeEnum(placement)];
    if (key === undefined) continue;
    bidding[key] = readNumber(entry, 'percentage');
  }
  return bidding;
}

const PROVIDER_PLACEMENTS = {
  placementtop: 'PLACEMENT_TOP',
  placementproductpage: 'PLACEMENT_PRODUCT_PAGE',
  placementrestofsearch: 'PLACEMENT_REST_OF_SEARCH',
  siteamazonbusiness: 'SITE_AMAZON_BUSINESS',
} as const;

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allow = new Set(allowed);
  return Object.keys(value).every((key) => allow.has(key));
}

/** Return null rather than risk a sparse replacement when Amazon widens this object. */
function readCampaignWriteContext(raw: Record<string, unknown>) {
  const dynamic = readRecord(raw, 'dynamicBidding');
  if (dynamic === null || !exactKeys(dynamic, ['strategy', 'placementBidding', 'shopperCohortBidding'])) return null;
  const strategyRaw = readString(dynamic, 'strategy');
  const strategy = strategyRaw === null ? null : BIDDING_STRATEGIES[normalizeEnum(strategyRaw)] ?? null;
  const placementRaw = dynamic['placementBidding'];
  if (strategy === null || !Array.isArray(placementRaw)) return null;
  const placementBidding: Array<{ placement: (typeof PROVIDER_PLACEMENTS)[keyof typeof PROVIDER_PLACEMENTS]; percentage: number }> = [];
  for (const candidate of placementRaw) {
    if (!isRecord(candidate) || !exactKeys(candidate, ['placement', 'percentage'])) return null;
    const placementRawValue = readString(candidate, 'placement');
    const percentage = readNumber(candidate, 'percentage');
    const placement = placementRawValue === null ? undefined : PROVIDER_PLACEMENTS[normalizeEnum(placementRawValue) as keyof typeof PROVIDER_PLACEMENTS];
    if (placement === undefined || percentage === null || !Number.isInteger(percentage)) return null;
    placementBidding.push({ placement, percentage });
  }
  if (new Set(placementBidding.map((entry) => entry.placement)).size !== placementBidding.length) return null;
  placementBidding.sort((left, right) => left.placement.localeCompare(right.placement));

  const shopperRaw = dynamic['shopperCohortBidding'];
  const shopperCohortBidding: Array<{
    shopperCohortType: string;
    percentage: number;
    audienceSegments?: Array<{ audienceId: string; audienceSegmentType: string }>;
  }> = [];
  if (shopperRaw !== undefined) {
    if (!Array.isArray(shopperRaw)) return null;
    for (const candidate of shopperRaw) {
      if (!isRecord(candidate) || !exactKeys(candidate, ['shopperCohortType', 'percentage', 'audienceSegments'])) return null;
      const shopperCohortType = readString(candidate, 'shopperCohortType');
      const percentage = readNumber(candidate, 'percentage');
      if (shopperCohortType === null || percentage === null || !Number.isInteger(percentage)) return null;
      const audienceRaw = candidate['audienceSegments'];
      if (audienceRaw !== undefined && !Array.isArray(audienceRaw)) return null;
      const audienceSegments: Array<{ audienceId: string; audienceSegmentType: string }> = [];
      for (const segment of audienceRaw ?? []) {
        if (!isRecord(segment) || !exactKeys(segment, ['audienceId', 'audienceSegmentType'])) return null;
        const audienceId = readString(segment, 'audienceId');
        const audienceSegmentType = readString(segment, 'audienceSegmentType');
        if (audienceId === null || audienceSegmentType === null) return null;
        audienceSegments.push({ audienceId, audienceSegmentType });
      }
      audienceSegments.sort((left, right) =>
        left.audienceId.localeCompare(right.audienceId)
          || left.audienceSegmentType.localeCompare(right.audienceSegmentType));
      shopperCohortBidding.push({
        shopperCohortType,
        percentage,
        ...(audienceRaw === undefined ? {} : { audienceSegments }),
      });
    }
    shopperCohortBidding.sort((left, right) =>
      left.shopperCohortType.localeCompare(right.shopperCohortType)
        || left.percentage - right.percentage
        || JSON.stringify(left.audienceSegments ?? []).localeCompare(
          JSON.stringify(right.audienceSegments ?? []),
        ));
  }

  const offAmazonRaw = raw['offAmazonSettings'];
  let offAmazonSettings: { offAmazonBudgetControlStrategy: string } | null = null;
  if (offAmazonRaw !== undefined) {
    if (!isRecord(offAmazonRaw) || !exactKeys(offAmazonRaw, ['offAmazonBudgetControlStrategy'])) return null;
    const strategyValue = readString(offAmazonRaw, 'offAmazonBudgetControlStrategy');
    if (strategyValue === null) return null;
    offAmazonSettings = { offAmazonBudgetControlStrategy: strategyValue };
  }
  const parsed = CampaignWriteContext.safeParse({
    strategy,
    placementBidding,
    shopperCohortBidding: shopperRaw === undefined ? null : shopperCohortBidding,
    offAmazonSettings,
  });
  return parsed.success ? parsed.data : null;
}

function commonName(raw: Record<string, unknown>): string | null {
  return readString(raw, 'name') ?? readString(raw, 'campaignName');
}

export function mapCampaigns(
  adProduct: AdProduct,
  raw: readonly unknown[],
): MapResult<MirrorRow<CampaignRow>> {
  const rows: MirrorRow<CampaignRow>[] = [];
  const skipped: SkippedEntity[] = [];

  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      skipped.push({ index, id: null, reason: 'not an object' });
      return;
    }
    const amazonId = readId(entry, 'campaignId');
    const state = mapState(readString(entry, 'state'));
    const budget = readBudget(entry);
    if (amazonId === null) {
      skipped.push({ index, id: null, reason: 'no campaignId' });
      return;
    }
    if (state === null) {
      skipped.push({ index, id: amazonId, reason: `unmappable state '${readString(entry, 'state') ?? 'missing'}'` });
      return;
    }
    if (budget === null) {
      // Deliberately not defaulted: see the file header.
      skipped.push({ index, id: amazonId, reason: 'no budget in payload' });
      return;
    }
    const dynamic = readRecord(entry, 'dynamicBidding');
    const strategy = dynamic === null ? null : readString(dynamic, 'strategy');
    rows.push({
      entityType: 'campaign',
      amazonId,
      adProduct,
      name: commonName(entry),
      state,
      portfolioId: readId(entry, 'portfolioId'),
      budgetAmount: budget.amount,
      budgetType: budget.type,
      targetingType: mapTargetingType(readString(entry, 'targetingType')),
      biddingStrategy: strategy === null ? null : (BIDDING_STRATEGIES[normalizeEnum(strategy)] ?? null),
      placementBidding: readPlacementBidding(entry),
      campaignWriteContext: adProduct === 'SP' ? readCampaignWriteContext(entry) : null,
      startDate: readString(entry, 'startDate'),
      endDate: readString(entry, 'endDate'),
    });
  });

  return result(rows, skipped, raw.length);
}

export function mapAdGroups(
  adProduct: AdProduct,
  raw: readonly unknown[],
): MapResult<MirrorRow<AdGroupRow>> {
  const rows: MirrorRow<AdGroupRow>[] = [];
  const skipped: SkippedEntity[] = [];

  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      skipped.push({ index, id: null, reason: 'not an object' });
      return;
    }
    const amazonId = readId(entry, 'adGroupId');
    const campaignId = readId(entry, 'campaignId');
    const state = mapState(readString(entry, 'state'));
    if (amazonId === null || campaignId === null || state === null) {
      skipped.push({
        index,
        id: amazonId,
        reason: amazonId === null ? 'no adGroupId' : campaignId === null ? 'no campaignId' : 'unmappable state',
      });
      return;
    }
    rows.push({
      entityType: 'ad_group',
      amazonId,
      adProduct,
      name: commonName(entry),
      state,
      campaignId,
      defaultBid: readNumber(entry, 'defaultBid'),
    });
  });

  return result(rows, skipped, raw.length);
}

export function mapKeywords(raw: readonly unknown[]): MapResult<MirrorRow<KeywordRow>> {
  const rows: MirrorRow<KeywordRow>[] = [];
  const skipped: SkippedEntity[] = [];

  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      skipped.push({ index, id: null, reason: 'not an object' });
      return;
    }
    const amazonId = readId(entry, 'keywordId');
    const campaignId = readId(entry, 'campaignId');
    const adGroupId = readId(entry, 'adGroupId');
    const keywordText = readString(entry, 'keywordText');
    const matchType = mapMatchType(readString(entry, 'matchType'));
    const state = mapState(readString(entry, 'state'));
    if (
      amazonId === null ||
      campaignId === null ||
      adGroupId === null ||
      keywordText === null ||
      matchType === null ||
      state === null
    ) {
      skipped.push({ index, id: amazonId, reason: 'incomplete keyword payload' });
      return;
    }
    rows.push({
      entityType: 'keyword',
      amazonId,
      adProduct: 'SP',
      name: keywordText,
      state,
      campaignId,
      adGroupId,
      keywordText,
      matchType,
      bid: readNumber(entry, 'bid'),
    });
  });

  return result(rows, skipped, raw.length);
}

export function mapTargets(raw: readonly unknown[]): MapResult<MirrorRow<TargetRow>> {
  const rows: MirrorRow<TargetRow>[] = [];
  const skipped: SkippedEntity[] = [];

  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      skipped.push({ index, id: null, reason: 'not an object' });
      return;
    }
    const amazonId = readId(entry, 'targetId');
    const campaignId = readId(entry, 'campaignId');
    const adGroupId = readId(entry, 'adGroupId');
    const state = mapState(readString(entry, 'state'));
    if (amazonId === null || campaignId === null || adGroupId === null || state === null) {
      skipped.push({ index, id: amazonId, reason: 'incomplete target payload' });
      return;
    }
    const expression = mapExpressions(entry, 'expression');
    if (expression.length === 0) {
      skipped.push({ index, id: amazonId, reason: 'no mappable expression clause' });
      return;
    }
    rows.push({
      entityType: 'target',
      amazonId,
      adProduct: 'SP',
      name: readResolvedExpression(entry),
      state,
      campaignId,
      adGroupId,
      expression,
      resolvedExpression: readResolvedExpression(entry),
      bid: readNumber(entry, 'bid'),
    });
  });

  return result(rows, skipped, raw.length);
}

/**
 * Negative keywords, ad-group- or campaign-scoped.
 *
 * Campaign negatives come from a different endpoint with no `adGroupId` and a
 * `CAMPAIGN_NEGATIVE_*` match spelling; both land in the same mirror row with
 * `scope` telling them apart.
 */
export function mapNegativeKeywords(
  raw: readonly unknown[],
  scope: 'campaign' | 'ad_group',
): MapResult<MirrorRow<NegativeRow>> {
  const rows: MirrorRow<NegativeRow>[] = [];
  const skipped: SkippedEntity[] = [];

  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      skipped.push({ index, id: null, reason: 'not an object' });
      return;
    }
    const amazonId = readId(entry, 'keywordId');
    const campaignId = readId(entry, 'campaignId');
    const keywordText = readString(entry, 'keywordText');
    const matchType = mapMatchType(readString(entry, 'matchType'));
    const state = mapState(readString(entry, 'state'));
    const adGroupId = readId(entry, 'adGroupId');
    if (amazonId === null || campaignId === null || keywordText === null || matchType === null || state === null) {
      skipped.push({ index, id: amazonId, reason: 'incomplete negative keyword payload' });
      return;
    }
    if (scope === 'ad_group' && adGroupId === null) {
      skipped.push({ index, id: amazonId, reason: 'ad-group negative without adGroupId' });
      return;
    }
    rows.push({
      entityType: 'negative',
      amazonId,
      adProduct: 'SP',
      name: keywordText,
      state,
      campaignId,
      adGroupId: scope === 'campaign' ? null : adGroupId,
      scope,
      keywordText,
      expression: null,
      matchType,
    });
  });

  return result(rows, skipped, raw.length);
}

/** Negative product targets. Same mirror row, expression instead of text. */
export function mapNegativeTargets(
  raw: readonly unknown[],
  scope: 'campaign' | 'ad_group',
): MapResult<MirrorRow<NegativeRow>> {
  const rows: MirrorRow<NegativeRow>[] = [];
  const skipped: SkippedEntity[] = [];

  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      skipped.push({ index, id: null, reason: 'not an object' });
      return;
    }
    const amazonId = readId(entry, 'targetId');
    const campaignId = readId(entry, 'campaignId');
    const state = mapState(readString(entry, 'state'));
    const adGroupId = readId(entry, 'adGroupId');
    const expression = mapExpressions(entry, 'expression');
    const matchType = expression[0]?.type ?? null;
    if (amazonId === null || campaignId === null || state === null || matchType === null) {
      skipped.push({ index, id: amazonId, reason: 'incomplete negative target payload' });
      return;
    }
    if (scope === 'ad_group' && adGroupId === null) {
      skipped.push({ index, id: amazonId, reason: 'ad-group negative without adGroupId' });
      return;
    }
    rows.push({
      entityType: 'negative',
      amazonId,
      adProduct: 'SP',
      name: readResolvedExpression(entry),
      state,
      campaignId,
      adGroupId: scope === 'campaign' ? null : adGroupId,
      scope,
      keywordText: null,
      expression,
      matchType,
    });
  });

  return result(rows, skipped, raw.length);
}

export function mapProductAds(raw: readonly unknown[]): MapResult<MirrorRow<ProductAdRow>> {
  const rows: MirrorRow<ProductAdRow>[] = [];
  const skipped: SkippedEntity[] = [];

  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      skipped.push({ index, id: null, reason: 'not an object' });
      return;
    }
    const amazonId = readId(entry, 'adId');
    const campaignId = readId(entry, 'campaignId');
    const adGroupId = readId(entry, 'adGroupId');
    const state = mapState(readString(entry, 'state'));
    if (amazonId === null || campaignId === null || adGroupId === null || state === null) {
      skipped.push({ index, id: amazonId, reason: 'incomplete product ad payload' });
      return;
    }
    const asin = readString(entry, 'asin');
    const sku = readString(entry, 'sku');
    rows.push({
      entityType: 'product_ad',
      amazonId,
      adProduct: 'SP',
      name: asin ?? sku,
      state,
      campaignId,
      adGroupId,
      asin,
      sku,
    });
  });

  return result(rows, skipped, raw.length);
}
