// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OptimizerCampaignRow } from '../../src/optimizer/campaigns';
import { CampaignWorkspace } from './campaign-workspace';

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));

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
    eligibilityReason: null,
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
    selectable: true,
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
  navigation.refresh.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (document as unknown as Record<string, unknown>)['visibilityState'];
});

function workspaceProps(
  rows: readonly OptimizerCampaignRow[],
  overrides: Partial<Parameters<typeof CampaignWorkspace>[0]> = {},
): Parameters<typeof CampaignWorkspace>[0] {
  return {
    currencyCode: 'USD',
    initialBatchId: null,
    mayRunOptimizer: true,
    period: { start: '2026-08-01', end: '2026-08-30' },
    profileId: '00000000-0000-4000-8000-000000000001',
    rows,
    run: null,
    ...overrides,
  };
}

function mount(
  rows: readonly OptimizerCampaignRow[],
  overrides: Partial<Parameters<typeof CampaignWorkspace>[0]> = {},
): { host: HTMLElement; root: ReturnType<typeof createRoot> } {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push(root);
  act(() => root.render(createElement(CampaignWorkspace, workspaceProps(rows, overrides))));
  return { host, root };
}

describe('campaign optimizer workspace', () => {
  it('renders a bounded campaign window and resets to the first page when filtering', () => {
    const { host } = mount(Array.from({ length: 56 }, (_, index) => row(index + 1)));

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
      initialBatchId: null,
      period: { start, end: '2026-08-30' },
      profileId,
      rows: campaignRows,
      run: null,
      mayRunOptimizer: true,
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

  it('selects every filtered eligible campaign across pages, retains hidden choices, and clears globally', () => {
    const rows = Array.from({ length: 56 }, (_, index) => {
      const position = index + 1;
      return row(position, {
        ...(position <= 30
          ? { groupId: 'group-a', groupName: 'Synthetic group', groupRole: 'profit' }
          : {}),
        ...(position === 5
          ? { eligibilityReason: 'Campaign state is paused.', selectable: false, state: 'paused' }
          : {}),
      });
    });
    const { host } = mount(rows);
    const group = host.querySelectorAll<HTMLSelectElement>('select').item(0);
    act(() => setSelectValue(group, 'group-a'));

    const header = host.querySelector<HTMLInputElement>('[data-testid="optimizer-select-filtered"]');
    expect(header?.getAttribute('aria-label')).toBe('Select all 29 eligible campaigns matching current filters');
    expect(header?.indeterminate).toBe(false);
    act(() => header?.click());
    expect(header?.checked).toBe(true);
    expect(host.querySelector('[data-testid="optimizer-selection-count"]')?.textContent)
      .toContain('29 campaigns selected');

    const next = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Next →');
    act(() => next?.click());
    expect(host.textContent).toContain('26–30 of 30');
    expect([...host.querySelectorAll<HTMLInputElement>('[data-testid="optimizer-campaign-select"]')]
      .every((checkbox) => checkbox.checked)).toBe(true);

    act(() => setSelectValue(group, 'all'));
    expect(header?.checked).toBe(false);
    expect(header?.indeterminate).toBe(true);

    act(() => setSelectValue(group, 'unassigned'));
    const firstUnassigned = host.querySelector<HTMLInputElement>('[data-testid="optimizer-campaign-select"]');
    act(() => firstUnassigned?.click());
    expect(host.querySelector('[data-testid="optimizer-selection-count"]')?.textContent)
      .toContain('30 campaigns selected');

    const clear = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Clear selected');
    act(() => clear?.click());
    expect(host.querySelector('[data-testid="optimizer-selection-count"]')?.textContent)
      .toContain('No campaigns selected');
    expect(firstUnassigned?.checked).toBe(false);
  });

  it('retains selection through period refresh and resets it only when the profile changes', () => {
    const rows = [row(1), row(2)];
    const { host, root } = mount(rows);
    const first = host.querySelector<HTMLInputElement>('[data-testid="optimizer-campaign-select"]');
    act(() => first?.click());
    expect(host.textContent).toContain('1 campaign selected');

    act(() => root.render(createElement(CampaignWorkspace, workspaceProps(rows, {
      period: { start: '2026-08-02', end: '2026-08-31' },
    }))));
    expect(host.textContent).toContain('1 campaign selected');

    act(() => root.render(createElement(CampaignWorkspace, workspaceProps(rows, {
      profileId: '00000000-0000-4000-8000-000000000002',
    }))));
    expect(host.textContent).toContain('No campaigns selected');
  });

  it('renders explicit ineligible reasons and disables every run control for a viewer', () => {
    const rows = [
      row(1),
      row(2, {
        eligibilityReason: 'Only Sponsored Products campaigns support bid previews.',
        selectable: false,
        adProduct: 'SB',
      }),
    ];
    const { host } = mount(rows, { mayRunOptimizer: false });
    expect(host.textContent).toContain('Only Sponsored Products campaigns support bid previews.');
    expect(host.textContent).toContain('Your role can view previews but cannot queue one.');
    expect(host.querySelector<HTMLButtonElement>('[data-testid="optimizer-run-preview"]')?.disabled).toBe(true);
    expect([...host.querySelectorAll<HTMLInputElement>('[data-testid="optimizer-campaign-select"]')]
      .every((checkbox) => checkbox.disabled)).toBe(true);
    expect(host.querySelector<HTMLInputElement>('[data-testid="optimizer-select-filtered"]')?.disabled).toBe(true);
  });

  it('refuses an all-campaign preview when the eligible roster exceeds the server bound', () => {
    const { host } = mount(
      Array.from({ length: 10_001 }, (_, index) => row(index + 1)),
    );
    expect(host.getElementsByTagName('tbody').item(0)?.children).toHaveLength(25);
    expect(host.querySelectorAll<HTMLInputElement>('input[name="optimizer-preview-scope"]')
      .item(0).disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[data-testid="optimizer-run-preview"]')?.disabled)
      .toBe(true);
    expect(host.textContent).toContain('One preview supports at most 10,000 campaigns');
    expect(host.textContent).toContain('Select a smaller campaign set');
  });

  it('polls without overlap, refreshes once on success, and exposes every successful child review', async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, '', '/optimizer?profile=00000000-0000-4000-8000-000000000001&from=2026-08-01');
    const accepted = {
      batchId: 'batch-one',
      status: 'queued',
      scope: { mode: 'all', campaignCount: 2, fingerprint: 'a'.repeat(64) },
      childCount: 2,
    };
    const queued = {
      batchId: 'batch-one', status: 'queued', campaignCount: 2, proposalsCount: 0,
      children: [
        { runId: 'run-one', groupName: 'Synthetic group', status: 'queued', campaignCount: 1, proposalsCount: 0 },
        { runId: 'run-two', groupName: null, status: 'queued', campaignCount: 1, proposalsCount: 0 },
      ],
    };
    const running = {
      ...queued,
      status: 'running',
      children: queued.children.map((child) => ({ ...child, status: 'running' })),
    };
    const succeeded = {
      ...queued,
      status: 'succeeded',
      proposalsCount: 1,
      children: [
        { ...queued.children[0], status: 'succeeded', proposalsCount: 1 },
        { ...queued.children[1], status: 'succeeded' },
      ],
    };
    const responses = [accepted, queued, running, succeeded];
    const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => Response.json(responses.shift()),
    );
    vi.stubGlobal('fetch', fetch);
    const { host } = mount([row(1), row(2)]);
    const run = host.querySelector<HTMLButtonElement>('[data-testid="optimizer-run-preview"]');
    await act(async () => run?.click());

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(window.location.search).toContain('batch=batch-one');
    expect(run?.disabled).toBe(true);
    expect(host.querySelector('.wa-optimizer-preview')?.getAttribute('aria-busy')).toBe('true');

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/optimizer/runs/batch-one?profileId=00000000-0000-4000-8000-000000000001');
    expect(host.textContent).toContain('Preview queued for 2 campaigns');
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(host.textContent).toContain('Preview running for 2 campaigns');
    await act(async () => vi.advanceTimersByTimeAsync(5_000));

    expect(host.textContent).toContain('Preview completed with 1 recommendation to review');
    expect(navigation.refresh).toHaveBeenCalledTimes(1);
    const reviews = [...host.querySelectorAll<HTMLAnchorElement>('[aria-label="Preview runs"] a')];
    expect(reviews).toHaveLength(2);
    expect(reviews[0]?.href).toContain('/recommendations?profile=00000000-0000-4000-8000-000000000001&run=run-one');
    expect(run?.disabled).toBe(false);
  });

  it('resumes polling from the batch URL after reload and aborts it when the profile changes', async () => {
    vi.useFakeTimers();
    const statusSignals: AbortSignal[] = [];
    const pending = new Promise<Response>(() => undefined);
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal !== undefined && init.signal !== null) statusSignals.push(init.signal);
      return pending;
    });
    vi.stubGlobal('fetch', fetch);
    const rows = [row(1)];
    const { host, root } = mount(rows, { initialBatchId: 'batch-resume' });
    expect(host.querySelector<HTMLButtonElement>('[data-testid="optimizer-run-preview"]')?.disabled).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toContain('/api/optimizer/runs/batch-resume?profileId=');

    act(() => root.render(createElement(CampaignWorkspace, workspaceProps(rows, {
      initialBatchId: null,
      profileId: '00000000-0000-4000-8000-000000000002',
    }))));
    expect(statusSignals[0]?.aborted).toBe(true);
  });

  it('clears an unreadable batch URL and re-enables a fresh preview', async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, '', '/optimizer?profile=00000000-0000-4000-8000-000000000001&batch=foreign-batch');
    const fetch = vi.fn(async () => Response.json({ error: 'Not found' }, { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    const { host } = mount([row(1)], { initialBatchId: 'foreign-batch' });
    const run = host.querySelector<HTMLButtonElement>('[data-testid="optimizer-run-preview"]');
    expect(run?.disabled).toBe(true);

    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    expect(host.textContent).toContain('Not found');
    expect(run?.disabled).toBe(false);
    expect(window.location.search).not.toContain('batch=');
  });

  it('retries a transient status failure and preserves partial child review links on terminal failure', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({
        batchId: 'batch-partial', status: 'queued',
        scope: { mode: 'all', campaignCount: 2, fingerprint: 'c'.repeat(64) }, childCount: 2,
      }))
      .mockResolvedValueOnce(Response.json({ error: 'temporary status outage' }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({
        batchId: 'batch-partial', status: 'failed', campaignCount: 2, proposalsCount: 1,
        children: [
          { runId: 'run-complete', groupName: 'Completed group', status: 'succeeded', campaignCount: 1, proposalsCount: 1 },
          { runId: 'run-failed', groupName: null, status: 'failed', campaignCount: 1, proposalsCount: 0 },
        ],
      }));
    vi.stubGlobal('fetch', fetch);
    const { host } = mount([row(1), row(2)]);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="optimizer-run-preview"]')?.click());
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(host.textContent).toContain('temporarily unavailable. Retrying automatically');
    await act(async () => vi.advanceTimersByTimeAsync(2_000));

    expect(host.textContent).toContain('Preview failed. 1 recommendation remains available');
    expect(navigation.refresh).toHaveBeenCalledTimes(1);
    const links = [...host.querySelectorAll<HTMLAnchorElement>('[aria-label="Preview runs"] a')];
    expect(links).toHaveLength(1);
    expect(links[0]?.href).toContain('run=run-complete');
    expect(host.querySelector<HTMLButtonElement>('[data-testid="optimizer-run-preview"]')?.disabled).toBe(false);
  });

  it('stops after ten visible observation minutes without claiming terminal state', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => Response.json({
      batchId: 'batch-observe', status: 'queued', campaignCount: 1, proposalsCount: 0,
      children: [{ runId: 'run-observe', groupName: null, status: 'queued', campaignCount: 1, proposalsCount: 0 }],
    }));
    vi.stubGlobal('fetch', fetch);
    const { host } = mount([row(1)], { initialBatchId: 'batch-observe' });
    await act(async () => vi.advanceTimersByTimeAsync(10 * 60 * 1_000));

    expect(host.textContent).toContain('Automatic status checks stopped after ten minutes');
    expect(host.textContent).toContain('The preview may still complete in the background');
    expect(host.textContent).not.toContain('Preview completed');
    expect(navigation.refresh).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="optimizer-run-preview"]')?.disabled).toBe(true);
  });

  it('aborts a status request that never settles when the visible deadline expires', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal !== undefined && init.signal !== null) signals.push(init.signal);
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal('fetch', fetch);
    const { host } = mount([row(1)], { initialBatchId: 'batch-hung' });

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(10 * 60 * 1_000 - 1_000));

    expect(signals[0]?.aborted).toBe(true);
    expect(host.textContent).toContain('Automatic status checks stopped after ten minutes');
    expect(host.textContent).not.toContain('Preview completed');
  });

  it('never overlaps status requests and does not consume the observation budget while hidden', async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    let resolveStatus!: (response: Response) => void;
    const pendingStatus = new Promise<Response>((resolve) => { resolveStatus = resolve; });
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({
        batchId: 'batch-slow', status: 'queued',
        scope: { mode: 'all', campaignCount: 1, fingerprint: 'b'.repeat(64) }, childCount: 1,
      }))
      .mockReturnValueOnce(pendingStatus)
      .mockResolvedValue(Response.json({
        batchId: 'batch-slow', status: 'queued', campaignCount: 1, proposalsCount: 0,
        children: [{ runId: 'run-slow', groupName: null, status: 'queued', campaignCount: 1, proposalsCount: 0 }],
      }));
    vi.stubGlobal('fetch', fetch);
    const { host } = mount([row(1)]);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="optimizer-run-preview"]')?.click());
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(fetch).toHaveBeenCalledTimes(2);

    visibility = 'hidden';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    resolveStatus(Response.json({
      batchId: 'batch-slow', status: 'queued', campaignCount: 1, proposalsCount: 0,
      children: [{ runId: 'run-slow', groupName: null, status: 'queued', campaignCount: 1, proposalsCount: 0 }],
    }));
    await act(async () => pendingStatus);
    await act(async () => vi.advanceTimersByTimeAsync(15 * 60 * 1_000));
    expect(host.textContent).not.toContain('Automatic status checks stopped');

    visibility = 'visible';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(host.textContent).not.toContain('Automatic status checks stopped');
  });

  it('reuses an idempotency key only while an exact-scope response remains uncertain', async () => {
    const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => { throw new TypeError('connection interrupted'); },
    );
    vi.stubGlobal('fetch', fetch);
    const { host } = mount([row(1)]);
    const run = host.querySelector<HTMLButtonElement>('[data-testid="optimizer-run-preview"]');

    await act(async () => run?.click());
    await act(async () => run?.click());
    expect(fetch).toHaveBeenCalledTimes(4);
    const firstBodies = fetch.mock.calls.slice(0, 4).map((call) =>
      JSON.parse((call[1] as RequestInit).body as string) as { clientRequestId: string },
    );
    expect(new Set(firstBodies.map((body) => body.clientRequestId)).size).toBe(1);

    const firstCampaign = host.querySelector<HTMLInputElement>('[data-testid="optimizer-campaign-select"]');
    act(() => firstCampaign?.click());
    await act(async () => run?.click());
    const changedBody = JSON.parse((fetch.mock.calls[4]?.[1] as RequestInit).body as string) as {
      clientRequestId: string;
      scope: { mode: string };
    };
    expect(changedBody.scope.mode).toBe('selected');
    expect(changedBody.clientRequestId).not.toBe(firstBodies[0]?.clientRequestId);
  });
});
