/**
 * The catalog: which entity levels exist, what they are made of, and which
 * columns a caller may name.
 *
 * This is the whitelist that makes `query` safe. No caller-supplied string ever
 * reaches SQL as an identifier; a caller names a dimension or a metric, and the
 * fragment that goes into the statement comes from this file. Values are always
 * bound as parameters.
 *
 * Three decisions here are inherited from the AdLabs recon rather than invented:
 *
 *  - **One filter vocabulary across every level** (`tools/recon/02-data-grid.md`
 *    §3). Uppercase keys, lowercase columns, the same shape everywhere.
 *  - **Archived is not optional.** Their campaign grid cannot see ARCHIVED at
 *    all, so any period total silently excludes archived spend. Ours reads the
 *    fact tables, which do not know what an entity's state is today, and joins
 *    the mirror only for labels. A campaign archived yesterday still shows its
 *    spend, with its state on the row.
 *  - **Facts first, mirror second, always LEFT JOIN.** A fact row whose entity
 *    has vanished from Amazon keeps its money and loses its name. The opposite
 *    (dropping the row) is how a month total quietly stops reconciling.
 */
import type { BaseMetric } from './metrics.js';

export const ENTITY_LEVELS = [
  'campaign',
  'ad_group',
  'keyword',
  'target',
  'search_term',
  'placement',
  'product',
  'profile',
] as const;
export type EntityLevel = (typeof ENTITY_LEVELS)[number];

export type DimensionType = 'string' | 'number' | 'date' | 'boolean';

export interface Dimension {
  /** SQL over the aliased sources, row by row. Never contains caller input. */
  sql: string;
  /**
   * How the column collapses when rows are grouped. Present only for columns
   * that are a summary rather than a key (an impression share, a provisional
   * flag), which is also what keeps them out of GROUP BY.
   */
  aggregate?: string;
  type: DimensionType;
  /** Join keys this dimension needs present. */
  requires?: readonly string[];
  description: string;
}

export interface LevelDefinition {
  /**
   * The fact source, already normalised to the shared metric vocabulary
   * (`impressions, clicks, spend, sales, orders, units`) so every level above
   * this line is identical. Aliased `f`.
   */
  source: string;
  /** Extra predicate that defines the level, e.g. keywords versus product targets. */
  where?: string;
  /** Join key -> SQL join clause. Emitted only when a referenced column needs it. */
  joins: Record<string, string>;
  dimensions: Record<string, Dimension>;
  /** The natural key: what one row means when the caller does not choose. */
  defaultDimensions: readonly string[];
  /** Metrics this level cannot carry, e.g. placements report no unit count. */
  unavailableMetrics?: readonly BaseMetric[];
  description: string;
}

/** The SP target-grain spine, renamed to the shared metric vocabulary. */
const SP_TARGET_SOURCE = `(
  select org_id, profile_id, date, ad_product, campaign_id, ad_group_id, target_id,
         target_kind, match_type,
         impressions, clicks, cost as spend, sales_7d as sales,
         purchases_7d as orders, units_sold_7d as units,
         top_of_search_impression_share
    from public.fact_sp_target_daily
)`;

const SEARCH_TERM_SOURCE = `(
  select org_id, profile_id, date, ad_product, campaign_id, ad_group_id, target_id,
         search_term, match_type,
         impressions, clicks, cost as spend, sales_7d as sales,
         purchases_7d as orders, units_sold_7d as units
    from public.fact_search_term_daily
)`;

const PLACEMENT_SOURCE = `(
  select org_id, profile_id, date, ad_product, campaign_id, placement,
         impressions, clicks, cost as spend, sales_7d as sales,
         purchases_7d as orders, 0::bigint as units
    from public.fact_placement_daily
)`;

/**
 * Campaign grain spans three ad products, so it is a union: SP rolled up from
 * the target spine, SB and SD from their own daily tables. A campaign total
 * that silently covered SP only would be wrong in exactly the accounts that
 * spend the most on SB.
 */
const CAMPAIGN_SOURCE = `(
  select org_id, profile_id, date, ad_product, campaign_id,
         impressions, clicks, cost as spend, sales_7d as sales,
         purchases_7d as orders, units_sold_7d as units
    from public.fact_sp_target_daily
  union all
  select org_id, profile_id, date, 'SB'::public.ad_product, campaign_id,
         impressions, clicks, cost, sales_7d, purchases_7d, units_sold_7d
    from public.fact_sb_daily
  union all
  select org_id, profile_id, date, 'SD'::public.ad_product, campaign_id,
         impressions, clicks, cost, sales_7d, purchases_7d, units_sold_7d
    from public.fact_sd_daily
)`;

const PROFILE_SOURCE = `(
  select org_id, profile_id, date, currency_code, provisional,
         impressions, clicks, cost as spend, sales_7d as sales,
         purchases_7d as orders, units_sold_7d as units
    from public.fact_profile_daily
)`;

const JOIN_CAMPAIGN =
  'left join public.campaigns cm on cm.profile_id = f.profile_id and cm.amazon_id = f.campaign_id';
const JOIN_AD_GROUP =
  'left join public.ad_groups ag on ag.profile_id = f.profile_id and ag.amazon_id = f.ad_group_id';
const JOIN_KEYWORD =
  'left join public.keywords kw on kw.profile_id = f.profile_id and kw.amazon_id = f.target_id';
const JOIN_TARGET =
  'left join public.targets tg on tg.profile_id = f.profile_id and tg.amazon_id = f.target_id';

const campaignDimensions: Record<string, Dimension> = {
  campaign_id: { sql: 'f.campaign_id', type: 'string', description: "Amazon's campaign id" },
  campaign_name: {
    sql: 'cm.name',
    type: 'string',
    requires: ['campaign'],
    description: 'Campaign name from the entity mirror; null when the campaign is unknown to the mirror',
  },
  campaign_state: {
    sql: 'cm.state::text',
    type: 'string',
    requires: ['campaign'],
    description: 'enabled | paused | archived. Archived rows are included, never hidden',
  },
  campaign_budget: {
    sql: 'cm.budget_amount',
    type: 'number',
    requires: ['campaign'],
    description: 'Current daily or lifetime budget',
  },
  ad_product: { sql: 'f.ad_product::text', type: 'string', description: 'SP | SB | SD' },
};

const adGroupDimensions: Record<string, Dimension> = {
  ad_group_id: { sql: 'f.ad_group_id', type: 'string', description: "Amazon's ad group id" },
  ad_group_name: {
    sql: 'ag.name',
    type: 'string',
    requires: ['adGroup'],
    description: 'Ad group name from the entity mirror',
  },
  ad_group_state: {
    sql: 'ag.state::text',
    type: 'string',
    requires: ['adGroup'],
    description: 'enabled | paused | archived',
  },
};

const dateDimension: Dimension = {
  sql: 'f.date',
  type: 'date',
  description: "The profile's own calendar day",
};

export const LEVELS: Record<EntityLevel, LevelDefinition> = {
  campaign: {
    source: CAMPAIGN_SOURCE,
    joins: { campaign: JOIN_CAMPAIGN },
    dimensions: { ...campaignDimensions, date: dateDimension },
    defaultDimensions: ['campaign_id'],
    description: 'One row per campaign, across SP, SB and SD.',
  },
  ad_group: {
    source: SP_TARGET_SOURCE,
    joins: { campaign: JOIN_CAMPAIGN, adGroup: JOIN_AD_GROUP },
    dimensions: { ...campaignDimensions, ...adGroupDimensions, date: dateDimension },
    defaultDimensions: ['ad_group_id'],
    description: 'One row per ad group. Sponsored Products only: SB and SD report no ad-group grain here.',
  },
  keyword: {
    source: SP_TARGET_SOURCE,
    where: "f.target_kind = 'keyword'",
    joins: { campaign: JOIN_CAMPAIGN, adGroup: JOIN_AD_GROUP, keyword: JOIN_KEYWORD },
    dimensions: {
      ...campaignDimensions,
      ...adGroupDimensions,
      target_id: { sql: 'f.target_id', type: 'string', description: "Amazon's keyword id" },
      keyword_text: {
        sql: 'kw.keyword_text',
        type: 'string',
        requires: ['keyword'],
        description: 'The keyword as Amazon stores it',
      },
      match_type: { sql: 'f.match_type::text', type: 'string', description: 'exact | phrase | broad' },
      bid: { sql: 'kw.bid', type: 'number', requires: ['keyword'], description: 'Current bid' },
      keyword_state: {
        sql: 'kw.state::text',
        type: 'string',
        requires: ['keyword'],
        description: 'enabled | paused | archived',
      },
      top_of_search_impression_share: {
        sql: 'f.top_of_search_impression_share',
        aggregate: 'avg(f.top_of_search_impression_share)',
        type: 'number',
        description:
          'Per-target top-of-search impression share, averaged over the window. AdLabs removed this column on 2026-07-28; we keep it',
      },
      date: dateDimension,
    },
    defaultDimensions: ['target_id'],
    description: 'One row per keyword.',
  },
  target: {
    source: SP_TARGET_SOURCE,
    where: "f.target_kind = 'target'",
    joins: { campaign: JOIN_CAMPAIGN, adGroup: JOIN_AD_GROUP, target: JOIN_TARGET },
    dimensions: {
      ...campaignDimensions,
      ...adGroupDimensions,
      target_id: { sql: 'f.target_id', type: 'string', description: "Amazon's target id" },
      targeting: {
        sql: 'tg.resolved_expression',
        type: 'string',
        requires: ['target'],
        description: 'The resolved targeting expression, e.g. asin_same_as B0...',
      },
      match_type: { sql: 'f.match_type::text', type: 'string', description: 'Product targeting kind' },
      bid: { sql: 'tg.bid', type: 'number', requires: ['target'], description: 'Current bid' },
      target_state: {
        sql: 'tg.state::text',
        type: 'string',
        requires: ['target'],
        description: 'enabled | paused | archived',
      },
      date: dateDimension,
    },
    defaultDimensions: ['target_id'],
    description: 'One row per product target (everything that is not a keyword).',
  },
  search_term: {
    source: SEARCH_TERM_SOURCE,
    joins: { campaign: JOIN_CAMPAIGN, adGroup: JOIN_AD_GROUP },
    dimensions: {
      ...campaignDimensions,
      ...adGroupDimensions,
      search_term: { sql: 'f.search_term', type: 'string', description: 'The customer search term' },
      target_id: {
        sql: 'f.target_id',
        type: 'string',
        description: 'The target it was attributed to; null where the report names no target',
      },
      match_type: { sql: 'f.match_type::text', type: 'string', description: 'Match type of the target' },
      date: dateDimension,
    },
    defaultDimensions: ['search_term', 'ad_group_id'],
    description: 'One row per search term per ad group.',
  },
  placement: {
    source: PLACEMENT_SOURCE,
    joins: { campaign: JOIN_CAMPAIGN },
    dimensions: {
      ...campaignDimensions,
      placement: {
        sql: 'f.placement::text',
        type: 'string',
        description: 'top_of_search | rest_of_search | product_pages | off_amazon | other',
      },
      date: dateDimension,
    },
    defaultDimensions: ['campaign_id', 'placement'],
    unavailableMetrics: ['units'],
    description: 'One row per campaign per placement. The seam for off-Amazon leakage.',
  },
  product: {
    // Facts are attributed to an ASIN through the ad group that advertised it.
    // Only ad groups advertising exactly one ASIN can be attributed without
    // inventing a split, so the rest are excluded AND counted: the response
    // carries the excluded spend rather than quietly under-reporting.
    source: SP_TARGET_SOURCE,
    joins: {
      singleAsin: `join (
        select profile_id, ad_group_id, min(asin) as asin
          from public.product_ads
         where asin is not null
         group by profile_id, ad_group_id
        having count(distinct asin) = 1
      ) pa on pa.profile_id = f.profile_id and pa.ad_group_id = f.ad_group_id`,
      campaign: JOIN_CAMPAIGN,
    },
    dimensions: {
      asin: { sql: 'pa.asin', type: 'string', requires: ['singleAsin'], description: 'The advertised ASIN' },
      ...campaignDimensions,
      date: dateDimension,
    },
    defaultDimensions: ['asin'],
    description:
      'One row per advertised ASIN. Attributed through single-ASIN ad groups only; the excluded share is reported on every response.',
  },
  profile: {
    source: PROFILE_SOURCE,
    joins: {},
    dimensions: {
      currency_code: { sql: 'f.currency_code', type: 'string', description: 'ISO 4217' },
      provisional: {
        sql: 'f.provisional',
        aggregate: 'bool_or(f.provisional)',
        type: 'boolean',
        description: 'True when any day in the window is still attributing',
      },
      date: dateDimension,
    },
    defaultDimensions: [],
    description: 'The profile rollup. One row for the whole window unless grouped by date.',
  },
};

export function levelDefinition(level: EntityLevel): LevelDefinition {
  return LEVELS[level];
}

export function dimensionNames(level: EntityLevel): string[] {
  return Object.keys(LEVELS[level].dimensions);
}
