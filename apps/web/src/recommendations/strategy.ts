/**
 * The strategy / objective dimension every proposal carries.
 *
 * `docs/DECISIONS.md` (2026-08-14, the vision entry) makes this a constraint on
 * WP-07 rather than a nicety: **per-campaign strategy assignment is coming, and
 * the recommendation surfaces have to carry the dimension now so adding
 * assignment later is a data change and not a rework.** So every proposal
 * resolves to a `ProposalStrategy` here, and the resolver is a four-step
 * cascade whose *first* step is the not-yet-existing assignment:
 *
 *   1. an explicit per-campaign assignment (WP-vision; today always empty)
 *   2. the opt group whose name matches the campaign's category
 *   3. a profile-wide default group (`default` / `*`) in the snapshot
 *   4. nothing — the neutral lens, and the panel says "unassigned"
 *
 * When assignment ships, only step 1 gains a data source. Nothing downstream —
 * not the column, not the filter key, not the provenance panel — changes.
 *
 * Two rules this file will not break:
 *
 * - **It reads the run's snapshot, never today's strategy document.** A
 *   six-week-old proposal explained with this week's thresholds is a lie with
 *   good intentions; `recommendation_runs.strategy_snapshot` exists precisely
 *   so it does not have to be.
 * - **It invents no doctrine.** A group with no `goal_lens` resolves to the
 *   neutral lens and says so. Mapping "a Rank campaign is obviously a
 *   rank-launch goal" would be putting an agency's doctrine into a public
 *   repository through the back door.
 */
import {
  CATEGORY_UNKNOWN,
  DEFAULT_GOAL,
  GOAL_LENSES,
  classifyCampaignCategory,
  resolveGoalLens,
} from '@wizard-ads/core';
import type { OptGroupStrategy, TenantStrategy } from '@wizard-ads/shared';

/** Where the objective came from. Ordered most to least specific. */
export type StrategySource =
  | 'campaign_assignment'
  | 'opt_group'
  | 'profile_default'
  | 'unassigned';

export interface ProposalStrategy {
  /** Opt group that supplied the policy, or null when none did. */
  optGroup: string | null;
  /** Campaign category, classified from the campaign name. */
  category: string;
  /** Goal lens key: `scale`, `rank-launch`, ... `neutral` when unassigned. */
  objective: string;
  /** The lens's own display label. */
  objectiveLabel: string;
  source: StrategySource;
  /** Target ACOS as a fraction, when the group carries one. */
  targetAcos: number | null;
  /**
   * Whether doctrine permits cutting this group on ACOS alone. `null` when the
   * group is silent, which is not the same as `false`.
   */
  cutOnAcosAlone: boolean | null;
  /** One sentence for the provenance panel. */
  explanation: string;
}

/**
 * Per-campaign assignment, keyed by Amazon campaign id.
 *
 * The map is the seam. Today every caller passes an empty one; when assignment
 * ships it is a table read, and this file does not change.
 */
export type StrategyAssignments = ReadonlyMap<string, string>;

export const NO_ASSIGNMENTS: StrategyAssignments = new Map();

/** Group names that mean "everything not otherwise assigned". */
const DEFAULT_GROUP_KEYS = ['default', '*', 'all'];

type OptGroups = Record<string, OptGroupStrategy>;

/**
 * Read the opt-group section out of a snapshot without trusting its shape.
 *
 * The snapshot is jsonb written by a seeder from an operator's own document,
 * so it can be null, can be an older revision, and must never throw here: a
 * malformed doctrine document should degrade the strategy column to
 * "unassigned", not blank the review screen.
 */
export function optGroupsOf(snapshot: unknown): OptGroups {
  if (snapshot === null || typeof snapshot !== 'object') return {};
  const groups = (snapshot as Partial<TenantStrategy>).opt_groups;
  if (groups === null || groups === undefined || typeof groups !== 'object') return {};
  const out: OptGroups = {};
  for (const [name, value] of Object.entries(groups as Record<string, unknown>)) {
    if (value !== null && typeof value === 'object') out[name] = value as OptGroupStrategy;
  }
  return out;
}

function findGroup(groups: OptGroups, wanted: string | null): [string, OptGroupStrategy] | null {
  if (wanted === null) return null;
  const target = wanted.trim().toLowerCase();
  if (target.length === 0) return null;
  for (const [name, group] of Object.entries(groups)) {
    if (name.trim().toLowerCase() === target) return [name, group];
  }
  return null;
}

function findDefaultGroup(groups: OptGroups): [string, OptGroupStrategy] | null {
  for (const key of DEFAULT_GROUP_KEYS) {
    const found = findGroup(groups, key);
    if (found !== null) return found;
  }
  return null;
}

function lensLabel(objective: string): string {
  return GOAL_LENSES[objective]?.label ?? resolveGoalLens(objective).label;
}

function describe(
  source: StrategySource,
  optGroup: string | null,
  objective: string,
  category: string,
): string {
  const lens = `goal lens ${objective} (${lensLabel(objective)})`;
  switch (source) {
    case 'campaign_assignment':
      return `This campaign is assigned to the '${optGroup}' opt group, which sets ${lens}.`;
    case 'opt_group':
      return (
        `Classified as a ${category} campaign from its name, which matches the ` +
        `'${optGroup}' opt group in the run's strategy snapshot; that group sets ${lens}.`
      );
    case 'profile_default':
      return (
        `No opt group matches a ${category} campaign, so the snapshot's default group ` +
        `('${optGroup}') applies, setting ${lens}.`
      );
    default:
      return (
        `No opt group in the run's strategy snapshot covers a ${category} campaign, so this ` +
        'proposal was computed under the neutral lens. Assign the campaign to a strategy to ' +
        'change that.'
      );
  }
}

export interface ResolveStrategyOptions {
  campaignId: string | null;
  campaignName: string | null;
  /** `recommendation_runs.strategy_snapshot`, as stored. */
  strategySnapshot: unknown;
  assignments?: StrategyAssignments;
}

/** Resolve the strategy dimension for one proposal. */
export function resolveProposalStrategy(options: ResolveStrategyOptions): ProposalStrategy {
  const groups = optGroupsOf(options.strategySnapshot);
  const category = classifyCampaignCategory(options.campaignName);
  const assignments = options.assignments ?? NO_ASSIGNMENTS;

  const assigned = options.campaignId === null ? undefined : assignments.get(options.campaignId);
  const byAssignment = findGroup(groups, assigned ?? null);
  const byCategory = category === CATEGORY_UNKNOWN ? null : findGroup(groups, category);
  const byDefault = findDefaultGroup(groups);

  const [source, found]: [StrategySource, [string, OptGroupStrategy] | null] =
    byAssignment !== null
      ? ['campaign_assignment', byAssignment]
      : byCategory !== null
        ? ['opt_group', byCategory]
        : byDefault !== null
          ? ['profile_default', byDefault]
          : ['unassigned', null];

  const optGroup = found === null ? null : found[0];
  const group = found === null ? null : found[1];
  const objective = group?.goal_lens ?? DEFAULT_GOAL;

  return {
    optGroup,
    category,
    objective,
    objectiveLabel: lensLabel(objective),
    source,
    targetAcos: group?.target_acos ?? null,
    cutOnAcosAlone: group?.cut_on_acos_alone ?? null,
    explanation: describe(source, optGroup, objective, category),
  };
}

/**
 * The caps a `batches.py validate` run needs, read out of the run's snapshot.
 *
 * Group values first, then the document-wide `caps` section, then null. Null is
 * a real answer and the caps file says so out loud: `validate` skips a
 * direction whose cap is absent, so a caps-less check that exits 0 has checked
 * nothing, and pretending a default exists would be worse than saying it does
 * not.
 */
export interface ExportCaps {
  targetAcos: number | null;
  maxIncrease: number | null;
  maxDecrease: number | null;
}

export function resolveExportCaps(snapshot: unknown, optGroup: string | null): ExportCaps {
  const groups = optGroupsOf(snapshot);
  const found = findGroup(groups, optGroup);
  const group = found === null ? null : found[1];

  const document =
    snapshot !== null && typeof snapshot === 'object'
      ? ((snapshot as Partial<TenantStrategy>).caps ?? null)
      : null;

  return {
    targetAcos: group?.target_acos ?? null,
    maxIncrease: group?.max_increase ?? document?.max_bid_increase ?? null,
    maxDecrease: group?.max_decrease ?? document?.max_bid_decrease ?? null,
  };
}

/** Short form for a table cell: `Rank · scale` / `Discovery · unassigned`. */
export function strategyLabel(strategy: ProposalStrategy): string {
  const objective = strategy.source === 'unassigned' ? 'unassigned' : strategy.objective;
  return `${strategy.category} · ${objective}`;
}
