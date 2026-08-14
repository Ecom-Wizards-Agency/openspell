/**
 * One resolved spec to the campaigns it asks for.
 *
 * The fan-out rule is per campaign type, and it is the whole shape of the
 * structure doctrine:
 *
 *   SKW    one campaign per keyword. That is what single-keyword means.
 *   PAT    one campaign for the whole target list, ASINs or categories.
 *   Auto   one campaign, four targeting groups, no keywords.
 *   others one campaign for the whole list, unless the spec asks for chunks.
 *
 * Everything else here is bookkeeping: which name each campaign gets, and
 * which of the resolved values ride along on it.
 */
import type {
  CampaignPurpose,
  CampaignType,
  EntityState,
  NegativeLevel,
  NegativeMatchType,
  SiteRestriction,
  TargetingType,
} from './constants.js';
import { generateAdGroupName, generateCampaignName, swapNameOrder, type NamingContext } from './naming.js';
import {
  resolveBiddingStrategy,
  resolveCampaignPurpose,
  resolveMatchType,
  resolveTriggerWord,
} from './resolve.js';
import type { GeneratedCampaign, NamingSettings, ResolvedSpec } from './types.js';
import { chunk, formatStartDate, splitLines } from './util.js';

/** Everything a campaign carries that comes straight off its spec. */
function carriedFromSpec(spec: ResolvedSpec) {
  return {
    sku: spec.sku,
    asin: spec.asin,
    dailyBudget: spec.dailyBudget,
    keywordBid: spec.keywordBid,
    negativeKeywords: spec.negativeKeywords,
    negativeTargetAsins: spec.negativeTargetAsins,
    negativeMatchType: spec.negativeMatchType as NegativeMatchType,
    negativeLevel: spec.negativeLevel as NegativeLevel,
    portfolioId: spec.portfolioId,
    state: spec.state as EntityState,
    childState: (spec.childState || spec.state) as EntityState,
    startDate: formatStartDate(spec.startDate),
    siteRestriction: spec.siteRestriction as SiteRestriction,
    topOfSearchPlacement: spec.topOfSearchPlacement,
    restOfSearchPlacement: spec.restOfSearchPlacement,
    productPagesPlacement: spec.productPagesPlacement,
    autoCloseMatchBid: spec.autoCloseMatchBid,
    autoCloseMatchState: spec.autoCloseMatchState,
    autoLooseMatchBid: spec.autoLooseMatchBid,
    autoLooseMatchState: spec.autoLooseMatchState,
    autoSubstitutesBid: spec.autoSubstitutesBid,
    autoSubstitutesState: spec.autoSubstitutesState,
    autoComplementsBid: spec.autoComplementsBid,
    autoComplementsState: spec.autoComplementsState,
  };
}

/**
 * The campaigns one spec produces.
 *
 * `today` is an argument, never a clock read, so the same spec generates the
 * same plan whenever it runs. Only the `Date` naming slot uses it here; the
 * start-date column resolves later, at the row boundary.
 */
export function generateCampaigns(
  spec: ResolvedSpec,
  namingSettings: NamingSettings,
  today: string,
): GeneratedCampaign[] {
  const naming = spec.swapNameOrder ? swapNameOrder(namingSettings) : namingSettings;
  const matchType = resolveMatchType(spec);
  const purpose = resolveCampaignPurpose(spec);
  const biddingStrategy = resolveBiddingStrategy(spec);
  const triggerWord = resolveTriggerWord(spec);
  const targetingType: TargetingType = spec.campaignType === 'Auto' ? 'AUTO' : 'MANUAL';
  const rawKeywords = splitLines(spec.keywordsRaw);

  const campaigns: GeneratedCampaign[] = [];

  function push(
    targetDescriptor: string,
    counter: number,
    keywords: readonly string[],
    asins: readonly string[],
    categories: readonly string[] = [],
  ): void {
    const ctx: NamingContext = {
      goal: spec.goal,
      campaignType: spec.campaignType,
      matchType,
      productName: spec.productName,
      targetDescriptor,
      counter,
      triggerWord,
      // A campaign built around exactly one keyword is named after it; one
      // built around several is named after its descriptor.
      keywordText: keywords.length === 1 ? (keywords[0] as string) : targetDescriptor,
    };
    campaigns.push({
      campaignName: generateCampaignName(naming, ctx, today),
      adGroupName: generateAdGroupName(naming, ctx, today),
      campaignType: spec.campaignType as CampaignType,
      campaignPurpose: purpose as CampaignPurpose,
      goal: spec.goal,
      targetingType,
      matchType,
      targetDescriptor,
      keywords,
      asins,
      categories,
      biddingStrategy,
      ...carriedFromSpec(spec),
    });
  }

  if (spec.campaignType === 'PAT') {
    if (spec.targetMode === 'CATEGORY') push(spec.targetDescriptor, 1, [], [], rawKeywords);
    else push(spec.targetDescriptor, 1, [], rawKeywords);
    return campaigns;
  }

  if (spec.campaignType === 'Auto') {
    push(spec.targetDescriptor, 1, [], []);
    return campaigns;
  }

  if (spec.campaignType === 'SKW') {
    rawKeywords.forEach((keyword, index) => {
      const descriptor = spec.skwIncludeKeywordInName ? keyword : spec.targetDescriptor;
      push(descriptor, index + 1, [keyword], []);
    });
    return campaigns;
  }

  if (spec.transposeKeywords && rawKeywords.length > 0) {
    const per = Math.max(1, spec.keywordsPerCampaign || 1);
    chunk(rawKeywords, per).forEach((group, index) => {
      push(spec.targetDescriptor, index + 1, group, []);
    });
    return campaigns;
  }

  push(spec.targetDescriptor, 1, rawKeywords, []);
  return campaigns;
}

/** Every campaign a whole config asks for, in spec order. */
export function generateAll(
  specs: readonly ResolvedSpec[],
  naming: NamingSettings,
  today: string,
): GeneratedCampaign[] {
  return specs.flatMap((spec) => generateCampaigns(spec, naming, today));
}
