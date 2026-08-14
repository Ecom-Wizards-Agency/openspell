/**
 * The web tier's database handle.
 *
 * One pool for the process, not one per request: a Server Component tree can
 * render a dozen times for a single page, and a pool per render exhausts
 * Postgres connections long before it exhausts anyone's patience.
 *
 * This connection is the service role. Authorization for everything WP-04
 * renders and writes is enforced above it, in `src/auth/roles.ts`, applied by
 * the server action or route handler before any statement runs. RLS remains the
 * backstop for anything that reaches the database over PostgREST with a user
 * JWT, and `packages/db`'s suite proves those policies; it is not what guards
 * these routes. The one credential that is *never* reachable from here by
 * design is the Amazon refresh token: it moves only through the security-definer
 * Vault RPCs, and only the OAuth callback calls the one that writes.
 */
import { connectionStringFromEnv, createDb } from '@wizard-ads/db';
import type { DbHandle } from '@wizard-ads/db';

let handle: DbHandle | null = null;
let attempted = false;

/** The handle, or null when `DATABASE_URL` is absent (a page then says so). */
export function database(): DbHandle | null {
  if (attempted) return handle;
  attempted = true;
  try {
    handle = createDb({ connectionString: connectionStringFromEnv(), max: 3 });
  } catch {
    handle = null;
  }
  return handle;
}

/** The handle, or a thrown error naming the missing variable. For write paths. */
export function requireDatabase(): DbHandle {
  const db = database();
  if (db === null) {
    throw new Error('DATABASE_URL is not set; the web app cannot reach the database.');
  }
  return db;
}

/** Test seam: drop the memoised handle so a suite can point at another database. */
export async function resetDatabase(): Promise<void> {
  const current = handle;
  handle = null;
  attempted = false;
  if (current) await current.close();
}
