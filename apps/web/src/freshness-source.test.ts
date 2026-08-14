/**
 * The brief's freshness acceptance check, stated exactly as it is written:
 *
 *   "Freshness banner sourced from `report_requests` (test: facts present but
 *    stale request row → banner shows stale)."
 *
 * So the fixture below deliberately writes **fresh facts** and a **stale ledger
 * row**, which is the state that separates a correct implementation from the
 * obvious wrong one. Anything that infers freshness from `max(date)` on the fact
 * tables passes a naive test and fails this one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import { ensureFactPartitions } from '@wizard-ads/db';
import { assessFreshness } from '@wizard-ads/ui';
import { loadReportLedger } from '../app/_lib/dashboard-data.js';

const available = await databaseAvailable();
const suite = available ? describe : describe.skip;

const NOW = new Date('2026-08-14T12:00:00Z');

suite('freshness comes from the report ledger', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;

  beforeAll(async () => {
    database = await createTestDatabase('wp06_fresh');
    const [org] = await database.sql<{ id: string }[]>`
      select app.seed_tenant_fixture('wp06fresh', '00000000-0000-4000-8000-0000000006b1'::uuid) as id
    `;
    orgId = (org as { id: string }).id;
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId} limit 1
    `;
    profileId = (profile as { id: string }).id;

    // Clear the fixture's own ledger row and its same-day fact, so the state
    // below is the only one and "the newest fact" is the one this test wrote.
    await database.sql`delete from public.report_requests where profile_id = ${profileId}`;
    await database.sql`delete from public.fact_profile_daily where profile_id = ${profileId}`;

    await ensureFactPartitions(database, '2026-08-01', 2);

    // Facts right up to yesterday: by any fact-derived measure this profile is fresh.
    await database.sql`
      insert into public.fact_profile_daily
        (org_id, profile_id, date, currency_code, impressions, clicks, cost, purchases_7d, sales_7d,
         units_sold_7d, provisional)
      values
        (${orgId}, ${profileId}, '2026-08-12', 'USD', 1000, 40, 30, 3, 90, 3, false),
        (${orgId}, ${profileId}, '2026-08-13', 'USD', 1100, 44, 33, 4, 99, 4, false)
      on conflict (profile_id, date) do nothing
    `;

    // ...and a ledger whose newest successful load is four days old.
    await database.sql`
      insert into public.report_requests
        (org_id, profile_id, report_type, start_date, end_date, status, requested_at, completed_at,
         rows_parsed, rows_loaded)
      values (${orgId}, ${profileId}, 'spCampaigns', '2026-08-09', '2026-08-10', 'completed',
              '2026-08-10T03:00:00Z', '2026-08-10T03:20:00Z', 4200, 4200)
    `;
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('shows stale even though the fact tables hold data through yesterday', async () => {
    const [newestFact] = await database.sql<{ date: string }[]>`
      select max(date)::text as date from public.fact_profile_daily where profile_id = ${profileId}
    `;
    expect((newestFact as { date: string }).date).toBe('2026-08-13');

    const ledger = await loadReportLedger(database, profileId);
    const assessment = assessFreshness(ledger, { now: NOW });

    expect(assessment.tone).toBe('warn');
    expect(assessment.staleTypes).toEqual(['spCampaigns']);
    // And it reports what the ledger covers, not what the facts hold.
    expect(assessment.coversThrough).toBe('2026-08-10');
  });

  it('turns green once a load completes, without any fact changing', async () => {
    await database.sql`
      insert into public.report_requests
        (org_id, profile_id, report_type, start_date, end_date, status, requested_at, completed_at,
         rows_parsed, rows_loaded)
      values (${orgId}, ${profileId}, 'spCampaigns', '2026-08-13', '2026-08-13', 'completed',
              '2026-08-14T03:00:00Z', '2026-08-14T03:25:00Z', 4300, 4300)
    `;

    const assessment = assessFreshness(await loadReportLedger(database, profileId), { now: NOW });
    expect(assessment.tone).toBe('good');
    expect(assessment.coversThrough).toBe('2026-08-13');
  });

  it('goes red when a load wrote fewer rows than it parsed', async () => {
    await database.sql`
      insert into public.report_requests
        (org_id, profile_id, report_type, start_date, end_date, status, requested_at, completed_at,
         rows_parsed, rows_loaded)
      values (${orgId}, ${profileId}, 'spSearchTerm', '2026-08-13', '2026-08-13', 'completed',
              '2026-08-14T04:00:00Z', '2026-08-14T04:30:00Z', 9000, 8800)
    `;

    const ledger = await loadReportLedger(database, profileId);
    const lossy = ledger.find((entry) => entry.reportType === 'spSearchTerm');
    // `counts_match` is a generated column: the database decided this, not the test.
    expect(lossy?.countsMatch).toBe(false);

    const assessment = assessFreshness(ledger, { now: NOW });
    expect(assessment.tone).toBe('bad');
    expect(assessment.lossyTypes).toEqual(['spSearchTerm']);
  });
});
