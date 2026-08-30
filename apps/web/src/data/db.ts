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
import { after } from 'next/server';

interface DatabaseState {
  handle: DbHandle | null;
  attempted: boolean;
  leases: number;
}

type DatabaseGlobal = typeof globalThis & {
  __wizardAdsDatabaseState?: DatabaseState;
};

const freshState = (): DatabaseState => ({ handle: null, attempted: false, leases: 0 });
const databaseGlobal = globalThis as DatabaseGlobal;
// Next dev invalidates modules and Vercel bundles routes independently. Reuse a
// single handle inside each runtime, then release it when the last response
// using it finishes. A module-local production cache leaves one pool alive per
// warm route bundle and can exhaust a small Supabase session pool during a
// serial operator click-through.
const state = (databaseGlobal.__wizardAdsDatabaseState ??= freshState());
// An HMR cycle can reuse state created by the preceding module shape.
state.leases ??= 0;

function leaseForResponse(handle: DbHandle): void {
  state.leases += 1;
  try {
    after(async () => {
      // A reset may already have replaced this generation of the handle.
      if (state.handle !== handle) return;
      state.leases = Math.max(0, state.leases - 1);
      if (state.leases !== 0) return;

      // Detach before awaiting close so a concurrent request cannot receive a
      // handle that postgres.js is already ending.
      state.handle = null;
      state.attempted = false;
      await handle.close().catch(() => {});
    });
  } catch {
    // `database()` is also exercised outside a Next request by unit tests and
    // local scripts. The short postgres.js idle timeout remains the fallback.
    state.leases = Math.max(0, state.leases - 1);
  }
}

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

  if (state.handle !== null) leaseForResponse(state.handle);
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
  state.leases = 0;
  if (current) await current.close();
}
