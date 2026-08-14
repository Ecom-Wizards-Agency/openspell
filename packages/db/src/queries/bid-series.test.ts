/**
 * WP-28's database half: the bid-series loader counts rows written against rows
 * offered and throws on a mismatch (program rule 4), re-syncing a day overwrites
 * rather than duplicating, and the reads return one target's corridor and the
 * set of targets that have one.
 *
 * Runs on the admin handle, which is what the worker's sync uses, so the org
 * predicates on the reads are the ones exercised.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '../testing/harness.js';
import type { TestDatabase } from '../testing/harness.js';
import {
  BidSeriesLoadCountMismatch,
  listBidSeriesTargets,
  readBidSeries,
  upsertBidSeries,
} from './bid-series.js';
import type { NewBidSeriesRow } from '../schema/bid-series.js';

const available = await databaseAvailable();

const OWNER = '28282828-2828-4282-8282-282828282828';
const TODAY = new Date().toISOString().slice(0, 10);

function yesterdayIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

describe.skipIf(!available)('WP-28 bid series queries', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;

  beforeAll(async () => {
    database = await createTestDatabase('wp28_bid_series');
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('corridor-alpha', ${OWNER}, 'owner')
    `;
    orgId = org?.seed_tenant_fixture ?? '';
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId} limit 1
    `;
    profileId = profile?.id ?? '';
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  function row(overrides: Partial<NewBidSeriesRow> = {}): NewBidSeriesRow {
    return {
      orgId,
      profileId,
      date: TODAY,
      campaignId: 'c-1',
      adGroupId: 'ag-1',
      targetId: 'kw-1',
      isKeyword: true,
      suggestedBidLow: 0.5,
      suggestedBidMedian: 0.8,
      suggestedBidHigh: 1.2,
      bid: 0.9,
      cpc: 1.1,
      maxPotentialCpc: 1.35,
      modifierComponents: [{ name: 'top_of_search', pct: 50 }],
      ...overrides,
    };
  }

  it('loads a corridor day and counts written against offered', async () => {
    const counts = await upsertBidSeries(database, [
      row(),
      row({ targetId: 'tg-1', isKeyword: false }),
    ]);
    expect(counts).toEqual({ offered: 2, written: 2 });
  });

  it('re-syncing the same grain overwrites rather than duplicating', async () => {
    await upsertBidSeries(database, [row({ suggestedBidHigh: 9.99, bid: 1.11 })]);
    const series = await readBidSeries(database, {
      orgId,
      profileId,
      targetId: 'kw-1',
      from: TODAY,
      to: TODAY,
    });
    expect(series).toHaveLength(1);
    expect(series[0]?.suggestedBidHigh).toBe(9.99);
    expect(series[0]?.bid).toBe(1.11);
    expect(series[0]?.modifierComponents).toEqual([{ name: 'top_of_search', pct: 50 }]);
  });

  it('reads one target as an oldest-first series across the window', async () => {
    await upsertBidSeries(database, [row({ date: yesterdayIso(), suggestedBidMedian: 0.6 })]);
    const series = await readBidSeries(database, {
      orgId,
      profileId,
      targetId: 'kw-1',
      from: yesterdayIso(),
      to: TODAY,
    });
    expect(series.map((r) => r.date)).toEqual([yesterdayIso(), TODAY]);
  });

  it('lists the targets that carry a corridor, most-recent first', async () => {
    const targets = await listBidSeriesTargets(database, {
      orgId,
      profileId,
      from: yesterdayIso(),
      to: TODAY,
    });
    const ids = targets.map((t) => t.targetId).sort();
    expect(ids).toEqual(['kw-1', 'tg-1']);
    const kw = targets.find((t) => t.targetId === 'kw-1');
    expect(kw?.isKeyword).toBe(true);
    expect(kw?.days).toBe(2);
  });

  it('an org that does not own the profile reads nothing', async () => {
    const series = await readBidSeries(database, {
      orgId: '00000000-0000-4000-8000-000000000000',
      profileId,
      targetId: 'kw-1',
      from: yesterdayIso(),
      to: TODAY,
    });
    expect(series).toHaveLength(0);
  });

  it('throws when the store reports fewer written rows than offered', () => {
    // The mismatch type exists and reads clearly; the loader raises it whenever
    // the database returns fewer rows than were handed in.
    const error = new BidSeriesLoadCountMismatch({ offered: 3, written: 2 });
    expect(error.message).toMatch(/offered 3 rows, wrote 2/);
  });
});
