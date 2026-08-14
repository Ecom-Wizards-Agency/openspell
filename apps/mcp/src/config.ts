/**
 * Server configuration, all of it from the environment.
 *
 * Nothing here has a tenant-specific default. The database URL is required
 * because a read-only analytics server with no database is not a degraded
 * server, it is a lie, and the web base URL is required for `create_goto_link`
 * because a deep link into an unknown host is worse than no link at all.
 */

export interface McpConfig {
  /** Service-role connection string. The MCP server bypasses RLS and scopes in the tool layer. */
  connectionString: string;
  /** Port for the Streamable HTTP endpoint. Its own port on the worker's Fly app. */
  port: number;
  host: string;
  /** Origin of the web app, for `create_goto_link`. No trailing slash. */
  webBaseUrl: string;
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

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): McpConfig {
  return {
    connectionString: env['WIZARD_ADS_MCP_DATABASE_URL'] ?? required(env, 'DATABASE_URL'),
    port: integer(env, 'WIZARD_ADS_MCP_PORT', 8787),
    host: env['WIZARD_ADS_MCP_HOST'] ?? '0.0.0.0',
    webBaseUrl: (env['WIZARD_ADS_WEB_BASE_URL'] ?? 'http://localhost:3000').replace(/\/+$/, ''),
    poolSize: integer(env, 'WIZARD_ADS_MCP_POOL_SIZE', 5),
    statementTimeoutSeconds: integer(env, 'WIZARD_ADS_MCP_STATEMENT_TIMEOUT', 30),
    maxRows: integer(env, 'WIZARD_ADS_MCP_MAX_ROWS', DEFAULT_MAX_ROWS),
    maxDownloadBytes: integer(env, 'WIZARD_ADS_MCP_MAX_DOWNLOAD_BYTES', DEFAULT_MAX_DOWNLOAD_BYTES),
  };
}
