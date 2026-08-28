/**
 * End-to-end proof against seeded data.
 *
 * There is no live Amazon data yet, so the run is exercised against the
 * deterministic dev seed. The test migrates a throwaway database, seeds it,
 * stands up the real MCP server in-process, issues a genuine read-only key, and
 * runs the analyst through the same client the scheduled job uses. Two things
 * are then true or the test fails:
 *
 *   1. The written insight references the seeded figures — its `spend` and
 *      `sales` equal the sums independently computed from `fact_profile_daily`
 *      over the analyst's own window.
 *   2. The MCP audit log shows the analyst's key called read tools and resources
 *      only. Every logged action is on the read allowlist; none of the write
 *      tools appear.
 *
 * The suite skips, rather than fails, when no Postgres is reachable, so
 * `pnpm check` stays honest on a machine with no database.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import { issueApiKey, startHttpServer } from '@wizard-ads/mcp';
import type { McpConfig } from '@wizard-ads/mcp';
import type { RunningServer } from '@wizard-ads/mcp';
import { connectMcp } from './mcp-client.js';
import type { AnalystMcpClient } from './mcp-client.js';
import { runDailyAnalyst } from './analyst.js';
import type { AnalystConfig } from './config.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DEV_ORG_SLUG = 'wizard-ads-dev';

/** The MCP write surface. None of these may appear in the analyst key's audit trail. */
const WRITE_TOOLS = new Set([
  'mcp.update_entities',
  'mcp.create_negatives',
  'mcp.apply_optimization',
  'mcp.create_tag',
  'mcp.set_context',
  'mcp.submit_feedback',
  'mcp.create_goto_link',
]);

const available = await databaseAvailable();

describe.skipIf(!available)('daily analyst against dev-seed', () => {
  let db: TestDatabase;
  let server: RunningServer;
  let mcp: AnalystMcpClient;
  let orgId: string;
  let keyId: string;

  beforeAll(async () => {
    db = await createTestDatabase('analyst');

    // Seed the deterministic dev fixture into the throwaway database, in a
    // subprocess so the seed script never joins this package's type graph.
    execFileSync('pnpm', ['--filter', '@wizard-ads/db', 'seed:dev', '--', '--days', '60'], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: db.connectionString },
      stdio: 'pipe',
    });

    const orgs = await db.sql<{ id: string }[]>`
      select id from public.orgs where slug = ${DEV_ORG_SLUG}
    `;
    const found = orgs[0];
    if (!found) throw new Error('dev-seed did not create the development org');
    orgId = found.id;

    const config: McpConfig = {
      connectionString: db.connectionString,
      port: 0,
      host: '127.0.0.1',
      webBaseUrl: 'http://localhost:3000',
      poolSize: 5,
      statementTimeoutSeconds: 30,
      maxRows: 1000,
      maxDownloadBytes: 5_000_000,
    };
    server = await startHttpServer({ config, handle: db });

    const issued = await issueApiKey(db, { orgId, label: 'analyst integration', scope: 'read' });
    keyId = issued.record.id;
    mcp = await connectMcp({ url: server.url, token: issued.token });
  }, 120_000);

  afterAll(async () => {
    await mcp?.close();
    await server?.close();
    await db?.drop();
  });

  it('writes one insight per sync-enabled profile, referencing seeded figures', async () => {
    const analystConfig: AnalystConfig = {
      mcpUrl: server.url,
      mcpToken: 'unused-here',
      databaseUrl: db.connectionString,
      lookbackDays: 30,
      asOf: undefined,
      dryRun: false,
    };

    const run = await runDailyAnalyst({ mcp, handle: db, config: analystConfig });

    // dev-seed writes four sync-enabled profiles.
    expect(run.profilesConsidered).toBe(4);
    expect(run.profilesAnalyzed).toBe(4);
    expect(run.insightsWritten).toBe(4);
    expect(run.results.every((r) => r.error === null)).toBe(true);

    // Every profile produced a persisted insight.
    const rows = await db.sql<{ count: string }[]>`
      select count(*)::text as count from public.insights
       where org_id = ${orgId} and source = 'headless_analyst'
    `;
    expect(Number(rows[0]?.count)).toBe(4);

    // Spot-audit one profile: the insight's figures must equal the sums taken
    // straight from the fact table over the same window the analyst reported on.
    const sample = run.results.find((r) => r.figures?.hasData);
    expect(sample).toBeDefined();
    const figures = sample?.figures;
    if (!figures) throw new Error('no profile with data to audit');

    const sums = await db.sql<{ spend: string | null; sales: string | null }[]>`
      select sum(cost)::float8 as spend, sum(sales_7d)::float8 as sales
        from public.fact_profile_daily
       where org_id = ${orgId} and profile_id = ${sample.profileId}
         and date >= ${figures.window.from}::date and date <= ${figures.window.to}::date
    `;
    const seededSpend = Number(sums[0]?.spend);
    const seededSales = Number(sums[0]?.sales);
    expect(seededSpend).toBeGreaterThan(0);
    expect(figures.totals.spend).toBeCloseTo(seededSpend, 2);
    expect(figures.totals.sales).toBeCloseTo(seededSales, 2);

    // The persisted digest quotes the same numbers and the profile's currency.
    const insight = await db.sql<{ body: string; figures: { totals: { spend: number } } }[]>`
      select body, figures from public.insights
       where org_id = ${orgId} and profile_id = ${sample.profileId}
       order by created_at desc limit 1
    `;
    expect(insight[0]?.figures.totals.spend).toBeCloseTo(seededSpend, 2);
    expect(insight[0]?.body).toContain(sample.currency);
  });

  it('dry run renders a well-formed digest from seeded figures but writes nothing', async () => {
    const before = await db.sql<{ count: string }[]>`
      select count(*)::text as count from public.insights where org_id = ${orgId}
    `;

    const run = await runDailyAnalyst({
      mcp,
      handle: db,
      config: {
        mcpUrl: server.url,
        mcpToken: 'unused-here',
        databaseUrl: db.connectionString,
        lookbackDays: 30,
        asOf: undefined,
        dryRun: true,
      },
    });

    expect(run.dryRun).toBe(true);
    expect(run.insightsWritten).toBe(0);
    expect(run.results.every((r) => r.insightId === null)).toBe(true);

    // The digest is still fully formed and quotes a real seeded number.
    const sample = run.results.find((r) => r.figures?.hasData);
    expect(sample?.markdown).toContain('### ');
    expect(sample?.markdown).toContain('Spend:');
    expect(sample?.figures?.totals.spend).toBeGreaterThan(0);

    // No row was written.
    const after = await db.sql<{ count: string }[]>`
      select count(*)::text as count from public.insights where org_id = ${orgId}
    `;
    expect(Number(after[0]?.count)).toBe(Number(before[0]?.count));
  });

  it('touched only read operations: the audit log shows zero write-tool calls by the analyst key', async () => {
    const actions = await db.sql<{ action: string; outcome: string }[]>`
      select action, (payload->>'outcome') as outcome
        from public.audit_log
       where org_id = ${orgId} and actor_type = 'mcp' and actor_id = ${keyId}
    `;

    // The run did call the server, so the log is not vacuously clean.
    expect(actions.length).toBeGreaterThan(0);

    const writes = actions.filter((row) => WRITE_TOOLS.has(row.action));
    expect(writes).toEqual([]);

    // Every logged action is an analytical tool or resource read, and none was
    // a gated refusal. Resource action names come from the MCP audit wrapper.
    const readAllowlist = new Set([
      'mcp.list_profiles',
      'mcp.get_sync_status',
      'mcp.get_entity_data',
      'mcp.get_flags',
      'mcp.get_pacing',
      'mcp.resource.instructions.read',
      'mcp.resource.profile-context.list',
      'mcp.resource.profile-context.read',
    ]);
    for (const row of actions) {
      expect(readAllowlist.has(row.action)).toBe(true);
      expect(row.outcome).toBe('ok');
    }
    expect(actions.some((row) => row.action === 'mcp.resource.profile-context.read')).toBe(true);
  });
});
