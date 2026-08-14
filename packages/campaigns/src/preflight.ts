/**
 * Preflight: is this config buildable, and is anything about it suspicious.
 *
 * Two severities, and the difference is load-bearing. An **issue** is a file
 * Amazon would reject or a campaign that would advertise nothing, so it blocks
 * the build. A **note** is a doctrine smell — a discovery campaign with no
 * never-ever list, a bidding strategy that overrides the QC table, a campaign
 * that would go live on upload — which the operator reads and decides about.
 *
 * The message strings are the contract. They are pinned against the reference
 * toolkit's own preflight in the parity suite, word for word, because an
 * operator reads these and not the code.
 */
import {
  ASIN_PATTERN,
  BIDDING_STRATEGIES,
  CAMPAIGN_PURPOSES,
  CAMPAIGN_PURPOSE_BIDDING,
  CAMPAIGN_TYPES,
  CAMPAIGN_TYPE_DEFAULT_PURPOSE,
  CAMPAIGN_TYPE_GOALS,
  CAMPAIGN_TYPE_MATCH,
  DROPPED_CAMPAIGN_TYPES,
  GOALS,
  MATCH_TYPES,
  MAX_BID,
  MAX_PLACEMENT_PERCENT,
  MIN_BID,
  MIN_BUDGET,
  NEGATIVE_LEVELS,
  NEGATIVE_MATCH_TYPES,
  STATES,
  type CampaignPurpose,
  type CampaignType,
  type Goal,
} from './constants.js';
import { generateAll } from './generate.js';
import { resolveNaming } from './naming.js';
import { resolveSpecs, vendorCentralMode } from './resolve.js';
import type { CampaignBuildConfig } from './types.js';
import { parseProductList, pyFloat, splitLines } from './util.js';

export interface PreflightResult {
  /** True when nothing blocks a build. Notes do not block. */
  ready: boolean;
  issues: string[];
  notes: string[];
}

/**
 * Placement fields, paired with the snake_case name a message reports.
 *
 * Messages name the key an operator's JSON actually uses, not the camelCase
 * the engine works in, so a reader can find what a message is about.
 */
const PLACEMENT_FIELDS = [
  ['topOfSearchPlacement', 'top_of_search_placement'],
  ['restOfSearchPlacement', 'rest_of_search_placement'],
  ['productPagesPlacement', 'product_pages_placement'],
] as const;

/** A well-formed ISO date, or null. Only the shape matters here. */
function isoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function preflight(config: CampaignBuildConfig, today: string): PreflightResult {
  const issues: string[] = [];
  const notes: string[] = [];

  if (!config.client) issues.push('config: `client` is required');
  if (!config.marketplace) issues.push('config: `marketplace` is required');
  if (config.campaigns.length === 0) {
    issues.push('config: `campaigns[]` is empty (nothing to build)');
  }

  const vendor = vendorCentralMode(config);
  const specs = resolveSpecs(config);
  const naming = resolveNaming(config.naming);
  const order = naming.variableOrder;

  specs.forEach((spec, index) => {
    const tag = `campaign ${index + 1} (${spec.campaignType || '?'})`;
    const type = spec.campaignType;

    const dropped = DROPPED_CAMPAIGN_TYPES[type];
    if (dropped !== undefined) {
      issues.push(`${tag}: ${dropped}`);
      return;
    }
    if (!CAMPAIGN_TYPES.includes(type as CampaignType)) {
      issues.push(`${tag}: campaign_type must be one of ${CAMPAIGN_TYPES.join('/')}`);
      return;
    }
    const campaignType = type as CampaignType;

    if (!spec.productName) {
      issues.push(`${tag}: product_name is required (used in the campaign name)`);
    }
    const skus = parseProductList(spec.sku);
    const asins = parseProductList(spec.asin);
    if (vendor && asins.length === 0) {
      issues.push(`${tag}: vendor mode needs asin(s) for the Product Ad rows`);
    }
    if (!vendor && skus.length === 0) {
      issues.push(
        `${tag}: sku(s) required for the Product Ad rows (seller accounts advertise by SKU)`,
      );
    }

    const keywords = splitLines(spec.keywordsRaw);
    if (['SKW', 'Halo', 'Phrase'].includes(campaignType) && keywords.length === 0) {
      issues.push(`${tag}: keywords[] is required for ${campaignType}`);
    }
    if (campaignType === 'PAT' && keywords.length === 0) {
      issues.push(`${tag}: target_asins[] or target_categories[] is required for PAT`);
    }
    if (campaignType === 'PAT') {
      if (spec.targetMode === 'CATEGORY') {
        const bad = keywords.filter((c) => !/^\d+$/.test(c.trim()));
        if (bad.length > 0) {
          issues.push(
            `${tag}: target_categories entries must be numeric category IDs: ${bad.slice(0, 5).join(', ')}`,
          );
        }
      } else {
        const bad = keywords.filter((a) => !ASIN_PATTERN.test(a.trim().toUpperCase()));
        if (bad.length > 0) {
          issues.push(`${tag}: target_asins entries not ASIN-shaped: ${bad.slice(0, 5).join(', ')}`);
        }
      }
    }

    const badNegativeAsins = spec.negativeTargetAsins.filter(
      (a) => !ASIN_PATTERN.test(String(a).trim().toUpperCase()),
    );
    if (badNegativeAsins.length > 0) {
      issues.push(
        `${tag}: negative_target_asins entries not ASIN-shaped: ${badNegativeAsins.slice(0, 5).join(', ')}`,
      );
    }

    if (!GOALS.includes(spec.goal as Goal)) {
      issues.push(`${tag}: goal must be one of ${GOALS.join('/')}`);
    } else if (!CAMPAIGN_TYPE_GOALS[campaignType].includes(spec.goal as Goal)) {
      notes.push(
        `${tag}: goal '${spec.goal}' is unusual for ${campaignType} `
        + `(app allows ${CAMPAIGN_TYPE_GOALS[campaignType].join('/')})`,
      );
    }

    if (spec.matchType && !MATCH_TYPES.includes(spec.matchType as never)) {
      issues.push(
        `${tag}: match_type must be one of ${MATCH_TYPES.join('/')} (or empty for the `
        + `${campaignType} default ${CAMPAIGN_TYPE_MATCH[campaignType]})`,
      );
    }
    if (spec.campaignPurpose && !CAMPAIGN_PURPOSES.includes(spec.campaignPurpose as CampaignPurpose)) {
      issues.push(
        `${tag}: campaign_purpose must be one of ${CAMPAIGN_PURPOSES.join('/')} (or empty for `
        + `the ${campaignType} default ${CAMPAIGN_TYPE_DEFAULT_PURPOSE[campaignType]})`,
      );
    }

    if (spec.biddingStrategy && !BIDDING_STRATEGIES.includes(spec.biddingStrategy as never)) {
      issues.push(`${tag}: bidding_strategy must be one of ${BIDDING_STRATEGIES.join('/')} (or empty)`);
    } else if (spec.biddingStrategy) {
      const purpose = (spec.campaignPurpose || CAMPAIGN_TYPE_DEFAULT_PURPOSE[campaignType]) as CampaignPurpose;
      const expected = CAMPAIGN_PURPOSE_BIDDING[purpose];
      if (expected && spec.biddingStrategy !== expected) {
        notes.push(
          `${tag}: bidding_strategy override '${spec.biddingStrategy}' differs from the `
          + `naming-convention.md default '${expected}' for purpose ${purpose} (QC-enforced table)`,
        );
      }
    }

    if (!STATES.includes(spec.state as never)) issues.push(`${tag}: state must be enabled|paused`);
    if (spec.childState && !STATES.includes(spec.childState as never)) {
      issues.push(`${tag}: child_state must be enabled|paused (or empty to inherit state)`);
    }

    if (!(spec.keywordBid >= MIN_BID && spec.keywordBid <= MAX_BID)) {
      issues.push(
        `${tag}: keyword_bid ${pyFloat(spec.keywordBid)} outside [${pyFloat(MIN_BID)}, ${pyFloat(MAX_BID)}]`,
      );
    }
    if (spec.dailyBudget < MIN_BUDGET) {
      issues.push(
        `${tag}: daily_budget ${pyFloat(spec.dailyBudget)} below Amazon's minimum ${pyFloat(MIN_BUDGET)}`,
      );
    }
    for (const [field, reported] of PLACEMENT_FIELDS) {
      const pct = spec[field];
      if (pct !== null && !(pct >= 0 && pct <= MAX_PLACEMENT_PERCENT)) {
        issues.push(`${tag}: ${reported} ${pct} outside [0, ${MAX_PLACEMENT_PERCENT}]`);
      }
    }

    if (!NEGATIVE_MATCH_TYPES.includes(spec.negativeMatchType as never)) {
      issues.push(`${tag}: negative_match_type must be one of ${NEGATIVE_MATCH_TYPES.join('/')}`);
    }
    if (!NEGATIVE_LEVELS.includes(spec.negativeLevel as never)) {
      issues.push(`${tag}: negative_level must be ad_group|campaign`);
    }
    if (spec.transposeKeywords && spec.keywordsPerCampaign < 1) {
      issues.push(`${tag}: transpose_keywords needs keywords_per_campaign >= 1`);
    }

    // Amazon rejects duplicate campaign names on create, so a spec that fans
    // out has to carry something in the name that differs per campaign.
    const fansOut = (spec.transposeKeywords && spec.keywordsPerCampaign >= 1
      && keywords.length > spec.keywordsPerCampaign)
      || (campaignType === 'SKW' && keywords.length > 1 && !spec.skwIncludeKeywordInName);
    const byKeyword = order.includes('Keyword') && campaignType === 'SKW' && spec.skwIncludeKeywordInName;
    const byCounter = order.includes('Counter')
      || (order.includes('CampCounter') && (campaignType === 'Halo' || campaignType === 'Auto'));
    if (fansOut && !byKeyword && !byCounter) {
      issues.push(
        `${tag}: fans out to several identically-named campaigns; add 'Counter' `
        + `(or, for Halo/Auto, 'CampCounter') to naming.variable_order (Amazon rejects `
        + `duplicate campaign names)`,
      );
    }

    if (campaignType === 'Phrase' && spec.negativeKeywords.length === 0) {
      notes.push(
        `${tag}: discovery campaign has no negative_keywords; naming-convention.md QC `
        + `requires a Never-Ever/negative-phrase list at ad-group level from day one`,
      );
    }
    const purposeForQc = spec.campaignPurpose || CAMPAIGN_TYPE_DEFAULT_PURPOSE[campaignType];
    if (campaignType === 'PAT' && spec.matchType === 'ASIN_EXPANDED'
      && purposeForQc === 'SELF_TARGETING' && spec.negativeTargetAsins.length === 0) {
      notes.push(
        `${tag}: Self-Targeting Expanded needs negative_target_asins for the exact own-ASIN `
        + `targets (naming-convention.md QC #7)`,
      );
    }

    if (spec.startDate) {
      const parsed = isoDate(spec.startDate);
      if (parsed === null) {
        issues.push(`${tag}: start_date must be YYYY-MM-DD`);
      } else if (spec.startDate < today) {
        issues.push(
          `${tag}: start_date ${spec.startDate} is in the past; Amazon rejects past start dates on create`,
        );
      }
    }
    if (spec.state === 'enabled') {
      notes.push(`${tag}: state=enabled means campaigns go LIVE on upload; the safety default is paused`);
    }
  });

  // The ad-group-name check needs generated names, and generating from a
  // config that already failed would just raise on the way to a worse message.
  if (issues.length === 0) {
    for (const campaign of generateAll(specs, naming, today)) {
      if (campaign.adGroupName === campaign.campaignName) {
        notes.push(
          `'${campaign.campaignName}': ad group name equals campaign name; naming-convention.md `
          + `QC requires the ad group name to differ (drop prefix & suffix)`,
        );
      }
    }
  }

  return { ready: issues.length === 0, issues, notes };
}
