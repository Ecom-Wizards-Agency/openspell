import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from './testing/harness.js';
import { asUser } from './testing/rls.js';
import type { TestDatabase } from './testing/harness.js';

const available = await databaseAvailable();
const OWNER_A = '81818181-8181-4181-8181-818181818181';
const OWNER_B = '82828282-8282-4282-8282-828282828282';

describe.skipIf(!available)('WP-171 optimization weekday schedules', () => {
  let database: TestDatabase;
  let orgA = '';
  let orgB = '';
  let profileA = '';

  beforeAll(async () => {
    database = await createTestDatabase('wp171_weekdays');
    const [a] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('weekday-alpha', ${OWNER_A}, 'owner')
    `;
    const [b] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('weekday-bravo', ${OWNER_B}, 'owner')
    `;
    orgA = a?.seed_tenant_fixture ?? '';
    orgB = b?.seed_tenant_fixture ?? '';
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgA} limit 1
    `;
    profileA = profile?.id ?? '';
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('resolves local review instants across DST without adding UTC days', async () => {
    const [spring] = await database.sql<{ due: Date | string }[]>`
      select app.next_optimization_review_at(
        array[7]::smallint[], 'America/New_York', 4,
        '2026-03-07T12:00:00Z'::timestamptz
      ) as due
    `;
    expect(new Date(spring?.due ?? '').toISOString()).toBe('2026-03-08T08:00:00.000Z');

    const [autumn] = await database.sql<{ due: Date | string }[]>`
      select app.next_optimization_review_at(
        array[7]::smallint[], 'Europe/Berlin', 4,
        '2026-10-24T12:00:00Z'::timestamptz
      ) as due
    `;
    expect(new Date(autumn?.due ?? '').toISOString()).toBe('2026-10-25T03:00:00.000Z');
  });

  it('backfills daily intervals to all days and longer intervals to their local anchor day', async () => {
    const [mapped] = await database.sql<{ daily: number[]; weekly: number[]; ambiguous: number[] }[]>`
      select app.legacy_optimization_review_weekdays(
               interval '12 hours', '2026-08-30T12:00:00Z', 'UTC'
             ) as daily,
             app.legacy_optimization_review_weekdays(
               interval '7 days', '2026-08-30T23:30:00Z', 'Asia/Tokyo'
             ) as weekly,
             app.legacy_optimization_review_weekdays(
               interval '3 days', '2026-08-30T23:30:00Z', 'Asia/Tokyo'
             ) as ambiguous
    `;
    expect(mapped).toEqual({
      daily: [1, 2, 3, 4, 5, 6, 7],
      weekly: [1],
      ambiguous: [1],
    });
  });

  it('rejects empty, duplicate, unordered, and out-of-range weekday sets', async () => {
    const insert = (name: string, weekdays: number[]) => database.sql`
      insert into public.optimization_groups (
        org_id, profile_id, name, role, target_acos,
        bid_increase_cap, bid_decrease_cap,
        placement_increase_cap, placement_decrease_cap,
        review_weekdays, cadence, prioritization
      ) values (
        ${orgA}, ${profileA}, ${name}, 'rank', 0.2,
        0.1, 0.1, 0.1, 0.1,
        ${weekdays}::smallint[], interval '7 days', 'balanced'
      )
    `;

    const refusal = /review weekdays|review_weekdays_canonical/i;
    await expect(insert('empty', [])).rejects.toThrow(refusal);
    await expect(insert('duplicate', [1, 1])).rejects.toThrow(refusal);
    await expect(insert('unordered', [4, 1])).rejects.toThrow(refusal);
    await expect(insert('out-of-range', [8])).rejects.toThrow(refusal);
  });

  it('recomputes enabled groups when the profile timezone or review hour changes', async () => {
    const [group] = await database.sql<{ id: string }[]>`
      insert into public.optimization_groups (
        org_id, profile_id, name, role, target_acos,
        bid_increase_cap, bid_decrease_cap,
        placement_increase_cap, placement_decrease_cap,
        review_weekdays, cadence, prioritization
      ) values (
        ${orgA}, ${profileA}, 'timezone schedule', 'profit', 0.2,
        0.1, 0.1, 0.1, 0.1,
        array[1, 4]::smallint[], interval '7 days', 'balanced'
      ) returning id
    `;
    expect(group?.id).toBeTruthy();

    await database.sql`
      update public.ad_profiles
         set timezone = 'America/Los_Angeles', preferred_sync_hour = 6
       where org_id = ${orgA} and id = ${profileA}
    `;
    const [next] = await database.sql<{ local_hour: number; local_weekday: number }[]>`
      select extract(hour from group_row.next_run_at at time zone profile.timezone)::int as local_hour,
             extract(isodow from group_row.next_run_at at time zone profile.timezone)::int as local_weekday
        from public.optimization_groups group_row
        join public.ad_profiles profile
          on profile.org_id = group_row.org_id and profile.id = group_row.profile_id
       where group_row.id = ${group?.id ?? ''}
    `;
    expect(next?.local_hour).toBe(6);
    expect([1, 4]).toContain(next?.local_weekday);

    await database.sql`
      update public.optimization_groups set enabled = false where id = ${group?.id ?? ''}
    `;
    const [paused] = await database.sql<{ next_run_at: Date | null }[]>`
      select next_run_at from public.optimization_groups where id = ${group?.id ?? ''}
    `;
    expect(paused?.next_run_at).toBeNull();
  });

  it('keeps weekday configuration tenant-scoped under RLS', async () => {
    await asUser(database, OWNER_A, async (sql) => {
      const rows = await sql<{ org_id: string; review_weekdays: number[] }[]>`
        select org_id, review_weekdays from public.optimization_groups order by id
      `;
      expect(rows.length).toBeGreaterThan(0);
      expect(new Set(rows.map((row) => row.org_id))).toEqual(new Set([orgA]));
      expect(rows.every((row) => row.review_weekdays.length > 0)).toBe(true);
    });
    await asUser(database, OWNER_B, async (sql) => {
      const rows = await sql<{ org_id: string }[]>`
        select org_id from public.optimization_groups where org_id = ${orgA}
      `;
      expect(rows).toEqual([]);
      const own = await sql<{ org_id: string }[]>`
        select org_id from public.optimization_groups where org_id = ${orgB}
      `;
      expect(own.length).toBeGreaterThan(0);
    });
  });
});
