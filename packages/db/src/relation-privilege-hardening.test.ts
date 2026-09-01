import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applySqlFile,
  createTestDatabase,
  databaseAvailable,
} from './testing/harness.js';
import type { TestDatabase } from './testing/harness.js';

const available = await databaseAvailable();
const BEFORE = '20260901000000_contextual_negative_review_exports.sql';
const HARDENING = fileURLToPath(
  new URL(
    '../../../supabase/migrations/20260901010000_authenticated_relation_privilege_hardening.sql',
    import.meta.url,
  ),
);

interface Snapshot {
  rowCounts: Array<{ table_name: string; row_count: string }>;
  policies: Array<{
    table_name: string;
    policy_name: string;
    permissive: boolean;
    command: string;
    roles: string[];
    using_expression: string | null;
    check_expression: string | null;
  }>;
  nonTargetRelationAcl: Array<{
    relation_name: string;
    relation_kind: string;
    grantee: string;
    privilege: string;
    grantable: boolean;
  }>;
  nonTargetDefaultAcl: Array<{
    object_type: string;
    grantee: string;
    privilege: string;
    grantable: boolean;
  }>;
}

async function snapshot(database: TestDatabase): Promise<Snapshot> {
  const relations = await database.sql<{ table_name: string }[]>`
    select class.relname as table_name
      from pg_catalog.pg_class class
      join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
     where namespace.nspname = 'public'
       and class.relkind in ('r', 'p')
       and not class.relispartition
     order by class.relname
  `;
  const rowCounts: Snapshot['rowCounts'] = [];
  for (const { table_name: tableName } of relations) {
    const [count] = await database.sql<{ row_count: string }[]>`
      select count(*)::text as row_count from ${database.sql(tableName)}
    `;
    rowCounts.push({ table_name: tableName, row_count: count?.row_count ?? '' });
  }

  const policies = await database.sql<Snapshot['policies']>`
    select class.relname as table_name,
           policy.polname as policy_name,
           policy.polpermissive as permissive,
           policy.polcmd::text as command,
           array(
             select case role_oid when 0 then 'public' else role.rolname end
               from unnest(policy.polroles) role_oid
               left join pg_catalog.pg_roles role on role.oid = role_oid
              order by 1
           ) as roles,
           pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) as using_expression,
           pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) as check_expression
      from pg_catalog.pg_policy policy
      join pg_catalog.pg_class class on class.oid = policy.polrelid
      join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
     where namespace.nspname = 'public'
     order by class.relname, policy.polname
  `;

  const nonTargetRelationAcl = await database.sql<Snapshot['nonTargetRelationAcl']>`
    select relation.relname as relation_name,
           relation.relkind::text as relation_kind,
           case privilege.grantee
             when 0 then 'public'
             else grantee.rolname
           end as grantee,
           upper(privilege.privilege_type) as privilege,
           privilege.is_grantable as grantable
      from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          relation.relacl,
          pg_catalog.acldefault(
            (case when relation.relkind = 'S' then 'S' else 'r' end)::"char",
            relation.relowner
          )
        )
      ) privilege
      left join pg_catalog.pg_roles grantee on grantee.oid = privilege.grantee
     where namespace.nspname = 'public'
       and relation.relkind in ('r', 'p', 'S')
       and privilege.grantee not in (
         (select oid from pg_catalog.pg_roles where rolname = 'anon'),
         (select oid from pg_catalog.pg_roles where rolname = 'authenticated')
       )
     order by relation.relname, relation.relkind, grantee.rolname,
              privilege.privilege_type, privilege.is_grantable
  `;

  const nonTargetDefaultAcl = await database.sql<Snapshot['nonTargetDefaultAcl']>`
    select defaults.defaclobjtype as object_type,
           case privilege.grantee
             when 0 then 'public'
             else grantee.rolname
           end as grantee,
           upper(privilege.privilege_type) as privilege,
           privilege.is_grantable as grantable
      from pg_catalog.pg_default_acl defaults
      cross join lateral pg_catalog.aclexplode(defaults.defaclacl) privilege
      left join pg_catalog.pg_roles grantee on grantee.oid = privilege.grantee
     where defaults.defaclnamespace = 'public'::regnamespace
       and defaults.defaclobjtype in ('r', 'S')
       and privilege.grantee not in (
         (select oid from pg_catalog.pg_roles where rolname = 'anon'),
         (select oid from pg_catalog.pg_roles where rolname = 'authenticated')
       )
     order by object_type, grantee.rolname, privilege.privilege_type,
              privilege.is_grantable
  `;

  return { rowCounts, policies, nonTargetRelationAcl, nonTargetDefaultAcl };
}

describe.skipIf(!available)('authenticated relation privilege hardening', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('relation_acl_upgrade', { throughMigration: BEFORE });
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('removes hosted inherited authority without changing data, policies or other roles', async () => {
    const [beforePrivileges] = await database.sql<{
      export_truncate: boolean;
      sequence_update: boolean;
    }[]>`
      select
        has_table_privilege(
          'authenticated', 'public.contextual_negative_exports', 'truncate'
        ) as export_truncate,
        has_sequence_privilege(
          'authenticated', 'public.experiment_events_id_seq', 'update'
        ) as sequence_update
    `;
    expect(beforePrivileges).toEqual({ export_truncate: true, sequence_update: true });

    const before = await snapshot(database);
    await applySqlFile(database, HARDENING);
    const after = await snapshot(database);

    expect(after).toEqual(before);

    const [afterPrivileges] = await database.sql<{
      export_truncate: boolean;
      sequence_update: boolean;
      sequence_usage: boolean;
    }[]>`
      select
        has_table_privilege(
          'authenticated', 'public.contextual_negative_exports', 'truncate'
        ) as export_truncate,
        has_sequence_privilege(
          'authenticated', 'public.experiment_events_id_seq', 'update'
        ) as sequence_update,
        has_sequence_privilege(
          'authenticated', 'public.experiment_events_id_seq', 'usage'
        ) as sequence_usage
    `;
    expect(afterPrivileges).toEqual({
      export_truncate: false,
      sequence_update: false,
      sequence_usage: true,
    });
  });

  it('refuses additive hosted catalog drift before changing any authority', async () => {
    const drifted = await createTestDatabase('relation_acl_drift', {
      throughMigration: BEFORE,
    });
    try {
      await drifted.sql`
        create table public.wp186_unreviewed_relation (
          id uuid primary key,
          org_id uuid not null
        )
      `;
      await drifted.sql`alter table public.wp186_unreviewed_relation enable row level security`;
      await drifted.sql`
        create policy tenant_read on public.wp186_unreviewed_relation
        for select to authenticated using (app.is_org_member(org_id))
      `;

      const authority = async () => {
        const [row] = await drifted.sql<{
          helper_execute: boolean;
          relation_truncate: boolean;
        }[]>`
          select
            has_function_privilege(
              'authenticated', 'app.install_tenant_rls(regclass,text[])', 'execute'
            ) as helper_execute,
            has_table_privilege(
              'authenticated', 'public.wp186_unreviewed_relation', 'truncate'
            ) as relation_truncate
        `;
        return row;
      };

      expect(await authority()).toEqual({
        helper_execute: true,
        relation_truncate: true,
      });
      await expect(applySqlFile(drifted, HARDENING)).rejects.toMatchObject({ code: '22012' });
      expect(await authority()).toEqual({
        helper_execute: true,
        relation_truncate: true,
      });
    } finally {
      await drifted.drop();
    }
  }, 60_000);

  it('refuses a non-postgres applier before changing any authority', async () => {
    const wrongApplier = await createTestDatabase('relation_acl_wrong_applier', {
      throughMigration: BEFORE,
    });
    try {
      const authority = async () => {
        const [row] = await wrongApplier.sql<{
          helper_execute: boolean;
          relation_truncate: boolean;
        }[]>`
          select
            has_function_privilege(
              'authenticated', 'app.install_tenant_rls(regclass,text[])', 'execute'
            ) as helper_execute,
            has_table_privilege(
              'authenticated', 'public.contextual_negative_exports', 'truncate'
            ) as relation_truncate
        `;
        return row;
      };

      expect(await authority()).toEqual({
        helper_execute: true,
        relation_truncate: true,
      });
      const migration = await readFile(HARDENING, 'utf8');
      await expect(
        wrongApplier.sql.begin(async (sql) => {
          await sql`set local role authenticated`;
          await sql.unsafe(migration);
        }),
      ).rejects.toMatchObject({ code: '22012' });
      expect(await authority()).toEqual({
        helper_execute: true,
        relation_truncate: true,
      });
    } finally {
      await wrongApplier.drop();
    }
  }, 60_000);

  it('refuses another creator\'s public default grant before mutation', async () => {
    const otherCreator = await createTestDatabase('relation_acl_other_creator', {
      throughMigration: BEFORE,
    });
    try {
      await otherCreator.sql`
        alter default privileges for role service_role in schema public
        grant select on tables to authenticated
      `;
      const targetDefaultCount = async () => {
        const [row] = await otherCreator.sql<{ count: number }[]>`
          select count(*)::int as count
            from pg_catalog.pg_default_acl defaults
            cross join lateral pg_catalog.aclexplode(defaults.defaclacl) privilege
           where defaults.defaclrole = (
                   select oid from pg_catalog.pg_roles where rolname = 'service_role'
                 )
             and defaults.defaclnamespace = 'public'::regnamespace
             and defaults.defaclobjtype = 'r'
             and privilege.grantee = (
                   select oid from pg_catalog.pg_roles where rolname = 'authenticated'
                 )
        `;
        return row?.count;
      };

      expect(await targetDefaultCount()).toBe(1);
      await expect(applySqlFile(otherCreator, HARDENING)).rejects.toMatchObject({ code: '22012' });
      expect(await targetDefaultCount()).toBe(1);
      const [authority] = await otherCreator.sql<{ relation_truncate: boolean }[]>`
        select has_table_privilege(
          'authenticated', 'public.contextual_negative_exports', 'truncate'
        ) as relation_truncate
      `;
      expect(authority?.relation_truncate).toBe(true);
    } finally {
      await otherCreator.drop();
    }
  }, 60_000);

  it('refuses a global API-role default grant before mutation', async () => {
    const globalDefault = await createTestDatabase('relation_acl_global_default', {
      throughMigration: BEFORE,
    });
    try {
      await globalDefault.sql`
        alter default privileges for role postgres
        grant select on tables to authenticated
      `;
      const targetDefaultCount = async () => {
        const [row] = await globalDefault.sql<{ count: number }[]>`
          select count(*)::int as count
            from pg_catalog.pg_default_acl defaults
            cross join lateral pg_catalog.aclexplode(defaults.defaclacl) privilege
           where defaults.defaclrole = (
                   select oid from pg_catalog.pg_roles where rolname = 'postgres'
                 )
             and defaults.defaclnamespace = 0
             and defaults.defaclobjtype = 'r'
             and privilege.grantee = (
                   select oid from pg_catalog.pg_roles where rolname = 'authenticated'
                 )
        `;
        return row?.count;
      };

      expect(await targetDefaultCount()).toBe(1);
      await expect(applySqlFile(globalDefault, HARDENING)).rejects.toMatchObject({ code: '22012' });
      expect(await targetDefaultCount()).toBe(1);
      const [authority] = await globalDefault.sql<{ relation_truncate: boolean }[]>`
        select has_table_privilege(
          'authenticated', 'public.contextual_negative_exports', 'truncate'
        ) as relation_truncate
      `;
      expect(authority?.relation_truncate).toBe(true);
    } finally {
      await globalDefault.drop();
    }
  }, 60_000);
});
