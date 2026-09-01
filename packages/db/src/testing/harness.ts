/**
 * Test harness: a throwaway database with every migration applied, in order.
 *
 * The suite runs the real migration files. Not a copy of them, not a Drizzle
 * rendering of them: the files an operator applies with `supabase db reset`. A
 * migration test that tests anything else tests nothing.
 *
 * Two environments have to work:
 *
 *   local Supabase   `supabase start` gives roles, auth, Vault and pg_cron.
 *   plain Postgres   none of those exist, so `supabase-platform-shim.sql`
 *                    creates the smallest believable version of each.
 *
 * The shim is guarded statement by statement, so applying it to a real Supabase
 * is a no-op and the same test run proves the same SQL in both places. It
 * stores its "vault" secrets in plaintext, which is safe only because the
 * database is thrown away and only synthetic values ever reach it.
 */
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { createDb } from '../client.js';
import type { DbHandle } from '../client.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MIGRATIONS_DIR = `${REPO_ROOT}supabase/migrations`;
const SHIM = `${REPO_ROOT}supabase/tests/supabase-platform-shim.sql`;
const FIXTURE = `${REPO_ROOT}supabase/tests/tenant-fixture.sql`;

/**
 * Where the tests find a Postgres. Defaults to the port `supabase start`
 * publishes, so an operator with local Supabase running needs no configuration.
 */
export function adminConnectionString(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env['WIZARD_ADS_TEST_DATABASE_URL'] ??
    env['DATABASE_URL'] ??
    'postgres://postgres:postgres@127.0.0.1:54322/postgres'
  );
}

/** The migration files, in the order Supabase applies them. */
export async function migrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((name) => name.endsWith('.sql')).sort();
}

/**
 * Is a Postgres reachable? Used to skip the database suites rather than fail
 * them on a machine with no database, so `pnpm check` stays honest in CI while
 * the suite still runs everywhere it can.
 */
export async function databaseAvailable(): Promise<boolean> {
  const sql = postgres(adminConnectionString(), {
    max: 1,
    connect_timeout: 3,
    onnotice: () => {},
  });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

export interface TestDatabase extends DbHandle {
  name: string;
  connectionString: string;
  /** Close the pool and drop the database. */
  drop(): Promise<void>;
}

export interface TestDatabaseOptions {
  /** Stop after this exact migration; useful for forward-migration upgrade proofs. */
  throughMigration?: string;
  /** Defaults to true. */
  applyFixture?: boolean;
}

/**
 * Create a database, apply the shim, then every migration in order, then the
 * tenant fixture. Returns a handle plus the teardown.
 */
export async function createTestDatabase(
  label = 'db',
  options: TestDatabaseOptions = {},
): Promise<TestDatabase> {
  const admin = adminConnectionString();
  const name = `wizard_ads_test_${label}_${randomUUID().slice(0, 8)}`.toLowerCase();
  const adminSql = postgres(admin, { max: 1, onnotice: () => {} });

  try {
    await adminSql.unsafe(`create database ${quoteIdent(name)}`);
  } finally {
    await adminSql.end({ timeout: 5 });
  }

  const connectionString = withDatabase(admin, name);
  const handle = createDb({ connectionString, max: 4 });

  try {
    await applySqlFile(handle, SHIM);
    let reachedRequestedMigration = options.throughMigration === undefined;
    for (const file of await migrationFiles()) {
      await applySqlFile(handle, `${MIGRATIONS_DIR}/${file}`);
      if (file === options.throughMigration) {
        reachedRequestedMigration = true;
        break;
      }
    }
    if (!reachedRequestedMigration) {
      throw new Error(`migration not found: ${options.throughMigration}`);
    }
    if (options.applyFixture !== false) await applySqlFile(handle, FIXTURE);
  } catch (error) {
    await handle.close();
    await dropDatabase(admin, name);
    throw error;
  }

  return {
    ...handle,
    name,
    connectionString,
    drop: async () => {
      await handle.close();
      await dropDatabase(admin, name);
    },
  };
}

/**
 * Apply one SQL file. Not split into statements: the files contain dollar-
 * quoted function bodies, and every naive splitter ever written breaks on one.
 */
export async function applySqlFile(handle: DbHandle, path: string): Promise<void> {
  const text = await readFile(path, 'utf8');
  await handle.sql.unsafe(text);
}

async function dropDatabase(admin: string, name: string): Promise<void> {
  const sql = postgres(admin, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`drop database if exists ${quoteIdent(name)} with (force)`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

function quoteIdent(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}
