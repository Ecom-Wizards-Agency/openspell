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
 *
 * WP-00.1 widened this contract (manager-approved) so the operator's live
 * strategy document has a home for every leaf it carries. Widening only: every
 * key added there is optional, no existing key changed meaning, and the schema
 * id did not move, so documents written against the original shape still parse
 * and no consumer had to change. `packages/strategy/README.md` maps each new
 * field to the engine that reads it.
 */
import { z } from 'zod';
import { IsoDate } from './primitives.js';

const severity = z.enum(['warn', 'fail']);

/**
 * Run-rate pacing. The cut order is method (published in PLAN.md), not a number.
 *
 * Pacing is a three-band decision, not a single tolerance: report above one
 * band, act above the next, and treat spending under a third as its own
 * problem. `rank_cut_requires_operator` is the guard that stops the last step
 * of `cut_order` from ever happening automatically.
 */
export const PacingStrategy = z.object({
  cut_order: z.array(z.enum(['waste', 'discovery', 'profit', 'rank'])).optional(),
  monthly_budget: z.number().nullable().optional(),
  /**
   * @deprecated Single-tolerance form. Superseded by `warn_above` / `act_above`
   * / `underpace_below`; kept optional so documents seeded before WP-00.1 and
   * the resolver defaults that reference it keep parsing.
   */
  run_rate_tolerance: z.number().optional(),
  /** Overpacing band that reports only. Fraction of the pace, not a currency amount. */
  warn_above: z.number().optional(),
  /** Overpacing band that triggers the cut order. Fraction of the pace. */
  act_above: z.number().optional(),
  /** Underpacing band: below this fraction of pace, budget is being left on the table. */
  underpace_below: z.number().optional(),
  /** When true, the `rank` step of `cut_order` is never taken without an operator decision. */
  rank_cut_requires_operator: z.boolean().optional(),
  lookback_days: z.number().int().positive().optional(),
});
export type PacingStrategy = z.infer<typeof PacingStrategy>;

/**
 * How a bid bound is expressed.
 *
 * Vocabulary, not doctrine: the unit says how to read the accompanying
 * `*_value`, and the value itself is per-tenant database data. Tokens are
 * lower snake_case like every other enum in this contract; a source document
 * that writes them in another case is normalized by the seeder, which already
 * rewrites the schema id and flattens the document.
 */
export const BidBoundUnit = z.enum(['absolute', 'pct_of_recommended', 'times_cpc']);
export type BidBoundUnit = z.infer<typeof BidBoundUnit>;

/**
 * Per-opt-group settings. Group names are tenant-chosen, hence a record.
 *
 * The bid floor and ceiling are the manual bounds the bidding engine clamps to
 * before any cap is applied: unit says how to read the value, so a ceiling can
 * be an absolute bid, a share of Amazon's recommended bid, or a multiple of the
 * group's CPC without the engine having to guess which.
 */
export const OptGroupStrategy = z.object({
  target_acos: z.number().optional(),
  max_increase: z.number().optional(),
  /** Increase cap once the group is in steady state, where one differs from `max_increase`. */
  max_increase_steady: z.number().optional(),
  max_decrease: z.number().optional(),
  goal_lens: z.string().optional(),
  /** Rank and SKW groups are never cut on ACOS alone. */
  cut_on_acos_alone: z.boolean().optional(),
  /** Named starting point for the group's settings, e.g. an optimizer preset. */
  preset: z.string().optional(),
  bid_floor_unit: BidBoundUnit.optional(),
  bid_floor_value: z.number().optional(),
  bid_ceiling_unit: BidBoundUnit.optional(),
  bid_ceiling_value: z.number().optional(),
  /** Per-group placement bounds. Ceilings, never steps; the document-wide `caps` are the fallback. */
  placement_max_increase: z.number().optional(),
  placement_max_decrease: z.number().optional(),
  /** Share of profile spend this group may take. A ceiling. */
  spend_share_max: z.number().optional(),
  /** Target TACOS as a multiple of breakeven, and the band around it where a range is used. */
  tacos_x_breakeven: z.number().optional(),
  tacos_x_breakeven_min: z.number().optional(),
  tacos_x_breakeven_max: z.number().optional(),
});
export type OptGroupStrategy = z.infer<typeof OptGroupStrategy>;

/**
 * Rank lifecycle. Units are explicit on every duration leaf, because a
 * lifecycle document that mixes days and weeks silently is a bug factory:
 * `dwell_days` is DAYS, `graduate_weeks_stable` is WEEKS.
 */
export const RankLifecycleStrategy = z.object({
  source: z.enum(['rank_radar', 'sqp', 'manual']).optional(),
  graduation_rank: z.number().int().positive().optional(),
  demotion_rank: z.number().int().positive().nullable().optional(),
  /** DAYS a keyword must hold its state before the lifecycle moves it. */
  dwell_days: z.number().int().nonnegative().optional(),
  /** WEEKS of stable rank required to graduate. Weeks, not days: it counts review cycles. */
  graduate_weeks_stable: z.number().int().nonnegative().optional(),
  /** Number of step-down cycles a graduated keyword walks through, as a range. */
  stepdown_cycles_min: z.number().int().nonnegative().optional(),
  stepdown_cycles_max: z.number().int().nonnegative().optional(),
  /** What happens when a graduated keyword regresses, e.g. which stage it returns to. */
  regression_reescalate: z.string().optional(),
});
export type RankLifecycleStrategy = z.infer<typeof RankLifecycleStrategy>;

export const StagedApplyStrategy = z.object({
  cooldown_days: z.number().int().nonnegative().optional(),
  max_rows_per_batch: z.number().int().positive().optional(),
  /** Batches one run may push before it stops and waits for the next cycle. */
  max_batches_per_run: z.number().int().positive().optional(),
  at_cap_tolerance: z.number().optional(),
  require_snapshot: z.boolean().optional(),
  levers: z.array(z.string()).optional(),
  /** Levers allowed to ignore the cooldown, e.g. a waste cut that cannot wait. */
  cooldown_bypasses: z.array(z.string()).optional(),
  /** Template for the tag written onto a changed entity so a batch can be found and reverted. */
  tag_format: z.string().optional(),
  /** Minimum DAYS between two pushes on the same rank target. */
  push_rank_min_days: z.number().int().nonnegative().optional(),
  /** Order the levers are worked through when a run cannot do everything. */
  priority_order: z.array(z.string()).optional(),
  /** How often each opt group is touched, keyed by group name. */
  group_cadence: z.record(z.string(), z.string()).optional(),
  /** What one batch counts, e.g. rows or entities. */
  batch_unit: z.string().optional(),
});
export type StagedApplyStrategy = z.infer<typeof StagedApplyStrategy>;

/** Discovery-side structure rules. */
export const DiscoveryStrategy = z.object({
  /** Minimum words a root must have before it is treated as a discovery root. */
  min_root_words: z.number().int().positive().optional(),
});
export type DiscoveryStrategy = z.infer<typeof DiscoveryStrategy>;

/** Gate an expanded (agent- or tool-suggested) candidate must clear to be considered. */
export const ExpandedCandidateFilterStrategy = z.object({
  min_relevancy: z.number().optional(),
  max_sv: z.number().optional(),
});
export type ExpandedCandidateFilterStrategy = z.infer<typeof ExpandedCandidateFilterStrategy>;

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
  /**
   * Sections added by WP-00.1. Optional at the top level, unlike the sections
   * above: a document seeded against the original contract has no key here, and
   * absence must stay a parse, not a failure.
   */
  discovery: DiscoveryStrategy.optional(),
  expanded_candidate_filter: ExpandedCandidateFilterStrategy.optional(),
});
export type TenantStrategy = z.infer<typeof TenantStrategy>;

/** The schema string the seeder writes and this package validates. */
export const TENANT_STRATEGY_SCHEMA = 'wizard-ads.tenant-strategy.v1' as const;
