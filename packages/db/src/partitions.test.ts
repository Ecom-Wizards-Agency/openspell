/**
 * Partition automation.
 *
 * Two acceptance checks live here. Inserting a fact for next month works after
 * the pre-create run (and fails before it, which is the deliberate half nobody
 * usually tests). And the retention pass drops only what is expired, after
 * rolling its numbers into the monthly table.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dropExpiredFactPartitions,
  ensureFactPartitions,
  listFactPartitions,
} from './queries/partitions.js';
import { upsertSpTargetFacts } from './queries/facts.js';
import { expectRejection } from './testing/errors.js';
import { createTestDatabase, databaseAvailable } from './testing/harness.js';
import type { TestDatabase } from './testing/harness.js';

const available = await databaseAvailable();
const USER = '44444444-4444-4444-8444-444444444444';

/** First of the month, `offset` months from now, as YYYY-MM-DD. */
function monthStart(offset: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1))
    .toISOString()
    .slice(0, 10);
}

describe.skipIf(!available)('partition automation', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;

  beforeAll(async () => {
    database = await createTestDatabase('partitions');
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('parts', ${USER}, 'owner')
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

  const fact = (date: string) => ({
    orgId,
    profileId,
    date,
    adProduct: 'SP' as const,
    campaignId: 'c-1',
    adGroupId: 'ag-1',
    targetId: 'kw-1',
    targetKind: 'keyword' as const,
    impressions: 10,
    clicks: 1,
    cost: 0.5,
    purchases7d: 0,
    sales7d: 0,
    unitsSold7d: 0,
  });

  it('refuses a fact for a month nobody created', async () => {
    // Twelve months out is beyond any pre-create run, and there is no default
    // partition to swallow it. Failing here is the design working.
    await expectRejection(
      upsertSpTargetFacts(database, [fact(monthStart(12))]),
      /no partition of relation/i,
    );
  });

  it('accepts that fact once the partition is pre-created', async () => {
    const created = await ensureFactPartitions(database, monthStart(12), 0);
    expect(created.some((row) => row.tableName === 'fact_sp_target_daily' && row.created)).toBe(
      true,
    );

    const counts = await upsertSpTargetFacts(database, [fact(monthStart(12))]);
    expect(counts).toEqual({ offered: 1, written: 1 });
  });

  it('is idempotent: a second run creates nothing', async () => {
    const again = await ensureFactPartitions(database, monthStart(12), 0);
    expect(again.every((row) => !row.created)).toBe(true);
  });

  it('pre-creates next month for every managed fact table', async () => {
    const actions = await ensureFactPartitions(database, new Date(), 1);
    const tables = new Set(actions.map((row) => row.tableName));
    for (const table of [
      'fact_sp_target_daily',
      'fact_search_term_daily',
      'fact_placement_daily',
      'fact_sb_daily',
      'fact_sd_daily',
      'fact_profile_daily',
      'fact_sales_traffic_daily',
      'fact_sqp_weekly',
      'fact_creative_daily',
    ]) {
      expect(tables).toContain(table);
    }

    const partitions = await listFactPartitions(database);
    const nextMonth = monthStart(1);
    expect(
      partitions.some((row) => row.tableName === 'fact_sp_target_daily' && row.month === nextMonth),
    ).toBe(true);
  });

  describe('retention', () => {
    it('reports what it would drop without dropping it', async () => {
      // 27 months back is outside the 26-month window for target facts and
      // outside the 13-month window for search terms.
      const old = monthStart(-27);
      await ensureFactPartitions(database, old, 0);
      await upsertSpTargetFacts(database, [fact(old)]);

      const planned = await dropExpiredFactPartitions(database, new Date(), true);
      expect(planned.some((row) => row.month === old)).toBe(true);
      expect(planned.every((row) => !row.dropped)).toBe(true);

      const still = await listFactPartitions(database);
      expect(still.some((row) => row.month === old)).toBe(true);
    });

    it('rolls the numbers up, then drops only the expired partitions', async () => {
      const old = monthStart(-27);
      const kept = monthStart(-12);
      await ensureFactPartitions(database, kept, 0);
      await upsertSpTargetFacts(database, [fact(kept)]);

      const dropped = await dropExpiredFactPartitions(database, new Date(), false);
      const droppedMonths = new Set(dropped.map((row) => row.month));
      expect(droppedMonths.has(old)).toBe(true);
      expect(droppedMonths.has(kept)).toBe(false);

      const partitions = await listFactPartitions(database);
      expect(partitions.some((row) => row.month === old)).toBe(false);
      expect(
        partitions.some((row) => row.tableName === 'fact_sp_target_daily' && row.month === kept),
      ).toBe(true);

      // The dropped month survives as an aggregate, which is the whole point of
      // rolling up before dropping.
      const [rollup] = await database.sql<{ impressions: string; clicks: string; days: number }[]>`
        select impressions, clicks, days from public.fact_monthly_rollup
        where profile_id = ${profileId} and month = ${old} and source = 'sp_target'
      `;
      expect(Number(rollup?.impressions)).toBe(10);
      expect(Number(rollup?.clicks)).toBe(1);
      expect(rollup?.days).toBe(1);
    });

    it('applies the shorter window to search terms', async () => {
      // 14 months back is inside 26 (targets stay) and outside 13 (terms go).
      const month = monthStart(-14);
      await ensureFactPartitions(database, month, 0);

      const planned = await dropExpiredFactPartitions(database, new Date(), true);
      const forMonth = planned.filter((row) => row.month === month).map((row) => row.tableName);
      expect(forMonth).toContain('fact_search_term_daily');
      expect(forMonth).not.toContain('fact_sp_target_daily');
    });
  });
});
