/**
 * Resolving a tenant strategy, and reading values out of one.
 *
 * The accessors return `null` when the tenant has not stated a value. They
 * never substitute a default, because there is no honest default for a target
 * ACOS: a caller that gets `null` must decline to optimize and say why, which
 * is strictly better than optimizing an account against a number nobody chose.
 */
import { TenantStrategy, type OptGroupStrategy } from '@wizard-ads/shared';
import { GOAL_LENS_STRATEGIES, NEUTRAL_DEFAULTS } from './defaults.js';
import { mergeLayers, type Layer, type MergeResult, type Provenance } from './merge.js';

/** A partial strategy document as a tenant or profile override supplies it. */
export type StrategyDocument = Record<string, unknown>;

export interface ResolveStrategyInput {
  /** The brand's goal/stage, used to pick the goal-lens layer. */
  goal?: string | null;
  /** The tenant-wide document, usually one `profile_strategy` row. */
  tenant?: StrategyDocument | null;
  /** A per-profile override on top of the tenant document. */
  profile?: StrategyDocument | null;
  /** Overrides the built-in neutral defaults. Tests use it; production does not. */
  defaults?: StrategyDocument | null;
}

export interface ResolvedStrategy extends MergeResult<TenantStrategy> {
  /** Which goal lens was applied, `neutral` when the goal is unknown or absent. */
  goal: string;
}

/**
 * The goal lens as a strategy fragment.
 *
 * It only reaches opt groups the tenant has actually declared: inventing a
 * group because a lens has an opinion about groups would create doctrine out of
 * nothing.
 */
function goalLensLayer(goal: string, tenant?: StrategyDocument | null, profile?: StrategyDocument | null): StrategyDocument {
  const lens = GOAL_LENS_STRATEGIES[goal];
  if (!lens || lens.cut_on_acos_alone === undefined) return {};
  const declared = new Set<string>([
    ...Object.keys((tenant?.opt_groups as Record<string, unknown> | undefined) ?? {}),
    ...Object.keys((profile?.opt_groups as Record<string, unknown> | undefined) ?? {}),
  ]);
  if (declared.size === 0) return {};
  const optGroups: Record<string, OptGroupStrategy> = {};
  for (const name of declared) optGroups[name] = { cut_on_acos_alone: lens.cut_on_acos_alone };
  return { opt_groups: optGroups };
}

/**
 * Merge the layers and validate the result against the frozen contract.
 *
 * Validation is not optional here: a document that reaches the optimizer with a
 * placeholder string where a fraction belongs must fail at resolve time, loudly
 * and with the offending path, rather than multiply a bid by `NaN`.
 */
export function resolveStrategy(input: ResolveStrategyInput = {}): ResolvedStrategy {
  const goal = input.goal && GOAL_LENS_STRATEGIES[input.goal] ? input.goal : 'neutral';
  const layers: Array<[Layer, StrategyDocument | null | undefined]> = [
    ['defaults', (input.defaults ?? NEUTRAL_DEFAULTS) as StrategyDocument],
    ['goal_lens', goalLensLayer(goal, input.tenant, input.profile)],
    ['tenant', input.tenant],
    ['profile', input.profile],
  ];
  const merged = mergeLayers<Record<string, unknown>>(layers);
  const parsed = TenantStrategy.parse(merged.value);
  return { value: parsed, provenance: merged.provenance, goal };
}

/** Parse and validate one raw document, e.g. straight out of the database. */
export function parseTenantStrategy(document: unknown): TenantStrategy {
  return TenantStrategy.parse(document);
}

/** The opt group by name, or `null` when the tenant has not declared it. */
export function optGroup(strategy: TenantStrategy, group: string): OptGroupStrategy | null {
  return strategy.opt_groups[group] ?? null;
}

/** Target ACOS for a group, or `null` when it is unset. Never defaulted. */
export function targetAcosFor(strategy: TenantStrategy, group: string): number | null {
  return optGroup(strategy, group)?.target_acos ?? null;
}

/**
 * Change caps for a group: the group's own values, falling back to the
 * document-wide caps. Shaped to match the bidding engine's `ChangeCaps` without
 * importing it, because `strategy` and `core` are siblings and neither may
 * depend on the other.
 */
export function changeCapsFor(
  strategy: TenantStrategy,
  group: string,
): { maxIncrease: number; maxDecrease: number; maxPlacementIncrease: number | null } | null {
  const g = optGroup(strategy, group);
  const maxIncrease = g?.max_increase ?? strategy.caps.max_bid_increase;
  const maxDecrease = g?.max_decrease ?? strategy.caps.max_bid_decrease;
  if (maxIncrease === undefined || maxDecrease === undefined) return null;
  return {
    maxIncrease,
    maxDecrease,
    maxPlacementIncrease: strategy.caps.max_placement_increase ?? null,
  };
}

/**
 * Whether a group may be cut on ACOS alone. Absent means NO: the protective
 * reading is the safe one, and a rank keyword cut by accident costs more than
 * one left alone for a cycle.
 */
export function cutOnAcosAlone(strategy: TenantStrategy, group: string): boolean {
  return optGroup(strategy, group)?.cut_on_acos_alone === true;
}

/** Which layer supplied a given dotted path, for the "why is this value here" answer. */
export function layerOf(provenance: Provenance, path: string): Layer | null {
  return provenance[path] ?? null;
}
