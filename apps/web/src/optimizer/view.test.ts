/**
 * The Campaign Optimizer's view model is pure, so its arithmetic is tested here
 * without a browser or a database — the two claims that matter are that a ratio
 * KPI is recomputed from base sums (never averaged), and that proposals group
 * into optimization groups with their shared policy resolved.
 */
import { describe, expect, it } from 'vitest';
import type { BaseTotals } from '@wizard-ads/ui';
import type { ProposalView } from '../recommendations/view';
import type { ProposalStrategy } from '../recommendations/strategy';
import {
  bidHistoryKpiTiles,
  kpiTiles,
  optimizationGroups,
  settingsSummary,
  totalsOf,
} from './view';

const totals = (over: Partial<BaseTotals>): BaseTotals => ({
  impressions: 0,
  clicks: 0,
  spend: 0,
  sales: 0,
  orders: 0,
  units: 0,
  ...over,
});

function strat(over: Partial<ProposalStrategy> = {}): ProposalStrategy {
  return {
    objective: 'Balanced',
    objectiveLabel: 'Balanced',
    targetAcos: 0.3,
    explanation: '',
    optGroup: null,
    category: 'other',
    source: 'profile_default',
    cutOnAcosAlone: false,
    ...over,
  };
}

function proposal(over: Partial<ProposalView>): ProposalView {
  return {
    id: 'p1',
    scope: 'Campaign A › Ad group 1',
    reasonLabel: 'High ACOS',
    strategy: strat(),
    ...over,
  } as ProposalView;
}

describe('kpiTiles', () => {
  it('recomputes ACOS from summed bases rather than averaging daily ACOS', () => {
    // spend 30 / sales 100 = 30% overall, even though the two days' ACOS were
    // 20% and 50% (mean 35%). The tile must read 30%.
    const period = totalsOf([
      { impressions: 100, clicks: 10, spend: 10, sales: 50, orders: 5 },
      { impressions: 100, clicks: 10, spend: 20, sales: 50, orders: 5 },
    ]);
    const comparison = totals({ spend: 40, sales: 100 });
    const tiles = kpiTiles(period, comparison);
    const acos = tiles.find((tile) => tile.metric === 'acos');
    expect(acos?.value).toBeCloseTo(0.3, 10);
    // prior ACOS 40/100 = 40%; delta = (0.3 - 0.4) / 0.4 = -0.25.
    expect(acos?.deltaPct).toBeCloseTo(-0.25, 10);
  });

  it('emits every AdLabs tile, in order', () => {
    const tiles = kpiTiles(totals({ spend: 1 }), totals({}));
    expect(tiles.map((tile) => tile.metric)).toEqual([
      'spend', 'sales', 'orders', 'roas', 'acos', 'rpc', 'impressions',
      'clicks', 'ctr', 'cpc', 'aov', 'cpa', 'cvr', 'cpm',
    ]);
  });

  it('builds the target-level bid-history KPI subset from the same base totals', () => {
    const tiles = bidHistoryKpiTiles(
      totals({ impressions: 1_000, clicks: 50, orders: 5, spend: 40, sales: 100 }),
    );
    expect(tiles.map((tile) => tile.metric)).toEqual([
      'impressions',
      'clicks',
      'orders',
      'spend',
      'sales',
      'acos',
      'ctr',
      'cvr',
      'cpc',
    ]);
    expect(tiles.find((tile) => tile.metric === 'acos')?.value).toBe(0.4);
    expect(tiles.find((tile) => tile.metric === 'cpc')?.value).toBe(0.8);
  });

  it('keeps an empty comparison absent instead of fabricating zero totals', () => {
    const tiles = kpiTiles(totals({ spend: 25, sales: 100 }), totalsOf([]));
    expect(tiles.every((tile) => tile.prev === null && tile.deltaPct === null)).toBe(true);
  });
});

describe('optimizationGroups', () => {
  it('groups by campaign and resolves the shared target when it is uniform', () => {
    const groups = optimizationGroups([
      proposal({ id: 'a', scope: 'Campaign A › Ad group 1' }),
      proposal({ id: 'b', scope: 'Campaign A › Ad group 2', reasonLabel: 'Low ACOS' }),
      proposal({ id: 'c', scope: 'Campaign B', strategy: strat({ objective: 'Reduce ACOS', objectiveLabel: 'Reduce ACOS', targetAcos: 0.2 }) }),
    ]);
    expect(groups).toHaveLength(2);
    const a = groups.find((group) => group.label === 'Campaign A');
    expect(a?.proposals).toHaveLength(2);
    expect(a?.targetAcos).toBe(0.3);
    expect(a?.objective).toBe('Balanced');
    // largest group first
    expect(groups[0]?.label).toBe('Campaign A');
  });

  it('reports a null target when a group mixes strategies', () => {
    const groups = optimizationGroups([
      proposal({ id: 'a', scope: 'Campaign A', strategy: strat({ targetAcos: 0.3 }) }),
      proposal({ id: 'b', scope: 'Campaign A', strategy: strat({ targetAcos: 0.25 }) }),
    ]);
    expect(groups[0]?.targetAcos).toBeNull();
  });
});

describe('settingsSummary', () => {
  it('is uniform only when every proposal shares one target and objective', () => {
    expect(
      settingsSummary([proposal({ id: 'a' }), proposal({ id: 'b' })]).uniform,
    ).toBe(true);
    expect(
      settingsSummary([
        proposal({ id: 'a' }),
        proposal({ id: 'b', strategy: strat({ objective: 'Reduce ACOS', objectiveLabel: 'Reduce ACOS', targetAcos: 0.2 }) }),
      ]).uniform,
    ).toBe(false);
  });
});
