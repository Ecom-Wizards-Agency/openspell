// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: Array<{ unmount: () => void }> = [];

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter === undefined) throw new Error('input value setter is unavailable');
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
  act(() => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

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
    expect(markup).toContain('OpenSpell settings only');
    expect(markup).toContain('does not update Amazon');
    expect(markup).toContain('Run group preview');
    expect(markup).toContain('Review every');
    expect(markup).toContain('Select all');
    expect(markup).toContain('Select all applies only to campaigns matching the current search filter');
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

  it('selects and clears only campaigns matching the active filter', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    act(() => {
      root.render(createElement(OptimizationGroupsManager, {
        profileId: workspace.groups[0]?.group.profileId ?? '',
        initial: workspace,
        canManage: true,
      }));
    });

    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search campaigns"]');
    expect(search).not.toBeNull();
    act(() => {
      if (search === null) return;
      setInputValue(search, 'campaign-b');
    });

    const selectAll = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Select all');
    expect(selectAll).toBeDefined();
    act(() => selectAll?.click());

    act(() => {
      if (search === null) return;
      setInputValue(search, '');
    });
    let campaignChecks = [...host.querySelectorAll<HTMLInputElement>('.wa-campaign-choice input')];
    expect(campaignChecks).toHaveLength(workspace.campaigns.length);
    expect(campaignChecks.every((checkbox) => checkbox.checked)).toBe(true);

    act(() => {
      if (search === null) return;
      setInputValue(search, 'campaign-b');
    });
    const deselectAll = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Deselect all');
    expect(deselectAll).toBeDefined();
    act(() => deselectAll?.click());

    act(() => {
      if (search === null) return;
      setInputValue(search, '');
    });
    campaignChecks = [...host.querySelectorAll<HTMLInputElement>('.wa-campaign-choice input')];
    expect(campaignChecks.map((checkbox) => checkbox.checked)).toEqual([true, false]);
  });
});
