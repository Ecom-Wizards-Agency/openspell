/**
 * Analyst configuration, all of it from the environment.
 *
 * The analyst holds two credentials and they are deliberately different things.
 * The MCP token is a read-only key: it is the only way the analyst reaches
 * account data, and its scope is what the acceptance check rests on — the
 * audit_log must show it never called a write tool. The database URL is a
 * separate, write-capable connection used for exactly one thing: inserting the
 * finished insight. Analysis reads never travel down it, so the "reads only via
 * MCP" claim stays true even though the process can also write a row.
 */

export interface AnalystConfig {
  /** Streamable HTTP endpoint of the wizard-ads MCP server, ending in /mcp. */
  mcpUrl: string;
  /** A read-only `wza_` API key. Never logged, never written to the insight. */
  mcpToken: string;
  /** Connection string used only to write insights. */
  databaseUrl: string;
  /** Trailing window the headline metrics are read over. */
  lookbackDays: number;
  /**
   * The day the run reports on, `YYYY-MM-DD`. Undefined means "let the data
   * decide": each profile is anchored on its own latest completed fact day.
   */
  asOf: string | undefined;
  /** When true, analyze and render but write nothing to the insights table. */
  dryRun: boolean;
}

export const DEFAULT_LOOKBACK_DAYS = 30;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is not set. The analyst will not run without it.`);
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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AnalystConfig {
  const asOf = env['WIZARD_ADS_ANALYST_AS_OF'];
  if (asOf !== undefined && asOf !== '' && !ISO_DATE.test(asOf)) {
    throw new Error(`WIZARD_ADS_ANALYST_AS_OF must be YYYY-MM-DD, got ${JSON.stringify(asOf)}`);
  }
  return {
    mcpUrl: env['WIZARD_ADS_ANALYST_MCP_URL'] ?? required(env, 'WIZARD_ADS_MCP_URL'),
    mcpToken: required(env, 'WIZARD_ADS_ANALYST_MCP_TOKEN'),
    databaseUrl:
      env['WIZARD_ADS_ANALYST_DATABASE_URL'] ?? required(env, 'DATABASE_URL'),
    lookbackDays: integer(env, 'WIZARD_ADS_ANALYST_LOOKBACK_DAYS', DEFAULT_LOOKBACK_DAYS),
    asOf: asOf === '' ? undefined : asOf,
    dryRun: env['WIZARD_ADS_ANALYST_DRY_RUN'] === '1' || env['WIZARD_ADS_ANALYST_DRY_RUN'] === 'true',
  };
}
