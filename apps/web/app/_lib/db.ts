/**
 * The web tier's database handle.
 *
 * Null when nothing is configured, rather than a throw: a dashboard route that
 * takes down the whole app because `DATABASE_URL` is unset is worse than one
 * that says it is not wired up yet. Same choice `tools/crosscheck-cli` made, so
 * every read surface behaves the same way on a fresh checkout.
 *
 * One connection, not a pool: a request handler wants exactly one, and
 * `prepare: false` (set inside `createDb`) is what makes it safe behind
 * Supabase's transaction-mode pooler.
 */
import { connectionStringFromEnv, createDb } from '@wizard-ads/db';
import type { DbHandle } from '@wizard-ads/db';

export function openDatabase(): DbHandle | null {
  try {
    return createDb({ connectionString: connectionStringFromEnv(), max: 1 });
  } catch {
    return null;
  }
}

/** Open, run, close. Returns null when there is no database to run against. */
export async function withDatabase<T>(run: (handle: DbHandle) => Promise<T>): Promise<T | null> {
  const handle = openDatabase();
  if (handle === null) return null;
  try {
    return await run(handle);
  } finally {
    await handle.close();
  }
}
