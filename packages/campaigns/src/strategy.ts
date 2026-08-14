/**
 * What a tenant's strategy document decides about a new campaign structure.
 *
 * The document itself is per-tenant database data; not one of its numbers is
 * in this repository and none ever may be. What lives here is which field
 * drives which decision:
 *
 *   `naming`                        the name grammar, per bucket
 *   `bids.by_bucket`                daily budget and placement modifiers
 *   `bids.start_bid_pct_of_recommended`  the launch bid, off Amazon's recommendation
 *   `sv_bands`                      which keyword belongs in which bucket
 *   `caps`                          how many keywords or ASINs one campaign holds
 *   `pat_split`                     which competitors count as stronger
 *   `discovery.min_root_words`      whether a discovery root is specific enough
 *
 * Every accessor returns `null` when the tenant has not stated a value. None of
 * them substitutes a default, for the reason `packages/strategy` gives: there
 * is no honest default for a doctrine number, and a caller that gets `null`
 * must decline and say why rather than invent one.
 */
import type { TenantStrategy } from '@wizard-ads/shared';
import { BUCKET_DEFINITIONS, type CampaignBucket, type KeywordRow, type TargetRow } from './keywords.js';
import { resolveNaming } from './naming.js';
import type { CampaignSpec, NamingSettings } from './types.js';
import { money } from './util.js';

/** A finding a structure check produced. `fail` blocks; `warn` reports. */
export interface StrategyFinding {
  severity: 'warn' | 'fail';
  /** The bucket or campaign the finding is about. */
  subject: string;
  message: string;
}

/**
 * The naming grammar as the tenant wrote it.
 *
 * The document mirrors the source app's settings one for one, which is what
 * makes a name generated here identical to a name generated there.
 */
export function namingFromStrategy(strategy: TenantStrategy): NamingSettings {
  const naming = strategy.naming;
  return resolveNaming({
    variableOrder: naming.variable_order,
    delimiter: naming.delimiter,
    suffix: naming.suffix,
    custom1Value: naming.custom1_value,
    custom2Value: naming.custom2_value,
  });
}

/** Per-bucket name context: the goal, match type and descriptor template. */
export function bucketNaming(strategy: TenantStrategy, bucket: CampaignBucket) {
  return strategy.naming.by_bucket?.[bucket] ?? null;
}

/**
 * Fill a descriptor template. The reference supports three placeholders and
 * silently leaves an unknown one alone, which is the right failure: an operator
 * sees `{root}` in a campaign name and fixes the template.
 */
export function formatDescriptor(
  template: string,
  values: { keyword?: string; root?: string; counter?: number },
): string {
  return template
    .replaceAll('{keyword}', values.keyword ?? '')
    .replaceAll('{root}', values.root ?? '')
    .replaceAll('{counter}', values.counter === undefined ? '' : String(values.counter));
}

/** Budget and placement modifiers for a bucket, or `null` when unstated. */
export function bucketBids(strategy: TenantStrategy, bucket: CampaignBucket) {
  const bids = strategy.bids.by_bucket?.[bucket];
  if (!bids) return null;
  return {
    dailyBudget: bids.daily_budget ?? null,
    topOfSearchPlacement: bids.top_of_search_placement ?? null,
    restOfSearchPlacement: bids.rest_of_search_placement ?? null,
    productPagesPlacement: bids.product_pages_placement ?? null,
  };
}

/**
 * The launch bid: a signed percentage off Amazon's recommended bid.
 *
 * `-30` means start 30% below the recommendation. Returns `null` when either
 * the rule or the recommendation is missing, because a launch bid guessed from
 * neither is worse than no proposal at all.
 */
export function startBid(strategy: TenantStrategy, recommendedBid: number | null | undefined): number | null {
  const pct = strategy.bids.start_bid_pct_of_recommended;
  if (pct === undefined || recommendedBid === null || recommendedBid === undefined) return null;
  return money(recommendedBid * (1 + pct / 100));
}

/**
 * Search-volume band checks.
 *
 * Rank keywords have a window with a floor and a ceiling; halo keywords have
 * only a ceiling, because the whole point of a halo campaign is the long tail.
 * The severity of each is the tenant's call, and absent means `warn`.
 */
export function checkSearchVolumeBands(
  rows: readonly KeywordRow[],
  strategy: TenantStrategy,
): StrategyFinding[] {
  const findings: StrategyFinding[] = [];
  const rank = strategy.sv_bands.rank_skw;
  const halo = strategy.sv_bands.halo;

  for (const row of rows) {
    const sv = row.searchVolume;
    if (sv === null || sv === undefined) continue;
    if ((row.bucket === 'rank_skw' || row.bucket === 'shield_skw') && rank) {
      const belowFloor = rank.min !== undefined && sv < rank.min;
      const aboveCeiling = rank.max !== undefined && sv > rank.max;
      if (belowFloor || aboveCeiling) {
        findings.push({
          severity: rank.severity_outside ?? 'warn',
          subject: row.bucket,
          message: `'${row.text}' has search volume ${sv}, outside the rank band`,
        });
      }
    }
    if (row.bucket === 'halo' && halo?.max !== undefined && sv >= halo.max) {
      findings.push({
        severity: halo.severity_above ?? 'warn',
        subject: 'halo',
        message: `'${row.text}' has search volume ${sv}, at or above the halo ceiling`,
      });
    }
  }
  return findings;
}

/** Word count, for the discovery-root specificity check. */
function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter((word) => word !== '').length;
}

/**
 * Structure caps and the discovery specificity check.
 *
 * Caps are ceilings: a halo campaign holding more keywords than the tenant
 * allows is a fail, not a rounding-down. A discovery root shorter than the
 * minimum is a warn, because "specific enough" is a judgement.
 */
export function checkStructureCaps(
  specs: readonly CampaignSpec[],
  strategy: TenantStrategy,
): StrategyFinding[] {
  const findings: StrategyFinding[] = [];
  const haloCap = strategy.caps.halo_keywords_per_campaign;
  const patCap = strategy.caps.pat_asins_per_campaign;
  const minRootWords = strategy.discovery?.min_root_words;

  for (const spec of specs) {
    const keywords = Array.isArray(spec.keywords) ? spec.keywords : [];
    const subject = spec.targetDescriptor || spec.campaignType || '?';
    if (spec.campaignType === 'Halo' && haloCap !== undefined && keywords.length > haloCap) {
      findings.push({
        severity: 'fail',
        subject,
        message: `halo campaign holds ${keywords.length} keywords, over the cap of ${haloCap}`,
      });
    }
    if (spec.campaignType === 'PAT' && patCap !== undefined && (spec.targetAsins?.length ?? 0) > patCap) {
      findings.push({
        severity: 'fail',
        subject,
        message: `PAT campaign holds ${spec.targetAsins?.length ?? 0} ASINs, over the cap of ${patCap}`,
      });
    }
    if (spec.campaignType === 'Phrase' && minRootWords !== undefined) {
      for (const keyword of keywords) {
        if (wordCount(keyword) < minRootWords) {
          findings.push({
            severity: 'warn',
            subject,
            message: `discovery root '${keyword}' has ${wordCount(keyword)} word(s); specificity check`,
          });
        }
      }
    }
  }
  return findings;
}

export interface PatSplitResult {
  /** Targets with their bucket decided, in input order. */
  targets: TargetRow[];
  /** Null when the method needs a human; the reason says which. */
  unresolved: string | null;
}

/** The middle value, averaging the two middle ones for an even count. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Split competitor ASINs into the stronger and weaker PAT campaigns.
 *
 * Two of the three methods are arithmetic and run here. The third, `agent`, is
 * a deliberate hand-off: the tenant has said a human or an analyst decides,
 * so this returns the targets untouched and says why rather than picking a
 * split nobody asked for. A target with no revenue figure is likewise left
 * where it was, because guessing "weaker" from missing data is how a strong
 * competitor ends up in the cheap campaign.
 */
export function splitPatTargets(
  targets: readonly TargetRow[],
  strategy: TenantStrategy,
): PatSplitResult {
  const method = strategy.pat_split.method;
  if (method === undefined || method === 'agent') {
    return {
      targets: [...targets],
      unresolved: method === 'agent'
        ? 'pat_split.method is `agent`: the stronger/weaker split is an operator decision'
        : 'pat_split.method is unset: the tenant has not chosen a split rule',
    };
  }

  const withRevenue = targets
    .map((target) => target.revenue)
    .filter((revenue): revenue is number => revenue !== null && revenue !== undefined);

  const threshold = method === 'median_revenue'
    ? median(withRevenue)
    : (strategy.pat_split.revenue_floor ?? null);
  if (threshold === null) {
    return {
      targets: [...targets],
      unresolved: method === 'median_revenue'
        ? 'no revenue figures, so there is no median to split on'
        : 'pat_split.revenue_floor is unset',
    };
  }

  return {
    targets: targets.map((target) => {
      if (target.revenue === null || target.revenue === undefined) return { ...target };
      return { ...target, bucket: target.revenue >= threshold ? 'pat_stronger' : 'pat_weaker' };
    }),
    unresolved: null,
  };
}

/**
 * Per-bucket spec defaults from the strategy: budget, placements, and the
 * launch bid when research supplied a recommendation.
 *
 * The result is a partial spec, ready to merge over one produced from keyword
 * rows. Fields the tenant has not stated are simply absent, so the builder's
 * own defaults still apply.
 */
export function specDefaultsForBucket(
  strategy: TenantStrategy,
  bucket: CampaignBucket,
  recommendedBid?: number | null,
): CampaignSpec {
  const spec: CampaignSpec = {};
  const bids = bucketBids(strategy, bucket);
  if (bids?.dailyBudget !== null && bids?.dailyBudget !== undefined) spec.dailyBudget = bids.dailyBudget;
  if (bids?.topOfSearchPlacement !== null && bids?.topOfSearchPlacement !== undefined) {
    spec.topOfSearchPlacement = bids.topOfSearchPlacement;
  }
  if (bids?.restOfSearchPlacement !== null && bids?.restOfSearchPlacement !== undefined) {
    spec.restOfSearchPlacement = bids.restOfSearchPlacement;
  }
  if (bids?.productPagesPlacement !== null && bids?.productPagesPlacement !== undefined) {
    spec.productPagesPlacement = bids.productPagesPlacement;
  }
  const bid = startBid(strategy, recommendedBid);
  if (bid !== null) spec.keywordBid = bid;

  const naming = bucketNaming(strategy, bucket);
  if (naming?.goal) spec.goal = naming.goal;
  if (naming?.match_type) spec.matchType = naming.match_type;
  // `campaign_type` from the document is deliberately NOT applied: the bucket
  // already fixes it, and a document that still says BMM must not resurrect a
  // campaign type this engine no longer generates.
  return spec;
}

/** The bucket a spec came from, when it can be told apart. Used for defaults. */
export function bucketOf(spec: CampaignSpec): CampaignBucket | null {
  for (const bucket of Object.keys(BUCKET_DEFINITIONS) as CampaignBucket[]) {
    const definition = BUCKET_DEFINITIONS[bucket];
    if (definition.campaignType === spec.campaignType
      && definition.campaignPurpose === spec.campaignPurpose) {
      // PAT buckets share a type and purpose; the descriptor tells them apart.
      if (definition.kind === 'asins' && spec.targetDescriptor !== definition.label) continue;
      return bucket;
    }
  }
  return null;
}
