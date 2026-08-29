import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applySqlFile,
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from '../testing/harness.js';

const available = await databaseAvailable();
const MIGRATION = fileURLToPath(new URL(
  '../../../../supabase/migrations/20260830100000_optimization_weekday_schedule.sql',
  import.meta.url,
));

describe.skipIf(!available)('optimization weekday migration transition', () => {
  let database: TestDatabase;
  let profileId: string;

  beforeAll(async () => {
    database = await createTestDatabase('wp90_transition', {
      throughMigration: '20260829160100_sb_video_observed_ingestion.sql',
      seed: false,
    });
    const [org] = await database.sql<{ id: string }[]>`
      insert into public.orgs (name, slug)
      values ('Synthetic schedule org', 'synthetic-schedule-org') returning id
    `;
    const [connection] = await database.sql<{ id: string }[]>`
      insert into public.ads_connections (org_id, label, status)
      values (${org?.id ?? ''}, 'Synthetic ads connection', 'active') returning id
    `;
    const [profile] = await database.sql<{ id: string }[]>`
      insert into public.ad_profiles (
        org_id, connection_id, amazon_profile_id, region, country_code,
        currency_code, timezone, sync_enabled
      ) values (
        ${org?.id ?? ''}, ${connection?.id ?? ''}, 'synthetic-profile',
        'NA', 'US', 'USD', 'America/New_York', true
      ) returning id
    `;
    profileId = profile?.id ?? '';
    await database.sql`
      insert into public.optimization_groups (
        org_id, profile_id, name, role, target_acos,
        bid_increase_cap, bid_decrease_cap, placement_increase_cap,
        placement_decrease_cap, cadence, prioritization, enabled, next_run_at
      ) values
        (${org?.id ?? ''}, ${profileId}, 'Daily legacy', 'rank', 0.2,
         0.1, 0.1, 0.1, 0.1, interval '1 day', 'balanced', true,
         '2026-09-07T13:30:00.000Z'::timestamptz),
        (${org?.id ?? ''}, ${profileId}, 'Weekly legacy', 'profit', 0.2,
         0.1, 0.1, 0.1, 0.1, interval '7 days', 'balanced', true,
         '2026-09-07T13:30:00.000Z'::timestamptz),
        (${org?.id ?? ''}, ${profileId}, 'Unsupported legacy', 'shield', 0.2,
         0.1, 0.1, 0.1, 0.1, interval '3 days', 'balanced', true,
         '2026-09-07T13:30:00.000Z'::timestamptz)
    `;
    await applySqlFile(database, MIGRATION);
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('preserves supported frequency and disables unsupported intervals for review', async () => {
    const rows = await database.sql<{
      name: string;
      cadence: string;
      legacy_next: string;
      weekdays: string[];
      local_time: string;
      migration_state: string;
      enabled: boolean;
      next_review: string | null;
    }[]>`
      select name, cadence::text as cadence, next_run_at::text as legacy_next,
             review_weekdays as weekdays, review_local_time::text as local_time,
             schedule_migration_state as migration_state, enabled,
             next_review_at::text as next_review
        from public.optimization_groups
       where profile_id = ${profileId}
       order by name
    `;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      name: 'Daily legacy',
      cadence: '1 day',
      weekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
      local_time: '09:30:00',
      migration_state: 'legacy_supported',
      enabled: true,
    });
    expect(new Date(rows[0]?.next_review ?? '').toISOString()).toBe('2026-09-07T13:30:00.000Z');
    expect(rows[1]).toMatchObject({
      name: 'Unsupported legacy',
      cadence: '3 days',
      weekdays: ['monday'],
      local_time: '09:30:00',
      migration_state: 'needs_review',
      enabled: false,
      next_review: null,
    });
    expect(rows[1]?.legacy_next).toContain('2026-09-07');
    expect(rows[2]).toMatchObject({
      name: 'Weekly legacy',
      cadence: '7 days',
      weekdays: ['monday'],
      local_time: '09:30:00',
      migration_state: 'legacy_supported',
      enabled: true,
    });
  });

  it('rejects empty, duplicate, unordered and unknown weekday sets', async () => {
    for (const invalid of [
      [] as string[],
      ['monday', 'monday'],
      ['tuesday', 'monday'],
      ['funday'],
    ]) {
      await expect(database.sql`
        update public.optimization_groups set review_weekdays = ${invalid}
         where profile_id = ${profileId} and name = 'Weekly legacy'
      `).rejects.toThrow(/optimization_groups_review_weekdays_canonical/);
    }
  });
});
