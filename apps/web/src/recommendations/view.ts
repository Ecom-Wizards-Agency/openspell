/**
 * The review surface's view model.
 *
 * A pure function from a stored proposal to everything the screen shows, so the
 * two things WP-07 is accepted on can be asserted without a browser: that every
 * `inputs` field renders for every reason, and that each proposal carries the
 * strategy / objective that produced it.
 *
 * The client component renders this and computes nothing else. A view model
 * that is assembled inside a component is a view model nothing can test.
 */
import type { RecommendationRecord } from '@wizard-ads/db';
import { limitReason, provenanceLines, reasonFormula, reasonLabel } from './provenance';
import type { ProvenanceLine } from './provenance';
import { resolveProposalStrategy, strategyLabel } from './strategy';
import type { ProposalStrategy, StrategyAssignments } from './strategy';

export interface ProposalView {
  id: string;
  runId: string;
  reason: string;
  reasonLabel: string;
  /** The published formula behind the reason: the change reason, in words. */
  changeReason: string;
  /** Why the result was clamped, or null when nothing bound it. */
  limitReason: string | null;
  entityType: string;
  entityId: string;
  /** Stable Amazon campaign identity when the source proposal carries one. */
  campaignId: string | null;
  /** Keyword text or campaign name; the entity id when the mirror knows no name. */
  entityLabel: string;
  /** Campaign, and ad group where there is one. */
  scope: string;
  field: string;
  currentValue: string;
  proposedValue: string;
  /** Signed relative change, or null when there is no numeric baseline. */
  delta: number | null;
  status: string;
  decisionNote: string | null;
  exportBatchTag: string | null;
  strategy: ProposalStrategy;
  strategyLabel: string;
  provenance: ProvenanceLine[];
  /** Whether the update bridge can carry it; a negative is a create. */
  exportable: boolean;
}

const EXPORTABLE_ENTITY_TYPES = new Set(['keyword', 'target', 'campaign', 'ad_group']);

function scalar(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

export function toProposalView(
  record: RecommendationRecord,
  options: { strategySnapshot: unknown; assignments?: StrategyAssignments },
): ProposalView {
  const strategy = resolveProposalStrategy({
    campaignId: record.campaignId,
    campaignName: record.campaignName,
    strategySnapshot: options.strategySnapshot,
    ...(options.assignments === undefined ? {} : { assignments: options.assignments }),
  });

  const current = numeric(record.currentValue);
  const proposed = numeric(record.proposedValue);
  const delta = current !== null && proposed !== null && current !== 0 ? (proposed - current) / current : null;

  const scopeParts = [record.campaignName ?? record.campaignId, record.adGroupName ?? record.adGroupId].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );

  return {
    id: record.id,
    runId: record.runId,
    reason: record.reason,
    reasonLabel: reasonLabel(record.reason),
    changeReason: reasonFormula(record.reason),
    limitReason: limitReason(record.inputs),
    entityType: record.entityType,
    entityId: record.entityId,
    campaignId: record.campaignId,
    entityLabel: record.entityName ?? record.entityId,
    scope: scopeParts.length > 0 ? scopeParts.join(' › ') : 'account',
    field: record.field,
    currentValue: scalar(record.currentValue),
    proposedValue: scalar(record.proposedValue),
    delta,
    status: record.status,
    decisionNote: record.decisionNote,
    exportBatchTag: record.exportBatchTag,
    strategy,
    strategyLabel: strategyLabel(strategy),
    provenance: provenanceLines(record.inputs),
    exportable: EXPORTABLE_ENTITY_TYPES.has(record.entityType),
  };
}

export interface ReasonGroup {
  reason: string;
  label: string;
  proposals: ProposalView[];
}

export type DecisionLaneId = 'needs_review' | 'ready_to_export' | 'completed';

export interface DecisionLane {
  id: DecisionLaneId;
  label: string;
  description: string;
  proposals: ProposalView[];
  reasons: ReasonGroup[];
}

const DECISION_LANES: ReadonlyArray<{
  id: DecisionLaneId;
  label: string;
  description: string;
  statuses: ReadonlySet<string>;
}> = [
  {
    id: 'needs_review',
    label: 'Needs review',
    description: 'New proposals waiting for an operator decision.',
    statuses: new Set(['proposed']),
  },
  {
    id: 'ready_to_export',
    label: 'Ready to export',
    description: 'Accepted proposals that can leave OpenSpell as files.',
    statuses: new Set(['accepted']),
  },
  {
    id: 'completed',
    label: 'Completed',
    description: 'Dismissed, exported, applied, or superseded proposals kept for the record.',
    statuses: new Set(['dismissed', 'exported', 'applied', 'superseded']),
  },
];

/**
 * Turn a flat run into the three operator decisions the stored status supports.
 *
 * This deliberately does not invent an optimization-group assignment. Until a
 * proposal carries real group context, reason is the most specific trustworthy
 * queue dimension and status says what the operator can do next.
 */
export function groupByDecision(proposals: readonly ProposalView[]): DecisionLane[] {
  return DECISION_LANES.map((lane) => {
    const inLane = proposals.filter((proposal) => lane.statuses.has(proposal.status));
    return {
      id: lane.id,
      label: lane.label,
      description: lane.description,
      proposals: inLane,
      reasons: groupByReason(inLane),
    };
  }).filter((lane) => lane.proposals.length > 0);
}

/**
 * Group by reason, in the order the recon's optimizer presents them: the two
 * efficiency criteria, then the two sales criteria, then everything else.
 * Pairing them is the interface, not a sort order.
 */
export const REASON_ORDER = [
  'high_acos',
  'high_spend_no_sales',
  'low_acos',
  'low_visibility',
  'flag',
  'pacing',
];

export function groupByReason(proposals: readonly ProposalView[]): ReasonGroup[] {
  const groups = new Map<string, ProposalView[]>();
  for (const proposal of proposals) {
    const bucket = groups.get(proposal.reason);
    if (bucket) bucket.push(proposal);
    else groups.set(proposal.reason, [proposal]);
  }
  const ordered = [...groups.keys()].sort((a, b) => {
    const ai = REASON_ORDER.indexOf(a);
    const bi = REASON_ORDER.indexOf(b);
    return (ai < 0 ? REASON_ORDER.length : ai) - (bi < 0 ? REASON_ORDER.length : bi);
  });
  return ordered.map((reason) => ({
    reason,
    label: reasonLabel(reason),
    proposals: groups.get(reason) ?? [],
  }));
}

/**
 * Reason coverage, the recon's "beat" #4.
 *
 * With four thousand rows an operator samples, so the surface reports how
 * concentrated the run is and puts the thin clusters first: "97% of rows fall
 * into 4 clusters, 3% are outliers" is what a manager is actually hunting for.
 */
export interface ReasonCoverage {
  reason: string;
  label: string;
  count: number;
  share: number;
}

export function reasonCoverage(proposals: readonly ProposalView[]): ReasonCoverage[] {
  const total = proposals.length;
  if (total === 0) return [];
  return groupByReason(proposals)
    .map((group) => ({
      reason: group.reason,
      label: group.label,
      count: group.proposals.length,
      share: group.proposals.length / total,
    }))
    .sort((a, b) => b.count - a.count);
}
