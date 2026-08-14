/**
 * Merging the file-wide defaults into each campaign spec.
 *
 * The rule the reference uses, and this keeps: a spec value wins, an empty
 * spec value falls through to `defaults`, and an empty default falls through
 * to a built-in. "Empty" means `null`, `undefined` or the empty string, and
 * deliberately not zero: a placement of 0% is a decision, not a blank.
 *
 * Two fields do NOT fall through to defaults, and both are on purpose:
 * negatives (a never-ever list belongs to the campaign that needs it) and the
 * per-campaign placement overrides (the file-wide placements are applied later,
 * at the row boundary, so that "unset" and "set to zero" stay distinguishable).
 */
import {
  CAMPAIGN_PURPOSE_BIDDING,
  CAMPAIGN_TYPE_BIDDING,
  CAMPAIGN_TYPE_DEFAULT_PURPOSE,
  CAMPAIGN_TYPE_GOALS,
  CAMPAIGN_TYPE_MATCH,
  DEFAULT_BID,
  DEFAULT_BUDGET,
  STATES,
  TRIGGER_WORD_LABELS,
  type BiddingStrategy,
  type CampaignPurpose,
  type CampaignType,
  type EntityState,
  type MatchType,
} from './constants.js';
import type { CampaignBuildConfig, CampaignDefaults, CampaignSpec, ResolvedSpec } from './types.js';

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function pick<T>(spec: CampaignSpec, defaults: CampaignDefaults, key: keyof CampaignSpec, fallback: T): T | string | number | boolean {
  const own = spec[key];
  const value = isBlank(own) ? defaults[key] : own;
  return isBlank(value) ? fallback : (value as T | string | number | boolean);
}

function asState(value: unknown): EntityState | null {
  return STATES.includes(value as EntityState) ? (value as EntityState) : null;
}

function asBid(value: unknown): number | null {
  return isBlank(value) ? null : Number(value);
}

function asPlacement(value: unknown): number | null {
  return isBlank(value) ? null : Math.trunc(Number(value));
}

/** One spec plus the defaults, every value coerced. */
export function resolveSpec(spec: CampaignSpec, defaults: CampaignDefaults): ResolvedSpec {
  const campaignType = spec.campaignType ?? '';
  const goals = CAMPAIGN_TYPE_GOALS[campaignType as CampaignType] ?? ['Discovery'];
  const targetCategories = spec.targetCategories ?? [];
  const targetAsins = spec.targetAsins ?? [];
  const isPat = campaignType === 'PAT';

  // A PAT campaign's "keywords" are its targets: categories if it has any,
  // otherwise ASINs. Everything else uses the keyword list.
  let keywords: readonly string[] | string;
  if (isPat && targetCategories.length > 0) keywords = targetCategories;
  else if (isPat && targetAsins.length > 0) keywords = targetAsins;
  else keywords = spec.keywords ?? [];
  const keywordList = typeof keywords === 'string' ? keywords.split('\n') : keywords;

  return {
    campaignType,
    campaignPurpose: (spec.campaignPurpose ?? '').trim().toUpperCase(),
    goal: spec.goal || (goals[0] as string),
    productName: spec.productName ?? '',
    targetDescriptor: spec.targetDescriptor ?? '',
    sku: spec.sku ?? '',
    asin: spec.asin ?? '',
    keywordsRaw: keywordList.map((k) => String(k)).join('\n'),
    targetMode: isPat && targetCategories.length > 0 ? 'CATEGORY' : 'ASIN',
    keywordsPerCampaign: Math.trunc(Number(spec.keywordsPerCampaign ?? 0)) || 0,
    transposeKeywords: Boolean(spec.transposeKeywords),
    swapNameOrder: Boolean(spec.swapNameOrder),
    skwIncludeKeywordInName: Boolean(spec.skwIncludeKeywordInName ?? true),
    matchType: spec.matchType || '',
    dailyBudget: Number(pick(spec, defaults, 'dailyBudget', DEFAULT_BUDGET)),
    keywordBid: Number(pick(spec, defaults, 'keywordBid', DEFAULT_BID)),
    biddingStrategy: String(pick(spec, defaults, 'biddingStrategy', '')),
    portfolioId: String(pick(spec, defaults, 'portfolioId', '')),
    negativeKeywords: spec.negativeKeywords ?? [],
    negativeTargetAsins: spec.negativeTargetAsins ?? [],
    negativeMatchType: spec.negativeMatchType || 'NEGATIVE_EXACT',
    negativeLevel: spec.negativeLevel || 'ad_group',
    state: String(pick(spec, defaults, 'state', 'paused')),
    childState: String(pick(spec, defaults, 'childState', '')),
    startDate: String(pick(spec, defaults, 'startDate', '')),
    siteRestriction: String(pick(spec, defaults, 'siteRestriction', 'Amazon')),
    topOfSearchPlacement: asPlacement(spec.topOfSearchPlacement),
    restOfSearchPlacement: asPlacement(spec.restOfSearchPlacement),
    productPagesPlacement: asPlacement(spec.productPagesPlacement),
    autoCloseMatchBid: asBid(spec.autoCloseMatchBid),
    autoCloseMatchState: asState(spec.autoCloseMatchState),
    autoLooseMatchBid: asBid(spec.autoLooseMatchBid),
    autoLooseMatchState: asState(spec.autoLooseMatchState),
    autoSubstitutesBid: asBid(spec.autoSubstitutesBid),
    autoSubstitutesState: asState(spec.autoSubstitutesState),
    autoComplementsBid: asBid(spec.autoComplementsBid),
    autoComplementsState: asState(spec.autoComplementsState),
  };
}

export function resolveSpecs(config: CampaignBuildConfig): ResolvedSpec[] {
  return config.campaigns.map((spec) => resolveSpec(spec, config.defaults));
}

/** Vendor mode can be declared on the file or inside its defaults block. */
export function vendorCentralMode(config: CampaignBuildConfig): boolean {
  return Boolean(config.defaults.vendorCentralMode || config.vendorCentralMode);
}

/** An explicit purpose wins; otherwise the campaign type's default one. */
export function resolveCampaignPurpose(spec: ResolvedSpec): CampaignPurpose {
  if (spec.campaignPurpose) return spec.campaignPurpose as CampaignPurpose;
  return CAMPAIGN_TYPE_DEFAULT_PURPOSE[spec.campaignType as CampaignType] ?? 'DISCOVERY';
}

/**
 * The trigger word slot. Three purposes carry their own label because they are
 * not literal campaign types; everything else is named after its type.
 */
export function resolveTriggerWord(spec: ResolvedSpec): string {
  const purpose = resolveCampaignPurpose(spec);
  return TRIGGER_WORD_LABELS[purpose] ?? spec.campaignType;
}

/**
 * Explicit override first, then the purpose table, then the type default.
 *
 * The purpose table is the one that matters: a Shield campaign built on SKW
 * takes down-only rather than the fixed bid its type would otherwise get.
 */
export function resolveBiddingStrategy(spec: ResolvedSpec): BiddingStrategy {
  if (spec.biddingStrategy) return spec.biddingStrategy as BiddingStrategy;
  const purpose = resolveCampaignPurpose(spec);
  return CAMPAIGN_PURPOSE_BIDDING[purpose]
    ?? CAMPAIGN_TYPE_BIDDING[spec.campaignType as CampaignType];
}

/** The spec's match type, or the campaign type's default one. */
export function resolveMatchType(spec: ResolvedSpec): MatchType {
  return (spec.matchType || CAMPAIGN_TYPE_MATCH[spec.campaignType as CampaignType]) as MatchType;
}
