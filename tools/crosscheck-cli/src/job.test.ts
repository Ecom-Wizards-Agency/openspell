/**
 * The handler end to end, against a real migrated database.
 *
 * Skipped when no Postgres is reachable, so `pnpm check` stays honest on a
 * machine without one. Point it at a database with
 * `WIZARD_ADS_TEST_DATABASE_URL`.
 */
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureFactPartitions } from '@wizard-ads/db';
import type { DbHandle } from '@wizard-ads/db';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import { runCrosscheckIngest } from './job.js';
import { readResults } from './results.js';
import { buildPanelModel } from './panel.js';
import { loadCrosscheckPanel, listCrosscheckedProfiles } from './load.js';
import {
  applySpendingFlags,
  evaluateExitCriterion,
  historiesFromResults,
  spendingCampaignWeeks,
} from './exit-report.js';
import {
  CLEAN_CAMPAIGN_EXPORT,
  CLEAN_PROFILE_EXPORT,
  CORRUPTED_CAMPAIGN,
  CORRUPTED_DIR,
  FIXTURE_CAMPAIGNS,
  FIXTURE_DATES,
  FIXTURE_PROFILE,
  FIXTURE_REPORT_DAY,
  INBOX_DIR,
  PROVISIONAL_DIR,
  PROVISIONAL_PROFILE_EXPORT,
  ourProfileDays,
} from './fixtures.js';

const available = await databaseAvailable();
const describeDb = available ? describe : describe.skip;

describeDb('crosscheck.ingest against a migrated database', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  let inbox: string;

  beforeAll(async () => {
    database = await createTestDatabase('crosscheck');
    ({ orgId, profileId } = await seedProfile(database));
    await seedFacts(database, orgId, profileId);
    inbox = await stageInbox([
      [INBOX_DIR, CLEAN_PROFILE_EXPORT],
      [INBOX_DIR, CLEAN_CAMPAIGN_EXPORT],
    ]);
  }, 120_000);

  afterAll(async () => {
    if (database) await database.drop();
    if (inbox) await rm(inbox, { recursive: true, force: true });
  });

  it('ingests both grains, counting rows kept against rows parsed', async () => {
    const result = await runCrosscheckIngest(database, job(orgId, profileId, inbox));

    expect(result.filesParsed).toBe(2);
    // Ten profile rows in the wide export plus four campaigns; three rows
    // belong to a profile we did not ask about.
    expect(result.rowsParsed).toBe(14);
    expect(result.rowsKept).toBe(11);
    expect(result.summary.profileDaysCompared).toBe(7);
    expect(result.summary.campaignsCompared).toBe(4);
    expect(result.summary.headline).toBe('verified');
    expect(result.written).toBe(result.findings.length);
  });

  it('wrote a verdict history the panel can render', async () => {
    const model = await loadCrosscheckPanel(database, { profileId });
    expect(model.chip.verdict).toBe('verified');
    expect(model.chip.verifiedStreak).toBe(7);
    expect(model.days).toHaveLength(7);
    expect(model.mismatchingCampaigns).toEqual([]);
    // The drill-down names the campaign from the entity mirror, not the export.
    const stored = await readResults(database, { profileId, grain: 'campaign_week' });
    expect(new Set(stored.map((r) => r.entityId)).size).toBe(4);
  });

  it('lists the profile in the panel switcher once it has a verdict', async () => {
    const profiles = await listCrosscheckedProfiles(database);
    expect(profiles.map((p) => p.profileId)).toContain(profileId);
  });

  it('is idempotent: a re-run updates the same rows rather than duplicating them', async () => {
    const before = await readResults(database, { profileId });
    const again = await runCrosscheckIngest(database, job(orgId, profileId, inbox));
    const after = await readResults(database, { profileId });
    expect(again.written).toBe(again.findings.length);
    expect(after).toHaveLength(before.length);
  });

  it('flags exactly the corrupted campaign when the corrupted export lands', async () => {
    const corrupted = await stageInbox([[CORRUPTED_DIR, CLEAN_CAMPAIGN_EXPORT]]);
    try {
      const result = await runCrosscheckIngest(database, job(orgId, profileId, corrupted));
      expect(result.summary.headline).toBe('mismatch');

      const stored = await readResults(database, { profileId, grain: 'campaign_week' });
      const mismatching = stored.filter((row) => row.verdict === 'mismatch');
      expect(new Set(mismatching.map((row) => row.entityId))).toEqual(new Set([CORRUPTED_CAMPAIGN]));

      const model = buildPanelModel(stored);
      expect(model.mismatchingCampaigns.map((c) => c.campaignId)).toEqual([CORRUPTED_CAMPAIGN]);
      expect(model.mismatchingCampaigns[0]?.figures.find((f) => f.metric === 'ad_spend')).toMatchObject({
        ours: 150.5,
        theirs: 168.56,
      });
    } finally {
      await rm(corrupted, { recursive: true, force: true });
    }
  });

  it('records the in-progress day as skipped and keeps the profile verdict verified', async () => {
    const provisional = await stageInbox([[PROVISIONAL_DIR, PROVISIONAL_PROFILE_EXPORT]]);
    try {
      const result = await runCrosscheckIngest(
        database,
        { ...job(orgId, profileId, provisional), date: FIXTURE_REPORT_DAY },
      );
      expect(result.summary.profileDaysSkipped).toBe(1);
      expect(result.summary.headline).toBe('verified');

      const stored = await readResults(database, { profileId, grain: 'profile' });
      const day = stored.filter((row) => row.date === FIXTURE_REPORT_DAY);
      expect(day).toHaveLength(3);
      expect(day.every((row) => row.verdict === 'skipped_provisional')).toBe(true);
    } finally {
      await rm(provisional, { recursive: true, force: true });
    }
  });

  it('refuses an export filed against another profile instead of comparing it', async () => {
    const wrong = await stageInbox([[INBOX_DIR, CLEAN_PROFILE_EXPORT]]);
    try {
      const other = await seedProfile(database, '9900000777');
      await expect(
        runCrosscheckIngest(database, {
          ...job(other.orgId, other.profileId, join(wrong, CLEAN_PROFILE_EXPORT)),
        }),
      ).rejects.toThrow(/names profile/);
    } finally {
      await rm(wrong, { recursive: true, force: true });
    }
  });

  it('feeds the exit-report generator from the rows it wrote', async () => {
    // Back to the clean export: the corrupted run above deliberately left a
    // failing campaign-week behind, and re-ingesting is how a fixed feed clears
    // a verdict in production too.
    await runCrosscheckIngest(database, job(orgId, profileId, inbox));
    const rows = await readResults(database, { profileId });
    const histories = applySpendingFlags(historiesFromResults(rows), spendingCampaignWeeks(rows));
    const report = evaluateExitCriterion(histories, { minProfiles: 1, consecutiveDays: 7 });
    expect(report.profiles[0]?.longestVerifiedStreak).toBe(7);
    expect(report.daysCriterionMet).toBe(true);
    // One profile, one week, and no optimizer parity finding: not a pass yet.
    expect(report.verdict).toBe('pending');
  });
});

function job(orgId: string, profileId: string, sourcePath: string) {
  return {
    type: 'crosscheck.ingest' as const,
    orgId,
    profileId,
    date: FIXTURE_REPORT_DAY,
    sourcePath,
  };
}

async function stageInbox(files: readonly [string, string][]): Promise<string> {
  const unique = [Date.now(), Math.random().toString(16).slice(2)].join('-');
  const path = join(tmpdir(), ['wizard-ads', 'crosscheck', unique].join('-'));
  await mkdir(path, { recursive: true });
  for (const [dir, name] of files) {
    await writeFile(join(path, name), await readFile(join(dir, name), 'utf8'), 'utf8');
  }
  return path;
}

const DEV_USER = '00000000-0000-4000-8000-0000000c1001';

async function seedProfile(
  handle: DbHandle,
  amazonProfileId: string = FIXTURE_PROFILE,
): Promise<{ orgId: string; profileId: string }> {
  await handle.sql`select public.auth_user_stub(${DEV_USER}::uuid)`;
  const orgs = await handle.sql<{ id: string }[]>`
    insert into public.orgs (slug, name)
    values (${`crosscheck-${amazonProfileId}`}, 'crosscheck fixture')
    on conflict (slug) do update set name = excluded.name
    returning id
  `;
  const orgId = orgs[0]?.id as string;
  await handle.sql`
    insert into public.org_members (org_id, user_id, role) values (${orgId}, ${DEV_USER}, 'owner')
    on conflict (org_id, user_id) do nothing
  `;
  const profiles = await handle.sql<{ id: string }[]>`
    insert into public.ad_profiles
      (org_id, amazon_profile_id, region, country_code, currency_code, timezone, sync_enabled, account_name)
    values (${orgId}, ${amazonProfileId}, 'NA', 'US', 'USD', 'America/Los_Angeles', true, ${`Fixture ${amazonProfileId}`})
    returning id
  `;
  return { orgId, profileId: profiles[0]?.id as string };
}

/** Our side: the campaign dailies, and the profile dailies they sum to. */
async function seedFacts(handle: DbHandle, orgId: string, profileId: string): Promise<void> {
  await ensureFactPartitions(handle, '2026-08-01', 1);

  for (const campaign of FIXTURE_CAMPAIGNS) {
    for (const [index, date] of FIXTURE_DATES.entries()) {
      await handle.sql`
        insert into public.fact_sp_target_daily
          (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, target_id, target_kind,
           match_type, impressions, clicks, cost, purchases_7d, sales_7d, units_sold_7d)
        values (${orgId}, ${profileId}, ${date}, 'SP', ${campaign.campaignId}, ${campaign.adGroupId},
                ${campaign.targetId}, 'keyword', 'exact', 1000, 50, ${campaign.spend[index] ?? 0},
                2, ${campaign.sales[index] ?? 0}, 2)
      `;
    }
  }

  for (const day of ourProfileDays(true)) {
    await handle.sql`
      insert into public.fact_profile_daily
        (org_id, profile_id, date, currency_code, impressions, clicks, cost, purchases_7d,
         sales_7d, units_sold_7d, provisional)
      values (${orgId}, ${profileId}, ${day.date}, 'USD', 4000, 200, ${day.adSpend ?? 0}, 8,
              ${day.adSales ?? 0}, 8, ${day.provisional})
    `;
  }

  for (const campaign of FIXTURE_CAMPAIGNS) {
    await handle.sql`
      insert into public.campaigns
        (org_id, profile_id, amazon_id, ad_product, name, state, budget_amount, budget_type)
      values (${orgId}, ${profileId}, ${campaign.campaignId}, 'SP', ${campaign.name}, 'enabled', 50, 'daily')
    `;
  }
}
