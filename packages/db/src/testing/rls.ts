/**
 * Run a block of SQL as a particular Supabase client would.
 *
 * PostgREST authenticates by switching role and putting the JWT claims on the
 * session; these helpers do exactly that and nothing more, so a policy that
 * passes here passes for a real browser client. Setting the claims is what
 * makes `auth.uid()` return a user, and switching the role is what makes RLS
 * apply at all: the table owner is exempt, which is why a test that forgets the
 * role switch always passes.
 */
import type { DbHandle, Sql } from '../client.js';

export type ClientRole = 'anon' | 'authenticated' | 'service_role';

export interface ActorOptions {
  role: ClientRole;
  /** The JWT subject. Required for `authenticated` to mean anything. */
  userId?: string;
}

/**
 * Run `fn` on a connection reserved for one client, with that client's role and
 * JWT claims set, and reset it afterwards.
 *
 * A reserved connection rather than a transaction, deliberately: half of what
 * these helpers are used for is asserting that a statement is *refused*, and
 * inside a transaction the first refusal aborts the block, so every later
 * assertion fails with "current transaction is aborted" instead of the error it
 * was checking for. Outside one, a refused statement is just a refused
 * statement and the next assertion still means something.
 */
export async function asActor<T>(
  handle: DbHandle,
  actor: ActorOptions,
  fn: (sql: Sql) => Promise<T>,
): Promise<T> {
  const reserved = await handle.sql.reserve();
  const claims = JSON.stringify({ sub: actor.userId ?? null, role: actor.role });

  try {
    await reserved`select set_config('request.jwt.claims', ${claims}, false)`;
    await reserved.unsafe(`set role ${actor.role}`);
    return await fn(reserved as unknown as Sql);
  } finally {
    await reserved.unsafe('reset role').catch(() => {});
    await reserved`select set_config('request.jwt.claims', '', false)`.catch(() => {});
    reserved.release();
  }
}

/** Shorthand for a signed-in member. */
export const asUser = <T>(handle: DbHandle, userId: string, fn: (sql: Sql) => Promise<T>) =>
  asActor(handle, { role: 'authenticated', userId }, fn);

/** Shorthand for a signed-out visitor. */
export const asAnon = <T>(handle: DbHandle, fn: (sql: Sql) => Promise<T>) =>
  asActor(handle, { role: 'anon' }, fn);

/** Shorthand for the worker. */
export const asServiceRole = <T>(handle: DbHandle, fn: (sql: Sql) => Promise<T>) =>
  asActor(handle, { role: 'service_role' }, fn);

/**
 * Every tenant table: a base table in `public` with an `org_id` column.
 *
 * Read from the catalog rather than a list, so a table added next month is
 * covered by the RLS suite the moment it exists.
 */
export async function tenantTables(handle: DbHandle): Promise<string[]> {
  const rows = await handle.sql<{ relname: string }[]>`
    select c.relname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and a.attnum > 0
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relispartition = false
    order by c.relname
  `;
  return rows.map((row) => row.relname);
}
