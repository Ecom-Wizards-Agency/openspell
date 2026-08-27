/**
 * The RLS negative test: a member of org A must never see a row of org B, on
 * every tenant table, not on a representative sample.
 *
 * The table list comes from the catalog, so a table added next month is covered
 * the moment it exists. To stop that from passing vacuously, the suite first
 * asserts that the fixture actually put a row in every one of those tables for
 * both orgs: an empty table trivially leaks nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from './testing/harness.js';
import { asAnon, asUser, tenantTables } from './testing/rls.js';
import type { TestDatabase } from './testing/harness.js';

const available = await databaseAvailable();

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

describe.skipIf(!available)('row level security', () => {
  let database: TestDatabase;
  let orgA: string;
  let orgB: string;
  let tables: string[];

  beforeAll(async () => {
    database = await createTestDatabase('rls');

    const [a] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('alpha', ${USER_A}, 'analyst')
    `;
    const [b] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('bravo', ${USER_B}, 'owner')
    `;
    orgA = a?.seed_tenant_fixture ?? '';
    orgB = b?.seed_tenant_fixture ?? '';
    tables = await tenantTables(database);
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('has a fixture row in every tenant table for both orgs', async () => {
    const missing: string[] = [];
    for (const table of tables) {
      const rows = await database.sql<{ a: string; b: string }[]>`
        select
          count(*) filter (where org_id = ${orgA}) as a,
          count(*) filter (where org_id = ${orgB}) as b
        from ${database.sql(table)}
      `;
      const counts = rows[0];
      if (!counts || Number(counts.a) < 1 || Number(counts.b) < 1) missing.push(table);
    }
    // A table listed here has no fixture coverage, so the leak test below would
    // pass without proving anything about it.
    expect(missing).toEqual([]);
  });

  it('shows a member of org A only org A rows, on every tenant table', async () => {
    const leaks: { table: string; foreignRows: number }[] = [];
    const invisible: string[] = [];
    // Deliberately invisible to an analyst: reading the audit log is an
    // owner/admin act, asserted separately below.
    const adminOnly = new Set(['audit_log', 'org_invitations']);

    await asUser(database, USER_A, async (sql) => {
      for (const table of tables) {
        const rows = await sql<{ own: string; foreign_rows: string }[]>`
          select
            count(*) filter (where org_id = ${orgA}) as own,
            count(*) filter (where org_id <> ${orgA}) as foreign_rows
          from ${sql(table)}
        `;
        const counts = rows[0];
        const foreignRows = Number(counts?.foreign_rows ?? 0);
        if (foreignRows > 0) leaks.push({ table, foreignRows });
        if (!adminOnly.has(table) && Number(counts?.own ?? 0) < 1) invisible.push(table);
      }
    });

    expect(leaks).toEqual([]);
    // The other half of the check: the policy must not be so tight that a
    // member cannot see their own data either.
    expect(invisible).toEqual([]);
  });

  it('shows a member of org A no org B org row', async () => {
    await asUser(database, USER_A, async (sql) => {
      const rows = await sql<{ id: string }[]>`select id from public.orgs`;
      expect(rows.map((row) => row.id)).toEqual([orgA]);
    });
  });

  it('shows a signed-out visitor nothing at all', async () => {
    await asAnon(database, async (sql) => {
      for (const table of ['orgs', 'ad_profiles', 'fact_sp_target_daily', 'recommendations']) {
        await expect(sql`select count(*) from ${sql(table)}`).rejects.toThrow(/permission denied/i);
      }
    });
  });

  it('lets an analyst retune a profile but not delete it', async () => {
    await asUser(database, USER_A, async (sql) => {
      const updated = await sql`
        update public.ad_profiles set target_acos = 0.3 where org_id = ${orgA} returning id
      `;
      expect(updated.length).toBe(1);

      const deleted = await sql`delete from public.ad_profiles where org_id = ${orgA} returning id`;
      // No error: RLS filters the row out of the delete's scope rather than
      // raising, which is exactly why a delete test must assert on the count.
      expect(deleted.length).toBe(0);
    });
  });

  it('refuses a member writing into another org', async () => {
    await asUser(database, USER_A, async (sql) => {
      await expect(
        sql`
          insert into public.tags (org_id, name, slug) values (${orgB}, 'stolen', 'stolen')
        `,
      ).rejects.toThrow(/row-level security/i);
    });
  });

  it('refuses a member writing to a service-role-only table', async () => {
    await asUser(database, USER_A, async (sql) => {
      await expect(
        sql`
          insert into public.fact_profile_daily (org_id, profile_id, date, currency_code)
          select ${orgA}, id, current_date - 1, 'USD' from public.ad_profiles limit 1
        `,
      ).rejects.toThrow(/permission denied|row-level security/i);
    });
  });

  it('keeps the audit log admin-only', async () => {
    // USER_A is an analyst in org A, and the audit log is owner/admin reading.
    await asUser(database, USER_A, async (sql) => {
      const rows = await sql`select * from public.audit_log`;
      expect(rows.length).toBe(0);
    });
    await asUser(database, USER_B, async (sql) => {
      const rows = await sql`select * from public.audit_log`;
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  it('keeps invitations admin-only and tenant-scoped', async () => {
    await asUser(database, USER_A, async (sql) => {
      const rows = await sql`select org_id from public.org_invitations`;
      expect(rows).toEqual([]);
    });
    await asUser(database, USER_B, async (sql) => {
      const rows = await sql<{ org_id: string }[]>`
        select org_id from public.org_invitations order by org_id
      `;
      expect(rows.map((row) => row.org_id)).toEqual([orgB]);
    });
  });
});
