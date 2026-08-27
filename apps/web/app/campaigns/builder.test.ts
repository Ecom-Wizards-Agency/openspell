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

afterEach(() => {
  act(() => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('Campaign Builder UI modes', () => {
  it('opens in UPDATE mode and keeps download behind preflight', () => {
    const host = mount();
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Update existing');
    const textarea = host.querySelector('[data-testid="campaign-builder-json"]') as HTMLTextAreaElement;
    expect(textarea.value).toContain('allowEndDateClear');
    const download = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Download'));
    expect(download?.disabled).toBe(true);
  });

  it('shows every preflight diff row with its operation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(preview)));
    const host = mount();
    const preflight = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Run preflight'));
    await act(async () => {
      preflight?.click();
    });
    const renderedRows = host.querySelectorAll('[data-testid="campaign-update-rows"] tbody tr');
    expect(renderedRows).toHaveLength(preview.rows.length);
    expect([...renderedRows].map((entry) => entry.textContent)).toEqual([
      expect.stringContaining('Update'),
      expect.stringContaining('Archive'),
      expect.stringContaining('Create'),
    ]);
    const download = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Download'));
    expect(download?.disabled).toBe(false);
  });

  it('switches to the existing CREATE input idiom without retaining an UPDATE preview', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(preview)));
    const host = mount();
    const preflight = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Run preflight'));
    await act(async () => {
      preflight?.click();
    });
    expect(host.querySelectorAll('[data-testid="campaign-update-rows"] tbody tr')).toHaveLength(3);

    const createTab = [...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.includes('Create new')) as HTMLButtonElement;
    act(() => createTab.click());
    expect(createTab.getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector('[data-testid="campaign-update-rows"]')).toBeNull();
    const textarea = host.querySelector('[data-testid="campaign-builder-json"]') as HTMLTextAreaElement;
    expect(textarea.value).toContain('"campaigns"');
    expect(textarea.value).toContain('"state": "paused"');
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
