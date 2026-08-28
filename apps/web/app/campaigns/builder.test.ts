// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BulkRow } from '@wizard-ads/campaigns';
import type { CampaignBuilderPreview } from '../../src/campaigns/artifact.js';
import { CampaignBuilder, updateRowDetails, updateRowId } from './builder.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ unmount: () => void }> = [];

function row(values: Record<string, string | number>): BulkRow {
  return {
    Product: 'Sponsored Products', Entity: '', Operation: '', 'Campaign ID': '',
    'Ad Group ID': '', 'Portfolio ID': '', 'Ad ID': '', 'Keyword ID': '',
    'Product Targeting ID': '', 'Campaign Name': '', 'Ad Group Name': '',
    'Start Date': '', 'End Date': '', 'Targeting Type': '', State: '', 'Daily Budget': '',
    SKU: '', ASIN: '', 'Ad Group Default Bid': '', Bid: '', 'Keyword Text': '',
    'Match Type': '', 'Bidding Strategy': '', Placement: '', Percentage: '',
    'Product Targeting Expression': '', Sites: '',
    ...values,
  };
}

const preview: CampaignBuilderPreview = {
  mode: 'update',
  ready: true,
  exportable: true,
  issues: [],
  notes: [],
  review: ['UPDATE Campaign 1001', 'ARCHIVE Keyword 4001', 'ADD Keyword synthetic'],
  rows: [
    row({ Entity: 'Campaign', Operation: 'Update', 'Campaign ID': '1001', 'Daily Budget': 25 }),
    row({ Entity: 'Keyword', Operation: 'Archive', 'Campaign ID': '1001', 'Ad Group ID': '2001', 'Keyword ID': '4001' }),
    row({ Entity: 'Keyword', Operation: 'Create', 'Campaign ID': '1001', 'Ad Group ID': '2001', 'Keyword ID': 'new_1', 'Keyword Text': 'synthetic' }),
  ],
  counts: { update: 1, archive: 1, create: 1 },
};

function mount(): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(CampaignBuilder, {
      profileId: '50505050-5050-4050-8050-505050505050',
      profileLabel: 'Synthetic profile',
      marketplace: 'US',
    }));
  });
  mounted.push(root);
  return host;
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const match = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(text));
  if (match === undefined) throw new Error(`Button not found: ${text}`);
  return match;
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

afterEach(() => {
  act(() => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('Campaign Builder guided modes', () => {
  it('opens in guided UPDATE mode with JSON closed and export behind preflight', () => {
    const host = mount();
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Update existing');
    expect(host.querySelector('input#update-campaign-id')).not.toBeNull();
    expect(button(host, 'Campaign settings').getAttribute('aria-pressed')).toBe('true');
    expect((host.querySelector('[data-testid="campaign-builder-advanced"]') as HTMLDetailsElement).open).toBe(false);
    expect(host.textContent).toContain('Neither action changes Amazon');
    expect(button(host, 'Download bulksheet').disabled).toBe(true);
  });

  it('validates guided fields before making a request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const host = mount();
    await act(async () => button(host, 'Preview changes').click());
    expect(fetch).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Campaign ID');
  });

  it('submits a guided sparse UPDATE and shows every returned diff row', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(preview));
    vi.stubGlobal('fetch', fetch);
    const host = mount();
    setValue(host.querySelector('#update-campaign-id') as HTMLInputElement, '1001');
    setValue(host.querySelector('#update-amount') as HTMLInputElement, '25');
    await act(async () => button(host, 'Preview changes').click());

    expect(fetch).toHaveBeenCalledTimes(1);
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      mode: 'update',
      output: 'preview',
      config: {
        allowEndDateClear: false,
        changes: { campaigns: [{ campaignId: '1001', dailyBudget: 25 }] },
      },
    });
    const renderedRows = host.querySelectorAll('[data-testid="campaign-update-rows"] tbody tr');
    expect(renderedRows).toHaveLength(preview.rows.length);
    expect([...renderedRows].map((entry) => entry.textContent)).toEqual([
      expect.stringContaining('Update'),
      expect.stringContaining('Archive'),
      expect.stringContaining('Create'),
    ]);
    expect(button(host, 'Download bulksheet').disabled).toBe(false);
  });

  it('switches to CREATE recipes and updates the live engine name preview', () => {
    const host = mount();
    const createTab = button(host, 'Create new');
    act(() => createTab.click());
    expect(createTab.getAttribute('aria-selected')).toBe('true');
    expect(button(host, 'Keyword group').getAttribute('aria-pressed')).toBe('true');

    setValue(host.querySelector('#campaign-product') as HTMLInputElement, 'Widget');
    setValue(host.querySelector('#campaign-descriptor') as HTMLInputElement, 'long-tail');
    setValue(host.querySelector('#campaign-sku') as HTMLTextAreaElement, 'SKU-1');
    setValue(host.querySelector('#campaign-targets') as HTMLTextAreaElement, 'synthetic keyword');

    const name = host.querySelector('[data-testid="campaign-name-preview"]')?.textContent ?? '';
    expect(name).toContain('Profit | SP | Exact | Halo | Widget | synthetic keyword | 01 | EW');
    expect(host.querySelector('[data-testid="campaign-validation"]')).toBeNull();
    expect(host.querySelector('[data-testid="campaign-update-rows"]')).toBeNull();
  });

  it('keeps JSON editing explicit and blocks malformed advanced input locally', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const host = mount();
    const advanced = host.querySelector('[data-testid="campaign-builder-advanced"]') as HTMLDetailsElement;
    act(() => { advanced.open = true; });
    const json = host.querySelector('[data-testid="campaign-builder-json"]') as HTMLTextAreaElement;
    expect(json.value).toContain('"changes"');
    setValue(json, '{invalid');
    await act(async () => button(host, 'Preview changes').click());
    expect(fetch).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Advanced JSON is not valid');
    expect(button(host, 'Reset to guided form').disabled).toBe(false);
  });
});

describe('UPDATE row labels', () => {
  it('uses the entity id before its parents and lists every non-control cell', () => {
    const keyword = row({
      Entity: 'Keyword', Operation: 'Create', 'Campaign ID': '1001', 'Ad Group ID': '2001',
      'Keyword ID': 'new_1', State: 'enabled', Bid: 0.75, 'Keyword Text': 'synthetic keyword',
    });
    expect(updateRowId(keyword)).toBe('new_1');
    expect(updateRowDetails(keyword)).toContain('State: enabled');
    expect(updateRowDetails(keyword)).toContain('Bid: 0.75');
    expect(updateRowDetails(keyword)).toContain('Keyword Text: synthetic keyword');
  });
});
