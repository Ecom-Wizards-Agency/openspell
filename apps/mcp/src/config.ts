/**
 * Server configuration, all of it from the environment.
 *
 * Nothing here has a tenant-specific default. The database URL is required
 * because a read-only analytics server with no database is not a degraded
 * server, it is a lie. Revision metadata is constrained to a Git object id so
 * the public health response can never echo an arbitrary environment value.
 */

export interface McpConfig {
  /** Service-role connection string. The MCP server bypasses RLS and scopes in the tool layer. */
  connectionString: string;
  /** Port for the Streamable HTTP endpoint. Its own port on the worker's Fly app. */
  port: number;
  host: string;
  /** @deprecated Retained for embedded callers; the read-only catalog does not use it. */
  webBaseUrl: string;
  /** Sanitized Git object id, or `unknown` when the build did not provide one. */
  revision?: string;
  /** Connection pool size. */
  poolSize: number;
  /** Postgres statement timeout. A runaway analytic query must not wedge a connection. */
  statementTimeoutSeconds: number;
  /** Hard cap on rows any single tool call may return. */
  maxRows: number;
  /** Hard cap on the bytes `download_data` may return. */
  maxDownloadBytes: number;
}

export const DEFAULT_MAX_ROWS = 1000;
export const DEFAULT_MAX_DOWNLOAD_BYTES = 5_000_000;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is not set. The MCP server will not start without it.`);
  }
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function revisionFromEnv(env: NodeJS.ProcessEnv): string {
  const raw = env['WIZARD_ADS_MCP_REVISION'];
  if (raw === undefined || raw.trim() === '') return 'unknown';

  const revision = raw.trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(revision)) {
    throw new Error('WIZARD_ADS_MCP_REVISION must be a 7-64 character hexadecimal Git object id.');
  }
  return revision;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): McpConfig {
  return {
    connectionString: env['WIZARD_ADS_MCP_DATABASE_URL'] ?? required(env, 'DATABASE_URL'),
    port: integer(env, 'WIZARD_ADS_MCP_PORT', 8787),
    host: env['WIZARD_ADS_MCP_HOST'] ?? '0.0.0.0',
    webBaseUrl: (env['WIZARD_ADS_WEB_BASE_URL'] ?? 'http://localhost:3000').replace(/\/+$/, ''),
    revision: revisionFromEnv(env),
    poolSize: integer(env, 'WIZARD_ADS_MCP_POOL_SIZE', 5),
    statementTimeoutSeconds: integer(env, 'WIZARD_ADS_MCP_STATEMENT_TIMEOUT', 30),
    maxRows: integer(env, 'WIZARD_ADS_MCP_MAX_ROWS', DEFAULT_MAX_ROWS),
    maxDownloadBytes: integer(env, 'WIZARD_ADS_MCP_MAX_DOWNLOAD_BYTES', DEFAULT_MAX_DOWNLOAD_BYTES),
  };
}
