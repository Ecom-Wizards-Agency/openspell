import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { spWriteMirrorObservations, spWriteObservations } from '../schema/sp-writes.js';
import { withAuthenticatedActor } from './authenticated-actor.js';

const available = await databaseAvailable();
const OWNER = '31313131-3131-4131-8131-313131313131';
const OTHER = '42424242-4242-4242-8242-424242424242';

describe.skipIf(!available)('native mirror persistence installation', () => {
  let database: TestDatabase;
  let orgId: string;
  beforeAll(async () => {
    database = await createTestDatabase('mirror_contract');
    const [tenant] = await database.sql<{ org: string }[]>`select app.seed_tenant_fixture('mirror-own', ${OWNER}, 'owner') as org`;
    orgId = tenant!.org;
    await database.sql`select app.seed_tenant_fixture('mirror-other', ${OTHER}, 'owner')`;
  }, 60_000);
  afterAll(async () => { await database?.drop(); });

  it('matches all receipt columns, foreign keys and unique identities to the current migration', async () => {
    const table = getTableConfig(spWriteMirrorObservations);
    const columns = await database.sql<{ name: string; required: boolean }[]>`
      select attname as name, attnotnull as required from pg_attribute
      where attrelid = 'public.sp_write_mirror_observations'::regclass and attnum > 0 and not attisdropped order by attnum`;
    expect(columns).toEqual(table.columns.map((column) => ({ name: column.name, required: column.notNull })));
    const constraints = await database.sql<{ name: string; type: string; target: string | null }[]>`
      select conname as name, contype::text as type, case when contype = 'f' then confrelid::regclass::text else null end as target
      from pg_constraint where conrelid = 'public.sp_write_mirror_observations'::regclass order by conname`;
    expect(constraints.filter((row) => row.type === 'f')).toEqual(table.foreignKeys.map((key) => ({
      name: key.getName(), type: 'f', target: getTableConfig(key.reference().foreignTable).name,
    })).sort((a, b) => a.name.localeCompare(b.name)));
    expect(constraints.filter((row) => row.type === 'u').map((row) => row.name))
      .toEqual(table.uniqueConstraints.map((key) => key.name).sort());
    expect(constraints.filter((row) => row.type === 'c').map((row) => row.name))
      .toEqual(table.checks.map((key) => key.name).sort());
    const parent = getTableConfig(spWriteObservations).uniqueConstraints.find((key) => key.name === 'sp_write_observations_mirror_identity_key');
    const [source] = await database.sql<{ columns: string[] }[]>`select array(
      select attname from unnest(conkey) with ordinality key(attnum, ord)
      join pg_attribute a on a.attrelid = conrelid and a.attnum = key.attnum order by key.ord
    ) as columns from pg_constraint where conrelid = 'public.sp_write_observations'::regclass
      and conname = 'sp_write_observations_mirror_identity_key'`;
    expect(source!.columns).toEqual(parent!.columns.map((column) => column.name));
  });

  it('permits tenant reads, denies direct writes and reserves reconciliation to the worker role', async () => {
    const rows = await withAuthenticatedActor(database, { orgId, userId: OWNER }, (sql) => sql<{ org_id: string }[]>`
      select org_id::text from public.sp_write_mirror_observations`);
    expect(rows).toEqual([{ org_id: orgId }]);
    const [grants] = await database.sql<{ worker: boolean; operator: boolean; anonymous: boolean; direct_insert: boolean; direct_update: boolean }[]>`
      select has_function_privilege('service_role', 'app.reconcile_sp_write_mirror(uuid,text)', 'EXECUTE') as worker,
        has_function_privilege('authenticated', 'app.reconcile_sp_write_mirror(uuid,text)', 'EXECUTE') as operator,
        has_table_privilege('anon', 'public.sp_write_mirror_observations', 'SELECT') as anonymous,
        has_table_privilege('service_role', 'public.sp_write_mirror_observations', 'INSERT') as direct_insert,
        has_table_privilege('service_role', 'public.sp_write_mirror_observations', 'UPDATE') as direct_update`;
    expect(grants).toEqual({ worker: true, operator: false, anonymous: false, direct_insert: false, direct_update: false });
    await expect(database.sql`update public.sp_write_mirror_observations set artifact = artifact where org_id = ${orgId}`)
      .rejects.toMatchObject({ code: '55000' });
    await expect(database.sql`delete from public.sp_write_mirror_observations where org_id = ${orgId}`)
      .rejects.toMatchObject({ code: '55000' });
  });
});
