/**
 * `TenantStrategy`: the shape of one tenant's doctrine document.
 *
 * SHAPE ONLY. Not one threshold value from any real strategy file appears in
 * this repo, and none ever may. The document lives as per-tenant jsonb in the
 * database, seeded by an operator-run script from a gitignored local file. This
 * repo is public; doctrine numbers are the agency's, not the internet's.
 *
 * Keys are snake_case because this schema validates the operator's own JSON
 * document unchanged, the same reason `ApplyRowWire` is snake_case. Sections
 * mirror `amazon-agent/tools/amazon-seo-keyword-workbook/ads-strategy.TEMPLATE.json`
 * plus the management sections named in docs/PLAN.md.
 *
 * Leaves are deliberately permissive: a tenant that has not filled in a section
 * should fail at seed time with a clear message, not fail to parse here.
 */
import { z } from 'zod';
import { IsoDate } from './primitives.js';

const severity = z.enum(['warn', 'fail']);

/** Run-rate pacing. The cut order is method (published in PLAN.md), not a number. */
export const PacingStrategy = z.object({
  cut_order: z.array(z.enum(['waste', 'discovery', 'profit', 'rank'])).optional(),
  monthly_budget: z.number().nullable().optional(),
  run_rate_tolerance: z.number().optional(),
  lookback_days: z.number().int().positive().optional(),
});
export type PacingStrategy = z.infer<typeof PacingStrategy>;

/** Per-opt-group settings. Group names are tenant-chosen, hence a record. */
export const OptGroupStrategy = z.object({
  target_acos: z.number().optional(),
  max_increase: z.number().optional(),
  max_decrease: z.number().optional(),
  goal_lens: z.string().optional(),
  /** Rank and SKW groups are never cut on ACOS alone. */
  cut_on_acos_alone: z.boolean().optional(),
});
export type OptGroupStrategy = z.infer<typeof OptGroupStrategy>;

export const RankLifecycleStrategy = z.object({
  source: z.enum(['rank_radar', 'sqp', 'manual']).optional(),
  graduation_rank: z.number().int().positive().optional(),
  demotion_rank: z.number().int().positive().nullable().optional(),
  dwell_days: z.number().int().nonnegative().optional(),
});
export type RankLifecycleStrategy = z.infer<typeof RankLifecycleStrategy>;

export const StagedApplyStrategy = z.object({
  cooldown_days: z.number().int().nonnegative().optional(),
  max_rows_per_batch: z.number().int().positive().optional(),
  at_cap_tolerance: z.number().optional(),
  require_snapshot: z.boolean().optional(),
  levers: z.array(z.string()).optional(),
});
export type StagedApplyStrategy = z.infer<typeof StagedApplyStrategy>;

export const BucketBids = z.object({
  daily_budget: z.number().optional(),
  top_of_search_placement: z.number().optional(),
  rest_of_search_placement: z.number().optional(),
  product_pages_placement: z.number().optional(),
});
export type BucketBids = z.infer<typeof BucketBids>;

export const BidStrategy = z.object({
  start_bid_pct_of_recommended: z.number().optional(),
  by_bucket: z.record(z.string(), BucketBids).optional(),
});
export type BidStrategy = z.infer<typeof BidStrategy>;

export const SvBandStrategy = z.object({
  rank_skw: z
    .object({
      min: z.number().optional(),
      max: z.number().optional(),
      severity_outside: severity.optional(),
    })
    .optional(),
  halo: z
    .object({
      max: z.number().optional(),
      severity_above: severity.optional(),
    })
    .optional(),
  phase1: z
    .object({
      count_min: z.number().optional(),
      count_max: z.number().optional(),
      sv_min: z.number().optional(),
      sv_max: z.number().optional(),
    })
    .optional(),
});
export type SvBandStrategy = z.infer<typeof SvBandStrategy>;

/** Caps are ceilings, never steps. The optimizer clamps to them, it never aims at them. */
export const CapStrategy = z.object({
  halo_keywords_per_campaign: z.number().int().positive().optional(),
  pat_asins_per_campaign: z.number().int().positive().optional(),
  max_bid_increase: z.number().optional(),
  max_bid_decrease: z.number().optional(),
  max_placement_increase: z.number().optional(),
  sd_budget_share_ceiling: z.number().optional(),
});
export type CapStrategy = z.infer<typeof CapStrategy>;

export const PatSplitStrategy = z.object({
  method: z.enum(['median_revenue', 'revenue_floor', 'agent']).optional(),
  revenue_floor: z.number().nullable().optional(),
});
export type PatSplitStrategy = z.infer<typeof PatSplitStrategy>;

export const BucketNaming = z.object({
  goal: z.string().optional(),
  match_type: z.string().optional(),
  campaign_type: z.string().optional(),
  descriptor: z.string().optional(),
});
export type BucketNaming = z.infer<typeof BucketNaming>;

export const NamingStrategy = z.object({
  variable_order: z.array(z.string()).optional(),
  delimiter: z.string().optional(),
  suffix: z.string().optional(),
  use_counter: z.boolean().optional(),
  skw_mode: z.boolean().optional(),
  add_date: z.boolean().optional(),
  custom1_label: z.string().optional(),
  custom1_value: z.string().optional(),
  custom2_label: z.string().optional(),
  custom2_value: z.string().optional(),
  by_bucket: z.record(z.string(), BucketNaming).optional(),
});
export type NamingStrategy = z.infer<typeof NamingStrategy>;

export const TenantStrategy = z.object({
  schema: z.literal('wizard-ads.tenant-strategy.v1'),
  refreshed_at: IsoDate.optional(),
  pacing: PacingStrategy,
  opt_groups: z.record(z.string(), OptGroupStrategy),
  rank_lifecycle: RankLifecycleStrategy,
  staged_apply: StagedApplyStrategy,
  bids: BidStrategy,
  sv_bands: SvBandStrategy,
  caps: CapStrategy,
  pat_split: PatSplitStrategy,
  naming: NamingStrategy,
});
export type TenantStrategy = z.infer<typeof TenantStrategy>;

/** The schema string the seeder writes and this package validates. */
export const TENANT_STRATEGY_SCHEMA = 'wizard-ads.tenant-strategy.v1' as const;
