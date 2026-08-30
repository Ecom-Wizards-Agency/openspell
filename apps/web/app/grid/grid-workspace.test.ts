// @vitest-environment jsdom
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildGridModelSafely,
  columnsFor,
  toCsv,
} from '@wizard-ads/ui';
import type { FreshnessAssessment, GridRow } from '@wizard-ads/ui';
import {
  GridWorkspace,
  gridRowsRequestUrl,
  parseGridRowsPayload,
} from './grid-client';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ unmount: () => void }> = [];
const freshness: FreshnessAssessment = {
  tone: 'good',
  headline: 'Fresh',
  details: [],
  staleTypes: [],
  lossyTypes: [],
  coversThrough: '2026-06-30',
};

function row(index: number, profile = 'profile-a'): GridRow {
  return {
    id: `${profile}-row-${index}`,
    dimensions: {
      search_term: `synthetic term ${String(index).padStart(4, '0')}`,
      campaign_name: `Campaign ${index % 7}`,
      ad_group_name: `Ad group ${index % 11}`,
      match_type: index % 2 === 0 ? 'exact' : 'phrase',
      ad_product: 'SP',
      harvested: index % 3 === 0,
    },
    totals: {
      impressions: index * 10,
      clicks: index,
      spend: index / 10,
      sales: index / 5,
      orders: index % 5,
      units: index % 7,
    },
    comparison: {
      impressions: index * 8,
      clicks: Math.max(0, index - 1),
      spend: index / 12,
      sales: index / 6,
      orders: index % 4,
      units: index % 6,
    },
    currencyCode: 'USD',
  };
}

function payload(rows: readonly GridRow[], truncated = false): unknown {
  return { rows, rowCount: rows.length, truncated };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function props(profileId = '50505050-5050-4050-8050-505050505050') {
  return {
    entity: 'search_terms' as const,
    currencyCode: 'USD',
    profileId,
    period: { start: '2026-06-30', end: '2026-06-30' },
    comparisonPeriod: { start: '2026-06-29', end: '2026-06-29' },
    freshness,
    campaignId: null,
  };
}

function mount(profileId?: string): { host: HTMLElement; root: ReturnType<typeof createRoot> } {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push(root);
  act(() => root.render(createElement(GridWorkspace, props(profileId))));
  return { host, root };
}

afterEach(() => {
  act(() => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  navigation.push.mockReset();
  vi.unstubAllGlobals();
});

describe('Grid row transport', () => {
  it('requests only the server-owned scope and exposes no partial controls while loading', () => {
    const pending = deferred<Response>();
    const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => pending.promise);
    vi.stubGlobal('fetch', fetch);
    const { host } = mount();

    expect(host.querySelector('[data-testid="grid-data-loading"]')).not.toBeNull();
    expect(host.textContent).toContain('Loading the complete result set');
    expect(host.textContent).not.toContain('Export CSV');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      '/api/grid/rows?profile=50505050-5050-4050-8050-505050505050&entity=search_terms&from=2026-06-30&to=2026-06-30',
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      cache: 'no-store',
      credentials: 'same-origin',
    });
  });

  it('reuses one in-flight request across the development Strict Mode effect replay', async () => {
    const pending = deferred<Response>();
    const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => pending.promise);
    vi.stubGlobal('fetch', fetch);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    act(() => {
      root.render(createElement(StrictMode, null, createElement(GridWorkspace, props())));
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(Response.json(payload([row(1)])));
      await pending.promise;
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="grid-data-ready"]')).not.toBeNull();
  });

  it('enables the complete model only after a counted response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(payload([row(1), row(2)]))));
    const { host } = mount();
    await act(async () => undefined);

    expect(host.querySelector('[data-testid="grid-data-ready"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="grid-row-count"]')?.textContent).toContain('2 rows');
    expect(host.textContent).toContain('Export CSV (2 of 2)');
    expect(host.textContent).not.toContain('Loading the complete result set');
  });

  it('announces and explains a truncated response as partial', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(payload([row(1), row(2)], true))));
    const { host } = mount();
    await act(async () => undefined);

    const status = host.querySelector('[data-testid="grid-row-count"]');
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.textContent).toContain('Partial result set loaded: 2 rows');
    expect(status?.textContent).not.toContain('Complete result set');
    expect(host.textContent).toContain('This result is too large to load safely');
    expect(host.textContent).toContain('totals cover only what is shown');
  });

  it('offers an explicit retry and never turns a malformed count into an actionable Grid', async () => {
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({ rows: [row(1)], rowCount: 2, truncated: false }))
      .mockResolvedValueOnce(Response.json(payload([row(1)])));
    vi.stubGlobal('fetch', fetch);
    const { host } = mount();
    await act(async () => undefined);

    expect(host.querySelector('[data-testid="grid-data-error"]')).not.toBeNull();
    expect(host.textContent).not.toContain('Export CSV');
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Retry');
    expect(retry).toBeDefined();
    await act(async () => retry?.click());

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-testid="grid-data-ready"]')).not.toBeNull();
    expect(host.textContent).toContain('Export CSV (1 of 1)');
  });

  it('aborts a changed scope and ignores a late response even when fetch ignores the signal', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    vi.stubGlobal('fetch', fetch);
    const { host, root } = mount('50505050-5050-4050-8050-505050505050');

    act(() => {
      root.render(createElement(GridWorkspace, props('60606060-6060-4060-8060-606060606060')));
    });
    expect(host.textContent).toContain('Loading the complete result set');
    const firstSignal = (fetch.mock.calls[0]?.[1] as RequestInit | undefined)?.signal;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(firstSignal?.aborted).toBe(true);

    await act(async () => {
      second.resolve(Response.json(payload([row(2, 'profile-b')])));
      await second.promise;
    });
    expect(host.querySelector('[data-testid="grid-start-experiment"]')?.getAttribute('href'))
      .toContain('terms=synthetic+term+0002');

    await act(async () => {
      first.resolve(Response.json(payload([row(1, 'profile-a')])));
      await first.promise;
    });
    const experimentHref = host.querySelector('[data-testid="grid-start-experiment"]')
      ?.getAttribute('href');
    expect(experimentHref).toContain('terms=synthetic+term+0002');
    expect(experimentHref).not.toContain('synthetic+term+0001');
  });

  it('preserves filtering, three-level grouping, totals, and CSV across 3,597-row JSON transport', () => {
    const source = Array.from({ length: 3_597 }, (_, index) => row(index + 1));
    const transported = parseGridRowsPayload(JSON.parse(JSON.stringify(payload(source))));
    const view = {
      filter: {
        groups: [{ filters: [{ key: 'MATCH_TYPE', conditions: [{ operator: 'IN' as const, values: ['exact'] }] }] }],
      },
      sort: [{ columnId: 'spend', direction: 'desc' as const }],
      groupBy: ['campaign_name', 'ad_group_name', 'match_type'],
    };

    const before = buildGridModelSafely(source, view);
    const after = buildGridModelSafely(transported.rows, view);
    expect(transported.rowCount).toBe(3_597);
    expect(after).toEqual(before);

    const flatBefore = buildGridModelSafely(source, { filter: { groups: [] }, sort: [], groupBy: [] });
    const flatAfter = buildGridModelSafely(transported.rows, { filter: { groups: [] }, sort: [], groupBy: [] });
    const options = {
      columns: columnsFor('search_terms'),
      label: 'search terms',
      currencyCode: 'USD',
      period: { start: '2026-06-30', end: '2026-06-30' },
      comparisonPeriod: { start: '2026-06-29', end: '2026-06-29' },
    };
    const beforeCsv = toCsv(flatBefore.model, options);
    const afterCsv = toCsv(flatAfter.model, options);
    expect(flatAfter.model.total).toBe(3_597);
    expect(flatAfter.model.exported).toBe(3_597);
    expect(afterCsv).toEqual(beforeCsv);

    const durations = Array.from({ length: 20 }, () => {
      const started = performance.now();
      buildGridModelSafely(transported.rows, view);
      return performance.now() - started;
    }).sort((a, b) => a - b);
    expect(durations[Math.ceil(durations.length * 0.95) - 1]).toBeLessThan(150);
  });

  it('builds a request without exposing currency or comparison control to the browser', () => {
    const url = gridRowsRequestUrl(props());
    expect(url).toContain('profile=50505050-5050-4050-8050-505050505050');
    expect(url).toContain('entity=search_terms');
    expect(url).not.toMatch(/currency|comparison|org/i);
  });
});
