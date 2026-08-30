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

interface DatabaseState {
  handle: DbHandle | null;
  attempted: boolean;
}

type DatabaseGlobal = typeof globalThis & {
  __wizardAdsDatabaseState?: DatabaseState;
};

const freshState = (): DatabaseState => ({ handle: null, attempted: false });
const databaseGlobal = globalThis as DatabaseGlobal;
// Next dev invalidates modules and Vercel bundles routes independently. Reuse
// one client inside each runtime, but allow it only one physical connection and
// have postgres.js release that connection after a short idle interval. The
// JavaScript client may remain warm without reserving a session-pool slot.
//
// Do not register response-level `after()` cleanup here. `database()` runs while
// Server Components resolve cookies and org context; moving lifecycle work into
// Next's after-context can invalidate that request state during a cancelled or
// redirected render.
const state = (databaseGlobal.__wizardAdsDatabaseState ??= freshState());

/** The handle, or null when `DATABASE_URL` is absent (a page then says so). */
export function database(): DbHandle | null {
  if (!state.attempted) {
    state.attempted = true;
    try {
      state.handle = createDb({
        connectionString: connectionStringFromEnv(),
        max: 1,
        idleTimeoutSeconds: 1,
      });
    } catch {
      state.handle = null;
    }
  }

  return state.handle;
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
  const current = state.handle;
  state.handle = null;
  state.attempted = false;
  if (current) await current.close();
}
