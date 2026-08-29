import { describe, expect, it } from 'vitest';
import type { OptimizationGroupRecord } from '@wizard-ads/db';
import type { OptimizerCampaignFactRow } from '../../app/_lib/optimizer-campaigns';
import type { ProposalView } from '../recommendations/view';
import { buildOptimizerCampaignRows, filterOptimizerCampaignRows } from './campaigns';

const campaign = (id: string, groupId: string | null): OptimizerCampaignFactRow => ({
  campaignId: id,
  name: `Campaign ${id}`,
  adProduct: 'SP',
  state: id === 'two' ? 'paused' : 'enabled',
  dailyBudget: 20,
  biddingStrategy: 'dynamic_down_only',
  startDate: '2026-08-01',
  groupId,
  currentRows: 1,
  impressions: 100,
  clicks: 10,
  spend: 8,
  sales: 20,
  orders: 2,
  comparisonRows: 1,
  comparisonSpend: 5,
});

describe('optimizer campaign workspace', () => {
  it('joins groups and proposals by stable ids, never campaign names', () => {
    const groups = [{
      group: { id: 'group-one', orgId: 'org', profileId: 'profile', name: 'Rank set', role: 'rank' },
      campaignIds: ['one'],
      nextRunAt: null,
      lastRun: { runId: 'run', status: 'succeeded', proposalsCount: 1, createdAt: '2026-08-28T10:00:00.000Z', finishedAt: null },
    }] as OptimizationGroupRecord[];
    const proposals = [{ campaignId: 'one' }, { campaignId: 'one' }, { campaignId: null }] as ProposalView[];

    const rows = buildOptimizerCampaignRows([campaign('one', 'group-one'), campaign('two', null)], groups, proposals);
    expect(rows[0]).toMatchObject({ groupName: 'Rank set', groupRole: 'rank', proposals: 2 });
    expect(rows[1]).toMatchObject({ groupName: null, proposals: 0 });
  });

  it('filters by search, group, and state without dropping the source set', () => {
    const rows = buildOptimizerCampaignRows(
      [campaign('one', 'group-one'), campaign('two', null)],
      [],
      [],
    );
    expect(filterOptimizerCampaignRows(rows, { query: 'two', group: 'unassigned', state: 'paused' }))
      .toHaveLength(1);
    expect(rows).toHaveLength(2);
  });
});
