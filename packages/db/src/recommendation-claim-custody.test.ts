import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { QuerySql } from './client.js';
import { expectRejection } from './testing/errors.js';
import {
  applySqlFile,
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from './testing/harness.js';
import { asServiceRole } from './testing/rls.js';

const available = await databaseAvailable();
const PREDECESSOR = '20260901050000_recommendation_preview_scopes.sql';
const MIGRATION = fileURLToPath(new URL(
  '../../../supabase/migrations/20260901060000_recommendation_claim_custody.sql',
  import.meta.url,
));
const REVISION = 'a'.repeat(40);
const NEXT_REVISION = 'b'.repeat(40);
const ACTOR = '96969696-9696-4969-8969-969696969696';

interface FixtureScope {
  orgId: string;
  profileId: string;
}

interface ScopedJob extends FixtureScope {
  jobId: string;
  runId: string;
  campaignIds: readonly string[];
}

interface ClaimedRow extends FixtureScope {
  id: string;
  job_type: string;
  claimed_by: string;
  claim_token: string;
}

describe.skipIf(!available)('recommendation claim custody migration upgrade', () => {
  const databases: TestDatabase[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.drop()));
  });

  it('upgrades populated WP-195 state without changing ledgers or activating custody', async () => {
    const database = await createTestDatabase('recommendation_custody_upgrade', {
      throughMigration: PREDECESSOR,
    });
    databases.push(database);
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('recommendation-custody-upgrade', ${ACTOR}::uuid, 'owner')
    `;
    if (org === undefined) throw new Error('tenant fixture is incomplete');
    const [profile] = await database.sql<{ profile_id: string }[]>`
      select id as profile_id from public.ad_profiles
       where org_id = ${org.seed_tenant_fixture}::uuid
    `;
    if (profile === undefined) throw new Error('tenant fixture is incomplete');
    const preMarkerJob = await enqueueScoped(
      database,
      { orgId: org.seed_tenant_fixture, profileId: profile.profile_id },
      ['pre-marker-wp195'],
      undefined,
      { omitExecutionLineage: true },
    );
    const [before] = await database.sql<{
      jobs: number;
      runs: number;
      recommendations: number;
      batches: number;
      campaigns: number;
    }[]>`
      select
        (select count(*)::integer from public.sync_jobs) as jobs,
        (select count(*)::integer from public.recommendation_runs) as runs,
        (select count(*)::integer from public.recommendations) as recommendations,
        (select count(*)::integer from public.recommendation_preview_batches) as batches,
        (select count(*)::integer from public.recommendation_run_campaigns) as campaigns
    `;

    await applySqlFile(database, MIGRATION);

    const [after] = await database.sql<{
      jobs: number;
      runs: number;
      recommendations: number;
      batches: number;
      campaigns: number;
      protocol: string;
      admission: string;
      epoch: string;
      authorized_revision: string | null;
    }[]>`
      select
        (select count(*)::integer from public.sync_jobs) as jobs,
        (select count(*)::integer from public.recommendation_runs) as runs,
        (select count(*)::integer from public.recommendations) as recommendations,
        (select count(*)::integer from public.recommendation_preview_batches) as batches,
        (select count(*)::integer from public.recommendation_run_campaigns) as campaigns,
        authority.protocol, authority.admission, authority.epoch,
        authority.authorized_revision
      from app.recommendation_claim_authority authority
      where authority.singleton
    `;
    expect(after).toEqual({
      ...before,
      protocol: 'legacy',
      admission: 'legacy',
      epoch: '0',
      authorized_revision: null,
    });
    const [closed] = await database.sql<{ closes: boolean }[]>`
      select app.recommendation_job_scope_closes(${preMarkerJob.jobId}::uuid) as closes
    `;
    expect(closed?.closes).toBe(true);
  });

  it('allows an in-flight legacy null-lineage queue run to finish without human classification', async () => {
    const database = await createTestDatabase('recommendation_custody_legacy_drain');
    databases.push(database);
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture(
        'recommendation-custody-legacy-drain', ${ACTOR}::uuid, 'owner'
      )
    `;
    if (org === undefined) throw new Error('tenant fixture is incomplete');
    const [profile] = await database.sql<{ profile_id: string }[]>`
      select id as profile_id from public.ad_profiles
       where org_id = ${org.seed_tenant_fixture}::uuid
    `;
    if (profile === undefined) throw new Error('tenant fixture is incomplete');
    const scope = { orgId: org.seed_tenant_fixture, profileId: profile.profile_id };
    const jobId = randomUUID();
    const runId = randomUUID();
    await asServiceRoleTransaction(database, async (tx) => {
      await tx`
        insert into public.sync_jobs
          (id, org_id, profile_id, job_type, payload, dedupe_key)
        values (
          ${jobId}::uuid, ${scope.orgId}::uuid, ${scope.profileId}::uuid,
          'recommendations.run',
          pg_catalog.jsonb_build_object(
            'type', 'recommendations.run', 'orgId', ${scope.orgId}::uuid,
            'profileId', ${scope.profileId}::uuid, 'runId', ${runId}::uuid,
            'lookbackDays', 7
          ),
          ${`wp196:legacy-drain:${jobId}`}
        )
      `;
      await tx`
        insert into public.recommendation_runs
          (id, org_id, profile_id, status, lookback_days, engine_version)
        values (
          ${runId}::uuid, ${scope.orgId}::uuid, ${scope.profileId}::uuid,
          'queued', 7, 'white-box-v1'
        )
      `;
    });
    const [claimed] = await asServiceRole(database, async (sql) => sql<{ id: string }[]>`
      select id from public.claim_sync_jobs(
        'legacy-recommendation-drain', 1,
        array['recommendations.run']::public.sync_job_type[]
      )
    `);
    expect(claimed?.id).toBe(jobId);

    await asServiceRoleTransaction(database, async (tx) => {
      await tx`
        update public.recommendation_runs
           set status = 'running', started_at = now() - interval '1 second'
         where id = ${runId}::uuid
      `;
      await tx`
        insert into public.recommendations
          (run_id, org_id, profile_id, reason, entity_type, entity_id,
           ad_product, field, current_value, proposed_value, inputs)
        values (
          ${runId}::uuid, ${scope.orgId}::uuid, ${scope.profileId}::uuid,
          'high_acos', 'keyword', 'legacy-drain-keyword', 'SP', 'bid',
          '1'::jsonb, '0.9'::jsonb, '{}'::jsonb
        )
      `;
      await tx`
        update public.recommendation_runs
           set status = 'succeeded', proposals_count = 1,
               window_start = date '2026-08-20', window_end = date '2026-08-26',
               finished_at = now(), error = null
         where id = ${runId}::uuid
      `;
      await tx`
        insert into public.audit_log
          (org_id, actor_type, action, target_type, target_id, payload, source)
        values (
          ${scope.orgId}::uuid, 'service', 'recommendation.run.succeeded',
          'recommendation_run', ${runId},
          pg_catalog.jsonb_build_object('engineVersion', 'white-box-v1', 'proposals', 1),
          'worker'
        )
      `;
    });
    await asServiceRole(database, async (sql) => sql`
      select public.finish_sync_job(${jobId}::uuid, 'succeeded', null, '{}'::jsonb, null)
    `);
    const [evidence] = await database.sql<{
      run_status: string;
      job_status: string;
      proposals: number;
    }[]>`
      select run.status::text as run_status, job.status::text as job_status,
             (select count(*)::integer from public.recommendations recommendation
               where recommendation.run_id = run.id) as proposals
        from public.recommendation_runs run
        join public.sync_jobs job on job.id = ${jobId}::uuid
       where run.id = ${runId}::uuid
    `;
    expect(evidence).toEqual({
      run_status: 'succeeded', job_status: 'succeeded', proposals: 1,
    });
  });

  it('keeps an exact armed claimant idle while fenced admission is blocked', async () => {
    const database = await createTestDatabase('recommendation_custody_blocked');
    databases.push(database);
    await asServiceRole(database, async (sql) => {
      await sql`select * from public.block_recommendation_admission(0)`;
      await sql`
        select * from public.activate_recommendation_fenced_claims(1, ${REVISION})
      `;
    });

    const claimed = await claimAsRecommendationWorker(database, 'worker-blocked-standby');
    expect(claimed).toEqual([]);
    const resumed = await asRecommendationWorker(database, async (sql) => sql<ClaimedRow[]>`
      select id, org_id, profile_id, job_type, claimed_by, claim_token
        from public.resume_recommendation_jobs_fenced('worker-blocked-standby', ${REVISION})
    `);
    expect(resumed).toEqual([]);
  });
});

describe.skipIf(!available)('exclusive recommendation claim custody', () => {
  let database: TestDatabase;
  let fixture: FixtureScope;
  let historicalRunId: string;

  beforeAll(async () => {
    database = await createTestDatabase('recommendation_custody');
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('recommendation-custody', ${ACTOR}::uuid, 'owner')
    `;
    if (org === undefined) throw new Error('tenant fixture is incomplete');
    const orgId = org.seed_tenant_fixture;
    const [profile] = await database.sql<{ profile_id: string }[]>`
      select id as profile_id from public.ad_profiles where org_id = ${orgId}::uuid
    `;
    if (profile === undefined) throw new Error('tenant fixture is incomplete');
    fixture = { orgId, profileId: profile.profile_id };
    historicalRunId = randomUUID();
    await database.sql`
      insert into public.recommendation_runs
        (id, org_id, profile_id, status, lookback_days, engine_version)
      values (${historicalRunId}::uuid, ${fixture.orgId}::uuid, ${fixture.profileId}::uuid,
              'queued', 7, 'historical-tokenless')
    `;

    await asServiceRole(database, async (sql) => {
      const [blocked] = await sql<{ decision: string; epoch: string }[]>`
        select decision, epoch from public.block_recommendation_admission(0)
      `;
      expect(blocked).toEqual({ decision: 'blocked', epoch: '1' });
      const [activated] = await sql<{
        decision: string;
        protocol: string;
        admission: string;
        epoch: string;
        authorized_revision: string;
      }[]>`
        select decision, protocol, admission, epoch, authorized_revision
          from public.activate_recommendation_fenced_claims(1, ${REVISION})
      `;
      expect(activated).toEqual({
        decision: 'activated',
        protocol: 'fenced',
        admission: 'blocked',
        epoch: '2',
        authorized_revision: REVISION,
      });
      const [authorized] = await sql<{
        decision: string;
        protocol: string;
        admission: string;
        epoch: string;
        authorized_revision: string;
      }[]>`
        select decision, protocol, admission, epoch, authorized_revision
          from public.authorize_recommendation_scoped_admission(2, ${REVISION})
      `;
      expect(authorized).toEqual({
        decision: 'authorized',
        protocol: 'fenced',
        admission: 'scoped',
        epoch: '3',
        authorized_revision: REVISION,
      });
    });
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('installs inert roles and gives the LOGIN role only the exact RPC surface', async () => {
    const roles = await database.sql<{
      rolname: string;
      rolcanlogin: boolean;
      rolinherit: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }[]>`
      select rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb,
             rolcreaterole, rolreplication, rolbypassrls
        from pg_catalog.pg_roles
       where rolname in ('openspell_recommendation_worker', 'openspell_recommendation_executor')
       order by rolname
    `;
    expect(roles).toEqual([
      {
        rolname: 'openspell_recommendation_executor', rolcanlogin: false,
        rolinherit: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false,
        rolreplication: false, rolbypassrls: false,
      },
      {
        rolname: 'openspell_recommendation_worker', rolcanlogin: false,
        rolinherit: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false,
        rolreplication: false, rolbypassrls: false,
      },
    ]);
    const [memberships] = await database.sql<{ unsafe: number }[]>`
      select count(*)::integer as unsafe
        from pg_catalog.pg_auth_members membership
       where membership.member in (
         'openspell_recommendation_worker'::regrole,
         'openspell_recommendation_executor'::regrole
       )
          or (
            membership.roleid in (
              'openspell_recommendation_worker'::regrole,
              'openspell_recommendation_executor'::regrole
            )
            and (
              membership.member <> current_user::regrole
              or membership.inherit_option
              or membership.set_option
            )
          )
    `;
    expect(memberships?.unsafe).toBe(0);

    const policies = await database.sql<{
      tablename: string;
      policyname: string;
      cmd: string;
      roles: string[];
    }[]>`
      select tablename, policyname, cmd, roles
        from pg_catalog.pg_policies
       where 'openspell_recommendation_executor' = any(roles)
       order by tablename, cmd, policyname
    `;
    expect(policies.map((row) => `${row.tablename}:${row.cmd}:${row.policyname}`)).toEqual([
      'ad_groups:SELECT:recommendation_executor_select',
      'ad_profiles:SELECT:recommendation_executor_select',
      'apply_batches:SELECT:recommendation_executor_select',
      'apply_rows:SELECT:recommendation_executor_select',
      'audit_log:INSERT:recommendation_executor_insert',
      'bid_series_daily:SELECT:recommendation_executor_select',
      'campaigns:SELECT:recommendation_executor_select',
      'fact_profile_daily:SELECT:recommendation_executor_select',
      'fact_sb_daily:SELECT:recommendation_executor_select',
      'fact_sd_daily:SELECT:recommendation_executor_select',
      'fact_sp_target_daily:SELECT:recommendation_executor_select',
      'keywords:SELECT:recommendation_executor_select',
      'product_ads:SELECT:recommendation_executor_select',
      'rank_observations:SELECT:recommendation_executor_select',
      'recommendation_observations:SELECT:recommendation_executor_select',
      'recommendation_preview_batches:SELECT:recommendation_executor_select',
      'recommendation_run_campaigns:SELECT:recommendation_executor_select',
      'recommendation_runs:SELECT:recommendation_executor_select',
      'recommendation_runs:UPDATE:recommendation_executor_update',
      'recommendations:INSERT:recommendation_executor_insert',
      'recommendations:SELECT:recommendation_executor_select',
      'sync_jobs:SELECT:recommendation_executor_select',
      'sync_jobs:UPDATE:recommendation_executor_update',
      'targets:SELECT:recommendation_executor_select',
    ]);
    expect(policies.every((policy) =>
      policy.roles.length === 1 && policy.roles[0] === 'openspell_recommendation_executor'
    )).toBe(true);

    const functions = await database.sql<{
      schema_name: string;
      function_name: string;
    }[]>`
      select namespace.nspname as schema_name,
             procedure.proname || '(' || pg_catalog.pg_get_function_identity_arguments(procedure.oid)
               || ')' as function_name
        from pg_catalog.pg_proc procedure
        join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
       where namespace.nspname not in ('pg_catalog', 'information_schema')
         and namespace.nspname not like 'pg_toast%'
         -- Installed only by the disposable tenant fixture, never by a migration.
         and procedure.proname <> 'auth_user_stub'
         and pg_catalog.has_schema_privilege(
           'openspell_recommendation_worker', namespace.oid, 'USAGE'
         )
         and pg_catalog.has_function_privilege(
           'openspell_recommendation_worker', procedure.oid, 'EXECUTE'
         )
       order by namespace.nspname, procedure.proname,
                pg_catalog.pg_get_function_identity_arguments(procedure.oid)
    `;
    expect(functions.map((row) => `${row.schema_name}.${row.function_name}`)).toEqual([
      'public.claim_recommendation_jobs_fenced(p_worker_id text, p_revision text, p_limit integer)',
      'public.defer_recommendation_job_fenced(p_job_id uuid, p_worker_id text, p_claim_token uuid, p_revision text, p_retry_in interval)',
      'public.fail_recommendation_run_fenced(p_job_id uuid, p_worker_id text, p_claim_token uuid, p_revision text, p_org_id uuid, p_profile_id uuid, p_run_id uuid, p_group_id uuid, p_error text)',
      'public.finish_recommendation_job_fenced(p_job_id uuid, p_worker_id text, p_claim_token uuid, p_revision text, p_status sync_job_status, p_error text, p_result jsonb, p_retry_in interval)',
      'public.get_recommendation_claim_authority()',
      'public.get_recommendation_cutover_evidence()',
      'public.get_recommendation_worker_authority()',
      'public.read_recommendation_inputs_fenced(p_job_id uuid, p_worker_id text, p_claim_token uuid, p_revision text, p_org_id uuid, p_profile_id uuid, p_run_id uuid, p_group_id uuid, p_window_start date, p_window_end date)',
      'public.resume_recommendation_jobs_fenced(p_worker_id text, p_revision text)',
      'public.start_recommendation_run_fenced(p_job_id uuid, p_worker_id text, p_claim_token uuid, p_revision text, p_org_id uuid, p_profile_id uuid, p_run_id uuid, p_group_id uuid)',
      'public.succeed_recommendation_run_fenced(p_job_id uuid, p_worker_id text, p_claim_token uuid, p_revision text, p_org_id uuid, p_profile_id uuid, p_run_id uuid, p_group_id uuid, p_completion jsonb)',
    ]);

    const [direct] = await database.sql<{
      queue_read: boolean;
      run_update: boolean;
      recommendation_insert: boolean;
      audit_insert: boolean;
      vault_read: boolean;
    }[]>`
      select
        pg_catalog.has_table_privilege('openspell_recommendation_worker',
          'public.sync_jobs', 'SELECT') as queue_read,
        pg_catalog.has_table_privilege('openspell_recommendation_worker',
          'public.recommendation_runs', 'UPDATE') as run_update,
        pg_catalog.has_table_privilege('openspell_recommendation_worker',
          'public.recommendations', 'INSERT') as recommendation_insert,
        pg_catalog.has_table_privilege('openspell_recommendation_worker',
          'public.audit_log', 'INSERT') as audit_insert,
        pg_catalog.has_table_privilege('openspell_recommendation_worker',
          'vault.secrets', 'SELECT') as vault_read
    `;
    expect(direct).toEqual({
      queue_read: false,
      run_update: false,
      recommendation_insert: false,
      audit_insert: false,
      vault_read: false,
    });

    await expectRejection(
      asRecommendationWorker(database, async (sql) => sql`select * from public.sync_jobs limit 1`),
      /permission denied/i,
    );
    await expectRejection(
      asRecommendationWorker(database, async (sql) => sql`
        select * from public.claim_sync_jobs('foreign-lane', 1)
      `),
      /permission denied/i,
    );
    await expect(
      asServiceRole(database, async (sql) => sql`
        select * from public.get_recommendation_claim_authority()
      `),
    ).resolves.toHaveLength(1);
    await expectRejection(
      asServiceRole(database, async (sql) => sql`
        select * from public.get_recommendation_worker_authority()
      `),
      /permission denied|recommendation-worker only/i,
    );
    const [evidence] = await asRecommendationWorker(database, async (sql) => sql<{
      protocol: string;
      admission: string;
      epoch: string;
      authorized_revision: string;
      queued_jobs: number;
      running_jobs: number;
      token_bearing_jobs: number;
      invalid_active_scopes: number;
    }[]>`
      select * from public.get_recommendation_cutover_evidence()
    `);
    expect(evidence).toEqual({
      protocol: 'fenced', admission: 'scoped', epoch: '3', authorized_revision: REVISION,
      queued_jobs: 0, running_jobs: 0, token_bearing_jobs: 0, invalid_active_scopes: 0,
    });
  });

  it('matches Node bytewise fingerprints including UUID normalization and non-ASCII ids', async () => {
    const profileUpper = fixture.profileId.toUpperCase();
    const groupUpper = 'ABABABAB-ABAB-4BAB-8BAB-ABABABABABAB';
    const campaigns = ['campaign-\u{10000}', 'campaign-\uE000', 'campaign-ä', 'campaign-a'];
    const [row] = await database.sql<{ batch: string; run: string }[]>`
      select
        app.recommendation_batch_scope_fingerprint(
          ${profileUpper}::uuid, ${campaigns}::text[]
        ) as batch,
        app.recommendation_run_scope_fingerprint(
          ${profileUpper}::uuid, ${groupUpper}::uuid, ${campaigns}::text[]
        ) as run
    `;
    expect(row).toEqual({
      batch: scopeFingerprint(
        'openspell.recommendation-preview.batch-scope.v1',
        [fixture.profileId, ...bytewiseSorted(campaigns)],
      ),
      run: scopeFingerprint(
        'openspell.recommendation-preview.run-scope.v1',
        [fixture.profileId, groupUpper.toLowerCase(), ...bytewiseSorted(campaigns)],
      ),
    });
  });

  it('admits only transaction-complete scope-v1 jobs and rolls partial evidence back', async () => {
    const badJob = randomUUID();
    await expectRejection(
      asServiceRole(database, async (sql) => sql`
        insert into public.sync_jobs
          (id, org_id, profile_id, job_type, payload, dedupe_key)
        values (
          ${badJob}::uuid, ${fixture.orgId}::uuid, ${fixture.profileId}::uuid,
          'recommendations.run',
          pg_catalog.jsonb_build_object(
            'type', 'recommendations.run', 'orgId', ${fixture.orgId}::uuid,
            'profileId', ${fixture.profileId}::uuid, 'runId', ${randomUUID()}::uuid,
            'lookbackDays', 7
          ),
          ${`wp196:bad:${badJob}`}
        )
      `),
      /scope.*does not close/i,
    );
    const [count] = await database.sql<{ count: number }[]>`
      select count(*)::integer as count from public.sync_jobs where id = ${badJob}::uuid
    `;
    expect(count?.count).toBe(0);

    const accepted = await enqueueScoped(database, fixture, ['campaign-z', 'campaign-a']);
    const [closed] = await database.sql<{ closes: boolean }[]>`
      select app.recommendation_job_scope_closes(${accepted.jobId}::uuid) as closes
    `;
    expect(closed?.closes).toBe(true);
    const staleProducerJobId = randomUUID();
    await expectRejection(
      enqueueScoped(
        database,
        fixture,
        ['pre-marker-after-scoped-gate'],
        undefined,
        { jobId: staleProducerJobId, omitExecutionLineage: true },
      ),
      /scoped recommendation admission evidence does not close/i,
    );
    const [staleProducerCount] = await database.sql<{ count: number }[]>`
      select count(*)::integer as count from public.sync_jobs
       where id = ${staleProducerJobId}::uuid
    `;
    expect(staleProducerCount?.count).toBe(0);
    const [claimed] = await claimAsRecommendationWorker(database, 'worker-admission-proof');
    expect(claimed?.id).toBe(accepted.jobId);
    await settleClaim(database, claimed!);
  });

  it('rejects malformed claimant identity, revision and limit before queue mutation', async () => {
    await expectRejection(
      asRecommendationWorker(database, async (sql) => sql`
        select * from public.claim_recommendation_jobs_fenced('', ${REVISION}, 1)
      `),
      /identity, revision or limit is invalid/i,
    );
    await expectRejection(
      asRecommendationWorker(database, async (sql) => sql`
        select * from public.claim_recommendation_jobs_fenced('worker-invalid-limit', ${REVISION}, 2)
      `),
      /identity, revision or limit is invalid/i,
    );
    await expectRejection(
      asRecommendationWorker(database, async (sql) => sql`
        select * from public.claim_recommendation_jobs_fenced(
          'worker-invalid-revision', ${REVISION.toUpperCase()}, 1
        )
      `),
      /identity, revision or limit is invalid/i,
    );
    await expectRejection(
      asRecommendationWorker(database, async (sql) => sql`
        select * from public.resume_recommendation_jobs_fenced(
          'worker-foreign-revision', ${NEXT_REVISION}
        )
      `),
      /authority does not match/i,
    );
  });

  it('binds run start and failure writes to the exact claim and tenant tuple', async () => {
    const queued = await enqueueScoped(database, fixture, ['claim-bound-run']);
    const [claim] = await claimAsRecommendationWorker(database, 'worker-run-custody');
    expect(claim?.id).toBe(queued.jobId);
    if (claim === undefined) throw new Error('recommendation claim missing');

    await expectRejection(
      asRecommendationWorker(database, async (sql) => sql`
        select * from public.start_recommendation_run_fenced(
          ${claim.id}::uuid, ${claim.claimed_by}, ${randomUUID()}::uuid, ${REVISION},
          ${fixture.orgId}::uuid, ${fixture.profileId}::uuid, ${queued.runId}::uuid, null
        )
      `),
      /custody is stale or mismatched/i,
    );
    const [unchanged] = await database.sql<{ status: string; audits: number }[]>`
      select run.status::text as status,
             (select count(*)::integer from public.audit_log audit
               where audit.target_id = run.id::text
                 and audit.action in ('recommendation.run.succeeded', 'recommendation.run.failed'))
               as audits
        from public.recommendation_runs run where run.id = ${queued.runId}::uuid
    `;
    expect(unchanged).toEqual({ status: 'queued', audits: 0 });

    const [started] = await asRecommendationWorker(database, async (sql) => sql<{
      decision: string;
    }[]>`
      select decision from public.start_recommendation_run_fenced(
        ${claim.id}::uuid, ${claim.claimed_by}, ${claim.claim_token}::uuid, ${REVISION},
        ${fixture.orgId}::uuid, ${fixture.profileId}::uuid, ${queued.runId}::uuid, null
      )
    `);
    expect(started?.decision).toBe('started');
    await expectRejection(
      asRecommendationWorker(database, async (sql) => sql`
        select * from public.fail_recommendation_run_fenced(
          ${claim.id}::uuid, ${claim.claimed_by}, ${claim.claim_token}::uuid, ${REVISION},
          ${randomUUID()}::uuid, ${fixture.profileId}::uuid, ${queued.runId}::uuid, null,
          'synthetic failure'
        )
      `),
      /custody is stale or mismatched/i,
    );
    const [failed] = await asRecommendationWorker(database, async (sql) => sql<{
      decision: string;
    }[]>`
      select decision from public.fail_recommendation_run_fenced(
        ${claim.id}::uuid, ${claim.claimed_by}, ${claim.claim_token}::uuid, ${REVISION},
        ${fixture.orgId}::uuid, ${fixture.profileId}::uuid, ${queued.runId}::uuid, null,
        'synthetic failure'
      )
    `);
    expect(failed?.decision).toBe('failed');
    const [evidence] = await database.sql<{ status: string; audits: number }[]>`
      select run.status::text as status,
             (select count(*)::integer from public.audit_log audit
               where audit.target_id = run.id::text
                 and audit.action = 'recommendation.run.failed') as audits
        from public.recommendation_runs run where run.id = ${queued.runId}::uuid
    `;
    expect(evidence).toEqual({ status: 'failed', audits: 1 });
    const [settled] = await asRecommendationWorker(database, async (sql) => sql<{
      decision: string;
      status: string;
    }[]>`
      select decision, status from public.finish_recommendation_job_fenced(
        ${claim.id}::uuid, ${claim.claimed_by}, ${claim.claim_token}::uuid, ${REVISION},
        'dead', 'synthetic permanent failure', null, null
      )
    `);
    expect(settled).toEqual({ decision: 'settled', status: 'dead' });
  });

  it('makes claim-bound success atomic and rejects a substituted capability with zero artifacts', async () => {
    const campaignId = 'claim-bound-success';
    const queued = await enqueueScoped(database, fixture, [campaignId]);
    const [claim] = await claimAsRecommendationWorker(database, 'worker-success-custody');
    expect(claim?.id).toBe(queued.jobId);
    if (claim === undefined) throw new Error('recommendation claim missing');

    await expectRejection(
      asRecommendationWorker(database, async (sql) => sql`
        select * from public.start_recommendation_run_fenced(
          ${claim.id}::uuid, ${claim.claimed_by}, ${claim.claim_token}::uuid, ${REVISION},
          ${randomUUID()}::uuid, ${fixture.profileId}::uuid, ${queued.runId}::uuid, null
        )
      `),
      /custody is stale or mismatched/i,
    );
    await asRecommendationWorker(database, async (sql) => sql`
      select * from public.start_recommendation_run_fenced(
        ${claim.id}::uuid, ${claim.claimed_by}, ${claim.claim_token}::uuid, ${REVISION},
        ${fixture.orgId}::uuid, ${fixture.profileId}::uuid, ${queued.runId}::uuid, null
      )
    `);
    const [run] = await database.sql<{
      lookback_days: number;
      strategy_snapshot: unknown;
    }[]>`
      select lookback_days, strategy_snapshot
        from public.recommendation_runs
       where id = ${queued.runId}::uuid
    `;
    if (run === undefined) throw new Error('recommendation run missing');
    const completion = {
      proposals: [{
        reason: 'high_acos',
        entityRef: {
          entityType: 'keyword',
          entityId: 'claim-bound-success-keyword',
          adProduct: 'SP',
          profileId: fixture.profileId,
          campaignId,
          adGroupId: null,
          name: 'synthetic keyword',
        },
        field: 'bid',
        currentValue: 1,
        proposedValue: 0.9,
        inputs: {},
        preconditionNotes: [{
          code: 'synthetic_precondition', message: 'Synthetic precondition evidence.',
        }],
      }],
      lookbackDays: run.lookback_days,
      window: { start: '2026-01-01', end: '2026-01-07' },
      strategySnapshot: run.strategy_snapshot,
      narrative: { qualitative: [], decisions: [] },
    };

    await expectRejection(
      asRecommendationWorker(database, async (sql) => sql`
        select * from public.read_recommendation_inputs_fenced(
          ${claim.id}::uuid, ${claim.claimed_by}, ${claim.claim_token}::uuid, ${REVISION},
          ${randomUUID()}::uuid, ${fixture.profileId}::uuid, ${queued.runId}::uuid, null,
          '2026-01-01'::date, '2026-01-07'::date
        )
      `),
      /custody is stale or mismatched/i,
    );
    const [inputEvidence] = await asRecommendationWorker(database, async (sql) => sql<{
      inputs: unknown;
      group_safety: unknown;
    }[]>`
      select inputs, group_safety from public.read_recommendation_inputs_fenced(
        ${claim.id}::uuid, ${claim.claimed_by}, ${claim.claim_token}::uuid, ${REVISION},
        ${fixture.orgId}::uuid, ${fixture.profileId}::uuid, ${queued.runId}::uuid, null,
        '2026-01-01'::date, '2026-01-07'::date
      )
    `);
    expect(inputEvidence?.inputs).toEqual(expect.objectContaining({
      targets: expect.any(Array), campaigns: expect.any(Array), profileFacts: expect.any(Array),
    }));

    await expectRejection(
      asRecommendationWorker(database, async (sql) => sql`
        select * from public.succeed_recommendation_run_fenced(
          ${claim.id}::uuid, ${claim.claimed_by}, ${randomUUID()}::uuid, ${REVISION},
          ${fixture.orgId}::uuid, ${fixture.profileId}::uuid, ${queued.runId}::uuid, null,
          ${JSON.stringify(completion)}::text::jsonb
        )
      `),
      /custody is stale or mismatched/i,
    );
    await expectRejection(
      asRecommendationWorker(database, async (sql) => sql`
        select * from public.succeed_recommendation_run_fenced(
          ${claim.id}::uuid, ${claim.claimed_by}, ${claim.claim_token}::uuid, ${REVISION},
          ${randomUUID()}::uuid, ${fixture.profileId}::uuid, ${queued.runId}::uuid, null,
          ${JSON.stringify(completion)}::text::jsonb
        )
      `),
      /custody is stale or mismatched/i,
    );
    const [beforeSuccess] = await database.sql<{
      status: string;
      proposals: number;
      audits: number;
    }[]>`
      select run.status::text as status,
             (select count(*)::integer from public.recommendations recommendation
               where recommendation.run_id = run.id) as proposals,
             (select count(*)::integer from public.audit_log audit
               where audit.target_id = run.id::text
                 and audit.action = 'recommendation.run.succeeded') as audits
        from public.recommendation_runs run where run.id = ${queued.runId}::uuid
    `;
    expect(beforeSuccess).toEqual({ status: 'running', proposals: 0, audits: 0 });

    const [succeeded] = await asRecommendationWorker(database, async (sql) => sql<{
      decision: string;
      proposals_count: number;
    }[]>`
      select decision, proposals_count from public.succeed_recommendation_run_fenced(
        ${claim.id}::uuid, ${claim.claimed_by}, ${claim.claim_token}::uuid, ${REVISION},
        ${fixture.orgId}::uuid, ${fixture.profileId}::uuid, ${queued.runId}::uuid, null,
        ${JSON.stringify(completion)}::text::jsonb
      )
    `);
    expect(succeeded).toEqual({ decision: 'succeeded', proposals_count: 1 });
    const [evidence] = await database.sql<{
      status: string;
      proposals_count: number;
      proposals: number;
      success_audits: number;
      precondition_audits: number;
    }[]>`
      select run.status::text as status, run.proposals_count,
             (select count(*)::integer from public.recommendations recommendation
               where recommendation.run_id = run.id) as proposals,
             (select count(*)::integer from public.audit_log audit
               where audit.target_id = run.id::text
                 and audit.action = 'recommendation.run.succeeded') as success_audits,
             (select count(*)::integer
                from public.audit_log audit
                join public.recommendations recommendation
                  on recommendation.id::text = audit.target_id
               where recommendation.run_id = run.id
                 and audit.action = 'recommendation.preconditions.noted') as precondition_audits
        from public.recommendation_runs run where run.id = ${queued.runId}::uuid
    `;
    expect(evidence).toEqual({
      status: 'succeeded', proposals_count: 1, proposals: 1,
      success_audits: 1, precondition_audits: 1,
    });
    await settleClaim(database, claim);
  });

  it('serializes concurrent claimers to one non-expiring global claim and exact settlement', async () => {
    const first = await enqueueScoped(database, fixture, ['claim-a']);
    const second = await enqueueScoped(database, fixture, ['claim-b']);
    const [left, right] = await Promise.all([
      claimAsRecommendationWorker(database, 'worker-a'),
      claimAsRecommendationWorker(database, 'worker-b'),
    ]);
    const claimed = [...left, ...right];
    expect(claimed).toHaveLength(1);
    const active = claimed[0]!;
    expect([first.jobId, second.jobId]).toContain(active.id);
    expect(active.claim_token).toMatch(/^[0-9a-f-]{36}$/);

    const resumed = await asRecommendationWorker(database, async (sql) => sql<ClaimedRow[]>`
      select id, org_id as "orgId", profile_id as "profileId", job_type,
             claimed_by, claim_token
        from public.resume_recommendation_jobs_fenced(${active.claimed_by}, ${REVISION})
    `);
    expect(resumed.map((row) => row.id)).toEqual([active.id]);

    const [stale] = await asRecommendationWorker(database, async (sql) => sql<{
      decision: string;
      status: string | null;
    }[]>`
      select decision, status
        from public.finish_recommendation_job_fenced(
          ${active.id}::uuid, ${active.claimed_by}, ${randomUUID()}::uuid, ${REVISION},
          'succeeded', null, '{}'::jsonb, null
        )
    `);
    expect(stale).toEqual({ decision: 'stale_claim', status: null });

    const [settled] = await asRecommendationWorker(database, async (sql) => sql<{
      decision: string;
      status: string;
    }[]>`
      select decision, status
        from public.finish_recommendation_job_fenced(
          ${active.id}::uuid, ${active.claimed_by}, ${active.claim_token}::uuid, ${REVISION},
          'succeeded', null, '{}'::jsonb, null
        )
    `);
    expect(settled).toEqual({ decision: 'settled', status: 'succeeded' });

    const replacement = await claimAsRecommendationWorker(database, 'worker-b');
    expect(replacement).toHaveLength(1);
    expect(replacement[0]?.id).not.toBe(active.id);
    await settleClaim(database, replacement[0]!);
  });

  it('consumes one attempt per retry and dead-letters a persistent failure', async () => {
    const queued = await enqueueScoped(database, fixture, ['retry-budget']);
    const [budget] = await database.sql<{ max_attempts: number }[]>`
      select max_attempts from public.sync_jobs where id = ${queued.jobId}::uuid
    `;
    if (budget === undefined) throw new Error('recommendation retry budget missing');

    for (let attempt = 1; attempt <= budget.max_attempts; attempt += 1) {
      const [claim] = await claimAsRecommendationWorker(database, 'worker-retry-budget');
      expect(claim?.id).toBe(queued.jobId);
      if (claim === undefined) throw new Error('recommendation retry claim missing');
      const [result] = await asRecommendationWorker(database, async (sql) => sql<{
        decision: string;
        status: string;
        attempts: number;
      }[]>`
        select decision, status, attempts
          from public.finish_recommendation_job_fenced(
            ${claim.id}::uuid, ${claim.claimed_by}, ${claim.claim_token}::uuid, ${REVISION},
            'failed', 'retryable recommendation execution failure', null, interval '0'
          )
      `);
      expect(result).toEqual({
        decision: 'settled',
        status: attempt < budget.max_attempts ? 'queued' : 'dead',
        attempts: attempt,
      });
    }
    const [terminal] = await database.sql<{
      status: string;
      attempts: number;
      claim_token: string | null;
    }[]>`
      select status::text as status, attempts, claim_token
        from public.sync_jobs where id = ${queued.jobId}::uuid
    `;
    expect(terminal).toEqual({
      status: 'dead', attempts: budget.max_attempts, claim_token: null,
    });
  });

  it('defers only the exact capability without consuming an execution attempt', async () => {
    const queued = await enqueueScoped(database, fixture, ['defer-capability']);
    const [claim] = await claimAsRecommendationWorker(database, 'worker-defer-capability');
    expect(claim?.id).toBe(queued.jobId);
    if (claim === undefined) throw new Error('recommendation defer claim missing');

    const [stale] = await asRecommendationWorker(database, async (sql) => sql<{
      decision: string;
      status: string | null;
      attempts: number | null;
    }[]>`
      select decision, status, attempts from public.defer_recommendation_job_fenced(
        ${claim.id}::uuid, ${claim.claimed_by}, ${randomUUID()}::uuid, ${REVISION}, interval '0'
      )
    `);
    expect(stale).toEqual({ decision: 'stale_claim', status: null, attempts: null });
    const [deferred] = await asRecommendationWorker(database, async (sql) => sql<{
      decision: string;
      status: string;
      attempts: number;
    }[]>`
      select decision, status, attempts from public.defer_recommendation_job_fenced(
        ${claim.id}::uuid, ${claim.claimed_by}, ${claim.claim_token}::uuid, ${REVISION}, interval '0'
      )
    `);
    expect(deferred).toEqual({ decision: 'deferred', status: 'queued', attempts: 0 });
    const [replacement] = await claimAsRecommendationWorker(database, 'worker-defer-capability');
    expect(replacement?.id).toBe(queued.jobId);
    const [attempts] = await database.sql<{ attempts: number }[]>`
      select attempts from public.sync_jobs where id = ${queued.jobId}::uuid
    `;
    expect(attempts?.attempts).toBe(1);
    await settleClaim(database, replacement!);
  });

  it('keeps legacy/report work available while excluding recommendation claims and finishes', async () => {
    const recommendation = await enqueueScoped(database, fixture, ['legacy-excluded']);
    const entityJob = randomUUID();
    await asServiceRole(database, async (sql) => sql`
      insert into public.sync_jobs
        (id, org_id, profile_id, job_type, payload, dedupe_key)
      values (
        ${entityJob}::uuid, ${fixture.orgId}::uuid, ${fixture.profileId}::uuid,
        'entity.sync',
        pg_catalog.jsonb_build_object(
          'type', 'entity.sync', 'orgId', ${fixture.orgId}::uuid,
          'profileId', ${fixture.profileId}::uuid, 'full', false
        ),
        ${`wp196:entity:${entityJob}`}
      )
    `);
    const claimed = await asServiceRole(database, async (sql) => sql<{
      id: string;
      job_type: string;
    }[]>`
      select id, job_type::text as job_type
        from public.claim_sync_jobs(
          'legacy-general', 10,
          array['entity.sync', 'recommendations.run']::public.sync_job_type[]
        )
    `);
    expect(claimed).toEqual([{ id: entityJob, job_type: 'entity.sync' }]);
    await asServiceRole(database, async (sql) => sql`
      select public.finish_sync_job(${entityJob}::uuid, 'succeeded', null, null, null)
    `);

    const [forced] = await database.sql<{ claim_token: string }[]>`
      update public.sync_jobs
         set status = 'running', claimed_by = 'stale-tokenless', claimed_at = now()
       where id = ${recommendation.jobId}::uuid
      returning gen_random_uuid()::text as claim_token
    `;
    expect(forced?.claim_token).toBeDefined();
    await expectRejection(
      asServiceRole(database, async (sql) => sql`
        select public.finish_sync_job(
          ${recommendation.jobId}::uuid, 'succeeded', null, null, null
        )
      `),
      /not authoritative for fenced custody/i,
    );
    await database.sql`
      update public.sync_jobs
         set status = 'queued', claimed_by = null, claimed_at = null
       where id = ${recommendation.jobId}::uuid
    `;
    const custom = await claimAsRecommendationWorker(database, 'worker-legacy-proof');
    expect(custom.map((row) => row.id)).toContain(recommendation.jobId);
    await settleClaim(database, custom[0]!);
  });

  it('isolates an invalid generic recommendation schedule from unrelated due work', async () => {
    const recommendationSchedule = randomUUID();
    const rankSchedule = randomUUID();
    await database.sql`
      insert into public.sync_schedules
        (id, org_id, profile_id, job_type, cadence, next_run_at, variant)
      values
        (${recommendationSchedule}::uuid, ${fixture.orgId}::uuid, ${fixture.profileId}::uuid,
         'recommendations.run', interval '1 day', now() - interval '1 minute', 'wp196-poison'),
        (${rankSchedule}::uuid, ${fixture.orgId}::uuid, ${fixture.profileId}::uuid,
         'rank.sync', interval '1 day', now() - interval '1 minute', 'wp196-control')
    `;
    const rows = await asServiceRole(database, async (sql) => sql<{
      schedule_id: string;
      enqueued: boolean;
    }[]>`
      select schedule_id, enqueued from public.enqueue_due_schedules()
    `);
    expect(rows.filter((row) =>
      row.schedule_id === recommendationSchedule || row.schedule_id === rankSchedule
    )).toEqual([{ schedule_id: rankSchedule, enqueued: true }]);
    const schedules = await database.sql<{
      id: string;
      last_enqueued_at: Date | null;
    }[]>`
      select id, last_enqueued_at from public.sync_schedules
       where id in (${recommendationSchedule}::uuid, ${rankSchedule}::uuid)
       order by id
    `;
    expect(schedules.find((row) => row.id === recommendationSchedule)?.last_enqueued_at).toBeNull();
    expect(schedules.find((row) => row.id === rankSchedule)?.last_enqueued_at).not.toBeNull();
  });

  it('rejects old direct writers with zero artifacts but preserves exact human N-gram lineage', async () => {
    await expectRejection(
      asServiceRole(database, async (sql) => sql`
        update public.recommendation_runs set status = 'running'
         where id = ${historicalRunId}::uuid
      `),
      /requires narrow custody/i,
    );

    const queueRun = await enqueueScoped(database, fixture, ['direct-write-block']);
    await expectRejection(
      asServiceRole(database, async (sql) => sql`
        insert into public.recommendations
          (run_id, org_id, profile_id, reason, entity_type, entity_id,
           ad_product, field, current_value, proposed_value, inputs)
        values (
          ${queueRun.runId}::uuid, ${fixture.orgId}::uuid, ${fixture.profileId}::uuid,
          'high_acos', 'keyword', 'blocked-direct', 'SP', 'bid', '1'::jsonb,
          '0.9'::jsonb, '{}'::jsonb
        )
      `),
      /requires narrow custody/i,
    );
    const [blockedCount] = await database.sql<{ count: number }[]>`
      select count(*)::integer as count from public.recommendations
       where run_id = ${queueRun.runId}::uuid
    `;
    expect(blockedCount?.count).toBe(0);

    const humanRun = randomUUID();
    await asServiceRoleTransaction(database, async (tx) => {
      await tx`
        insert into public.recommendation_runs
          (id, org_id, profile_id, status, lookback_days, engine_version,
           proposals_count, started_at, finished_at)
        values (
          ${humanRun}::uuid, ${fixture.orgId}::uuid, ${fixture.profileId}::uuid,
          'succeeded', 30, 'ngram-explorer', 1, now(), now()
        )
      `;
      await tx`
        insert into public.recommendations
          (run_id, org_id, profile_id, reason, entity_type, entity_id,
           ad_product, field, current_value, proposed_value, inputs)
        values (
          ${humanRun}::uuid, ${fixture.orgId}::uuid, ${fixture.profileId}::uuid,
          'flag', 'negative', 'synthetic-search-term', 'SP', 'negative_keyword',
          null, ${JSON.stringify('synthetic-search-term')}::jsonb, '{}'::jsonb
        )
      `;
      await tx`
        insert into public.audit_log
          (org_id, actor_type, action, target_type, target_id, payload, source)
        values (
          ${fixture.orgId}::uuid, 'user', 'recommendation.proposed',
          'recommendation_run', ${humanRun},
          pg_catalog.jsonb_build_object('source', 'ngram-explorer', 'proposals', 1),
          'web'
        )
      `;
    });
    const [humanCount] = await database.sql<{ count: number }[]>`
      select count(*)::integer as count from public.recommendations
       where run_id = ${humanRun}::uuid
    `;
    expect(humanCount?.count).toBe(1);

    const forcedEarlyRun = randomUUID();
    await expectRejection(
      asServiceRoleTransaction(database, async (tx) => {
        await tx`
          insert into public.recommendation_runs
            (id, org_id, profile_id, status, lookback_days, engine_version,
             proposals_count, started_at, finished_at)
          values (
            ${forcedEarlyRun}::uuid, ${fixture.orgId}::uuid, ${fixture.profileId}::uuid,
            'succeeded', 30, 'ngram-explorer', 1, now(), now()
          )
        `;
        await tx`
          insert into public.recommendations
            (run_id, org_id, profile_id, reason, entity_type, entity_id,
             ad_product, field, proposed_value, inputs)
          values (
            ${forcedEarlyRun}::uuid, ${fixture.orgId}::uuid, ${fixture.profileId}::uuid,
            'flag', 'negative', 'first-human-proposal', 'SP', 'negative_keyword',
            ${JSON.stringify('first-human-proposal')}::jsonb, '{}'::jsonb
          )
        `;
        await tx`
          insert into public.audit_log
            (org_id, actor_type, action, target_type, target_id, payload, source)
          values (
            ${fixture.orgId}::uuid, 'user', 'recommendation.proposed',
            'recommendation_run', ${forcedEarlyRun},
            pg_catalog.jsonb_build_object('source', 'ngram-explorer', 'proposals', 1),
            'web'
          )
        `;
        await tx.unsafe('set constraints recommendation_runs_human_lineage_validate immediate');
        await tx`
          insert into public.recommendations
            (run_id, org_id, profile_id, reason, entity_type, entity_id,
             ad_product, field, proposed_value, inputs)
          values (
            ${forcedEarlyRun}::uuid, ${fixture.orgId}::uuid, ${fixture.profileId}::uuid,
            'flag', 'negative', 'late-same-transaction-append', 'SP', 'negative_keyword',
            ${JSON.stringify('late-same-transaction-append')}::jsonb, '{}'::jsonb
          )
        `;
      }),
      /human recommendation lineage is incomplete or mixed/i,
    );
    const [forcedEarlyCount] = await database.sql<{ runs: number; proposals: number }[]>`
      select
        (select count(*)::integer from public.recommendation_runs
          where id = ${forcedEarlyRun}::uuid) as runs,
        (select count(*)::integer from public.recommendations
          where run_id = ${forcedEarlyRun}::uuid) as proposals
    `;
    expect(forcedEarlyCount).toEqual({ runs: 0, proposals: 0 });

    await expectRejection(
      asServiceRole(database, async (sql) => sql`
        insert into public.recommendations
          (run_id, org_id, profile_id, reason, entity_type, entity_id,
           ad_product, field, proposed_value, inputs)
        values (
          ${humanRun}::uuid, ${fixture.orgId}::uuid, ${fixture.profileId}::uuid,
          'flag', 'negative', 'late-append', 'SP', 'negative_keyword',
          ${JSON.stringify('late-append')}::jsonb, '{}'::jsonb
        )
      `),
      /cannot accept later proposals/i,
    );
    const [claimedQueueRun] = await claimAsRecommendationWorker(database, 'worker-direct-proof');
    expect(claimedQueueRun?.id).toBe(queueRun.jobId);
    await settleClaim(database, claimedQueueRun!);
  });

  it('serializes admission changes before or after complete producer transactions', async () => {
    let releaseProducer = () => {};
    let producerHeld = () => {};
    const releaseProducerPromise = new Promise<void>((resolve) => { releaseProducer = resolve; });
    const producerHeldPromise = new Promise<void>((resolve) => { producerHeld = resolve; });
    const admittedPromise = enqueueScoped(
      database,
      fixture,
      ['admission-before-block'],
      async () => {
        producerHeld();
        await releaseProducerPromise;
      },
    );
    await producerHeldPromise;
    const blockAfterPromise = asServiceRole(database, async (sql) => sql<{
      decision: string;
      epoch: string;
    }[]>`
      select decision, epoch from public.block_recommendation_admission(3)
    `);
    releaseProducer();
    const [admitted, [blockedAfter]] = await Promise.all([admittedPromise, blockAfterPromise]);
    expect(blockedAfter).toEqual({ decision: 'blocked', epoch: '4' });
    const [closed] = await database.sql<{ closes: boolean }[]>`
      select app.recommendation_job_scope_closes(${admitted.jobId}::uuid) as closes
    `;
    expect(closed?.closes).toBe(true);
    await asServiceRole(database, async (sql) => {
      await sql`delete from public.recommendation_runs where id = ${admitted.runId}::uuid`;
      await sql`delete from public.sync_jobs where id = ${admitted.jobId}::uuid`;
    });
    const [reopened] = await asServiceRole(database, async (sql) => sql<{
      decision: string;
      epoch: string;
    }[]>`
      select decision, epoch
        from public.authorize_recommendation_scoped_admission(4, ${REVISION})
    `);
    expect(reopened).toEqual({ decision: 'authorized', epoch: '5' });

    let releaseBlock = () => {};
    let blockHeld = () => {};
    let blockedBefore: { decision: string; epoch: string } | undefined;
    const releaseBlockPromise = new Promise<void>((resolve) => { releaseBlock = resolve; });
    const blockHeldPromise = new Promise<void>((resolve) => { blockHeld = resolve; });
    const blockBeforePromise = asServiceRoleTransaction(database, async (sql) => {
      [blockedBefore] = await sql<{ decision: string; epoch: string }[]>`
        select decision, epoch from public.block_recommendation_admission(5)
      `;
      blockHeld();
      await releaseBlockPromise;
    });
    await blockHeldPromise;
    const refusedJobId = randomUUID();
    const refusedPromise = enqueueScoped(
      database,
      fixture,
      ['admission-after-block'],
      undefined,
      { jobId: refusedJobId },
    );
    releaseBlock();
    await blockBeforePromise;
    expect(blockedBefore).toEqual({ decision: 'blocked', epoch: '6' });
    await expectRejection(refusedPromise, /admission is blocked/i);
    const [refusedCount] = await database.sql<{ count: number }[]>`
      select count(*)::integer as count from public.sync_jobs where id = ${refusedJobId}::uuid
    `;
    expect(refusedCount?.count).toBe(0);
    const [reopenedAgain] = await asServiceRole(database, async (sql) => sql<{
      decision: string;
      epoch: string;
    }[]>`
      select decision, epoch
        from public.authorize_recommendation_scoped_admission(6, ${REVISION})
    `);
    expect(reopenedAgain).toEqual({ decision: 'authorized', epoch: '7' });
  });

  it('requires blocked zero-custody state for exact revision rebind', async () => {
    const pending = await enqueueScoped(database, fixture, ['rebind-pending']);
    const claimed = await claimAsRecommendationWorker(database, 'worker-rebind');
    expect(claimed[0]?.id).toBe(pending.jobId);
    const [blocked] = await asServiceRole(database, async (sql) => sql<{
      decision: string;
      epoch: string;
    }[]>`
      select decision, epoch from public.block_recommendation_admission(7)
    `);
    expect(blocked).toEqual({ decision: 'blocked', epoch: '8' });
    const [refused] = await asServiceRole(database, async (sql) => sql<{
      decision: string;
      unresolved: number;
    }[]>`
      select decision, unresolved
        from public.rebind_recommendation_fenced_revision(
          8, ${REVISION}, ${NEXT_REVISION}
        )
    `);
    expect(refused).toEqual({ decision: 'unresolved', unresolved: 1 });
    await settleClaim(database, claimed[0]!);
    const [rebound] = await asServiceRole(database, async (sql) => sql<{
      decision: string;
      epoch: string;
      authorized_revision: string;
    }[]>`
      select decision, epoch, authorized_revision
        from public.rebind_recommendation_fenced_revision(
          8, ${REVISION}, ${NEXT_REVISION}
        )
    `);
    expect(rebound).toEqual({
      decision: 'rebound', epoch: '9', authorized_revision: NEXT_REVISION,
    });
    await expectRejection(
      claimAsRecommendationWorker(database, 'old-revision-worker'),
      /authority does not match/i,
    );
  });
});

async function enqueueScoped(
  database: TestDatabase,
  scope: FixtureScope,
  campaignIds: readonly string[],
  beforeCommit?: () => Promise<void>,
  identity: { jobId?: string; runId?: string; omitExecutionLineage?: boolean } = {},
): Promise<ScopedJob> {
  const jobId = identity.jobId ?? randomUUID();
  const runId = identity.runId ?? randomUUID();
  const fingerprint = scopeFingerprint(
    'openspell.recommendation-preview.run-scope.v1',
    [scope.profileId.toLowerCase(), 'unassigned', ...bytewiseSorted(campaignIds)],
  );
  const strategy = {
    schema: 'wizard-ads.tenant-strategy.v1', pacing: {}, opt_groups: {},
    rank_lifecycle: {}, staged_apply: {}, bids: {}, sv_bands: {}, caps: {},
    pat_split: {}, naming: {},
  };
  await asServiceRoleTransaction(database, async (tx) => {
    await tx`
      insert into public.sync_jobs
        (id, org_id, profile_id, job_type, payload, dedupe_key)
      values (
        ${jobId}::uuid, ${scope.orgId}::uuid, ${scope.profileId}::uuid,
        'recommendations.run',
        pg_catalog.jsonb_build_object(
          'type', 'recommendations.run', 'orgId', ${scope.orgId}::uuid,
          'profileId', ${scope.profileId}::uuid, 'runId', ${runId}::uuid,
          'lookbackDays', 7
        ),
        ${`wp196:recommendation:${jobId}`}
      )
    `;
    if (identity.omitExecutionLineage === true) {
      await tx`
        insert into public.recommendation_runs
          (id, org_id, profile_id, status, lookback_days, strategy_snapshot,
           strategy_goal, scope_version, scope_count, scope_fingerprint, job_id,
           engine_version)
        values (
          ${runId}::uuid, ${scope.orgId}::uuid, ${scope.profileId}::uuid,
          'queued', 7, ${JSON.stringify(strategy)}::jsonb, 'neutral', 1,
          ${campaignIds.length}, ${fingerprint}, ${jobId}::uuid,
          'white-box-v1'
        )
      `;
    } else {
      await tx`
        insert into public.recommendation_runs
          (id, org_id, profile_id, status, lookback_days, strategy_snapshot,
           strategy_goal, scope_version, scope_count, scope_fingerprint, job_id,
           engine_version, execution_lineage)
        values (
          ${runId}::uuid, ${scope.orgId}::uuid, ${scope.profileId}::uuid,
          'queued', 7, ${JSON.stringify(strategy)}::jsonb, 'neutral', 1,
          ${campaignIds.length}, ${fingerprint}, ${jobId}::uuid,
          'white-box-v1', 'queue'
        )
      `;
    }
    for (const campaignId of campaignIds) {
      await tx`
        insert into public.recommendation_run_campaigns
          (org_id, profile_id, batch_id, run_id, campaign_id)
        values (
          ${scope.orgId}::uuid, ${scope.profileId}::uuid, null,
          ${runId}::uuid, ${campaignId}
        )
      `;
    }
    if (beforeCommit !== undefined) await beforeCommit();
  });
  return { ...scope, jobId, runId, campaignIds };
}

async function asRecommendationWorker<T>(
  database: TestDatabase,
  fn: (sql: QuerySql) => Promise<T>,
): Promise<T> {
  const reserved = await database.sql.reserve();
  try {
    await reserved.unsafe('set session authorization openspell_recommendation_worker');
    return await fn(reserved);
  } finally {
    await reserved.unsafe('reset session authorization').catch(() => {});
    reserved.release();
  }
}

async function asServiceRoleTransaction(
  database: TestDatabase,
  fn: (sql: QuerySql) => Promise<void>,
): Promise<void> {
  await database.sql.begin(async (tx) => {
    await tx.unsafe('set local role service_role');
    await fn(tx);
  });
}

async function claimAsRecommendationWorker(
  database: TestDatabase,
  workerId: string,
): Promise<ClaimedRow[]> {
  return asRecommendationWorker(database, async (sql) => sql<ClaimedRow[]>`
    select id, org_id as "orgId", profile_id as "profileId", job_type,
           claimed_by, claim_token
      from public.claim_recommendation_jobs_fenced(${workerId}, ${REVISION}, 1)
  `);
}

async function settleClaim(database: TestDatabase, claim: ClaimedRow): Promise<void> {
  const [settled] = await asRecommendationWorker(database, async (sql) => sql<{
    decision: string;
    status: string;
  }[]>`
    select decision, status
      from public.finish_recommendation_job_fenced(
        ${claim.id}::uuid, ${claim.claimed_by}, ${claim.claim_token}::uuid, ${REVISION},
        'succeeded', null, '{}'::jsonb, null
      )
  `);
  expect(settled).toEqual({ decision: 'settled', status: 'succeeded' });
}

function bytewiseSorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function scopeFingerprint(domain: string, values: readonly string[]): string {
  const hash = createHash('sha256');
  hash.update(`${domain}\n`);
  for (const value of values) {
    hash.update(`${Buffer.byteLength(value, 'utf8')}:`);
    hash.update(value);
    hash.update('\n');
  }
  return hash.digest('hex');
}
