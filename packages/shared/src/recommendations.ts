/**
 * `Recommendation`: one proposed change, with its work shown.
 *
 * The `inputs` object is the differentiator, not decoration. AdLabs states the
 * White Box formula publicly but not the numbers that went into a given row;
 * every recommendation we emit carries the RPC, the click count, which level of
 * the data-confidence hierarchy supplied the CVR, which ceiling bound the
 * result, and whether a change cap clamped it. A recommendation nobody can
 * audit is a black box with better manners.
 */
import { z } from 'zod';
import { EntityRef, IsoDate, Uuid } from './primitives.js';

/** The four White Box reasons, plus our two non-bid proposal sources. */
export const RecommendationReason = z.enum([
  'high_acos',
  'high_spend_no_sales',
  'low_acos',
  'low_visibility',
  'flag',
  'pacing',
]);
export type RecommendationReason = z.infer<typeof RecommendationReason>;

/**
 * Which level of the data-confidence hierarchy supplied the conversion rate.
 * Ordered most to least specific; a proposal built on `profile` is a much
 * weaker claim than one built on `keyword`, and the UI says so.
 */
export const CvrSourceLevel = z.enum(['keyword', 'ad_group', 'campaign', 'profile']);
export type CvrSourceLevel = z.infer<typeof CvrSourceLevel>;

export const RecommendationStatus = z.enum([
  'proposed',
  'accepted',
  'dismissed',
  'exported',
  'applied',
  'superseded',
]);
export type RecommendationStatus = z.infer<typeof RecommendationStatus>;

/** Provenance. Every field here answers "why is this number what it is". */
export const RecommendationInputs = z.object({
  /** Revenue per click over the window, or null when there were no clicks. */
  rpc: z.number().nullable(),
  clicks: z.number().int().nonnegative(),
  cvrSourceLevel: CvrSourceLevel,
  /**
   * Name of the ceiling that bound the value (manual max bid, max-affordable
   * CPC, data-based level ceiling, suggested-bid ceiling, budget ceiling), or
   * null when the formula result stood unbound. The engine's actual set is
   * `CeilingName` in @wizard-ads/core, which now includes `suggested_bid` — the
   * engine emits it whenever an Amazon suggested bid is supplied and binds.
   * Deliberately a string: the ceiling set is doctrine and doctrine lives in tenant config,
   * never in this repo.
   */
  ceilingApplied: z.string().nullable(),
  /**
   * Mirror of `ceilingApplied` for the lower bound: the name of the floor that
   * lifted the value (Amazon minimum, manual minimum, suggested-bid low edge, or
   * a dynamic data-based floor), or null when the value stood above every floor.
   * The engine's set is `FloorName` in @wizard-ads/core. Optional so a
   * recommendation emitted before the corridor floors existed stays valid; a
   * string for the same doctrine-lives-in-tenant-config reason as the ceiling.
   */
  floorApplied: z.string().nullable().optional(),
  /** True when a change cap clamped the step. A cap is a ceiling, not a step. */
  capClamped: z.boolean(),
  window: z
    .object({
      start: IsoDate,
      end: IsoDate,
    })
    .optional(),
});
export type RecommendationInputs = z.infer<typeof RecommendationInputs>;

export const Recommendation = z.object({
  id: Uuid.optional(),
  runId: Uuid,
  profileId: Uuid,
  reason: RecommendationReason,
  entityRef: EntityRef,
  /** The field the proposal would change: `bid`, `budget`, `state`, ... */
  field: z.string().min(1),
  currentValue: z.union([z.number(), z.string(), z.null()]),
  proposedValue: z.union([z.number(), z.string(), z.null()]),
  inputs: RecommendationInputs,
  status: RecommendationStatus,
  createdAt: z.iso.datetime().optional(),
});
export type Recommendation = z.infer<typeof Recommendation>;
