import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OptimizationWorkspace } from '@wizard-ads/db';
import { OptimizationGroupsManager } from './groups-manager';

const workspace: OptimizationWorkspace = {
  groups: [{
    group: {
      id: '11111111-1111-4111-8111-111111111111',
      orgId: '22222222-2222-4222-8222-222222222222',
      profileId: '33333333-3333-4333-8333-333333333333',
      name: 'Synthetic rank pool',
      role: 'rank',
      targetAcos: 0.23,
      bidFloor: 0.41,
      bidCeiling: 2.37,
      bidIncreaseCap: 0.17,
      bidDecreaseCap: 0.13,
      placementIncreaseCap: 0.19,
      placementDecreaseCap: 0.11,
      exclusions: [],
      cadence: '7 days',
      prioritization: 'growth_first',
      enabled: true,
    },
    campaignIds: ['campaign-a'],
    nextRunAt: '2026-09-01T00:00:00.000Z',
    lastRun: null,
  }],
  campaigns: [
    {
      campaignId: 'campaign-a',
      name: 'Assigned campaign',
      adProduct: 'SP',
      state: 'enabled',
      dailyBudget: 20,
      groupId: '11111111-1111-4111-8111-111111111111',
    },
    {
      campaignId: 'campaign-b',
      name: 'Unassigned campaign',
      adProduct: 'SB',
      state: 'enabled',
      dailyBudget: 30,
      groupId: null,
    },
  ],
  assignedCampaigns: 1,
  unassignedCampaigns: 1,
};

describe('optimization groups manager', () => {
  it('renders persisted group context, campaign coverage, and the read-only Amazon boundary', () => {
    const markup = renderToStaticMarkup(createElement(OptimizationGroupsManager, {
      profileId: workspace.groups[0]?.group.profileId ?? '',
      initial: workspace,
      canManage: true,
    }));

    expect(markup).toContain('Synthetic rank pool');
    expect(markup).toContain('Target ACOS 23.0%');
    expect(markup).toContain('Assigned campaign');
    expect(markup).toContain('Unassigned campaign');
    expect(markup).toContain('Wizard Ads settings only');
    expect(markup).toContain('does not update Amazon');
    expect(markup).toContain('Run group preview');
  });

  it('disables every mutating control for a viewer', () => {
    const markup = renderToStaticMarkup(createElement(OptimizationGroupsManager, {
      profileId: workspace.groups[0]?.group.profileId ?? '',
      initial: workspace,
      canManage: false,
    }));

    expect(markup).not.toContain('New group');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('Save group');
  });
});
