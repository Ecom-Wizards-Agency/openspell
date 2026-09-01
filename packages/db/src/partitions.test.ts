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
const BOUNDARY_USER = '55555555-5555-4555-8555-555555555555';
const LOOKBACK_USER = '66666666-6666-4666-8666-666666666666';

/** First of the month, `offset` months from now, as YYYY-MM-DD. */
function monthStart(offset: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1))
    .toISOString()
    .slice(0, 10);
}

function futureCrossMonthSundayBoundary(): {
  date: string;
  month: string;
  weekStart: string;
  weekMonth: string;
} {
  const now = new Date();
  for (let offset = 18; offset < 30; offset += 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    if (date.getUTCDay() === 0) continue;

    const weekStart = new Date(date);
    weekStart.setUTCDate(date.getUTCDate() - date.getUTCDay());
    return {
      date: date.toISOString().slice(0, 10),
      month: date.toISOString().slice(0, 8) + '01',
      weekStart: weekStart.toISOString().slice(0, 10),
      weekMonth: weekStart.toISOString().slice(0, 8) + '01',
    };
  }
  throw new Error('Could not find a future cross-month Sunday boundary');
}

function futureSundayMonthStart(): {
  date: string;
  month: string;
  previousDate: string;
  previousMonth: string;
} {
  const now = new Date();
  // Keep this range disjoint from futureCrossMonthSundayBoundary(), whose
  // fixture also creates the month immediately before its selected month.
  for (let offset = 42; offset < 72; offset += 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    if (date.getUTCDay() !== 0) continue;

    const previousDate = new Date(date);
    previousDate.setUTCDate(0);
    return {
      date: date.toISOString().slice(0, 10),
      month: date.toISOString().slice(0, 8) + '01',
      previousDate: previousDate.toISOString().slice(0, 10),
      previousMonth: previousDate.toISOString().slice(0, 8) + '01',
    };
  }
  throw new Error('Could not find a future Sunday month start');
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

  it('opens the preceding month when a fixture week crosses a month boundary', async () => {
    const boundary = futureCrossMonthSundayBoundary();
    const before = await listFactPartitions(database);
    expect(before.some((row) => row.month === boundary.month)).toBe(false);
    expect(before.some((row) => row.month === boundary.weekMonth)).toBe(false);

    const [boundaryOrg] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture(
        'parts-boundary',
        ${BOUNDARY_USER},
        'owner',
        ${boundary.date}::date
      )
    `;
    const boundaryOrgId = boundaryOrg?.seed_tenant_fixture ?? '';

    const sqpRows = await database.sql<{ weekStart: string }[]>`
      select week_start::text as "weekStart"
        from public.fact_sqp_weekly
       where org_id = ${boundaryOrgId}
    `;
    const salesRows = await database.sql<{ date: string }[]>`
      select date::text as date
        from public.fact_sales_traffic_daily
       where org_id = ${boundaryOrgId}
    `;

    expect(boundaryOrgId).not.toBe('');
    expect(sqpRows).toEqual([{ weekStart: boundary.weekStart }]);
    expect(salesRows).toEqual([{ date: boundary.date }]);

    const partitions = await listFactPartitions(database);
    expect(
      partitions.some(
        (row) => row.tableName === 'fact_sqp_weekly' && row.month === boundary.weekMonth,
      ),
    ).toBe(true);
    expect(
      partitions.some(
        (row) => row.tableName === 'fact_sales_traffic_daily' && row.month === boundary.month,
      ),
    ).toBe(true);
  });

  it('opens the preceding month for fixture lookbacks when the month starts Sunday', async () => {
    const boundary = futureSundayMonthStart();
    const before = await listFactPartitions(database);
    expect(before.some((row) => row.month === boundary.month)).toBe(false);
    expect(before.some((row) => row.month === boundary.previousMonth)).toBe(false);

    const [boundaryOrg] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture(
        'parts-lookback-boundary',
        ${LOOKBACK_USER},
        'owner',
        ${boundary.date}::date
      )
    `;
    const boundaryOrgId = boundaryOrg?.seed_tenant_fixture ?? '';
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${boundaryOrgId} limit 1
    `;
    const inserted = await database.sql<{ date: string }[]>`
      insert into public.fact_profile_daily
        (org_id, profile_id, date, currency_code, impressions, clicks, cost,
         purchases_7d, sales_7d, units_sold_7d, provisional)
      values (${boundaryOrgId}, ${profile?.id ?? ''}, ${boundary.previousDate}::date,
              'USD', 1, 1, 1, 0, 0, 0, false)
      returning date::text as date
    `;

    expect(boundaryOrgId).not.toBe('');
    expect(inserted).toEqual([{ date: boundary.previousDate }]);

    const partitions = await listFactPartitions(database);
    expect(
      partitions.some(
        (row) => row.tableName === 'fact_profile_daily' && row.month === boundary.previousMonth,
      ),
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
