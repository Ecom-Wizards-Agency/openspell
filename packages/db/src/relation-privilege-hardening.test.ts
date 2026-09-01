import { randomUUID } from 'node:crypto';
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
    grantor: string;
    grantee: string;
    privilege: string;
    grantable: boolean;
  }>;
  nonTargetColumnAcl: Array<{
    relation_name: string;
    column_name: string;
    grantor: string;
    grantee: string;
    privilege: string;
    grantable: boolean;
  }>;
  nonTargetDefaultAcl: Array<{
    creator: string;
    grantor: string;
    scope: string;
    object_type: string;
    grantee: string;
    privilege: string;
    grantable: boolean;
  }>;
  platformDefaultAcl: Array<{
    creator: string;
    grantor: string;
    scope: string;
    object_type: string;
    grantee: string;
    privilege: string;
    grantable: boolean;
  }>;
  helperNonTargetAcl: Array<{
    grantor: string;
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
           grantor.rolname as grantor,
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
      join pg_catalog.pg_roles grantor on grantor.oid = privilege.grantor
      left join pg_catalog.pg_roles grantee on grantee.oid = privilege.grantee
     where namespace.nspname = 'public'
       and relation.relkind in ('r', 'p', 'S')
       and privilege.grantee not in (
         (select oid from pg_catalog.pg_roles where rolname = 'anon'),
         (select oid from pg_catalog.pg_roles where rolname = 'authenticated')
       )
     order by relation.relname, relation.relkind, grantor.rolname, grantee.rolname,
              privilege.privilege_type, privilege.is_grantable
  `;

  const nonTargetColumnAcl = await database.sql<Snapshot['nonTargetColumnAcl']>`
    select relation.relname as relation_name,
           attribute.attname as column_name,
           grantor.rolname as grantor,
           grantee.rolname as grantee,
           upper(privilege.privilege_type) as privilege,
           privilege.is_grantable as grantable
      from pg_catalog.pg_attribute attribute
      join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      cross join lateral pg_catalog.aclexplode(attribute.attacl) privilege
      join pg_catalog.pg_roles grantor on grantor.oid = privilege.grantor
      join pg_catalog.pg_roles grantee on grantee.oid = privilege.grantee
     where namespace.nspname = 'public'
       and relation.relkind in ('r', 'p')
       and attribute.attnum > 0
       and not attribute.attisdropped
       and privilege.grantee not in (
         0::oid,
         (select oid from pg_catalog.pg_roles where rolname = 'anon'),
         (select oid from pg_catalog.pg_roles where rolname = 'authenticated')
       )
     order by relation.relname, attribute.attname, grantor.rolname, grantee.rolname,
              privilege.privilege_type, privilege.is_grantable
  `;

  const nonTargetDefaultAcl = await database.sql<Snapshot['nonTargetDefaultAcl']>`
    select creator.rolname as creator,
           grantor.rolname as grantor,
           case defaults.defaclnamespace
             when 0 then 'global'
             else namespace.nspname
           end as scope,
           defaults.defaclobjtype as object_type,
           case privilege.grantee
             when 0 then 'public'
             else grantee.rolname
           end as grantee,
           upper(privilege.privilege_type) as privilege,
           privilege.is_grantable as grantable
      from pg_catalog.pg_default_acl defaults
      cross join lateral pg_catalog.aclexplode(defaults.defaclacl) privilege
      join pg_catalog.pg_roles creator on creator.oid = defaults.defaclrole
      join pg_catalog.pg_roles grantor on grantor.oid = privilege.grantor
      left join pg_catalog.pg_namespace namespace on namespace.oid = defaults.defaclnamespace
      left join pg_catalog.pg_roles grantee on grantee.oid = privilege.grantee
     where defaults.defaclnamespace = 'public'::regnamespace
       and defaults.defaclobjtype in ('r', 'S')
       and privilege.grantee not in (
         (select oid from pg_catalog.pg_roles where rolname = 'anon'),
         (select oid from pg_catalog.pg_roles where rolname = 'authenticated')
       )
     order by creator.rolname, grantor.rolname, scope, object_type,
              grantee.rolname, privilege.privilege_type,
              privilege.is_grantable
  `;

  const platformDefaultAcl = await database.sql<Snapshot['platformDefaultAcl']>`
    select creator.rolname as creator,
           grantor.rolname as grantor,
           namespace.nspname as scope,
           defaults.defaclobjtype as object_type,
           grantee.rolname as grantee,
           upper(privilege.privilege_type) as privilege,
           privilege.is_grantable as grantable
      from pg_catalog.pg_default_acl defaults
      cross join lateral pg_catalog.aclexplode(defaults.defaclacl) privilege
      join pg_catalog.pg_roles creator on creator.oid = defaults.defaclrole
      join pg_catalog.pg_roles grantor on grantor.oid = privilege.grantor
      join pg_catalog.pg_roles grantee on grantee.oid = privilege.grantee
      join pg_catalog.pg_namespace namespace on namespace.oid = defaults.defaclnamespace
     where creator.rolname = 'supabase_admin'
       and namespace.nspname = 'public'
       and defaults.defaclobjtype in ('r', 'S')
       and grantee.rolname in ('anon', 'authenticated')
     order by creator, grantor, scope, object_type, grantee, privilege, grantable
  `;

  const helperNonTargetAcl = await database.sql<Snapshot['helperNonTargetAcl']>`
    select grantor.rolname as grantor,
           grantee.rolname as grantee,
           upper(privilege.privilege_type) as privilege,
           privilege.is_grantable as grantable
      from pg_catalog.pg_proc function
      cross join lateral pg_catalog.aclexplode(
        coalesce(function.proacl, pg_catalog.acldefault('f', function.proowner))
      ) privilege
      join pg_catalog.pg_roles grantor on grantor.oid = privilege.grantor
      join pg_catalog.pg_roles grantee on grantee.oid = privilege.grantee
     where function.oid = 'app.install_tenant_rls(regclass,text[])'::regprocedure
       and grantee.rolname not in ('anon', 'authenticated', 'service_role')
     order by grantor, grantee, privilege, grantable
  `;

  return {
    rowCounts,
    policies,
    nonTargetRelationAcl,
    nonTargetColumnAcl,
    nonTargetDefaultAcl,
    platformDefaultAcl,
    helperNonTargetAcl,
  };
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
    const apiRoles = await database.sql<
      Array<{
        rolname: string;
        rolinherit: boolean;
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
        rolreplication: boolean;
        rolcanlogin: boolean;
      }>
    >`
      select rolname, rolinherit, rolsuper, rolbypassrls, rolcreaterole,
             rolcreatedb, rolreplication, rolcanlogin
        from pg_catalog.pg_roles
       where rolname in ('anon', 'authenticated')
       order by rolname
    `;
    expect(apiRoles).toEqual([
      {
        rolname: 'anon',
        rolinherit: true,
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolcanlogin: false,
      },
      {
        rolname: 'authenticated',
        rolinherit: true,
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolcanlogin: false,
      },
    ]);

    await database.sql`
      do $$
      begin
        if not exists (
          select 1 from pg_catalog.pg_roles where rolname = 'wizard_preview'
        ) then
          create role wizard_preview nologin noinherit;
        end if;
      end;
      $$
    `;
    await database.sql`
      grant execute on function app.install_tenant_rls(regclass, text[])
      to wizard_preview
    `;
    await database.sql`grant select (id) on public.orgs to wizard_preview`;

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
    const [server] = await database.sql<{ version: number }[]>`
      select current_setting('server_version_num')::integer as version
    `;
    expect(before.platformDefaultAcl).toHaveLength((server?.version ?? 0) >= 170000 ? 22 : 20);
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
    const [preview] = await database.sql<{ execute: boolean }[]>`
      select has_function_privilege(
        'wizard_preview', 'app.install_tenant_rls(regclass,text[])', 'execute'
      ) as execute
    `;
    expect(preview?.execute).toBe(true);
    const [previewColumn] = await database.sql<{ select_id: boolean }[]>`
      select has_column_privilege(
        'wizard_preview', 'public.orgs', 'id', 'select'
      ) as select_id
    `;
    expect(previewColumn?.select_id).toBe(true);
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

  it('proves uncommitted schema and API-role drift can escape snapshots without the freeze', async () => {
    const concurrent = await createTestDatabase('relation_acl_uncommitted_creator', {
      throughMigration: BEFORE,
    });
    const pending = await concurrent.sql.reserve();
    try {
      await pending`begin`;
      await pending`
        create table public.wp186_uncommitted_relation (
          id uuid primary key,
          org_id uuid not null
        )
      `;
      await pending`alter table public.wp186_uncommitted_relation enable row level security`;
      await pending`
        create policy tenant_read on public.wp186_uncommitted_relation
        for select to authenticated using (app.is_org_member(org_id))
      `;
      await pending`grant select (id) on table public.orgs to public`;
      await pending`grant service_role to authenticated`;
      await pending`alter role authenticated bypassrls`;

      const [invisible] = await concurrent.sql<{
        relation: string | null;
        columnAclInvisible: boolean;
        membershipInvisible: boolean;
        bypassInvisible: boolean;
      }[]>`
        select
          to_regclass('public.wp186_uncommitted_relation')::text as relation,
          not exists (
            select 1
              from pg_catalog.pg_attribute attribute
              cross join lateral pg_catalog.aclexplode(attribute.attacl) privilege
             where attribute.attrelid = 'public.orgs'::regclass
               and attribute.attname = 'id'
               and privilege.grantee = 0
          ) as "columnAclInvisible",
          not pg_has_role('authenticated', 'service_role', 'member')
            as "membershipInvisible",
          not (
            select rolbypassrls
              from pg_catalog.pg_roles
             where rolname = 'authenticated'
          ) as "bypassInvisible"
      `;
      expect(invisible).toEqual({
        relation: null,
        columnAclInvisible: true,
        membershipInvisible: true,
        bypassInvisible: true,
      });

      await applySqlFile(concurrent, HARDENING);
      await pending`commit`;

      const [escaped] = await concurrent.sql<{
        table_truncate: boolean;
        table_select: boolean;
        public_column_acl: boolean;
        inherited_truncate: boolean;
        membership: boolean;
        bypassrls: boolean;
      }[]>`
        select
          has_table_privilege(
            'authenticated', 'public.wp186_uncommitted_relation', 'truncate'
          ) as table_truncate,
          has_table_privilege(
            'authenticated', 'public.wp186_uncommitted_relation', 'select'
          ) as table_select,
          exists (
            select 1
              from pg_catalog.pg_attribute attribute
              cross join lateral pg_catalog.aclexplode(attribute.attacl) privilege
             where attribute.attrelid = 'public.orgs'::regclass
               and attribute.attname = 'id'
               and privilege.grantee = 0
          ) as public_column_acl,
          has_table_privilege(
            'authenticated', 'public.orgs', 'truncate'
          ) as inherited_truncate,
          pg_has_role('authenticated', 'service_role', 'member') as membership,
          (
            select rolbypassrls
              from pg_catalog.pg_roles
             where rolname = 'authenticated'
          ) as bypassrls
      `;
      expect(escaped).toEqual({
        table_truncate: true,
        table_select: true,
        public_column_acl: true,
        inherited_truncate: true,
        membership: true,
        bypassrls: true,
      });
    } finally {
      await pending`rollback`.catch(() => {});
      await concurrent.sql`alter role authenticated nobypassrls`.catch(() => {});
      await concurrent.sql`revoke service_role from authenticated`.catch(() => {});
      pending.release();
      await concurrent.drop();
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

  it('accepts a brokered session whose current role is postgres', async () => {
    const brokered = await createTestDatabase('relation_acl_brokered', {
      throughMigration: BEFORE,
    });
    const brokerRole = `wp186_broker_${randomUUID().replaceAll('-', '')}`;
    try {
      await brokered.sql`create role ${brokered.sql(brokerRole)} noinherit`;
      await brokered.sql`grant postgres to ${brokered.sql(brokerRole)}`;
      const migration = await readFile(HARDENING, 'utf8');
      await brokered.sql.begin(async (sql) => {
        await sql`set local session authorization ${sql(brokerRole)}`;
        await sql`set local role postgres`;
        const [identity] = await sql<{ session_user: string; current_user: string }[]>`
          select session_user, current_user
        `;
        expect(identity).toEqual({ session_user: brokerRole, current_user: 'postgres' });
        await sql.unsafe(migration);
      });

      const [authority] = await brokered.sql<{
        relation_truncate: boolean;
        helper_execute: boolean;
      }[]>`
        select
          has_table_privilege(
            'authenticated', 'public.contextual_negative_exports', 'truncate'
          ) as relation_truncate,
          has_function_privilege(
            'authenticated', 'app.install_tenant_rls(regclass,text[])', 'execute'
          ) as helper_execute
      `;
      expect(authority).toEqual({ relation_truncate: false, helper_execute: false });
    } finally {
      await brokered.sql`revoke postgres from ${brokered.sql(brokerRole)}`.catch(() => {});
      await brokered.sql`drop role if exists ${brokered.sql(brokerRole)}`.catch(() => {});
      await brokered.drop();
    }
  }, 60_000);

  it('refuses a partial platform default matrix before changing any authority', async () => {
    const partial = await createTestDatabase('relation_acl_partial_platform', {
      throughMigration: BEFORE,
    });
    try {
      await partial.sql`
        alter default privileges for role supabase_admin in schema public
        revoke select on tables from anon
      `;
      const before = await snapshot(partial);
      const [authorityBefore] = await partial.sql<{ relation_truncate: boolean }[]>`
        select has_table_privilege(
          'authenticated', 'public.contextual_negative_exports', 'truncate'
        ) as relation_truncate
      `;
      expect(authorityBefore?.relation_truncate).toBe(true);

      await expect(applySqlFile(partial, HARDENING)).rejects.toMatchObject({ code: '22012' });

      expect(await snapshot(partial)).toEqual(before);
      const [authorityAfter] = await partial.sql<{ relation_truncate: boolean }[]>`
        select has_table_privilege(
          'authenticated', 'public.contextual_negative_exports', 'truncate'
        ) as relation_truncate
      `;
      expect(authorityAfter?.relation_truncate).toBe(true);
    } finally {
      await partial.drop();
    }
  }, 60_000);

  it('refuses a platform default grant option before changing any authority', async () => {
    const grantable = await createTestDatabase('relation_acl_platform_grantable', {
      throughMigration: BEFORE,
    });
    try {
      await grantable.sql`
        alter default privileges for role supabase_admin in schema public
        grant select on tables to authenticated with grant option
      `;
      const before = await snapshot(grantable);
      await expect(applySqlFile(grantable, HARDENING)).rejects.toMatchObject({ code: '22012' });
      expect(await snapshot(grantable)).toEqual(before);
    } finally {
      await grantable.drop();
    }
  }, 60_000);

  it('refuses an additive platform default with a foreign grantor', async () => {
    const badGrantor = await createTestDatabase('relation_acl_platform_bad_grantor', {
      throughMigration: BEFORE,
    });
    try {
      await badGrantor.sql`
        update pg_catalog.pg_default_acl
           set defaclacl = array_append(
             defaclacl,
             pg_catalog.makeaclitem(
               'authenticated'::regrole,
               'service_role'::regrole,
               'SELECT',
               false
             )
           )
         where defaclrole = 'supabase_admin'::regrole
           and defaclnamespace = 'public'::regnamespace
           and defaclobjtype = 'r'
      `;
      const before = await snapshot(badGrantor);
      await expect(applySqlFile(badGrantor, HARDENING)).rejects.toMatchObject({
        code: '22012',
      });
      expect(await snapshot(badGrantor)).toEqual(before);
    } finally {
      await badGrantor.drop();
    }
  }, 60_000);

  it('refuses public and delegated target column authority before mutation', async () => {
    const columnDrift = await createTestDatabase('relation_acl_column_drift', {
      throughMigration: BEFORE,
    });
    try {
      await columnDrift.sql`
        grant select (id), update (id), references (id)
        on public.orgs to public
      `;
      await columnDrift.sql`
        grant select (id) on public.orgs to authenticated with grant option
      `;
      const before = await snapshot(columnDrift);
      const [authorityBefore] = await columnDrift.sql<{
        publicSelect: boolean;
        authenticatedGrantable: boolean;
      }[]>`
        select
          has_column_privilege('anon', 'public.orgs', 'id', 'select') as "publicSelect",
          has_column_privilege(
            'authenticated', 'public.orgs', 'id', 'select with grant option'
          ) as "authenticatedGrantable"
      `;
      expect(authorityBefore).toEqual({
        publicSelect: true,
        authenticatedGrantable: true,
      });

      await expect(applySqlFile(columnDrift, HARDENING)).rejects.toMatchObject({
        code: '22012',
      });

      expect(await snapshot(columnDrift)).toEqual(before);
      const [authorityAfter] = await columnDrift.sql<{
        publicSelect: boolean;
        authenticatedGrantable: boolean;
      }[]>`
        select
          has_column_privilege('anon', 'public.orgs', 'id', 'select') as "publicSelect",
          has_column_privilege(
            'authenticated', 'public.orgs', 'id', 'select with grant option'
          ) as "authenticatedGrantable"
      `;
      expect(authorityAfter).toEqual(authorityBefore);
    } finally {
      await columnDrift.drop();
    }
  }, 60_000);

  it('refuses a public platform default before changing any authority', async () => {
    const publicDefault = await createTestDatabase('relation_acl_platform_public', {
      throughMigration: BEFORE,
    });
    try {
      await publicDefault.sql`
        alter default privileges for role supabase_admin in schema public
        grant select on tables to public
      `;
      const before = await snapshot(publicDefault);
      await expect(applySqlFile(publicDefault, HARDENING)).rejects.toMatchObject({
        code: '22012',
      });
      expect(await snapshot(publicDefault)).toEqual(before);
    } finally {
      await publicDefault.drop();
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

  it('rolls back every change when the final catalog guard fails', async () => {
    const finalFailure = await createTestDatabase('relation_acl_final_failure', {
      throughMigration: BEFORE,
    });
    try {
      const before = await snapshot(finalFailure);
      const [authorityBefore] = await finalFailure.sql<{
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
      expect(authorityBefore).toEqual({ helper_execute: true, relation_truncate: true });

      const migration = await readFile(HARDENING, 'utf8');
      const injected = migration.replace(
        '-- A second statement snapshot catches committed drift after the precondition',
        `grant truncate on table public.contextual_negative_exports to authenticated;\n\n` +
          '-- A second statement snapshot catches committed drift after the precondition',
      );
      expect(injected).not.toBe(migration);
      await expect(finalFailure.sql.unsafe(injected)).rejects.toMatchObject({ code: '22012' });

      expect(await snapshot(finalFailure)).toEqual(before);
      const [authorityAfter] = await finalFailure.sql<{
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
      expect(authorityAfter).toEqual(authorityBefore);
    } finally {
      await finalFailure.drop();
    }
  }, 60_000);

  it('rolls back a target column grant injected before the final guard', async () => {
    const finalColumnFailure = await createTestDatabase('relation_acl_final_column', {
      throughMigration: BEFORE,
    });
    try {
      const before = await snapshot(finalColumnFailure);
      const migration = await readFile(HARDENING, 'utf8');
      const injected = migration.replace(
        '-- A second statement snapshot catches committed drift after the precondition',
        `grant select (id) on table public.orgs to public;\n\n` +
          '-- A second statement snapshot catches committed drift after the precondition',
      );
      expect(injected).not.toBe(migration);
      await expect(finalColumnFailure.sql.unsafe(injected)).rejects.toMatchObject({
        code: '22012',
      });
      expect(await snapshot(finalColumnFailure)).toEqual(before);
      const [authority] = await finalColumnFailure.sql<{ noPublicColumnAcl: boolean }[]>`
        select not exists (
          select 1
            from pg_catalog.pg_attribute attribute
            cross join lateral pg_catalog.aclexplode(attribute.attacl) privilege
           where attribute.attrelid = 'public.orgs'::regclass
             and attribute.attname = 'id'
             and privilege.grantee = 0
        ) as "noPublicColumnAcl"
      `;
      expect(authority?.noPublicColumnAcl).toBe(true);
    } finally {
      await finalColumnFailure.drop();
    }
  }, 60_000);

  it.each([
    {
      name: 'membership',
      setup: 'create role wp186_inert_parent nologin noinherit;',
      inject: 'grant wp186_inert_parent to authenticated;',
      verify: `select not pg_has_role('authenticated', 'wp186_inert_parent', 'member') as restored`,
      cleanup: 'drop role if exists wp186_inert_parent;',
    },
    {
      name: 'bypassrls',
      setup: '',
      inject: 'alter role authenticated bypassrls;',
      verify: `select not rolbypassrls as restored from pg_roles where rolname = 'authenticated'`,
      cleanup: '',
    },
  ])('rolls back injected API-role $name drift', async ({ name, setup, inject, verify, cleanup }) => {
    const roleDrift = await createTestDatabase(`relation_acl_final_role_${name}`, {
      throughMigration: BEFORE,
    });
    try {
      if (setup !== '') await roleDrift.sql.unsafe(setup);
      const before = await snapshot(roleDrift);
      const migration = await readFile(HARDENING, 'utf8');
      const injected = migration.replace(
        '-- A second statement snapshot catches committed drift after the precondition',
        `${inject}\n\n` +
          '-- A second statement snapshot catches committed drift after the precondition',
      );
      expect(injected).not.toBe(migration);
      await expect(roleDrift.sql.unsafe(injected)).rejects.toMatchObject({ code: '22012' });
      expect(await snapshot(roleDrift)).toEqual(before);
      const [restored] = await roleDrift.sql.unsafe<{ restored: boolean }[]>(verify);
      expect(restored?.restored).toBe(true);
    } finally {
      if (cleanup !== '') await roleDrift.sql.unsafe(cleanup).catch(() => {});
      await roleDrift.drop();
    }
  }, 60_000);

  it('contains no top-level role or session-authorization change', async () => {
    const migration = await readFile(HARDENING, 'utf8');
    expect(migration).not.toMatch(
      /^\s*(?:set|reset)\s+(?:(?:local|session)\s+)?role\b/im,
    );
    expect(migration).not.toMatch(/^\s*set\s+session\s+authorization\b/im);
    expect(migration.trimEnd()).toMatch(
      /then 1 else 0 end as wp186_catalog_postcondition;$/,
    );
  });
});
