import { SpWriteActor } from '@wizard-ads/shared/sp-write-application';
import type { DbHandle, QuerySql } from '../client.js';

/**
 * Production counterpart of the test role helpers. PostgreSQL restores both
 * role and claims when this transaction commits or rolls back. No session-level
 * state or reserved connection cleanup is needed on the request pool.
 *
 * The caller supplies an authenticated server identity, never an HTTP body.
 * RLS and the approval RPC still decide that user's current authorization.
 */
export async function withAuthenticatedActor<T>(
  handle: Pick<DbHandle, 'sql'>,
  rawActor: SpWriteActor,
  operation: (sql: QuerySql) => Promise<T>,
): Promise<T> {
  const actor = SpWriteActor.parse(rawActor);
  const claims = JSON.stringify({ sub: actor.userId, role: 'authenticated' });
  const result = await handle.sql.begin(async (sql) => {
    await sql`select set_config('request.jwt.claims', ${claims}, true)`;
    await sql`set local role authenticated`;
    return { value: await operation(sql) };
  });
  return result.value;
}
