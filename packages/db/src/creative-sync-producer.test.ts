import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobPayload } from '@wizard-ads/shared';
import { createTestDatabase, databaseAvailable, type TestDatabase } from './testing/index.js';
import { enqueueDailyCreativeSyncJobs } from './queries/creative-sync-producer.js';

const available = await databaseAvailable();
const USER = '11111111-2222-4333-8444-555555555555';

describe.skipIf(!available)('daily Creative sync producer', () => {
  let database: TestDatabase;
  let orgId: string;
  let utcProfileId: string;
  let westProfileId: string;

  beforeAll(async () => {
    database = await createTestDatabase('creative_producer');
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('creative-producer', ${USER}, 'owner')
    `;
    orgId = org?.seed_tenant_fixture ?? '';
    const [seeded] = await database.sql<{ id: string }[]>`
      update public.ad_profiles
         set sync_enabled = true, timezone = 'UTC'
       where org_id = ${orgId}
      returning id
    `;
    utcProfileId = seeded?.id ?? '';
    const [west] = await database.sql<{ id: string }[]>`
      insert into public.ad_profiles
        (org_id, amazon_profile_id, region, country_code, currency_code, timezone, sync_enabled)
      values
        (${orgId}, 'synthetic-west-profile', 'NA', 'US', 'USD', 'America/Los_Angeles', true)
      returning id
    `;
    westProfileId = west?.id ?? '';
    await database.sql`
      insert into public.ad_profiles
        (org_id, amazon_profile_id, region, country_code, currency_code, timezone, sync_enabled)
      values
        (${orgId}, 'synthetic-disabled-profile', 'NA', 'US', 'USD', 'UTC', false)
    `;
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('offers each enabled profile once for its own local date and deduplicates retries', async () => {
    const observedAt = new Date('2026-08-30T00:30:00.000Z');
    const first = await enqueueDailyCreativeSyncJobs(database, observedAt);
    expect(first).toMatchObject({
      enabledProfiles: 2,
      offeredProfiles: 2,
      deferredPendingProfiles: 0,
      enqueuedJobs: 2,
      deduplicatedJobs: 0,
    });
    expect(first.observations.map((row) => [row.profileId, row.localDate]).sort()).toEqual([
      [utcProfileId, '2026-08-30'],
      [westProfileId, '2026-08-29'],
    ].sort());
    expect(new Set(first.observations.map((row) => row.dedupeKey)).size).toBe(2);

    const retry = await enqueueDailyCreativeSyncJobs(database, observedAt);
    expect(retry).toMatchObject({
      enabledProfiles: 2,
      offeredProfiles: 2,
      deferredPendingProfiles: 0,
      enqueuedJobs: 0,
      deduplicatedJobs: 2,
    });
    expect(retry.observations.map((row) => row.jobId).sort())
      .toEqual(first.observations.map((row) => row.jobId).sort());

    const jobs = await database.sql<{
      org_id: string;
      profile_id: string;
      payload: unknown;
      dedupe_key: string;
    }[]>`
      select org_id, profile_id, payload, dedupe_key
        from public.sync_jobs
       where job_type = 'creative.sync'
       order by profile_id
    `;
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      const payload = JobPayload.parse(job.payload);
      expect(payload).toMatchObject({
        type: 'creative.sync',
        orgId: job.org_id,
        profileId: job.profile_id,
        adProduct: 'SB',
        allowObservedAttributionFacts: true,
      });
      expect(job.dedupe_key).toContain(job.profile_id);
    }
  });

  it('defers an overlapping pending report, then offers the same local day after it clears', async () => {
    const snapshotId = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
    await database.sql`
      insert into public.creative_sync_snapshots
        (id, org_id, profile_id, start_date, end_date, observed_at,
         mapping_provenance, historical_validity, status, pagination_complete,
         fact_promotion_allowed, source_assets, parsed_assets, source_ads, parsed_ads,
         mapped, legacy, unsupported, ambiguous, unmapped)
      values
        (${snapshotId}, ${orgId}, ${westProfileId}, '2026-08-30', '2026-08-30', now(),
         'current_sb_ad_snapshot', 'unproven_current_snapshot', 'report_pending', true,
         true, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    `;
    const observedAt = new Date('2026-08-31T08:30:00.000Z');
    const deferred = await enqueueDailyCreativeSyncJobs(database, observedAt);
    expect(deferred).toMatchObject({
      enabledProfiles: 2,
      offeredProfiles: 1,
      deferredPendingProfiles: 1,
      enqueuedJobs: 1,
      deduplicatedJobs: 0,
    });
    expect(deferred.observations).toHaveLength(1);
    expect(deferred.observations[0]?.profileId).toBe(utcProfileId);

    await database.sql`
      update public.creative_sync_snapshots set status = 'blocked' where id = ${snapshotId}
    `;
    const afterTerminal = await enqueueDailyCreativeSyncJobs(database, observedAt);
    expect(afterTerminal).toMatchObject({
      enabledProfiles: 2,
      offeredProfiles: 2,
      deferredPendingProfiles: 0,
      enqueuedJobs: 1,
      deduplicatedJobs: 1,
    });
    expect(afterTerminal.observations.map((row) => row.localDate)).toEqual([
      '2026-08-31',
      '2026-08-31',
    ]);

    const nextDay = await enqueueDailyCreativeSyncJobs(
      database,
      new Date('2026-09-01T08:30:00.000Z'),
    );
    expect(nextDay).toMatchObject({
      enabledProfiles: 2,
      offeredProfiles: 2,
      deferredPendingProfiles: 0,
      enqueuedJobs: 2,
      deduplicatedJobs: 0,
    });
    expect(nextDay.observations.map((row) => row.localDate)).toEqual([
      '2026-09-01',
      '2026-09-01',
    ]);
  });
});
