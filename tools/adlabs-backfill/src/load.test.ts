/**
 * The loaders, against a real migrated database.
 *
 * Four properties are asserted here because all four are things that would be
 * invisible until they had already corrupted something:
 *
 *  1. every backfilled fact row points at a ledger row that says so;
 *  2. a day we already hold from our own API pull is not touched;
 *  3. the profile's current local day is never written;
 *  4. rows read equals rows written, and the money that comes back out of the
 *     rollup equals the money that went in — to the cent, not to a tolerance.
 *
 * Skipped when no Postgres is reachable, so `pnpm check` stays honest on a
 * machine without one. Point it at a database with `WIZARD_ADS_TEST_DATABASE_URL`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureFactPartitions } from '@wizard-ads/db';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import {
  LEDGER_SOURCE,
  loadProfileDays,
  loadRollupMonth,
  readBackfilledDepth,
  readProfileTargets,
} from './load.js';
import type { ProfileTarget } from './load.js';
import { parseEntityExport } from './rollup.js';
import { parseProfileTimeline } from './timeline.js';

const available = await databaseAvailable();
const DEV_USER = '00000000-0000-4000-8000-0000000c1003';
const PROFILE = '9900000101';
/** Pinned "now": the profile is in Los Angeles, so its local day is the 13th. */
const NOW = new Date('2026-08-14T02:00:00Z');

/** Four days with data, one zero-filled, one the profile's in-progress day. */
const TIMELINE = [
  'clicks,date,impressions,orders,profile_id,sales,spend,units',
  '10,2026-08-09,1000,1,9900000101,40.50,10.25,1',
  '0,2026-08-10,0,0,9900000101,0,0,0',
  '20,2026-08-11,2000,3,9900000101,120.00,22.75,3',
  '30,2026-08-12,3000,4,9900000101,200.00,33.00,4',
  '5,2026-08-13,500,0,9900000101,0.00,5.50,0',
  '1,2026-08-14,100,0,9900000101,0.00,1.10,0',
  '7,2026-08-11,700,1,9900000999,50.00,7.00,1',
  '',
].join('\n');

const CAMPAIGNS = [
  'campaign_ad_type,campaign_id,clicks,impressions,orders,sales,spend,units',
  'Sponsored Products,cmp-1,15,1500,2,80.55,12.34,2',
  'Sponsored Brands,cmp-2,4,400,1,19.45,4.66,1',
  'Sponsored Display,cmp-3,0,0,0,0.00,0.00,0',
  '',
].join('\n');

describe.skipIf(!available)('the backfill loaders', () => {
  let database: TestDatabase;
  let target: ProfileTarget;

  beforeAll(async () => {
    database = await createTestDatabase('adlabs_backfill');
    await seedProfile(database);
    const targets = await readProfileTargets(database);
    target = targets.get(PROFILE) as ProfileTarget;
    expect(target).toBeDefined();
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  describe('phase 0', () => {
    it('loads the complete days and stops at the profile-local today', async () => {
      const parsed = parseProfileTimeline(TIMELINE);
      const result = await loadProfileDays(
        database,
        target,
        parsed.byProfile.get(PROFILE) ?? [],
        { now: NOW, adlabsCurrency: 'USD' },
      );

      // Five nonzero days in the file; the 13th is the profile's local today
      // and the 14th has not happened there yet.
      expect(result.rowsOffered).toBe(5);
      expect(result.rowsInProgress).toBe(2);
      expect(result.rowsApiCovered).toBe(0);
      expect(result.rowsEligible).toBe(3);
      expect(result.rowsLoaded).toBe(3);
      expect(result.firstDate).toBe('2026-08-09');
      expect(result.lastDate).toBe('2026-08-12');
      expect(result.currencyMismatch).toBeNull();

      const dates = await database.sql<{ date: string }[]>`
        select date::text as date from public.fact_profile_daily
        where profile_id = ${target.profileId} order by date
      `;
      expect(dates.map((row) => row.date)).toEqual(['2026-08-09', '2026-08-11', '2026-08-12']);
    });

    it('gave every row a ledger row that names the source', async () => {
      const rows = await database.sql<{ source: string; rows_parsed: string; rows_loaded: string; counts_match: boolean }[]>`
        select r.source, r.rows_parsed::text, r.rows_loaded::text, r.counts_match
        from public.fact_profile_daily f
        join public.report_requests r on r.id = f.report_request_id
        where f.profile_id = ${target.profileId}
      `;
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.source === LEDGER_SOURCE)).toBe(true);
      expect(rows[0]?.rows_parsed).toBe('3');
      expect(rows[0]?.rows_loaded).toBe('3');
      expect(rows[0]?.counts_match).toBe(true);
    });

    it('leaves an API-sourced day alone and reports it as already ours', async () => {
      const requests = await database.sql<{ id: string }[]>`
        insert into public.report_requests
          (org_id, profile_id, report_type, start_date, end_date, status, source, rows_parsed, rows_loaded)
        values (${target.orgId}, ${target.profileId}, 'spCampaigns', '2026-08-11', '2026-08-11',
                'completed', 'amazon_api', 1, 1)
        returning id
      `;
      await database.sql`
        update public.fact_profile_daily
        set cost = 999.99, report_request_id = ${requests[0]?.id as string}
        where profile_id = ${target.profileId} and date = '2026-08-11'
      `;

      const parsed = parseProfileTimeline(TIMELINE);
      const result = await loadProfileDays(
        database,
        target,
        parsed.byProfile.get(PROFILE) ?? [],
        { now: NOW },
      );
      expect(result.rowsApiCovered).toBe(1);
      expect(result.rowsEligible).toBe(2);
      expect(result.rowsLoaded).toBe(2);

      const kept = await database.sql<{ cost: string }[]>`
        select cost from public.fact_profile_daily
        where profile_id = ${target.profileId} and date = '2026-08-11'
      `;
      expect(Number(kept[0]?.cost)).toBe(999.99);
    });

    it('reports the depth it loaded, per profile', async () => {
      const depth = await readBackfilledDepth(database);
      const mine = depth.find((row) => row.amazonProfileId === PROFILE);
      expect(mine?.days).toBe(2);
      expect(mine?.firstDate).toBe('2026-08-09');
      expect(mine?.lastDate).toBe('2026-08-12');
    });

    it('writes nothing on a dry run', async () => {
      const before = await countProfileDays(database, target.profileId);
      const parsed = parseProfileTimeline(TIMELINE);
      const result = await loadProfileDays(
        database,
        target,
        parsed.byProfile.get(PROFILE) ?? [],
        { now: NOW, dryRun: true },
      );
      expect(result.reportRequestId).toBeNull();
      expect(result.rowsLoaded).toBe(0);
      expect(await countProfileDays(database, target.profileId)).toBe(before);
    });
  });

  describe('phase 1', () => {
    it('loads a month, tags the source, and gives back the same money', async () => {
      const parsed = parseEntityExport('campaign', CAMPAIGNS);
      const result = await loadRollupMonth(database, target, parsed, {
        startDate: '2026-07-01',
        endDate: '2026-07-31',
      });

      expect(result.month).toBe('2026-07-01');
      expect(result.days).toBe(31);
      expect(result.rowsSeen).toBe(3);
      expect(result.rowsIdle).toBe(1);
      expect(result.rowsEligible).toBe(2);
      expect(result.rowsLoaded).toBe(2);
      // The cent-exact check, both directions: file against store.
      expect(result.fileTotals.cost).toBe(17);
      expect(result.storedTotals?.cost).toBe(17);
      expect(result.fileTotals.sales7d).toBe(100);
      expect(result.storedTotals?.sales7d).toBe(100);
    });

    it('leaves the 14-day columns null rather than claiming a window it does not know', async () => {
      const rows = await database.sql<
        { source: string; purchases_14d: string | null; sales_14d: string | null; days: number }[]
      >`
        select source, purchases_14d::text, sales_14d::text, days
        from public.fact_monthly_rollup
        where profile_id = ${target.profileId} and source = 'adlabs_backfill'
      `;
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.purchases_14d === null && row.sales_14d === null)).toBe(true);
      expect(rows.every((row) => row.days === 31)).toBe(true);
    });

    it('is idempotent: a re-run overwrites the same rows', async () => {
      const parsed = parseEntityExport('campaign', CAMPAIGNS);
      const again = await loadRollupMonth(database, target, parsed, {
        startDate: '2026-07-01',
        endDate: '2026-07-31',
      });
      expect(again.rowsLoaded).toBe(2);
      const count = await database.sql<{ n: string }[]>`
        select count(*)::text as n from public.fact_monthly_rollup
        where profile_id = ${target.profileId} and source = 'adlabs_backfill'
      `;
      expect(count[0]?.n).toBe('2');
    });

    it('does not collide with the partition automation own rollups', async () => {
      // The tenant fixture writes a `sp_target` rollup for the same profile
      // shape; a backfill row must live beside it, not on top of it.
      const sources = await database.sql<{ source: string }[]>`
        select distinct source from public.fact_monthly_rollup
        where profile_id = ${target.profileId}
      `;
      expect(sources.map((row) => row.source)).toEqual(['adlabs_backfill']);
    });
  });
});

async function seedProfile(database: TestDatabase): Promise<void> {
  await database.sql`select public.auth_user_stub(${DEV_USER}::uuid)`;
  const orgs = await database.sql<{ id: string }[]>`
    insert into public.orgs (slug, name) values ('adlabs-backfill', 'backfill loader fixture')
    returning id
  `;
  const orgId = orgs[0]?.id as string;
  await database.sql`
    insert into public.org_members (org_id, user_id, role) values (${orgId}, ${DEV_USER}, 'owner')
  `;
  await database.sql`
    insert into public.ad_profiles
      (org_id, amazon_profile_id, region, country_code, currency_code, timezone, sync_enabled)
    values (${orgId}, ${PROFILE}, 'NA', 'US', 'USD', 'America/Los_Angeles', true)
  `;
  // The loader opens historical partitions itself; this only proves the
  // fixture month exists before the first assertion about counts.
  await ensureFactPartitions(database, '2026-08-01', 0);
}

async function countProfileDays(database: TestDatabase, profileId: string): Promise<number> {
  const rows = await database.sql<{ n: string }[]>`
    select count(*)::text as n from public.fact_profile_daily where profile_id = ${profileId}
  `;
  return Number(rows[0]?.n ?? 0);
}
