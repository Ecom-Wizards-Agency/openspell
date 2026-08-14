/**
 * Lightweight serverless connection for the WP-08 web routes.
 *
 * This deliberately avoids the Drizzle schema graph: tag/goto helpers use the
 * raw postgres tag, and a one-connection request should not bundle every table.
 */
import postgres from 'postgres';
import type { Sql } from 'postgres';

export interface Wp08Database {
  sql: Sql;
  close(): Promise<void>;
}

export function createWp08Database(connectionString: string): Wp08Database {
  const sql = postgres(connectionString, {
    max: 1,
    prepare: false,
    onnotice: () => {},
    connection: { statement_timeout: 15_000 },
  });
  return { sql, close: async () => sql.end({ timeout: 5 }) };
}
