/**
 * A one-connection database handle for a request handler.
 *
 * Deliberately not `createDb`: that attaches Drizzle, which pulls the whole
 * schema graph into a serverless bundle for the sake of a handful of tag and
 * goto statements that are written as raw SQL anyway. It also rewrites the
 * client's jsonb and timestamp serializers, so a query layer used through both
 * handles has to marshal those itself — see `pg-time.ts`, and the tests that
 * run the same round trip through both handles.
 */
import postgres from 'postgres';
import type { Sql } from 'postgres';

export interface RequestDatabase {
  sql: Sql;
  close(): Promise<void>;
}

export function createRequestDatabase(connectionString: string): RequestDatabase {
  const sql = postgres(connectionString, {
    max: 1,
    prepare: false,
    onnotice: () => {},
    connection: { statement_timeout: 15_000 },
  });
  return { sql, close: async () => sql.end({ timeout: 5 }) };
}
