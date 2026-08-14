/**
 * WP-28 bid-corridor sync orchestration.
 *
 * Driven entirely through a fake store and a fake suggested-bid client — no
 * database, no HTTP. It proves the three things the pass is responsible for:
 * a corridor is written per target, the max-potential CPC is composed from the
 * bid and its placement modifiers (WP-26), and rows composed are counted against
 * rows written so a store that drops one fails the pass (program rule 4).
 */
import { describe, expect, it, vi } from 'vitest';
import type { NewBidSeriesRow } from '@wizard-ads/db';
import type { AdsProfileContext, SuggestedBidRequest, SuggestedBidResult } from './ads-api.js';
import {
  profileToday,
  runBidSeriesSync,
  syncBidSeriesForProfile,
  type BidSeriesStore,
  type BidSeriesTargetInput,
} from './bid-series.js';
import { defaultRegionTokenBuckets } from './region-token-buckets.js';

const PROFILE: AdsProfileContext = {
  id: '22222222-2222-4222-8222-222222222222',
  orgId: '11111111-1111-4111-8111-111111111111',
  amazonProfileId: 'amazon-profile-9',
  region: 'NA',
  currencyCode: 'USD',
  timezone: 'America/Los_Angeles',
};

class FakeStore implements BidSeriesStore {
  written: NewBidSeriesRow[] = [];
  constructor(
    private readonly profiles: AdsProfileContext[],
    private readonly targets: BidSeriesTargetInput[],
    private readonly writeCount?: (rows: readonly NewBidSeriesRow[]) => number,
  ) {}
  async listSyncEnabledProfiles(): Promise<AdsProfileContext[]> { return this.profiles; }
  async listBidSeriesTargets(): Promise<BidSeriesTargetInput[]> { return this.targets; }
  async upsertBidSeries(rows: readonly NewBidSeriesRow[]): Promise<number> {
    this.written.push(...rows);
    return this.writeCount ? this.writeCount(rows) : rows.length;
  }
}

function fakeClient(byTarget: Record<string, { low: number; median: number; high: number }>) {
  return {
    getSpSuggestedBids: vi.fn(async (_p: AdsProfileContext, _ids: SuggestedBidRequest): Promise<SuggestedBidResult> => {
      const map = new Map(Object.entries(byTarget).map(([id, c]) => [id, { targetId: id, ...c }]));
      return { byTarget: map, submitted: map.size, returned: map.size, errors: 0 };
    }),
  };
}

const kw = (over: Partial<BidSeriesTargetInput> = {}): BidSeriesTargetInput => ({
  targetId: 'kw-1',
  isKeyword: true,
  campaignId: 'c-1',
  adGroupId: 'ag-1',
  bid: 1.0,
  cpc: 1.4,
  placementModifiers: [{ name: 'top_of_search', pct: 50 }],
  ...over,
});

describe('profileToday', () => {
  it('renders the profile-local calendar day as YYYY-MM-DD', () => {
    // Just past midnight UTC on the 2nd is still the 1st in Los Angeles.
    const at = new Date('2026-08-02T05:00:00Z');
    expect(profileToday('America/Los_Angeles', at)).toBe('2026-08-01');
    expect(profileToday('UTC', at)).toBe('2026-08-02');
  });

  it('falls back to the UTC day for a bad timezone', () => {
    expect(profileToday('Not/AZone', new Date('2026-08-02T05:00:00Z'))).toBe('2026-08-02');
  });
});

describe('syncBidSeriesForProfile', () => {
  it('writes a corridor per target and composes the max-potential CPC from the bid and modifiers', async () => {
    const store = new FakeStore([PROFILE], [kw(), kw({ targetId: 'tg-1', isKeyword: false, bid: 2.0, placementModifiers: [] })]);
    const client = fakeClient({ 'kw-1': { low: 0.5, median: 0.8, high: 1.2 }, 'tg-1': { low: 1, median: 1.5, high: 2 } });
    const result = await syncBidSeriesForProfile(PROFILE, { store, client, buckets: defaultRegionTokenBuckets });

    expect(result).toEqual({ targets: 2, corridors: 2, written: 2 });
    const keyword = store.written.find((r) => r.targetId === 'kw-1');
    expect(keyword?.suggestedBidMedian).toBe(0.8);
    // 1.0 base bid x (1 + 50/100) = 1.5.
    expect(keyword?.maxPotentialCpc).toBe(1.5);
    expect(keyword?.modifierComponents).toEqual([{ name: 'top_of_search', pct: 50 }]);
    // No modifiers: max-potential CPC is just the bid.
    const target = store.written.find((r) => r.targetId === 'tg-1');
    expect(target?.maxPotentialCpc).toBe(2.0);
  });

  it('leaves the corridor null for a target Amazon did not answer', async () => {
    const store = new FakeStore([PROFILE], [kw()]);
    const client = fakeClient({}); // no suggestions
    const result = await syncBidSeriesForProfile(PROFILE, { store, client });
    expect(result.corridors).toBe(0);
    expect(store.written[0]?.suggestedBidMedian).toBeNull();
    // The bid and realized CPC are still recorded even with no corridor.
    expect(store.written[0]?.bid).toBe(1.0);
    expect(store.written[0]?.cpc).toBe(1.4);
  });

  it('throws when the store writes fewer rows than composed (program rule 4)', async () => {
    const store = new FakeStore([PROFILE], [kw(), kw({ targetId: 'kw-2' })], () => 1);
    const client = fakeClient({ 'kw-1': { low: 0.5, median: 0.8, high: 1.2 } });
    await expect(syncBidSeriesForProfile(PROFILE, { store, client })).rejects.toThrow(/composed 2 rows but wrote 1/);
  });

  it('does nothing for a profile with no targets', async () => {
    const store = new FakeStore([PROFILE], []);
    const client = fakeClient({});
    const result = await syncBidSeriesForProfile(PROFILE, { store, client });
    expect(result).toEqual({ targets: 0, corridors: 0, written: 0 });
    expect(client.getSpSuggestedBids).not.toHaveBeenCalled();
  });
});

describe('runBidSeriesSync', () => {
  it('sums the corridor across every sync-enabled profile', async () => {
    const store = new FakeStore([PROFILE, { ...PROFILE, id: 'other' }], [kw()]);
    const client = fakeClient({ 'kw-1': { low: 0.5, median: 0.8, high: 1.2 } });
    const counts = await runBidSeriesSync({ store, client });
    expect(counts).toEqual({ profiles: 2, targets: 2, corridors: 2, written: 2 });
  });
});
