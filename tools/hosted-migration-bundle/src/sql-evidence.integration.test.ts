import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HOSTED_MIGRATION_BUNDLE_POLICY } from './policy.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const EVIDENCE_ROOT = join(REPO_ROOT, 'tools', 'hosted-migration-bundle', 'sql');
const SHIM = join(REPO_ROOT, 'supabase', 'tests', 'supabase-platform-shim.sql');
const EXACT_HISTORY_WORKDIR = process.env['WP197_EXACT_HISTORY_WORKDIR'];
const ADMIN_URL =
  process.env['WIZARD_ADS_TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://postgres:postgres@127.0.0.1:54322/postgres';

interface EvidenceRow {
  readonly pass: boolean;
  readonly check_key?: string;
  readonly selectedEvidenceScript?: string;
  readonly outOfScopePrivilegeFingerprint?: string;
}

interface PrefixObservation {
  readonly prefix: number;
  readonly probe: EvidenceRow[];
  readonly evidence: EvidenceRow[];
}

interface MutationObservation {
  readonly name: string;
  readonly evidence: EvidenceRow[];
  readonly proof: 'embedded_failure' | 'fingerprint_change';
  readonly baselineFingerprint?: string;
}

class RollbackProof extends Error {}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/u.test(value)) throw new Error('unsafe disposable database name');
  return `"${value}"`;
}

function collectRows(value: unknown): EvidenceRow[] {
  if (!Array.isArray(value)) return [];
  const rows: EvidenceRow[] = [];
  for (const item of value) {
    if (Array.isArray(item)) {
      rows.push(...collectRows(item));
    } else if (item !== null && typeof item === 'object' && 'pass' in item) {
      rows.push(item as EvidenceRow);
    }
  }
  return rows;
}

async function readEvidence(
  run: (source: string) => Promise<unknown>,
  filename: string,
  insideTransaction = false,
): Promise<EvidenceRow[]> {
  let source = await readFile(join(EVIDENCE_ROOT, filename), 'utf8');
  if (insideTransaction) {
    source = source
      .replace(/^begin transaction isolation level repeatable read read only;\s*$/mu, '')
      .replace(/^rollback;\s*$/mu, '');
  }
  return collectRows(await run(source));
}

async function databaseAvailable(): Promise<boolean> {
  if (EXACT_HISTORY_WORKDIR === undefined) return false;
  const sql = postgres(ADMIN_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => undefined);
  }
}

const available = await databaseAvailable();

describe.skipIf(!available)('exact hosted migration SQL evidence', () => {
  const prefixes: PrefixObservation[] = [];
  const mutations: MutationObservation[] = [];
  let databaseName = '';
  let databaseSql: ReturnType<typeof postgres> | undefined;
  let restrictedProbe: EvidenceRow[] = [];
  let restrictedEvidence: EvidenceRow[] = [];

  async function recordPrefix(prefix: number): Promise<void> {
    const sql = databaseSql!;
    const selected = `wp-197-hosted-migration-prefix-${prefix}.sql`;
    prefixes.push({
      prefix,
      probe: await readEvidence((source) => sql.unsafe(source), 'wp-197-hosted-migration-probe.sql'),
      evidence: await readEvidence((source) => sql.unsafe(source), selected),
    });
  }

  async function recordMutation(
    name: string,
    prefix: number,
    statement: string,
    proof: MutationObservation['proof'] = 'embedded_failure',
  ): Promise<void> {
    const sql = databaseSql!;
    let evidence: EvidenceRow[] = [];
    const baselineFingerprint = prefixes.at(-1)?.evidence[0]?.outOfScopePrivilegeFingerprint;
    try {
      await sql.begin(async (transaction) => {
        await transaction.unsafe(statement);
        evidence = await readEvidence(
          (source) => transaction.unsafe(source),
          `wp-197-hosted-migration-prefix-${prefix}.sql`,
          true,
        );
        throw new RollbackProof();
      });
    } catch (error: unknown) {
      if (!(error instanceof RollbackProof)) throw error;
    }
    mutations.push({ name, evidence, proof, baselineFingerprint });
  }

  beforeAll(async () => {
    const historyRoot = EXACT_HISTORY_WORKDIR!;
    let phase = 'create disposable database';
    try {
    const adminSql = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    databaseName = `wizard_ads_wp197_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    try {
      await adminSql.unsafe(`create database ${quoteIdentifier(databaseName)}`);
    } finally {
      await adminSql.end({ timeout: 5 });
    }

    databaseSql = postgres(withDatabase(ADMIN_URL, databaseName), {
      max: 1,
      onnotice: () => {},
    });
    const sql = databaseSql;
    const applyFile = async (path: string): Promise<void> => {
      const source = await readFile(path, 'utf8');
      await sql.unsafe(source);
    };
    phase = 'apply platform shim';
    await applyFile(SHIM);
    // The generic plain-PostgreSQL shim deliberately simulates Supabase's
    // broad creator defaults. The exact hosted WP-186 precondition observed no
    // API-role defaults for supabase_admin, so remove only that
    // shim-only difference before replaying the byte-authoritative history.
    await sql.unsafe(
      'alter default privileges for role supabase_admin in schema public ' +
      'revoke all on tables from anon, authenticated, service_role; ' +
      'alter default privileges for role supabase_admin in schema public ' +
      'revoke all on sequences from anon, authenticated, service_role;',
    );
    await sql.unsafe(
      'create schema supabase_migrations; ' +
      'create table supabase_migrations.schema_migrations (version text primary key);',
    );

    const historyMigrations = join(historyRoot, 'supabase', 'migrations');
    const historyNames = (await readdir(historyMigrations))
      .filter((name) => name.endsWith('.sql'))
      .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
    expect(historyNames).toEqual(HOSTED_MIGRATION_BUNDLE_POLICY.baseline.map((entry) => entry.filename));
    phase = 'apply exact hosted baseline';
    for (const entry of HOSTED_MIGRATION_BUNDLE_POLICY.baseline) {
      const path = join(historyMigrations, entry.filename);
      const bytes = await readFile(path);
      expect({ byteCount: bytes.byteLength, sha256: sha256(bytes) }).toEqual({
        byteCount: entry.byteCount,
        sha256: entry.sha256,
      });
      await sql.begin(async (transaction) => {
        await transaction.unsafe(bytes.toString('utf8'));
        await transaction.unsafe(
          'insert into supabase_migrations.schema_migrations (version) values ($1)',
          [entry.filename.slice(0, 14)],
        );
      });
    }

    phase = 'record prefix 41';
    await recordPrefix(41);
    const firstAddition = HOSTED_MIGRATION_BUNDLE_POLICY.additions[0]!;
    const firstAdditionBytes = await readFile(join(REPO_ROOT, firstAddition.repositoryPath));
    expect({ byteCount: firstAdditionBytes.byteLength, sha256: sha256(firstAdditionBytes) }).toEqual({
      byteCount: firstAddition.byteCount,
      sha256: firstAddition.sha256,
    });
    let injectedFailureObserved = false;
    try {
      await sql.begin(async (transaction) => {
        await transaction.unsafe(firstAdditionBytes.toString('utf8'));
        await transaction.unsafe(
          'insert into supabase_migrations.schema_migrations (version) values ($1)',
          [firstAddition.filename.slice(0, 14)],
        );
        throw new RollbackProof();
      });
    } catch (error: unknown) {
      if (!(error instanceof RollbackProof)) throw error;
      injectedFailureObserved = true;
    }
    expect(injectedFailureObserved).toBe(true);
    await recordPrefix(41);

    phase = 'apply additions and adversarial checks';
    for (const [index, addition] of HOSTED_MIGRATION_BUNDLE_POLICY.additions.entries()) {
      const bytes = await readFile(join(REPO_ROOT, addition.repositoryPath));
      expect({ byteCount: bytes.byteLength, sha256: sha256(bytes) }).toEqual({
        byteCount: addition.byteCount,
        sha256: addition.sha256,
      });
      await sql.begin(async (transaction) => {
        await transaction.unsafe(bytes.toString('utf8'));
        await transaction.unsafe(
          'insert into supabase_migrations.schema_migrations (version) values ($1)',
          [addition.filename.slice(0, 14)],
        );
      });
      const prefix = 42 + index;
      await recordPrefix(prefix);

      if (prefix === 42) {
        await recordMutation(
          'wp187 RLS disabled',
          prefix,
          'alter table public.sp_write_plans disable row level security',
        );
        await recordMutation(
          'wp187 immutable trigger removed',
          prefix,
          'drop trigger sp_write_plans_immutable on public.sp_write_plans',
        );
      }
      if (prefix === 45) {
        await recordMutation(
          'wp195 tenant policy widened',
          prefix,
          'alter policy tenant_read on public.recommendation_preview_batches using (true)',
        );
      }
      if (prefix === 46) {
        await recordMutation(
          'wp196 admission trigger removed',
          prefix,
          'drop trigger sync_jobs_recommendation_admission_gate on public.sync_jobs',
        );
        await recordMutation(
          'wp196 executor policy role widened',
          prefix,
          'alter policy recommendation_executor_select on public.sync_jobs ' +
          'to openspell_recommendation_executor, authenticated',
        );
        await recordMutation(
          'wp196 service control execute revoked',
          prefix,
          'revoke execute on function public.block_recommendation_admission(bigint) from service_role',
        );
        await recordMutation(
          'out-of-scope column privilege added',
          prefix,
          'grant update (email) on public.org_invitations to anon',
          'fingerprint_change',
        );
        await recordMutation(
          'out-of-scope schema privilege added',
          prefix,
          'grant create on schema public to authenticated',
          'fingerprint_change',
        );
        await recordMutation(
          'out-of-scope role attribute changed',
          prefix,
          'alter role anon connection limit 17',
          'fingerprint_change',
        );
        await recordMutation(
          'out-of-scope type privilege added',
          prefix,
          'grant usage on type public.feedback_type to anon',
          'fingerprint_change',
        );
        await recordMutation(
          'out-of-scope role membership added',
          prefix,
          'grant authenticated to anon',
          'fingerprint_change',
        );
      }
    }

    phase = 'restricted-role evidence';
    const restrictedRole = `wp197_evidence_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await sql.unsafe(`create role ${quoteIdentifier(restrictedRole)} nologin`);
    await sql.unsafe(`grant pg_read_all_data to ${quoteIdentifier(restrictedRole)}`);
    try {
      await sql.unsafe(`set role ${quoteIdentifier(restrictedRole)}`);
      restrictedProbe = await readEvidence(
        (source) => sql.unsafe(source),
        'wp-197-hosted-migration-probe.sql',
      );
      restrictedEvidence = await readEvidence(
        (source) => sql.unsafe(source),
        'wp-197-hosted-migration-prefix-46.sql',
      );
    } finally {
      await sql.unsafe('reset role');
      await sql.unsafe(`drop role ${quoteIdentifier(restrictedRole)}`);
    }
    } catch (error: unknown) {
      throw new Error(`WP-197 disposable proof failed during ${phase}`, { cause: error });
    }
  }, 180_000);

  afterAll(async () => {
    await databaseSql?.end({ timeout: 5 }).catch(() => undefined);
    if (databaseName === '') return;
    const adminSql = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    try {
      await adminSql.unsafe(`drop database if exists ${quoteIdentifier(databaseName)} with (force)`);
    } finally {
      await adminSql.end({ timeout: 5 });
    }
  });

  it('passes exact prefixes 41 through 46 and resumes after an injected rollback', () => {
    expect(prefixes.map((entry) => entry.prefix)).toEqual([41, 41, 42, 43, 44, 45, 46]);
    for (const observation of prefixes) {
      expect(observation.probe).toHaveLength(1);
      expect(observation.probe[0]).toMatchObject({
        pass: true,
        selectedEvidenceScript:
          'wp-197-hosted-' + `migration-prefix-${observation.prefix}.sql`,
      });
      expect(observation.evidence.length).toBeGreaterThan(0);
      expect(observation.evidence.filter((row) => row.pass !== true)).toEqual([]);
    }
  });

  it('fails every adversarial catalog, policy, trigger and privilege mutation closed', () => {
    expect(mutations.map((entry) => entry.name)).toEqual([
      'wp187 RLS disabled',
      'wp187 immutable trigger removed',
      'wp195 tenant policy widened',
      'wp196 admission trigger removed',
      'wp196 executor policy role widened',
      'wp196 service control execute revoked',
      'out-of-scope column privilege added',
      'out-of-scope schema privilege added',
      'out-of-scope role attribute changed',
      'out-of-scope type privilege added',
      'out-of-scope role membership added',
    ]);
    for (const observation of mutations) {
      expect(observation.evidence.length, observation.name).toBeGreaterThan(0);
      if (observation.proof === 'embedded_failure') {
        expect(
          observation.evidence.some((row) => row.pass === false),
          observation.name,
        ).toBe(true);
      } else {
        const observed = new Set(
          observation.evidence.map((row) => row.outOfScopePrivilegeFingerprint),
        );
        expect(observation.baselineFingerprint, observation.name).toMatch(/^[0-9a-f]{64}$/u);
        expect(observed.size, observation.name).toBe(1);
        expect([...observed][0], observation.name).not.toBe(observation.baselineFingerprint);
      }
    }
  });

  it('runs the public probe and final prefix without pg_authid or superuser access', () => {
    expect(restrictedProbe).toHaveLength(1);
    expect(restrictedProbe[0]).toMatchObject({ pass: true });
    expect(restrictedEvidence.length).toBeGreaterThan(0);
    expect(restrictedEvidence.filter((row) => row.pass !== true)).toEqual([]);
  });
});
