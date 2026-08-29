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
  connectionId: '99999999-9999-4999-8999-999999999999',
  amazonProfileId: 'amazon-profile-9',
  region: 'NA',
  currencyCode: 'USD',
  timezone: 'America/Los_Angeles',
};

class FakeStore implements BidSeriesStore {
  written: NewBidSeriesRow[] = [];
  /** Profile ids whose corridor is already written for the day. */
  alreadySynced = new Set<string>();
  /** Profile ids whose target read throws, to prove per-profile isolation. */
  failing = new Set<string>();
  readCalls: string[] = [];
  constructor(
    private readonly profiles: AdsProfileContext[],
    private readonly targets: BidSeriesTargetInput[],
    private readonly writeCount?: (rows: readonly NewBidSeriesRow[]) => number,
  ) {}
  async listSyncEnabledProfiles(): Promise<AdsProfileContext[]> { return this.profiles; }
  async listBidSeriesTargets(profile: AdsProfileContext): Promise<BidSeriesTargetInput[]> {
    this.readCalls.push(profile.id);
    if (this.failing.has(profile.id)) throw new Error(`${profile.id} exploded`);
    return this.targets;
  }
  async upsertBidSeries(rows: readonly NewBidSeriesRow[]): Promise<number> {
    this.written.push(...rows);
    return this.writeCount ? this.writeCount(rows) : rows.length;
  }
  async hasSeriesForDate(profile: AdsProfileContext): Promise<boolean> {
    return this.alreadySynced.has(profile.id);
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
  const SECOND: AdsProfileContext = { ...PROFILE, id: 'other' };

  it('sums the corridor across every sync-enabled profile', async () => {
    const store = new FakeStore([PROFILE, SECOND], [kw()]);
    const client = fakeClient({ 'kw-1': { low: 0.5, median: 0.8, high: 1.2 } });
    const counts = await runBidSeriesSync({ store, client });
    expect(counts).toEqual({ profiles: 2, targets: 2, corridors: 2, written: 2, skipped: 0, failed: 0, unvisited: 0 });
  });

  it('skips a profile that already carries the day, without an Amazon call', async () => {
    const store = new FakeStore([PROFILE, SECOND], [kw()]);
    store.alreadySynced.add(PROFILE.id);
    const client = fakeClient({ 'kw-1': { low: 0.5, median: 0.8, high: 1.2 } });

    const counts = await runBidSeriesSync({ store, client });

    expect(counts).toEqual({ profiles: 1, targets: 1, corridors: 1, written: 1, skipped: 1, failed: 0, unvisited: 0 });
    // The gated profile was never even read, let alone asked about.
    expect(store.readCalls).toEqual([SECOND.id]);
    expect(client.getSpSuggestedBids).toHaveBeenCalledTimes(1);
  });

  it('keeps syncing after one profile throws, and reports the failure', async () => {
    const store = new FakeStore([PROFILE, SECOND], [kw()]);
    store.failing.add(PROFILE.id);
    const client = fakeClient({ 'kw-1': { low: 0.5, median: 0.8, high: 1.2 } });
    const errors: string[] = [];

    const counts = await runBidSeriesSync({
      store,
      client,
      logger: { info: () => {}, error: (message) => errors.push(message) },
    });

    // The profile after the throwing one still got its day.
    expect(counts).toMatchObject({ profiles: 1, written: 1, failed: 1, skipped: 0 });
    expect(store.readCalls).toEqual([PROFILE.id, SECOND.id]);
    expect(errors).toHaveLength(1);
  });

  it('stops between profiles when the tick\'s budget is gone', async () => {
    const store = new FakeStore([PROFILE, SECOND], [kw()]);
    const client = fakeClient({ 'kw-1': { low: 0.5, median: 0.8, high: 1.2 } });

    // A deadline already in the past: the pass is called, reaches nobody, and
    // says so rather than starting a request the platform would cut off.
    const counts = await runBidSeriesSync({ store, client, deadlineMs: Date.now() - 1 });

    expect(counts).toMatchObject({ profiles: 0, written: 0, unvisited: 2 });
    expect(store.readCalls).toEqual([]);
    expect(client.getSpSuggestedBids).not.toHaveBeenCalled();
  });

  it('fails the pass only when every profile failed', async () => {
    const store = new FakeStore([PROFILE, SECOND], [kw()]);
    store.failing.add(PROFILE.id);
    store.failing.add(SECOND.id);
    const client = fakeClient({});
    await expect(
      runBidSeriesSync({ store, client, logger: { info: () => {}, error: () => {} } }),
    ).rejects.toThrow(/exploded/);
  });
});
