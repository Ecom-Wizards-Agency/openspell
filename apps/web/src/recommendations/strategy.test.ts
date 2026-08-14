/**
 * The strategy / objective dimension.
 *
 * The point of these tests is the cascade's *first* step: an assignment map
 * that is empty today and populated when per-campaign strategy assignment
 * ships. If the assignment case works now, adding assignment later is a data
 * change, which is exactly what `docs/DECISIONS.md` asks WP-07 to guarantee.
 *
 * No doctrine value appears here. The snapshots below are shapes with
 * obviously-synthetic numbers.
 */
import { describe, expect, it } from 'vitest';
import {
  optGroupsOf,
  resolveExportCaps,
  resolveProposalStrategy,
  strategyLabel,
} from './strategy';

const SNAPSHOT = {
  schema: 'wizard-ads.tenant-strategy.v1',
  opt_groups: {
    Rank: { goal_lens: 'rank-launch', target_acos: 0.5, max_increase: 0.2, cut_on_acos_alone: false },
    Profit: { goal_lens: 'profit-maintain', target_acos: 0.2 },
    default: { goal_lens: 'scale', target_acos: 0.33 },
  },
  caps: { max_bid_increase: 0.25, max_bid_decrease: 0.3 },
};

describe('resolveProposalStrategy', () => {
  it('reads the group a campaign is explicitly assigned to first', () => {
    const strategy = resolveProposalStrategy({
      campaignId: 'c-1',
      // The name would classify as Profit; the assignment wins.
      campaignName: 'Brand | Halo | Widget',
      strategySnapshot: SNAPSHOT,
      assignments: new Map([['c-1', 'Rank']]),
    });
    expect(strategy.source).toBe('campaign_assignment');
    expect(strategy.optGroup).toBe('Rank');
    expect(strategy.objective).toBe('rank-launch');
    expect(strategy.targetAcos).toBe(0.5);
    expect(strategy.cutOnAcosAlone).toBe(false);
  });

  it('falls back to the opt group matching the campaign category', () => {
    const strategy = resolveProposalStrategy({
      campaignId: 'c-2',
      campaignName: 'Brand | SKW | blue widget',
      strategySnapshot: SNAPSHOT,
    });
    expect(strategy.source).toBe('opt_group');
    expect(strategy.category).toBe('Rank');
    expect(strategy.objective).toBe('rank-launch');
    expect(strategyLabel(strategy)).toBe('Rank · rank-launch');
  });

  it('falls back to the snapshot default group when no category group matches', () => {
    const strategy = resolveProposalStrategy({
      campaignId: 'c-3',
      campaignName: 'Something with no category token',
      strategySnapshot: SNAPSHOT,
    });
    expect(strategy.source).toBe('profile_default');
    expect(strategy.optGroup).toBe('default');
    expect(strategy.objective).toBe('scale');
  });

  it('says unassigned rather than guessing a goal when the snapshot is empty', () => {
    const strategy = resolveProposalStrategy({
      campaignId: 'c-4',
      campaignName: 'Brand | SKW | blue widget',
      strategySnapshot: { schema: 'wizard-ads.tenant-strategy.v1', opt_groups: {} },
    });
    expect(strategy.source).toBe('unassigned');
    expect(strategy.objective).toBe('neutral');
    expect(strategy.targetAcos).toBeNull();
    // Not the same as false: the group is silent, and the panel says so.
    expect(strategy.cutOnAcosAlone).toBeNull();
    expect(strategyLabel(strategy)).toBe('Rank · unassigned');
    expect(strategy.explanation).toContain('neutral lens');
  });

  it('degrades to unassigned rather than throwing on a malformed snapshot', () => {
    for (const snapshot of [null, undefined, 'not a document', { opt_groups: 7 }]) {
      const strategy = resolveProposalStrategy({
        campaignId: 'c-5',
        campaignName: 'Brand | SKW | widget',
        strategySnapshot: snapshot,
      });
      expect(strategy.source).toBe('unassigned');
    }
    expect(optGroupsOf({ opt_groups: { a: null, b: { goal_lens: 'scale' } } })).toEqual({
      b: { goal_lens: 'scale' },
    });
  });
});

describe('resolveExportCaps', () => {
  it('prefers the group caps, then the document caps, then null', () => {
    expect(resolveExportCaps(SNAPSHOT, 'Rank')).toEqual({
      targetAcos: 0.5,
      maxIncrease: 0.2,
      maxDecrease: 0.3,
    });
    expect(resolveExportCaps(SNAPSHOT, 'Profit')).toEqual({
      targetAcos: 0.2,
      maxIncrease: 0.25,
      maxDecrease: 0.3,
    });
    expect(resolveExportCaps({ opt_groups: {} }, 'anything')).toEqual({
      targetAcos: null,
      maxIncrease: null,
      maxDecrease: null,
    });
  });
});
