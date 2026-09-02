import { describe, expect, it } from 'vitest';
import type { OptimizationGroupRecord } from '@wizard-ads/db';
import type { OptimizerCampaignFactRow } from '../../app/_lib/optimizer-campaigns';
import type { ProposalView } from '../recommendations/view';
import {
  buildOptimizerCampaignRows,
  filterOptimizerCampaignRows,
  parseOptimizerPreviewAccepted,
  parseOptimizerPreviewStatus,
} from './campaigns';

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
      group: { id: 'group-one', orgId: 'org', profileId: 'profile', name: 'Rank set', role: 'rank', enabled: true },
      campaignIds: ['one'],
      nextRunAt: null,
      lastRun: { runId: 'run', status: 'succeeded', proposalsCount: 1, createdAt: '2026-08-28T10:00:00.000Z', finishedAt: null },
    }] as OptimizationGroupRecord[];
    const proposals = [{ campaignId: 'one' }, { campaignId: 'one' }, { campaignId: null }] as ProposalView[];

    const rows = buildOptimizerCampaignRows([campaign('one', 'group-one'), campaign('two', null)], groups, proposals);
    expect(rows[0]).toMatchObject({ groupName: 'Rank set', groupRole: 'rank', proposals: 2, selectable: true });
    expect(rows[1]).toMatchObject({ groupName: null, proposals: 0, selectable: false });
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

  it('explains every unsupported preview row and permits enabled SP campaigns only', () => {
    const groups = [{
      group: { id: 'disabled-group', orgId: 'org', profileId: 'profile', name: 'Paused policy', role: 'rank', enabled: false },
      campaignIds: ['group-disabled'],
      nextRunAt: null,
      lastRun: null,
    }] as OptimizationGroupRecord[];
    const rows = buildOptimizerCampaignRows([
      campaign('eligible', null),
      { ...campaign('paused', null), state: 'paused' },
      { ...campaign('deleted', null), state: 'deleted' },
      { ...campaign('brand', null), adProduct: 'SB' },
      { ...campaign('group-disabled', 'disabled-group'), state: 'enabled' },
      { ...campaign('missing-group', 'missing-group'), state: 'enabled' },
    ], groups, []);

    expect(rows.map((row) => [row.campaignId, row.selectable, row.eligibilityReason])).toEqual([
      ['eligible', true, null],
      ['paused', false, 'Campaign state is paused.'],
      ['deleted', false, 'Campaign state is deleted.'],
      ['brand', false, 'Only Sponsored Products campaigns support bid previews.'],
      ['group-disabled', false, 'The assigned optimization group is disabled.'],
      ['missing-group', false, 'The assigned optimization group is unavailable.'],
    ]);
  });

  it('validates bounded preview acceptance and child status payloads', () => {
    const accepted = parseOptimizerPreviewAccepted({
      batchId: 'batch-one',
      status: 'queued',
      scope: { mode: 'selected', campaignCount: 2, fingerprint: 'a'.repeat(64) },
      childCount: 2,
    });
    expect(accepted.scope).toMatchObject({ mode: 'selected', campaignCount: 2 });

    const status = parseOptimizerPreviewStatus({
      batchId: 'batch-one',
      status: 'succeeded',
      campaignCount: 2,
      proposalsCount: 1,
      children: [{
        runId: 'run-one',
        groupName: null,
        status: 'succeeded',
        campaignCount: 2,
        proposalsCount: 1,
      }],
    });
    expect(status.children).toHaveLength(1);
    expect(() => parseOptimizerPreviewAccepted({ ...accepted, childCount: 0 }))
      .toThrow('invalid acceptance response');
    expect(() => parseOptimizerPreviewStatus({ ...status, children: [{ runId: 'run-one' }] }))
      .toThrow('invalid child status');
  });
});
