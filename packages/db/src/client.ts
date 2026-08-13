/**
 * Connection handling.
 *
 * Two shapes come out of `createDb`: the Drizzle query builder for everything
 * typed, and the raw postgres.js tag for the security-definer functions, which
 * are called as functions rather than composed as queries.
 *
 * `prepare: false` is not a preference. Supabase's pooler in transaction mode
 * does not support prepared statements, and a schema that only works against a
 * direct connection is a schema that fails the first time somebody points the
 * web tier at the pooler.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Database = PostgresJsDatabase<typeof schema>;
export type Sql = postgres.Sql;

export interface DbHandle {
  /** Typed query builder. */
  db: Database;
  /** Raw tag, for calling SQL functions and for test setup. */
  sql: Sql;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  connectionString: string;
  /** Pool size. The worker wants a few; a serverless request handler wants one. */
  max?: number;
  /** Seconds. Postgres kills the query, so a runaway report load cannot wedge a connection. */
  statementTimeoutSeconds?: number;
  onnotice?: (notice: unknown) => void;
}

export function createDb(options: CreateDbOptions): DbHandle {
  const sql = postgres(options.connectionString, {
    max: options.max ?? 5,
    prepare: false,
    onnotice: options.onnotice ?? (() => {}),
    connection:
      options.statementTimeoutSeconds === undefined
        ? {}
        : { statement_timeout: options.statementTimeoutSeconds * 1000 },
  });

  return {
    sql,
    db: drizzle(sql, { schema }),
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

/**
 * The connection string, from the environment, with a message that says which
 * variable is missing rather than failing with a driver error six frames deep.
 */
export function connectionStringFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  variable = 'DATABASE_URL',
): string {
  const value = env[variable];
  if (!value) {
    throw new Error(
      `${variable} is not set. Point it at the local Supabase database ` +
        '(supabase start prints it) or at a service-role connection string.',
    );
  }
  return value;
}
