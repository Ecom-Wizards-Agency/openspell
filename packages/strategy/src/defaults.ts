/**
 * The neutral defaults layer.
 *
 * This document contains METHOD and no NUMBERS, and that is a rule rather than
 * an accident of the current content. The cut order, the lever vocabulary and
 * the pat-split method are published in `docs/PLAN.md`; a target ACOS, a change
 * cap or a search-volume band is the agency's doctrine and lives as per-tenant
 * database data seeded from a gitignored file. This repository is public.
 *
 * A tenant that has not filled in a section therefore inherits structure and
 * not a plausible-looking number, so a missing value fails loudly at seed time
 * instead of quietly optimizing an account against somebody's guess.
 */
import { TENANT_STRATEGY_SCHEMA, type TenantStrategy } from '@wizard-ads/shared';

export const NEUTRAL_DEFAULTS: TenantStrategy = {
  schema: TENANT_STRATEGY_SCHEMA,
  pacing: {
    // Fixed doctrine, and a method rather than a threshold: waste first, rank
    // last and only on an explicit operator decision.
    cut_order: ['waste', 'discovery', 'profit', 'rank'],
    monthly_budget: null,
  },
  opt_groups: {},
  rank_lifecycle: {},
  staged_apply: {
    require_snapshot: true,
    levers: [
      'waste-cut',
      'bid-down',
      'push',
      'budget',
      'placement',
      'harvest',
      'negative',
      'pause',
      'revert',
      'other',
    ],
  },
  bids: {},
  sv_bands: {},
  caps: {},
  pat_split: {},
  naming: {},
};

/**
 * Goal-lens layer: what a brand's stage changes about METHOD.
 *
 * Deliberately thin, and deliberately free of thresholds. The numeric side of a
 * goal lens (which flag fires, at what percentage) belongs to the doctrine
 * engine's `GOAL_LENSES`, which is the reference toolkit's own published table.
 * What belongs here is the structural decision a stage implies: a launch or a
 * defence never cuts a rank keyword on ACOS alone; a liquidation is allowed to.
 */
export type GoalLensStrategy = {
  /** Applied to every opt group that does not state its own value. */
  cut_on_acos_alone?: boolean;
};

export const GOAL_LENS_STRATEGIES: Record<string, GoalLensStrategy> = {
  'rank-launch': { cut_on_acos_alone: false },
  defend: { cut_on_acos_alone: false },
  scale: {},
  'profit-maintain': {},
  maintain: {},
  liquidate: { cut_on_acos_alone: true },
  inactive: {},
  neutral: {},
};
