/**
 * The Sponsored Products campaign vocabulary, ported from the reference
 * toolkit's `campaign_model.py`.
 *
 * Two vocabularies live here and they are not the same one. The **model**
 * vocabulary (`EXACT`, `Down only`, `NEGATIVE_PHRASE`) is what a plan is
 * written in; the **Amazon** vocabulary (`exact`, `Dynamic bids - down only`,
 * `negativePhrase`) is what a bulksheet cell holds. The reference keeps both
 * and translates at the row boundary, because the upload parser documents the
 * second set and only the second set. Every `AMAZON_*` map below is that
 * translation, value for value.
 *
 * None of this is doctrine. It is Amazon's own enum surface plus the naming
 * grammar, which is why it can live in a public repository while a target ACOS
 * cannot.
 */

/**
 * The campaign types this engine generates.
 *
 * BMM is deliberately absent (operator decision, 2026-08-14: it does not work
 * on our accounts). The reference toolkit still builds broad-match-modifier
 * campaigns; this package does not, and the modifier rewrite that went with
 * them is gone rather than switched off. Nothing here says anything about
 * *reading* BMM: an account can still be full of campaigns named that way, and
 * classifying them is another package's job.
 */
export const CAMPAIGN_TYPES = ['SKW', 'Halo', 'Phrase', 'Auto', 'PAT'] as const;
export type CampaignType = (typeof CAMPAIGN_TYPES)[number];

/**
 * Types the reference generates that we no longer do, so a spec asking for one
 * gets an answer instead of a bare "not one of the valid values".
 */
export const DROPPED_CAMPAIGN_TYPES: Readonly<Record<string, string>> = {
  BMM: 'BMM generation was dropped on 2026-08-14 (operator decision); use Phrase for discovery',
};

export const GOALS = ['Discovery', 'Rank', 'Profit', 'Brand'] as const;
export type Goal = (typeof GOALS)[number];

export const MATCH_TYPES = ['EXACT', 'BROAD', 'PHRASE', 'ASIN_EXACT', 'ASIN_EXPANDED', 'AUTO'] as const;
export type MatchType = (typeof MATCH_TYPES)[number];

export const NEGATIVE_MATCH_TYPES = ['NEGATIVE_EXACT', 'NEGATIVE_PHRASE'] as const;
export type NegativeMatchType = (typeof NEGATIVE_MATCH_TYPES)[number];

export const NEGATIVE_LEVELS = ['ad_group', 'campaign'] as const;
export type NegativeLevel = (typeof NEGATIVE_LEVELS)[number];

export const BIDDING_STRATEGIES = ['Down only', 'Up and down', 'Fixed bids'] as const;
export type BiddingStrategy = (typeof BIDDING_STRATEGIES)[number];

export const STATES = ['enabled', 'paused'] as const;
export type EntityState = (typeof STATES)[number];

export const SITE_RESTRICTIONS = ['Amazon', 'Amazon Business'] as const;
export type SiteRestriction = (typeof SITE_RESTRICTIONS)[number];

export const TARGETING_TYPES = ['MANUAL', 'AUTO'] as const;
export type TargetingType = (typeof TARGETING_TYPES)[number];

/** Which goals the source app offers per campaign type. The first is the default. */
export const CAMPAIGN_TYPE_GOALS: Record<CampaignType, readonly Goal[]> = {
  SKW: ['Rank', 'Brand'],
  Halo: ['Profit'],
  Phrase: ['Discovery', 'Brand'],
  Auto: ['Discovery'],
  PAT: ['Discovery', 'Rank', 'Profit', 'Brand'],
};

export const CAMPAIGN_TYPE_MATCH: Record<CampaignType, MatchType> = {
  SKW: 'EXACT',
  Halo: 'EXACT',
  Phrase: 'PHRASE',
  Auto: 'AUTO',
  PAT: 'ASIN_EXACT',
};

/** The type-level bidding default, used when no purpose has a table row. */
export const CAMPAIGN_TYPE_BIDDING: Record<CampaignType, BiddingStrategy> = {
  SKW: 'Fixed bids',
  Halo: 'Down only',
  Phrase: 'Down only',
  Auto: 'Up and down',
  PAT: 'Down only',
};

export const CAMPAIGN_PURPOSES = [
  'RANK_SKW',
  'HALO',
  'DISCOVERY',
  'AUTO',
  'CATEGORY',
  'SELF_TARGETING',
  'SHIELD',
] as const;
export type CampaignPurpose = (typeof CAMPAIGN_PURPOSES)[number];

/**
 * Purpose cuts across type: a Shield campaign is still `SKW`, and a
 * self-targeting campaign is still `PAT`, but each takes a different bidding
 * default than its type's usual one.
 */
export const CAMPAIGN_TYPE_DEFAULT_PURPOSE: Record<CampaignType, CampaignPurpose> = {
  SKW: 'RANK_SKW',
  Halo: 'HALO',
  Phrase: 'DISCOVERY',
  Auto: 'AUTO',
  PAT: 'DISCOVERY',
};

export const CAMPAIGN_PURPOSE_BIDDING: Record<CampaignPurpose, BiddingStrategy> = {
  RANK_SKW: 'Fixed bids',
  AUTO: 'Up and down',
  CATEGORY: 'Up and down',
  SELF_TARGETING: 'Up and down',
  SHIELD: 'Down only',
  DISCOVERY: 'Down only',
  HALO: 'Down only',
};

/**
 * The trigger word in a campaign name must match the campaign type. Three
 * purposes are not literal type values and carry their own label; everything
 * else falls back to the type.
 */
export const TRIGGER_WORD_LABELS: Partial<Record<CampaignPurpose, string>> = {
  SHIELD: 'Shield',
  SELF_TARGETING: 'Self-Targeting',
  CATEGORY: 'Category',
};

export const NAMING_VARIABLES = [
  'Goal', 'SP', 'AdType', 'MatchType', 'TriggerWord', 'ProductName', 'Keyword',
  'TargetDescriptor', 'EW', 'Counter', 'CampCounter', 'CampaignType', 'Date',
  'Custom1', 'Custom2',
] as const;
export type NamingVariable = (typeof NAMING_VARIABLES)[number];

export const MATCH_TYPE_LABELS: Record<MatchType, string> = {
  EXACT: 'Exact',
  BROAD: 'Broad',
  PHRASE: 'Phrase',
  ASIN_EXACT: 'ASINExact',
  ASIN_EXPANDED: 'ASINExpanded',
  AUTO: 'Auto',
};

/** Amazon's own limits, not ours. */
export const MIN_BID = 0.02;
export const MAX_BID = 1000.0;
export const MIN_BUDGET = 1.0;
export const DEFAULT_BID = 0.5;
export const DEFAULT_BUDGET = 10.0;
export const MAX_CAMPAIGN_NAME = 128;
export const MAX_AD_GROUP_NAME = 255;
export const MAX_PLACEMENT_PERCENT = 900;

export const SHEET_NAME_SP = 'Sponsored Products Campaigns';

/** Column order is part of the contract: Amazon reads the header, we write it. */
export const SP_COLUMNS = [
  'Product', 'Entity', 'Operation', 'Campaign ID', 'Ad Group ID', 'Portfolio ID',
  'Ad ID', 'Keyword ID', 'Product Targeting ID', 'Campaign Name', 'Ad Group Name',
  'Start Date', 'End Date', 'Targeting Type', 'State', 'Daily Budget', 'SKU', 'ASIN',
  'Ad Group Default Bid', 'Bid', 'Keyword Text', 'Match Type', 'Bidding Strategy',
  'Placement', 'Percentage', 'Product Targeting Expression', 'Sites',
] as const;
export type SpColumn = (typeof SP_COLUMNS)[number];

export const AMAZON_MATCH: Partial<Record<MatchType, string>> = {
  EXACT: 'exact',
  BROAD: 'broad',
  PHRASE: 'phrase',
};

export const AMAZON_NEG_MATCH: Record<NegativeMatchType, string> = {
  NEGATIVE_EXACT: 'negativeExact',
  NEGATIVE_PHRASE: 'negativePhrase',
};

export const AMAZON_BIDDING: Record<BiddingStrategy, string> = {
  'Down only': 'Dynamic bids - down only',
  'Up and down': 'Dynamic bids - up and down',
  'Fixed bids': 'Fixed bid',
};

/** Placement keys in the order the reference emits their Bidding Adjustment rows. */
export const PLACEMENT_KEYS = [
  'topOfSearchPlacement',
  'restOfSearchPlacement',
  'productPagesPlacement',
] as const;
export type PlacementKey = (typeof PLACEMENT_KEYS)[number];

export const PLACEMENT_LABELS: Record<PlacementKey, string> = {
  topOfSearchPlacement: 'Placement Top',
  restOfSearchPlacement: 'Placement Rest Of Search',
  productPagesPlacement: 'Placement Product Page',
};

/**
 * The four auto-targeting groups: the expression each writes, and the two spec
 * fields that override its bid and its state. Naming the fields here rather
 * than assembling them from the key keeps the compiler checking that they
 * exist.
 */
export const AUTO_GROUPS = [
  { key: 'closeMatch', expression: 'close-match', bidField: 'autoCloseMatchBid', stateField: 'autoCloseMatchState' },
  { key: 'looseMatch', expression: 'loose-match', bidField: 'autoLooseMatchBid', stateField: 'autoLooseMatchState' },
  { key: 'substitutes', expression: 'substitutes', bidField: 'autoSubstitutesBid', stateField: 'autoSubstitutesState' },
  { key: 'complements', expression: 'complements', bidField: 'autoComplementsBid', stateField: 'autoComplementsState' },
] as const;
export type AutoGroupKey = (typeof AUTO_GROUPS)[number]['key'];

export const AUTO_EXPRESSIONS: readonly string[] = AUTO_GROUPS.map((g) => g.expression);

export const ASIN_PATTERN = /^[A-Z0-9]{10}$/;

/**
 * The entity names a create file uses, in the order a campaign emits them.
 * Exported because the QA gates and the plan projection must agree on them.
 */
export const ENTITIES = [
  'Campaign',
  'Bidding Adjustment',
  'Ad Group',
  'Product Ad',
  'Product Targeting',
  'Keyword',
  'Negative Product Targeting',
  'Negative Keyword',
  'Campaign Negative Keyword',
] as const;
export type Entity = (typeof ENTITIES)[number];
