/**
 * The crosscheck cannot verify itself against backfilled history.
 *
 * This is the one test that guards WP-18's central risk. The AdLabs history
 * backfill writes `fact_profile_daily` and the campaign dailies for periods the
 * Amazon Ads API can no longer serve, from AdLabs' own store. If the fact
 * readers pick those rows up, the crosscheck compares AdLabs against AdLabs,
 * finds perfect agreement, and reports `verified` — a green verdict that
 * carries no information at all. A silent failure that looks like success is
 * the one bug this tool exists to not have.
 *
 * The assertion is therefore stated in the negative and at the verdict level,
 * not at the SQL level: with an AdLabs-sourced fact row in the table and an
 * AdLabs export naming the same figures for the same day, the verdict must not
 * be `verified`. It must be `missing_ours`, because that is the truth — we hold
 * no independently-sourced figure for that day.
 *
 * The same run then swaps the ledger row's source to `amazon_api` and re-checks
 * the same day, which proves the exclusion is doing the work rather than some
 * unrelated property of the fixture making every day fail.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureFactPartitions } from '@wizard-ads/db';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import { runCrosscheckIngest } from './job.js';
import { readOurCampaignTotals, readOurProfileDays } from './facts.js';
import { exportFileName } from './fixtures.js';

const available = await databaseAvailable();
const DEV_USER = '00000000-0000-4000-8000-0000000c1002';
const PROFILE = '9900000042';
/** A completed day well inside the fixture month, so nothing is provisional. */
const DAY = '2026-08-03';
const SPEND = 123.45;
const SALES = 678.9;

describe.skipIf(!available)('backfilled facts are invisible to the crosscheck', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  let reportRequestId: string;
  let inbox: string;

  beforeAll(async () => {
    database = await createTestDatabase('backfill_isolation');
    ({ orgId, profileId } = await seedProfile(database));
    reportRequestId = await seedBackfilledDay(database, orgId, profileId);
    inbox = await stageExport();
  }, 120_000);

  afterAll(async () => {
    if (database) await database.drop();
    if (inbox) await rm(inbox, { recursive: true, force: true });
  });

  it('the row is really in the table, so the test is not passing vacuously', async () => {
    const rows = await database.sql<{ cost: string }[]>`
      select cost from public.fact_profile_daily
      where profile_id = ${profileId} and date = ${DAY}
    `;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.cost)).toBe(SPEND);
  });

  it('does not read a backfilled profile-day', async () => {
    expect(await readOurProfileDays(database, profileId, DAY, DAY)).toEqual([]);
  });

  it('does not read a backfilled campaign-day', async () => {
    expect(await readOurCampaignTotals(database, profileId, DAY, DAY)).toEqual([]);
  });

  it('returns missing_ours rather than verified when only backfilled rows exist', async () => {
    const result = await runCrosscheckIngest(database, {
      type: 'crosscheck.ingest',
      orgId,
      profileId,
      date: '2026-08-04',
      sourcePath: inbox,
    });

    expect(result.summary.profileDaysCompared).toBe(1);
    expect(result.summary.headline).toBe('missing_ours');
    expect(result.findings.every((finding) => finding.verdict !== 'verified')).toBe(true);
  });

  it('reads the very same row once its ledger row says amazon_api', async () => {
    await database.sql`
      update public.report_requests set source = 'amazon_api' where id = ${reportRequestId}
    `;
    try {
      const days = await readOurProfileDays(database, profileId, DAY, DAY);
      expect(days).toEqual([{ date: DAY, adSpend: SPEND, adSales: SALES, provisional: false }]);

      const result = await runCrosscheckIngest(database, {
        type: 'crosscheck.ingest',
        orgId,
        profileId,
        date: '2026-08-04',
        sourcePath: inbox,
      });
      expect(result.summary.headline).toBe('verified');
    } finally {
      await database.sql`
        update public.report_requests set source = 'adlabs_backfill' where id = ${reportRequestId}
      `;
    }
  });

  it('refuses a source label nobody has defined', async () => {
    await expect(
      database.sql`
        update public.report_requests set source = 'guesswork' where id = ${reportRequestId}
      `,
    ).rejects.toThrow(/report_requests_source_known/);
  });
});

async function seedProfile(
  database: TestDatabase,
): Promise<{ orgId: string; profileId: string }> {
  await database.sql`select public.auth_user_stub(${DEV_USER}::uuid)`;
  const orgs = await database.sql<{ id: string }[]>`
    insert into public.orgs (slug, name) values ('backfill-isolation', 'backfill isolation fixture')
    returning id
  `;
  const orgId = orgs[0]?.id as string;
  await database.sql`
    insert into public.org_members (org_id, user_id, role) values (${orgId}, ${DEV_USER}, 'owner')
  `;
  const profiles = await database.sql<{ id: string }[]>`
    insert into public.ad_profiles
      (org_id, amazon_profile_id, region, country_code, currency_code, timezone, sync_enabled, account_name)
    values (${orgId}, ${PROFILE}, 'NA', 'US', 'USD', 'America/Los_Angeles', true, 'Isolation fixture')
    returning id
  `;
  return { orgId, profileId: profiles[0]?.id as string };
}

/** One day of facts, at both grains, pointing at an `adlabs_backfill` ledger row. */
async function seedBackfilledDay(
  database: TestDatabase,
  orgId: string,
  profileId: string,
): Promise<string> {
  await ensureFactPartitions(database, '2026-08-01', 1);

  const requests = await database.sql<{ id: string }[]>`
    insert into public.report_requests
      (org_id, profile_id, report_type, start_date, end_date, status, source,
       amazon_report_id, rows_parsed, rows_loaded)
    values (${orgId}, ${profileId}, 'spCampaigns', ${DAY}, ${DAY}, 'completed', 'adlabs_backfill',
            'adlabs:00000000-0000-4000-8000-000000000042', 1, 1)
    returning id
  `;
  const reportRequestId = requests[0]?.id as string;

  await database.sql`
    insert into public.fact_profile_daily
      (org_id, profile_id, date, currency_code, impressions, clicks, cost, purchases_7d,
       sales_7d, units_sold_7d, provisional, report_request_id)
    values (${orgId}, ${profileId}, ${DAY}, 'USD', 5000, 200, ${SPEND}, 9, ${SALES}, 9, false,
            ${reportRequestId})
  `;
  await database.sql`
    insert into public.fact_sp_target_daily
      (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, target_id, target_kind,
       match_type, impressions, clicks, cost, purchases_7d, sales_7d, units_sold_7d,
       report_request_id)
    values (${orgId}, ${profileId}, ${DAY}, 'SP', 'cmp-4201', 'agp-4201', 'tgt-4201', 'keyword',
            'exact', 5000, 200, ${SPEND}, 9, ${SALES}, 9, ${reportRequestId})
  `;

  return reportRequestId;
}

/**
 * An AdLabs export naming exactly the figures the backfilled row holds. If the
 * reader leaked, this would agree with itself perfectly.
 */
async function stageExport(): Promise<string> {
  const path = join(tmpdir(), `wizard-ads-backfill-isolation-${Date.now()}`);
  await mkdir(path, { recursive: true });
  const name = exportFileName('profile', PROFILE, DAY, DAY);
  await writeFile(
    join(path, name),
    ['date,profile_id,spend,sales', `${DAY},${PROFILE},${SPEND},${SALES}`, ''].join('\n'),
    'utf8',
  );
  return path;
}
