/**
 * WP-207 rehearsal: current main's legacy claim path against the hosted
 * 41-version schema, then the forward upgrade through the canonical 44-file
 * prefix, on a disposable database.
 *
 * Finding F1 in `docs/workpackages/REPLAN-2026-09-05.md`: the hosted ledger
 * stops at `20260901010000`, where `claim_sync_jobs` still returns rows
 * without `claim_token`. The shared parser in `packages/db` fails closed on
 * that row shape *after* the claim UPDATE has committed, so every tick strands
 * one `running` row and burns one attempt. This suite proves that exact
 * failure and committed row state, applies `20260901020000`, `030000` and
 * `040000` in order, recovers the stranded synthetic row explicitly, and
 * proves the reclaim succeeds tokenless with the same identity.
 *
 * The database package stays free of worker imports: this file lives in the
 * worker and reaches the harness through `@wizard-ads/db/testing`.
 *
 * Skipped only when no disposable database is reachable. It refuses a hosted
 * Supabase hostname outright rather than skipping: the rehearsal writes
 * schema, and the only acceptable target is a local or branch database.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminConnectionString,
  applySqlFile,
  createTestDatabase,
  databaseAvailable,
  migrationFiles,
  type TestDatabase,
} from '@wizard-ads/db/testing';
import type { ClaimedJob } from '@wizard-ads/db';
import type { EntitySyncJob } from '@wizard-ads/shared';
import { PostgresWorkerStore } from './store.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));

/** Repository file that closes the hosted 41-version ledger. */
const HOSTED_PREFIX_41_TERMINAL = '20260901010000_authenticated_relation_privilege_hardening.sql';
/** Versions applied in this order on top of the 41 files to reach the canonical 44-file prefix. */
const PREFIX_44_UPGRADE_VERSIONS = ['20260901020000', '20260901030000', '20260901040000'] as const;
/** Resolve a version to its single repository file without naming the file in source. */
function migrationFileForVersion(files: readonly string[], version: string): string {
  const matches = files.filter((file) => file.startsWith(`${version}_`));
  if (matches.length !== 1) throw new Error(`expected exactly one migration file for ${version}`);
  return matches[0] as string;
}

// Synthetic identities only. Nothing here corresponds to any tenant or profile.
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const PROFILE_ID = '22222222-2222-4222-8222-222222222222';
const WORKER_ID = 'wp207-rehearsal-worker';
const DEDUPE_KEY = 'wp207-rehearsal:entity.sync';

const PAYLOAD: EntitySyncJob = {
  type: 'entity.sync',
  orgId: ORG_ID,
  profileId: PROFILE_ID,
  full: false,
};

interface DurableRow {
  id: string;
  status: string;
  attempts: number;
  claimed_by: string | null;
  last_error: string | null;
  payload: unknown;
}

function refuseHostedTarget(connectionString: string): void {
  const host = new URL(connectionString).hostname.toLowerCase();
  if (host.includes('supabase.co')) {
    throw new Error(
      'store.hosted-prefix.test.ts refuses a hosted Supabase target; point ' +
        'WIZARD_ADS_TEST_DATABASE_URL at a disposable local or branch database',
    );
  }
}

const available = await databaseAvailable();

describe.skipIf(!available)('hosted 41-version prefix rehearsal', () => {
  let database: TestDatabase;
  let store: PostgresWorkerStore;
  let strandedJobId: string;

  async function durableRows(): Promise<DurableRow[]> {
    return database.sql<DurableRow[]>`
      select id, status::text as status, attempts, claimed_by, last_error, payload
        from public.sync_jobs
       order by created_at
    `;
  }

  async function claimTokenColumnCount(): Promise<number> {
    const rows = await database.sql<{ count: string }[]>`
      select count(*)::text as count
        from information_schema.columns
       where table_schema = 'public'
         and table_name = 'sync_jobs'
         and column_name = 'claim_token'
    `;
    return Number(rows[0]?.count ?? 'NaN');
  }

  beforeAll(async () => {
    refuseHostedTarget(adminConnectionString());
    // The tenant fixture seeds tables that only exist after later migrations,
    // so it cannot be applied to the 41-file prefix; the suite inserts the one
    // synthetic org and profile it needs by hand.
    database = await createTestDatabase('hosted_prefix', {
      throughMigration: HOSTED_PREFIX_41_TERMINAL,
      applyFixture: false,
    });
    store = new PostgresWorkerStore(database, { info: () => {} });
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('the repository files agree with the hosted 41-file boundary and the 44-file upgrade order', async () => {
    const files = await migrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(46);
    expect(files[40]).toBe(HOSTED_PREFIX_41_TERMINAL);
    const upgradeFiles = PREFIX_44_UPGRADE_VERSIONS.map((version) => migrationFileForVersion(files, version));
    expect(files.slice(41, 44)).toEqual(upgradeFiles);
    expect(await claimTokenColumnCount()).toBe(0);
  });

  it('a legacy claim against the 41-file schema throws after committing one running row', async () => {
    await database.sql`
      insert into public.orgs (id, slug, name)
      values (${ORG_ID}, 'wp207-rehearsal', 'WP-207 rehearsal org')
    `;
    await database.sql`
      insert into public.ad_profiles
        (id, org_id, amazon_profile_id, region, country_code, currency_code, timezone)
      values
        (${PROFILE_ID}, ${ORG_ID}, 'wp207-synthetic-profile', 'NA', 'US', 'USD', 'UTC')
    `;

    expect(await store.enqueue(PAYLOAD, new Date(), DEDUPE_KEY)).toBe(true);

    // Current main's parser reads `claim_token`; the 41-file `claim_sync_jobs`
    // does not return it, so the row parse fails closed. The UPDATE inside the
    // SQL function has already committed by then: that is the stranding.
    await expect(store.claim(WORKER_ID, 1)).rejects.toThrow(/invalid claim capability/);

    const rows = await durableRows();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (row === undefined) throw new Error('unreachable');
    strandedJobId = row.id;
    expect(row.status).toBe('running');
    expect(row.attempts).toBe(1);
    expect(row.claimed_by).toBe(WORKER_ID);
    expect(row.last_error).toBeNull();
    expect(row.payload).toEqual(PAYLOAD);
  });

  it('applying 020000, 030000 and 040000 in order reaches the 44-file prefix without touching the row', async () => {
    for (const file of upgradeFiles) {
      await applySqlFile(database, `${MIGRATIONS_DIR}${file}`);
    }

    expect(await claimTokenColumnCount()).toBe(1);

    const authority = await database.sql<{ protocol: string; epoch: string | number }[]>`
      select protocol, epoch from public.get_report_worker_claim_authority()
    `;
    expect(authority).toHaveLength(1);
    expect(authority[0]?.protocol).toBe('legacy');
    expect(Number(authority[0]?.epoch)).toBe(0);

    const rows = await database.sql<(DurableRow & { claim_token: string | null })[]>`
      select id, status::text as status, attempts, claimed_by, last_error, payload, claim_token
        from public.sync_jobs
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(strandedJobId);
    expect(rows[0]?.status).toBe('running');
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.claim_token).toBeNull();
  }, 120_000);

  it('explicit stale recovery revives exactly the one stranded row', async () => {
    // Zero interval: the row was claimed seconds ago, and the hosted cron
    // default of 30 minutes is the wrong question for an attended recovery.
    expect(await store.requeueStale('0 seconds')).toBe(1);

    const rows = await durableRows();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (row === undefined) throw new Error('unreachable');
    expect(row.id).toBe(strandedJobId);
    expect(row.status).toBe('queued');
    // Recovery does not refund the attempt the stranded claim consumed.
    expect(row.attempts).toBe(1);
    expect(row.claimed_by).toBeNull();
    expect(row.last_error).toBe('reclaimed: worker went away');

    // Nothing else was stale, so a second recovery finds nothing.
    expect(await store.requeueStale('0 seconds')).toBe(0);
  });

  it('the reclaim on the 44-file prefix returns exactly one tokenless job with the same identity', async () => {
    const jobs: ClaimedJob[] = await store.claim(WORKER_ID, 1);
    expect(jobs).toHaveLength(1);
    const [job] = jobs;
    if (job === undefined) throw new Error('unreachable');
    expect(job.id).toBe(strandedJobId);
    expect(job.claim).toBeNull();
    expect(job.jobType).toBe('entity.sync');
    expect(job.orgId).toBe(ORG_ID);
    expect(job.profileId).toBe(PROFILE_ID);
    expect(job.payload).toEqual(PAYLOAD);
    expect(job.claimedBy).toBe(WORKER_ID);
    expect(job.attempts).toBe(2);

    const rows = await database.sql<(DurableRow & { claim_token: string | null })[]>`
      select id, status::text as status, attempts, claimed_by, last_error, payload, claim_token
        from public.sync_jobs
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(strandedJobId);
    expect(rows[0]?.status).toBe('running');
    expect(rows[0]?.attempts).toBe(2);
    expect(rows[0]?.claim_token).toBeNull();

    // The queue held exactly one row; a second claim finds nothing.
    expect(await store.claim(WORKER_ID, 1)).toEqual([]);
  });
});
