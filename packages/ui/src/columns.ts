/**
 * Column sets, one per entity level.
 *
 * Built against `tools/recon/02-data-grid.md` §2, which is exact: those column
 * names were read off live `get_entity_data` responses, not transcribed from
 * documentation. Where our fact tables cannot source a recon column it is
 * absent and the reason is written down, rather than shipped as a plausible
 * zero. A grid that shows `top_of_search_impression_share = 0` because nothing
 * populated it is worse than one that does not show the column.
 *
 * Two of the recon's "beat" items are implemented here rather than deferred:
 *
 *  - **One casing, one name.** No `match_types` on one entity and `match_type`
 *    on another; no `profile_id` meaning two different numbers. The column id
 *    is lowercase snake_case, the filter key is its uppercase twin, and that is
 *    the entire mapping (`filter.ts`).
 *  - **Archived is not optional.** `state` is a real column with a real filter
 *    on every level, and the default view (enabled-only, matching AdLabs) is a
 *    *stated* filter chip the operator can see and remove -- not an invisible
 *    server-side exclusion that quietly drops archived spend out of a month
 *    total.
 */
import type { MetricScale } from './metrics.js';
import { METRIC_SPECS, metricSpec } from './metrics.js';
import {
  COMPARISON_SUFFIX,
  DELTA_ABSOLUTE_SUFFIX,
  DELTA_PERCENT_SUFFIX,
} from './rows.js';

export type EntityLevel =
  | 'campaigns'
  | 'ad_groups'
  | 'targets'
  | 'search_terms'
  | 'placements';

export const ENTITY_LEVELS: readonly EntityLevel[] = [
  'campaigns',
  'ad_groups',
  'targets',
  'search_terms',
  'placements',
];

export const ENTITY_LABELS: Record<EntityLevel, string> = {
  campaigns: 'Campaigns',
  ad_groups: 'Ad groups',
  targets: 'Targets',
  search_terms: 'Search terms',
  placements: 'Placements',
};

export type ColumnKind = 'dimension' | 'metric';

export interface GridColumn {
  id: string;
  header: string;
  kind: ColumnKind;
  scale: MetricScale | 'text';
  align: 'left' | 'right';
  /** Starting width in pixels; the operator drags from here. */
  width: number;
  /** Pinned columns sit left of the pin line and do not scroll horizontally. */
  pinned?: boolean;
  /** Shown in the column picker, so a name never has to be self-explanatory. */
  description?: string;
  /** The rare cell whose visual hierarchy carries more than its sort value. */
  cell?: 'suggested_bid';
}

const dimension = (
  id: string,
  header: string,
  options: Partial<GridColumn> = {},
): GridColumn => ({
  id,
  header,
  kind: 'dimension',
  scale: 'text',
  align: 'left',
  width: 180,
  ...options,
});

/** Expand one metric into the recon's four columns. */
export function metricColumns(key: string): GridColumn[] {
  const spec = metricSpec(key);
  if (spec === undefined) return [];
  const base: Omit<GridColumn, 'id' | 'header'> = {
    kind: 'metric',
    scale: spec.scale,
    align: 'right',
    width: 104,
  };
  return [
    { ...base, id: key, header: spec.label },
    { ...base, id: `${key}${COMPARISON_SUFFIX}`, header: `${spec.label} (prev)` },
    {
      ...base,
      id: `${key}${DELTA_ABSOLUTE_SUFFIX}`,
      header: `${spec.label} Δ`,
      description: 'Difference against the comparison period, in the metric’s own unit.',
    },
    {
      ...base,
      id: `${key}${DELTA_PERCENT_SUFFIX}`,
      header: `${spec.label} Δ%`,
      scale: 'percent',
      description: 'Relative change against the comparison period. Always a fraction, on every entity.',
    },
  ];
}

/** Every metric, four columns each, in registry order. */
export function allMetricColumns(): GridColumn[] {
  return METRIC_SPECS.flatMap((spec) => metricColumns(spec.key));
}

/**
 * Non-metric columns per level.
 *
 * Absent from `campaigns` against the recon, and why: `campaign_global_id`,
 * `cost_type`, `creative_type`, `goal`, `audience_name`, `site_restrictions`
 * and the dayparting trio have no source in our entity mirror yet (the mirror
 * carries what the sync writes -- see `packages/db` schema); `has_opt_rule`,
 * `last_optimized_at` and `last_optimized_note` arrive with the optimizer
 * (WP-05/WP-12) and are a handoff, not a gap.
 */
const DIMENSIONS: Record<EntityLevel, GridColumn[]> = {
  campaigns: [
    dimension('campaign_name', 'Campaign', { width: 320, pinned: true }),
    dimension('campaign_state', 'State', { width: 96 }),
    dimension('ad_product', 'Ad type', { width: 88 }),
    dimension('targeting_type', 'Targeting', { width: 104 }),
    dimension('bidding_strategy', 'Bid strategy', { width: 150 }),
    dimension('budget_amount', 'Budget', { scale: 'money', align: 'right', width: 104 }),
    dimension('budget_type', 'Budget type', { width: 104 }),
    dimension('portfolio_name', 'Portfolio', { width: 180 }),
    dimension('start_date', 'Start', { width: 104 }),
    dimension('end_date', 'End', { width: 104 }),
    dimension('is_ended', 'Ended', {
      width: 80,
      description:
        'End date strictly before today in the profile timezone. An ended campaign cannot take ' +
        'budget or bid updates even while its state reads Enabled.',
    }),
    dimension('campaign_id', 'Campaign ID', { width: 160 }),
  ],
  ad_groups: [
    dimension('ad_group_name', 'Ad group', { width: 280, pinned: true }),
    dimension('ad_group_state', 'State', { width: 96 }),
    dimension('campaign_name', 'Campaign', { width: 280 }),
    dimension('default_bid', 'Default bid', { scale: 'money', align: 'right', width: 104 }),
    dimension('ad_product', 'Ad type', { width: 88 }),
    dimension('ad_group_id', 'Ad group ID', { width: 160 }),
    dimension('campaign_id', 'Campaign ID', { width: 160 }),
  ],
  targets: [
    dimension('targeting', 'Target', { width: 280, pinned: true }),
    dimension('target_state', 'State', { width: 96 }),
    dimension('target_kind', 'Kind', {
      width: 96,
      description: 'Keyword or product target. One name, on every entity level.',
    }),
    dimension('match_type', 'Match', {
      width: 96,
      description:
        'Singular everywhere. AdLabs spells this `match_types` on targets and `match_type` on ' +
        'negatives; one concept gets one name here.',
    }),
    dimension('bid', 'Bid', { scale: 'money', align: 'right', width: 96 }),
    dimension('suggested_bid', 'Suggested bid', {
      scale: 'money',
      align: 'right',
      width: 128,
      cell: 'suggested_bid',
      description: 'Latest Amazon suggested-bid median, with the low–high range beneath it.',
    }),
    dimension('max_potential_cpc', 'Max potential CPC', {
      scale: 'money',
      align: 'right',
      width: 136,
      description: 'Latest base bid after placement, audience, and dayparting modifiers.',
    }),
    dimension('diff_from_suggested_bid', 'Bid − suggested', {
      scale: 'money',
      align: 'right',
      width: 128,
      description: 'Current bid minus the latest Amazon suggested-bid median.',
    }),
    dimension('rpc_category', 'RPC category', {
      width: 120,
      description: 'Campaign-name classification. A filter, not an optimizer run.',
    }),
    dimension('ad_group_name', 'Ad group', { width: 220 }),
    dimension('campaign_name', 'Campaign', { width: 280 }),
    dimension('ad_product', 'Ad type', { width: 88 }),
    dimension('target_id', 'Target ID', { width: 160 }),
  ],
  search_terms: [
    dimension('search_term', 'Search term', { width: 320, pinned: true }),
    dimension('targeting', 'Matched target', { width: 240 }),
    dimension('match_type', 'Match', { width: 96 }),
    dimension('ad_group_name', 'Ad group', { width: 220 }),
    dimension('campaign_name', 'Campaign', { width: 280 }),
    dimension('harvested', 'Harvested', {
      width: 104,
      description:
        'Whether this term already exists as a target somewhere in the profile. Without it an ' +
        'operator re-harvests the same winners every week.',
    }),
    dimension('ad_product', 'Ad type', { width: 88 }),
  ],
  placements: [
    dimension('placement', 'Placement', { width: 200, pinned: true }),
    dimension('campaign_name', 'Campaign', { width: 320 }),
    dimension('placement_modifier', 'Current modifier', {
      scale: 'percent',
      align: 'right',
      width: 140,
    }),
    dimension('ad_product', 'Ad type', { width: 88 }),
    dimension('campaign_id', 'Campaign ID', { width: 160 }),
  ],
};

/** Every column available at a level: dimensions first, then all four metric columns. */
export function columnsFor(level: EntityLevel): GridColumn[] {
  return [...(DIMENSIONS[level] ?? []), ...allMetricColumns()];
}

/**
 * What is visible before the operator touches anything.
 *
 * Value plus Δ% for the metrics that drive a decision, and no comparison or
 * absolute-delta columns: they exist, they are one click away in the column
 * picker, and putting all sixty on screen by default would make the grid
 * useless on the day it shipped.
 */
const DEFAULT_METRICS = ['impressions', 'clicks', 'spend', 'sales', 'orders', 'ctr', 'cvr', 'cpc', 'acos', 'roas'];

export function defaultVisibleColumns(level: EntityLevel): string[] {
  const dims = (DIMENSIONS[level] ?? []).filter((column) => column.pinned || isKeyDimension(level, column.id));
  const metrics = DEFAULT_METRICS.flatMap((key) => [key, `${key}${DELTA_PERCENT_SUFFIX}`]);
  return [...dims.map((column) => column.id), ...metrics];
}

function isKeyDimension(level: EntityLevel, id: string): boolean {
  const keys: Record<EntityLevel, readonly string[]> = {
    campaigns: ['campaign_state', 'ad_product', 'budget_amount'],
    ad_groups: ['ad_group_state', 'campaign_name', 'default_bid'],
    targets: [
      'target_state',
      'match_type',
      'bid',
      'suggested_bid',
      'max_potential_cpc',
      'diff_from_suggested_bid',
      'rpc_category',
      'campaign_name',
    ],
    search_terms: ['match_type', 'campaign_name', 'harvested'],
    placements: ['campaign_name', 'placement_modifier'],
  };
  return (keys[level] ?? []).includes(id);
}

/**
 * The state column each level filters on. Used to build the default
 * enabled-only view as a visible chip rather than a hidden exclusion.
 */
export const STATE_COLUMN: Partial<Record<EntityLevel, string>> = {
  campaigns: 'campaign_state',
  ad_groups: 'ad_group_state',
  targets: 'target_state',
};
