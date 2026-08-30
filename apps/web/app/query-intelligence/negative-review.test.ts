// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContextualNegativeProposalRecord } from '@wizard-ads/db';
import { NegativeProposalReview } from './negative-review';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ unmount: () => void }> = [];

function proposal(ordinal: number): ContextualNegativeProposalRecord {
  return {
    id: `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`,
    profileId: '00000000-0000-4000-8000-000000000086',
    marketplaceId: 'SYNTHETIC_MARKET',
    campaignId: `campaign-${ordinal}`,
    adGroupId: `ad-group-${ordinal}`,
    searchTerm: `Synthetic query ${ordinal}`,
    normalizedQuery: `synthetic query ${ordinal}`,
    category: 'excluded',
    sourceGroupRole: 'profit',
    matchType: 'negative_exact',
    reason: 'Synthetic exclusion.',
    status: 'proposed',
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    exportId: null,
    exportedAt: null,
    reviewFingerprint: String(ordinal).repeat(64),
  };
}

function mount(): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push(root);
  act(() => root.render(createElement(NegativeProposalReview, {
    proposals: [proposal(1), proposal(2)],
    exports: [],
    profileId: '00000000-0000-4000-8000-000000000086',
    marketplaceId: 'SYNTHETIC_MARKET',
    role: 'owner',
  })));
  return host;
}

afterEach(() => {
  act(() => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('contextual negative review UI', () => {
  it('submits row fingerprints and reconciles only ids the server actually changed', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      offered: 2,
      matched: 2,
      updated: 1,
      unchanged: 0,
      refused: [],
      changed: [{
        id: proposal(1).id,
        status: 'accepted',
        decidedAt: '2026-08-30T00:00:00.000Z',
        decidedBy: '00000000-0000-4000-8000-000000000089',
        decisionNote: null,
        reviewFingerprint: 'a'.repeat(64),
      }],
    }));
    vi.stubGlobal('fetch', fetch);
    const host = mount();
    const checkboxes = [...host.querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]')];
    act(() => {
      for (const checkbox of checkboxes) checkbox.click();
    });
    const accept = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Accept selected')) as HTMLButtonElement;
    await act(async () => accept.click());

    const request = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      proposals: [
        { id: proposal(1).id, expectedFingerprint: '1'.repeat(64) },
        { id: proposal(2).id, expectedFingerprint: '2'.repeat(64) },
      ],
    });
    const rows = [...host.querySelectorAll('tbody tr')];
    const first = rows.find((row) => row.textContent?.includes('Synthetic query 1'));
    const second = rows.find((row) => row.textContent?.includes('Synthetic query 2'));
    expect(first?.textContent).toContain('Accepted');
    expect(second?.textContent).toContain('Needs review');
  });
});
