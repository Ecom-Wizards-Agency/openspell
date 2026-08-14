/**
 * The plan, and the rows the plan projects to.
 *
 * This is the file where the two halves meet. `buildPlan` resolves the last
 * layer of defaults — the file-wide placements, the portfolio, the start date,
 * vendor mode — and assigns the temporary ids that link a campaign to its ad
 * group. `planToRows` then only reads: every value a row carries is already on
 * the plan, so the exported workbook and the plan an operator reviews cannot
 * disagree about a bid.
 *
 * Temporary ids are `tmp-N`, counted across the whole file. They are not
 * numeric on purpose: Amazon's bulksheet parser rejects a bare number as a
 * temporary id on a create row, which cost a live upload once.
 */
import {
  AMAZON_BIDDING,
  AMAZON_MATCH,
  AMAZON_NEG_MATCH,
  AUTO_GROUPS,
  PLACEMENT_KEYS,
  PLACEMENT_LABELS,
  SHEET_NAME_SP,
  SP_COLUMNS,
  type EntityState,
  type NegativeMatchType,
  type PlacementKey,
} from './constants.js';
import { generateAll } from './generate.js';
import { resolveNaming } from './naming.js';
import { resolveSpecs, vendorCentralMode } from './resolve.js';
import {
  CAMPAIGN_PLAN_SCHEMA,
  type BulkRow,
  type CampaignBuildConfig,
  type CampaignPlan,
  type GeneratedCampaign,
  type PlannedAdGroup,
  type PlannedCampaign,
  type PlannedKeyword,
  type PlannedNegativeKeyword,
  type PlannedNegativeProductTarget,
  type PlannedPlacement,
  type PlannedProductAd,
  type PlannedProductTarget,
  type SheetModel,
} from './types.js';
import { money, parseDateToExport, parseProductList } from './util.js';

export interface BuildPlanOptions {
  /** `YYYY-MM-DD`. Required: this engine never reads a clock. */
  today: string;
}

/** Per-campaign placement, else the file-wide default, else nothing. */
function placementPercent(
  campaign: GeneratedCampaign,
  key: PlacementKey,
  defaults: CampaignBuildConfig['defaults'],
): number {
  const own = campaign[key];
  const value = own ?? defaults[key] ?? 0;
  return value || 0;
}

function autoTargets(campaign: GeneratedCampaign, childState: EntityState): PlannedProductTarget[] {
  return AUTO_GROUPS.map((group) => ({
    expression: group.expression,
    bid: money(campaign[group.bidField] ?? campaign.keywordBid),
    state: campaign[group.stateField] ?? childState,
  }));
}

function patTargets(campaign: GeneratedCampaign, childState: EntityState): PlannedProductTarget[] {
  const expanded = campaign.matchType === 'ASIN_EXPANDED';
  const expressions = [
    ...campaign.categories.map((categoryId) => `category="${categoryId}"`),
    ...campaign.asins.map((asin) => (expanded ? `asin-expanded="${asin}"` : `asin="${asin}"`)),
  ];
  return expressions.map((expression) => ({
    expression,
    bid: money(campaign.keywordBid),
    state: childState,
  }));
}

function keywordTargets(campaign: GeneratedCampaign, childState: EntityState): PlannedKeyword[] {
  const matchType = AMAZON_MATCH[campaign.matchType] ?? campaign.matchType;
  return campaign.keywords.map((text) => ({
    text,
    matchType,
    bid: money(campaign.keywordBid),
    state: childState,
  }));
}

function productAds(
  campaign: GeneratedCampaign,
  childState: EntityState,
  vendorMode: boolean,
): PlannedProductAd[] {
  const skus = parseProductList(campaign.sku);
  const asins = parseProductList(campaign.asin);
  const out: PlannedProductAd[] = [];
  for (let i = 0; i < Math.max(skus.length, asins.length); i += 1) {
    const sku = skus[i] ?? '';
    const asin = asins[i] ?? '';
    if (!sku && !asin) continue;
    // A vendor account advertises by ASIN; sending a SKU is how a vendor bulk
    // upload fails, so the column goes out empty rather than absent.
    out.push({ sku: vendorMode ? '' : sku, asin, state: childState });
  }
  return out;
}

function negativeKeywords(
  campaign: GeneratedCampaign,
  childState: EntityState,
): PlannedNegativeKeyword[] {
  const matchType = AMAZON_NEG_MATCH[(campaign.negativeMatchType || 'NEGATIVE_EXACT') as NegativeMatchType]
    ?? campaign.negativeMatchType;
  return campaign.negativeKeywords.map((text) => ({ text, matchType, state: childState }));
}

function negativeProductTargets(
  campaign: GeneratedCampaign,
  childState: EntityState,
): PlannedNegativeProductTarget[] {
  return campaign.negativeTargetAsins.map((asin) => ({
    expression: `asin="${String(asin).trim().toUpperCase()}"`,
    state: childState,
  }));
}

/** Generated campaigns to a plan, with every remaining default resolved. */
export function planFromCampaigns(
  campaigns: readonly GeneratedCampaign[],
  config: CampaignBuildConfig,
  options: BuildPlanOptions,
): CampaignPlan {
  const vendorMode = vendorCentralMode(config);
  let nextId = 0;
  const tempId = (): string => {
    nextId += 1;
    return `tmp-${nextId}`;
  };

  const planned: PlannedCampaign[] = campaigns.map((campaign) => {
    const childState = campaign.childState || campaign.state;
    const campaignId = tempId();
    const adGroupId = tempId();

    const placements: PlannedPlacement[] = [];
    for (const key of PLACEMENT_KEYS) {
      const percentage = placementPercent(campaign, key, config.defaults);
      if (percentage > 0) {
        placements.push({ placement: PLACEMENT_LABELS[key], percentage: Math.trunc(percentage) });
      }
    }

    const targets = campaign.targetingType === 'AUTO'
      ? autoTargets(campaign, childState)
      : campaign.campaignType === 'PAT'
        ? patTargets(campaign, childState)
        : [];
    const keywords = campaign.targetingType === 'AUTO' || campaign.campaignType === 'PAT'
      ? []
      : keywordTargets(campaign, childState);
    const negatives = negativeKeywords(campaign, childState);
    const atCampaignLevel = campaign.negativeLevel === 'campaign';

    const adGroup: PlannedAdGroup = {
      id: adGroupId,
      name: campaign.adGroupName,
      state: childState,
      defaultBid: money(campaign.keywordBid),
      productAds: productAds(campaign, childState, vendorMode),
      keywords,
      productTargets: targets,
      negativeKeywords: atCampaignLevel ? [] : negatives,
      negativeProductTargets: negativeProductTargets(campaign, childState),
    };

    return {
      id: campaignId,
      name: campaign.campaignName,
      campaignType: campaign.campaignType,
      campaignPurpose: campaign.campaignPurpose,
      goal: campaign.goal,
      targetingType: campaign.targetingType,
      matchType: campaign.matchType,
      targetDescriptor: campaign.targetDescriptor,
      state: campaign.state,
      dailyBudget: money(campaign.dailyBudget),
      biddingStrategy: campaign.biddingStrategy,
      biddingStrategyLabel: AMAZON_BIDDING[campaign.biddingStrategy] ?? campaign.biddingStrategy,
      startDate: parseDateToExport(campaign.startDate || '', options.today),
      portfolioId: campaign.portfolioId || String(config.defaults.portfolioId ?? ''),
      sites: campaign.siteRestriction === 'Amazon Business' ? 'Amazon Business' : '',
      placements,
      adGroup,
      negativeKeywords: atCampaignLevel ? negatives : [],
    };
  });

  return {
    schema: CAMPAIGN_PLAN_SCHEMA,
    client: config.client,
    marketplace: config.marketplace,
    today: options.today,
    sheetName: SHEET_NAME_SP,
    campaigns: planned,
  };
}

/** A whole config to a plan: resolve the specs, generate, then plan. */
export function buildCampaignPlan(
  config: CampaignBuildConfig,
  options: BuildPlanOptions,
): CampaignPlan {
  const naming = resolveNaming(config.naming);
  const campaigns = generateAll(resolveSpecs(config), naming, options.today);
  return planFromCampaigns(campaigns, config, options);
}

// ---------------------------------------------------------------------------
// projection to bulk rows

function emptyRow(): BulkRow {
  const row = Object.fromEntries(SP_COLUMNS.map((column) => [column, ''])) as BulkRow;
  row.Product = 'Sponsored Products';
  row.Operation = 'Create';
  return row;
}

/**
 * A plan to bulk rows, in the order Amazon's parser wants to meet them:
 * campaign, its bid adjustments, its ad group, what it advertises, what it
 * targets, then what it excludes.
 */
export function planToRows(plan: CampaignPlan): BulkRow[] {
  const rows: BulkRow[] = [];

  for (const campaign of plan.campaigns) {
    const common = {
      'Campaign ID': campaign.id,
      'Campaign Name': campaign.name,
    };
    const adGroupCommon = {
      ...common,
      'Ad Group ID': campaign.adGroup.id,
      'Ad Group Name': campaign.adGroup.name,
      State: campaign.adGroup.state,
    };

    rows.push({
      ...emptyRow(),
      ...common,
      Entity: 'Campaign',
      'Start Date': campaign.startDate,
      'Targeting Type': campaign.targetingType,
      State: campaign.state,
      'Daily Budget': campaign.dailyBudget,
      'Bidding Strategy': campaign.biddingStrategyLabel,
      'Portfolio ID': campaign.portfolioId,
      Sites: campaign.sites,
    });

    for (const placement of campaign.placements) {
      rows.push({
        ...emptyRow(),
        ...common,
        Entity: 'Bidding Adjustment',
        Placement: placement.placement,
        Percentage: placement.percentage,
      });
    }

    rows.push({
      ...emptyRow(),
      ...adGroupCommon,
      Entity: 'Ad Group',
      'Ad Group Default Bid': campaign.adGroup.defaultBid,
    });

    for (const ad of campaign.adGroup.productAds) {
      rows.push({
        ...emptyRow(),
        ...adGroupCommon,
        Entity: 'Product Ad',
        State: ad.state,
        SKU: ad.sku,
        ASIN: ad.asin,
      });
    }

    for (const target of campaign.adGroup.productTargets) {
      rows.push({
        ...emptyRow(),
        ...adGroupCommon,
        Entity: 'Product Targeting',
        State: target.state,
        Bid: target.bid,
        'Product Targeting Expression': target.expression,
      });
    }

    for (const keyword of campaign.adGroup.keywords) {
      rows.push({
        ...emptyRow(),
        ...adGroupCommon,
        Entity: 'Keyword',
        State: keyword.state,
        Bid: keyword.bid,
        'Keyword Text': keyword.text,
        'Match Type': keyword.matchType,
      });
    }

    for (const negative of campaign.adGroup.negativeProductTargets) {
      rows.push({
        ...emptyRow(),
        ...adGroupCommon,
        Entity: 'Negative Product Targeting',
        State: negative.state,
        'Product Targeting Expression': negative.expression,
      });
    }

    for (const negative of campaign.adGroup.negativeKeywords) {
      rows.push({
        ...emptyRow(),
        ...adGroupCommon,
        Entity: 'Negative Keyword',
        State: negative.state,
        'Keyword Text': negative.text,
        'Match Type': negative.matchType,
      });
    }

    for (const negative of campaign.negativeKeywords) {
      rows.push({
        ...emptyRow(),
        ...common,
        Entity: 'Campaign Negative Keyword',
        State: negative.state,
        'Keyword Text': negative.text,
        'Match Type': negative.matchType,
      });
    }
  }

  return rows;
}

/** Rows as a worksheet: the header, then every row in column order. */
export function planToSheet(plan: CampaignPlan): SheetModel {
  return {
    sheetName: plan.sheetName,
    header: [...SP_COLUMNS],
    rows: planToRows(plan).map((row) => SP_COLUMNS.map((column) => row[column])),
  };
}
