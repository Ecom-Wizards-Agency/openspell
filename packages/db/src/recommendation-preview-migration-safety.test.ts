import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from './client.js';
import {
  applySqlFile,
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from './testing/harness.js';

const available = await databaseAvailable();
const PREDECESSOR = '20260901040000_fenced_sync_claims.sql';
const MIGRATION = fileURLToPath(new URL(
  '../../../supabase/migrations/20260901050000_recommendation_preview_scopes.sql',
  import.meta.url,
));

describe.skipIf(!available)('recommendation preview scope migration safety', () => {
  const databases: TestDatabase[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.drop()));
  });

  it('upgrades populated predecessor state without changing legacy ledger counts', async () => {
    const database = await createTestDatabase('preview_scope_upgrade', {
      throughMigration: PREDECESSOR,
    });
    databases.push(database);
    await database.sql`
      select app.seed_tenant_fixture(
        'preview-scope-upgrade',
        '78787878-7878-4787-8787-787878787878'::uuid,
        'owner'
      )
    `;
    const [profile] = await database.sql<{ org_id: string; profile_id: string }[]>`
      select org_id, id as profile_id from public.ad_profiles order by id limit 1
    `;
    if (!profile) throw new Error('tenant fixture profile missing');
    await database.sql`
      insert into public.recommendation_runs
        (org_id, profile_id, status, lookback_days, engine_version, started_at, finished_at)
      values (${profile.org_id}, ${profile.profile_id}, 'succeeded', 7,
              'synthetic-legacy-engine', now(), now())
    `;
    const [before] = await database.sql<{
      runs: number;
      recommendations: number;
      jobs: number;
    }[]>`
      select
        (select count(*)::integer from public.recommendation_runs) as runs,
        (select count(*)::integer from public.recommendations) as recommendations,
        (select count(*)::integer from public.sync_jobs) as jobs
    `;
    expect(before?.runs).toBeGreaterThan(0);

    await applySqlFile(database, MIGRATION);

    const [after] = await database.sql<{
      runs: number;
      recommendations: number;
      jobs: number;
      legacy_scoped: number;
    }[]>`
      select
        (select count(*)::integer from public.recommendation_runs) as runs,
        (select count(*)::integer from public.recommendations) as recommendations,
        (select count(*)::integer from public.sync_jobs) as jobs,
        (select count(*)::integer from public.recommendation_runs
          where engine_version = 'synthetic-legacy-engine' and scope_version is not null) as legacy_scoped
    `;
    expect(after).toEqual({ ...before, legacy_scoped: 0 });
  });

  it('fails at the bounded shared DDL lock, rolls back, then replays cleanly', async () => {
    const database = await createTestDatabase('preview_scope_lock', {
      throughMigration: PREDECESSOR,
      applyFixture: false,
    });
    databases.push(database);
    const gate = createDb({ connectionString: database.connectionString, max: 1 });
    const contender = createDb({ connectionString: database.connectionString, max: 1 });
    let release = () => {};
    let held = () => {};
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const heldPromise = new Promise<void>((resolve) => { held = resolve; });
    const lock = gate.sql.begin(async (sql) => {
      await sql`
        select pg_advisory_xact_lock(
          pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0)
        )
      `;
      held();
      await releasePromise;
    });

    try {
      await heldPromise;
      const started = Date.now();
      await expect(applySqlFile(contender, MIGRATION)).rejects.toMatchObject({ code: '55P03' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
      const [absent] = await database.sql<{ present: boolean }[]>`
        select to_regclass('public.recommendation_preview_batches') is not null as present
      `;
      expect(absent?.present).toBe(false);
      release();
      await lock;
      await applySqlFile(contender, MIGRATION);
      const [present] = await database.sql<{ present: boolean }[]>`
        select to_regclass('public.recommendation_preview_batches') is not null as present
      `;
      expect(present?.present).toBe(true);
    } finally {
      release();
      await Promise.allSettled([lock]);
      await Promise.all([gate.close(), contender.close()]);
    }
  }, 15_000);
});
