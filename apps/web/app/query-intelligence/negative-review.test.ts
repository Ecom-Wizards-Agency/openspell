// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NEGATIVE_REVIEW_ACTION_LIMIT,
  NEGATIVE_REVIEW_PAGE_SIZE,
  NegativeProposalReview,
  type ContextualNegativeReviewProposal,
  type ContextualNegativeReviewState,
} from './negative-review';

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ unmount: () => void }> = [];
const PROFILE = '11111111-1111-4111-8111-111111111111';
const MARKETPLACE = 'SYNTHETIC_MARKET';

function proposal(index: number, status: ContextualNegativeReviewProposal['status'] = 'proposed'):
ContextualNegativeReviewProposal {
  const suffix = String(index).padStart(12, '0');
  return {
    id: `00000000-0000-4000-8000-${suffix}`,
    profileId: PROFILE,
    marketplaceId: MARKETPLACE,
    campaignId: `campaign-${index}`,
    adGroupId: `ad-group-${index}`,
    searchTerm: `Synthetic query ${index}`,
    normalizedQuery: `synthetic query ${index}`,
    category: 'excluded',
    sourceGroupRole: 'profit',
    matchType: 'negative_exact',
    reason: `Synthetic review reason ${index}.`,
    status,
    reviewFingerprint: String(index).padStart(64, 'a').slice(-64),
  };
}

function ready(rows: ContextualNegativeReviewProposal[]): ContextualNegativeReviewState {
  const counts = { proposed: 0, accepted: 0, dismissed: 0, exported: 0 };
  for (const row of rows) counts[row.status] += 1;
  return { status: 'ready', proposals: rows, counts, rowCount: rows.length, reviewBytes: rows.length * 80 };
}

function props(
  review: ContextualNegativeReviewState,
  profileId = PROFILE,
  role = 'owner',
  exports: Parameters<typeof NegativeProposalReview>[0]['exports'] = [],
) {
  return { review, exports, profileId, marketplaceId: MARKETPLACE, role };
}

function mount(review: ContextualNegativeReviewState, profileId = PROFILE, role = 'owner') {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push(root);
  act(() => root.render(createElement(NegativeProposalReview, props(review, profileId, role))));
  return { host, root };
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const result = [...host.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.includes(text));
  if (!result) throw new Error(`button not found: ${text}`);
  return result;
}

afterEach(() => {
  act(() => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  navigation.refresh.mockReset();
  vi.unstubAllGlobals();
});

describe('contextual-negative review UI', () => {
  it('reaches the complete bounded set while rendering one compact page', () => {
    const rows = Array.from({ length: 302 }, (_, index) => proposal(index + 1));
    const { host } = mount(ready(rows));

    expect(host.querySelectorAll('tbody tr')).toHaveLength(NEGATIVE_REVIEW_PAGE_SIZE);
    expect(host.textContent).toContain('302 complete rows');
    expect(host.textContent).toContain('page 1 of 7');
    act(() => button(host, 'Next').click());
    expect(host.textContent).toContain('page 2 of 7');
    expect(host.textContent).toContain('Synthetic query 51');
    expect(host.textContent).not.toContain('Synthetic query 1Synthetic');
  });

  it('selects only rendered rows, shows a tray, and clears it on scope remount', () => {
    const review = ready(Array.from({ length: 75 }, (_, index) => proposal(index + 1)));
    const { host, root } = mount(review);

    act(() => button(host, 'Select rendered page').click());
    expect(host.querySelector('[data-testid="negative-selection-tray"]')?.textContent)
      .toContain(`${NEGATIVE_REVIEW_PAGE_SIZE} explicitly selected`);

    act(() => root.render(createElement(NegativeProposalReview, props(
      review,
      '22222222-2222-4222-8222-222222222222',
    ))));
    expect(host.querySelector('[data-testid="negative-selection-tray"]')).toBeNull();
  });

  it('fails closed at the explicit 500-proposal selection limit', () => {
    const rows = Array.from({ length: NEGATIVE_REVIEW_ACTION_LIMIT + 1 }, (_, index) => proposal(index + 1));
    const { host } = mount(ready(rows));

    for (let page = 0; page < 11; page += 1) {
      act(() => button(host, 'Select rendered page').click());
      if (page < 10) act(() => button(host, 'Next').click());
    }

    expect(host.querySelector('[data-testid="negative-selection-tray"]')?.textContent)
      .toContain(`${NEGATIVE_REVIEW_ACTION_LIMIT} explicitly selected`);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Selection stopped');
  });

  it('shows an explicit capacity state without proposal rows', () => {
    const { host } = mount({
      status: 'capacity_exceeded',
      rowCount: 5001,
      reviewBytes: 9 * 1024 * 1024,
      rowLimit: 5000,
      byteLimit: 8 * 1024 * 1024,
      measurementsAvailable: true,
      reason: 'The review scope exceeds its row limit.',
    });

    expect(host.querySelector('[data-testid="negative-review-capacity"]')).not.toBeNull();
    expect(host.querySelectorAll('tbody tr')).toHaveLength(0);
    expect(host.textContent).toContain('no proposal bodies were loaded');
    expect(host.textContent).toContain('Amazon not updated');
  });

  it('does not present fallback zeros as observed facts when measurement times out', () => {
    const { host } = mount({
      status: 'capacity_exceeded',
      rowCount: 0,
      reviewBytes: 0,
      rowLimit: 5000,
      byteLimit: 8 * 1024 * 1024,
      measurementsAvailable: false,
      reason: 'The complete review snapshot exceeded its five-second query budget.',
    });

    expect(host.textContent).toContain('Rows foundNot measured');
    expect(host.textContent).toContain('Review fieldsNot measured');
    expect(host.textContent).not.toContain('Rows found0');
  });

  it('keeps viewer controls disabled and never offers an Amazon apply action', () => {
    const { host } = mount(ready([proposal(1), proposal(2, 'accepted')]), PROFILE, 'viewer');
    expect(button(host, 'Accept selected').disabled).toBe(true);
    expect(button(host, 'Export 0 selected accepted').disabled).toBe(true);
    expect(host.textContent).toContain('Role viewer is read-only');
    expect(host.textContent).toContain('Amazon not updated');
    expect(host.textContent).not.toContain('Apply to Amazon');
  });

  it('shows exact status counts and immutable export history', () => {
    const review = ready([
      proposal(1),
      proposal(2, 'accepted'),
      proposal(3, 'accepted'),
      proposal(4, 'dismissed'),
      proposal(5, 'exported'),
    ]);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    act(() => root.render(createElement(NegativeProposalReview, props(review, PROFILE, 'owner', [{
      id: '99999999-9999-4999-8999-999999999999',
      rowCount: 2,
      createdAt: '2026-09-01T00:00:00.000Z',
      note: 'Synthetic immutable evidence.',
    }]))));

    const statusButtons = [...host.querySelectorAll<HTMLElement>('[data-testid="negative-review-counts"] button')];
    expect(statusButtons.map((button) => button.textContent)).toEqual([
      'Needs review1',
      'Ready to export2',
      'Dismissed1',
      'Exported1',
    ]);
    expect(host.textContent).toContain('Recent immutable evidence exports');
    expect(host.textContent).toContain('2 rows · Synthetic immutable evidence.');
  });
});
