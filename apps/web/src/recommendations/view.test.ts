/**
 * The review view model, and the acceptance check it exists to make provable:
 * **the provenance panel renders every `inputs` field for each of the four
 * reasons.** Asserted here against fixtures rather than only in a browser,
 * because a screenshot proves one render and this proves the model.
 */
import { describe, expect, it } from 'vitest';
import type { RecommendationRecord } from '@wizard-ads/db';
import type { RecommendationInputs } from '@wizard-ads/shared';
import { groupByDecision, groupByReason, reasonCoverage, toProposalView } from './view';

const INPUT_KEYS = ['rpc', 'clicks', 'cvrSourceLevel', 'ceilingApplied', 'capClamped', 'window'];

const WHITE_BOX_REASONS = ['high_acos', 'high_spend_no_sales', 'low_acos', 'low_visibility'] as const;

function inputsFor(reason: string): RecommendationInputs {
  const base: RecommendationInputs = {
    rpc: 1.8,
    clicks: 42,
    cvrSourceLevel: 'ad_group',
    ceilingApplied: 'data_based_ad_group',
    capClamped: true,
    window: { start: '2026-07-01', end: '2026-07-28' },
  };
  // The two cases where a field is legitimately absent: a non-converting target
  // with no clicks has no RPC, and an unbound result names no ceiling.
  if (reason === 'high_spend_no_sales') return { ...base, rpc: null, ceilingApplied: null, capClamped: false };
  return base;
}

function record(reason: string, overrides: Partial<RecommendationRecord> = {}): RecommendationRecord {
  return {
    id: `id-${reason}`,
    runId: 'run-1',
    orgId: 'org-1',
    profileId: 'profile-1',
    reason: reason as RecommendationRecord['reason'],
    entityType: 'keyword',
    entityId: 'kw-1',
    entityName: 'blue widget',
    adProduct: 'SP',
    campaignId: 'c-1',
    adGroupId: 'ag-1',
    campaignName: 'Brand | SKW | blue widget',
    adGroupName: 'exact',
    campaignPortfolioId: null,
    campaignKnown: true,
    field: 'bid',
    currentValue: 0.9,
    proposedValue: 0.72,
    inputs: inputsFor(reason),
    status: 'proposed',
    decidedBy: null,
    decidedAt: null,
    exportBatchId: null,
    exportBatchTag: null,
    decisionNote: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

const SNAPSHOT = {
  schema: 'wizard-ads.tenant-strategy.v1',
  opt_groups: { Rank: { goal_lens: 'rank-launch', target_acos: 0.45 } },
};

describe('toProposalView', () => {
  it.each(WHITE_BOX_REASONS)('renders every inputs field for %s', (reason) => {
    const view = toProposalView(record(reason), { strategySnapshot: SNAPSHOT });
    expect(view.provenance.map((line) => line.key)).toEqual(INPUT_KEYS);
    // Every line carries a value and a reason for being there: a panel of
    // labels with blank values would pass a "renders" check and tell nobody
    // anything.
    for (const line of view.provenance) {
      expect(line.value.length).toBeGreaterThan(0);
      expect(line.hint.length).toBeGreaterThan(0);
    }
    expect(view.changeReason.length).toBeGreaterThan(0);
  });

  it('states an absent input explicitly rather than dropping the line', () => {
    const view = toProposalView(record('high_spend_no_sales'), { strategySnapshot: SNAPSHOT });
    const rpc = view.provenance.find((line) => line.key === 'rpc');
    expect(rpc?.value).toBe('—');
    expect(rpc?.hint).toContain('No clicks');
    const ceiling = view.provenance.find((line) => line.key === 'ceilingApplied');
    expect(ceiling?.value).toBe('none');
    expect(view.limitReason).toBeNull();
  });

  it('separates the change reason from the limit reason', () => {
    const view = toProposalView(record('low_visibility'), { strategySnapshot: SNAPSHOT });
    expect(view.changeReason).toContain('step up');
    expect(view.limitReason).toContain('data_based_ad_group');
    expect(view.limitReason).toContain('change cap');
  });

  it('carries the strategy that produced it', () => {
    const view = toProposalView(record('high_acos'), { strategySnapshot: SNAPSHOT });
    expect(view.strategyLabel).toBe('Rank · rank-launch');
    expect(view.strategy.targetAcos).toBe(0.45);
    expect(view.strategy.source).toBe('opt_group');
  });

  it('computes the relative change and marks a create as unexportable', () => {
    const bid = toProposalView(record('high_acos'), { strategySnapshot: SNAPSHOT });
    expect(bid.delta).toBeCloseTo(-0.2, 6);
    expect(bid.exportable).toBe(true);

    const negative = toProposalView(
      record('flag', {
        entityType: 'negative',
        field: 'negative_keyword',
        currentValue: null,
        proposedValue: 'negative_exact',
      }),
      { strategySnapshot: SNAPSHOT },
    );
    expect(negative.delta).toBeNull();
    expect(negative.currentValue).toBe('—');
    expect(negative.exportable).toBe(false);
  });
});

describe('grouping and coverage', () => {
  it('orders reasons as the optimizer presents them and reports coverage', () => {
    const views = [
      toProposalView(record('low_acos'), { strategySnapshot: SNAPSHOT }),
      toProposalView(record('high_acos', { id: 'a' }), { strategySnapshot: SNAPSHOT }),
      toProposalView(record('high_acos', { id: 'b' }), { strategySnapshot: SNAPSHOT }),
    ];
    expect(groupByReason(views).map((group) => group.reason)).toEqual(['high_acos', 'low_acos']);

    const coverage = reasonCoverage(views);
    expect(coverage[0]).toMatchObject({ reason: 'high_acos', count: 2 });
    expect(coverage[0]?.share).toBeCloseTo(2 / 3, 6);
    expect(reasonCoverage([])).toEqual([]);
  });

  it('builds a decision queue from stored statuses without inventing groups', () => {
    const views = [
      toProposalView(record('low_acos'), { strategySnapshot: SNAPSHOT }),
      toProposalView(record('high_acos', { id: 'accepted', status: 'accepted' }), {
        strategySnapshot: SNAPSHOT,
      }),
      toProposalView(record('high_acos', { id: 'exported', status: 'exported' }), {
        strategySnapshot: SNAPSHOT,
      }),
      toProposalView(record('flag', { id: 'dismissed', status: 'dismissed' }), {
        strategySnapshot: SNAPSHOT,
      }),
    ];

    const queue = groupByDecision(views);
    expect(queue.map((lane) => [lane.id, lane.proposals.length])).toEqual([
      ['needs_review', 1],
      ['ready_to_export', 1],
      ['completed', 2],
    ]);
    expect(queue[2]?.reasons.map((group) => group.reason)).toEqual(['high_acos', 'flag']);
  });
});
