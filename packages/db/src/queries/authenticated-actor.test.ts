import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, type DbHandle } from '../client.js';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { withAuthenticatedActor } from './authenticated-actor.js';

const available = await databaseAvailable();
const USER_A = '10101010-1010-4010-8010-101010101010';
const USER_B = '20202020-2020-4020-8020-202020202020';

describe.skipIf(!available)('transaction-local authenticated actor', () => {
  let database: TestDatabase;
  let connection: DbHandle;
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    database = await createTestDatabase('write_actor');
    const rows = await database.sql<{ org_a: string; org_b: string }[]>`
      select app.seed_tenant_fixture('write-actor-a', ${USER_A}, 'owner') as org_a,
             app.seed_tenant_fixture('write-actor-b', ${USER_B}, 'admin') as org_b
    `;
    orgA = rows[0]!.org_a;
    orgB = rows[0]!.org_b;
    // One physical connection makes a leaked actor observable on the next request.
    connection = createDb({ connectionString: database.connectionString, max: 1 });
  }, 60_000);

  afterAll(async () => {
    await connection?.close();
    await database?.drop();
  });

  async function outsideIdentity() {
    const rows = await connection.sql<{ role: string; subject: string | null }[]>`
      select current_user::text as role, auth.uid()::text as subject
    `;
    return rows[0];
  }

  it('runs the authenticated RPC role with tenant RLS and restores the connection after success', async () => {
    const before = await outsideIdentity();
    const result = await withAuthenticatedActor(connection, { orgId: orgA, userId: USER_A }, async (sql) => {
      const rows = await sql<{
        role: string; subject: string; can_approve: boolean; visible_orgs: string[];
      }[]>`
        select current_user::text as role, auth.uid()::text as subject,
               has_function_privilege(current_user, 'app.approve_sp_write_cycle(uuid,text)', 'execute') as can_approve,
               (select array_agg(distinct org_id::text order by org_id::text) from public.ad_profiles) as visible_orgs
      `;
      return rows[0];
    });
    expect(result).toEqual({ role: 'authenticated', subject: USER_A, can_approve: true, visible_orgs: [orgA] });
    expect(await outsideIdentity()).toEqual(before);
  });

  it('restores claims and role after a database error aborts the transaction', async () => {
    const before = await outsideIdentity();
    await expect(withAuthenticatedActor(connection, { orgId: orgA, userId: USER_A }, async (sql) => {
      await sql`select 1 / 0`;
    })).rejects.toMatchObject({ code: '22012' });
    expect(await outsideIdentity()).toEqual(before);
    const next = await withAuthenticatedActor(connection, { orgId: orgB, userId: USER_B }, async (sql) => {
      const rows = await sql<{ subject: string; visible_orgs: string[] }[]>`
        select auth.uid()::text as subject,
               (select array_agg(distinct org_id::text order by org_id::text) from public.ad_profiles) as visible_orgs
      `;
      return rows[0];
    });
    expect(next).toEqual({ subject: USER_B, visible_orgs: [orgB] });
  });

  it('isolates overlapping requests on the same pool and cleans up a callback rejection', async () => {
    const before = await outsideIdentity();
    const actors = [
      { orgId: orgA, userId: USER_A },
      { orgId: orgB, userId: USER_B },
    ];
    const results = await Promise.all(actors.map((actor) => withAuthenticatedActor(connection, actor, async (sql) => {
      await sql`select pg_sleep(0.01)`;
      const rows = await sql<{ subject: string }[]>`select auth.uid()::text as subject`;
      return rows[0]!.subject;
    })));
    expect(results).toEqual([USER_A, USER_B]);
    await expect(withAuthenticatedActor(connection, actors[0]!, async () => {
      throw new Error('synthetic callback failure');
    })).rejects.toThrow('synthetic callback failure');
    expect(await outsideIdentity()).toEqual(before);
  });

  it('rejects malformed actor identity before invoking the operation', async () => {
    const operation = vi.fn();
    await expect(withAuthenticatedActor(connection, { orgId: orgA, userId: 'invalid' }, operation)).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled();
  });
});
