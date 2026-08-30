// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { OptimizerCampaignRow } from '../../src/optimizer/campaigns';
import { CampaignWorkspace } from './campaign-workspace';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: Array<{ unmount: () => void }> = [];

function row(index: number, overrides: Partial<OptimizerCampaignRow> = {}): OptimizerCampaignRow {
  const suffix = String(index).padStart(2, '0');
  return {
    adProduct: 'SP',
    biddingStrategy: 'dynamic_bids_down_only',
    campaignId: `campaign-${suffix}`,
    clicks: index,
    comparisonRows: 1,
    comparisonSpend: index - 1,
    currentRows: 1,
    dailyBudget: 20,
    groupId: null,
    groupName: null,
    groupRole: null,
    impressions: index * 10,
    lastRunAt: null,
    name: `Synthetic campaign ${suffix}`,
    orders: 1,
    proposals: 0,
    sales: index * 2,
    spend: index,
    startDate: '2026-01-01',
    state: 'enabled',
    ...overrides,
  };
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter === undefined) throw new Error('input value setter is unavailable');
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  if (setter === undefined) throw new Error('select value setter is unavailable');
  setter.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

afterEach(() => {
  act(() => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

describe('campaign optimizer workspace', () => {
  it('renders a bounded campaign window and resets to the first page when filtering', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    act(() => {
      root.render(createElement(CampaignWorkspace, {
        currencyCode: 'USD',
        period: { start: '2026-08-01', end: '2026-08-30' },
        profileId: 'profile-synthetic',
        rows: Array.from({ length: 56 }, (_, index) => row(index + 1)),
        run: null,
      }));
    });

    expect(host.querySelectorAll('tbody tr')).toHaveLength(25);
    expect(host.textContent).toContain('1–25 of 56');
    expect(host.textContent).toContain('Page 1 of 3');

    const next = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Next →');
    expect(next).toBeDefined();
    act(() => next?.click());

    expect(host.querySelectorAll('tbody tr')).toHaveLength(25);
    expect(host.textContent).toContain('26–50 of 56');
    expect(host.textContent).toContain('Synthetic campaign 26');
    expect(host.textContent).not.toContain('Synthetic campaign 01');

    act(() => next?.click());
    expect(host.querySelectorAll('tbody tr')).toHaveLength(6);
    expect(host.textContent).toContain('51–56 of 56');
    expect(host.textContent).toContain('Synthetic campaign 56');

    const previous = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '← Previous');
    expect(previous).toBeDefined();
    act(() => previous?.click());
    expect(host.textContent).toContain('26–50 of 56');

    const search = host.querySelector<HTMLInputElement>('input[aria-label="Find campaign"]');
    expect(search).not.toBeNull();
    act(() => {
      if (search !== null) setInputValue(search, 'campaign 56');
    });

    expect(host.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(host.textContent).toContain('1–1 of 1');
    expect(host.textContent).toContain('Synthetic campaign 56');
    expect(host.textContent).not.toContain('Page 2 of 3');
  });

  it('resets paging for group, state, clear, and profile context changes', () => {
    const rows = Array.from({ length: 56 }, (_, index) => {
      const position = index + 1;
      return row(position, {
        groupId: position <= 30 ? 'group-a' : null,
        groupName: position <= 30 ? 'Synthetic group' : null,
        groupRole: position <= 30 ? 'profit' : null,
        state: position <= 40 ? 'enabled' : 'paused',
      });
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    const render = (
      profileId: string,
      campaignRows: readonly OptimizerCampaignRow[] = rows,
      start = '2026-08-01',
    ) => createElement(CampaignWorkspace, {
      currencyCode: 'USD',
      period: { start, end: '2026-08-30' },
      profileId,
      rows: campaignRows,
      run: null,
    });

    act(() => root.render(render('profile-a')));
    const next = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Next →');
    act(() => next?.click());
    act(() => next?.click());
    expect(host.textContent).toContain('51–56 of 56');

    const selects = host.querySelectorAll<HTMLSelectElement>('select');
    const group = selects.item(0);
    const state = selects.item(1);
    act(() => setSelectValue(group, 'group-a'));
    expect(host.textContent).toContain('1–25 of 30');

    act(() => setSelectValue(state, 'enabled'));
    expect(host.textContent).toContain('1–25 of 30');

    const clear = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Clear filters');
    expect(clear).toBeDefined();
    act(() => clear?.click());
    expect(host.textContent).toContain('1–25 of 56');

    act(() => next?.click());
    act(() => next?.click());
    expect(host.textContent).toContain('51–56 of 56');
    act(() => root.render(render('profile-b', rows.slice(0, 30))));
    expect(host.textContent).toContain('1–25 of 30');
    expect(host.textContent).toContain('Synthetic campaign 01');

    const nextAfterProfile = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Next →');
    act(() => nextAfterProfile?.click());
    expect(host.textContent).toContain('26–30 of 30');
    act(() => root.render(render('profile-b', rows.slice(0, 30), '2026-08-02')));
    expect(host.textContent).toContain('1–25 of 30');

    act(() => root.render(render('profile-c')));
    const nextAfterPeriod = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Next →');
    act(() => nextAfterPeriod?.click());
    act(() => nextAfterPeriod?.click());
    expect(host.textContent).toContain('51–56 of 56');
    act(() => root.render(render('profile-c', rows.slice(0, 30))));
    expect(host.textContent).toContain('26–30 of 30');
    act(() => root.render(render('profile-c')));
    expect(host.textContent).toContain('26–50 of 56');
  });
});
