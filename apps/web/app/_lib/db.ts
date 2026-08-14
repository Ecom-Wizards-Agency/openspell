/**
 * The web tier's database handle.
 *
 * Null when nothing is configured, rather than a throw: a dashboard route that
 * takes down the whole app because `DATABASE_URL` is unset is worse than one
 * that says it is not wired up yet. Same choice `tools/crosscheck-cli` made, so
 * every read surface behaves the same way on a fresh checkout.
 *
 * "Nothing is configured" now means what it says. `createDb` only fails when the
 * variable is *absent*, so a URL pointing at a Postgres that is down, moved or
 * refusing this password used to sail past this file and blow up at the first
 * query — the exact failure the paragraph above promises not to have. So
 * `withDatabase` catches that class of error too and returns the same null. Only
 * that class: a syntax error or a missing column is a bug here and still throws.
 *
 * One connection, not a pool: a request handler wants exactly one, and
 * `prepare: false` (set inside `createDb`) is what makes it safe behind
 * Supabase's transaction-mode pooler.
 */
import { connectionStringFromEnv, createDb } from '@wizard-ads/db';
import type { DbHandle } from '@wizard-ads/db';
import { isDatabaseUnreachable } from '../../src/db-unreachable';

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
  } catch (error) {
    if (isDatabaseUnreachable(error)) return null;
    throw error;
  } finally {
    // Closing a pool that never connected is a no-op that can still reject;
    // failing to hang up must not replace the answer the caller is owed.
    await handle.close().catch(() => {});
  }
}
