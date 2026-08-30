/**
 * The acceptance suite: a real MCP client, over Streamable HTTP, against a real
 * database, with every answer checked against SQL run by hand.
 *
 * It stands in for WP-09's first acceptance check ("a Claude Code session
 * answers 'top 10 wasted-spend targets last week for profile X' correctly vs a
 * hand-run SQL check") by exercising the same protocol a Claude session speaks.
 * A live client session against staging remains the operator's step; what is
 * mechanised here is the part that can regress silently.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import { main as seedDevData, ORG_SLUG } from '../../../supabase/seed/dev-seed.js';
import { readAuditEntries } from './audit.js';
import { DEFAULT_MAX_DOWNLOAD_BYTES, DEFAULT_MAX_ROWS } from './config.js';
import type { McpConfig } from './config.js';
import { startHttpServer } from './http.js';
import { jsonText } from './json.js';
import type { RunningServer } from './http.js';
import {
  issueApiKey,
  MAX_API_KEY_LIFETIME_DAYS,
  revokeApiKey,
} from './keys.js';
import type { IssueApiKeyInput } from './keys.js';

const available = await databaseAvailable();

/** Three keywords with spend and no sales, planted in two profiles at once. */
const WASTED = ['waste-alpha', 'waste-beta', 'waste-gamma'];
const OTHER_ORG_USER = '22222222-2222-4222-8222-222222222222';

interface ToolCall {
  payload: Record<string, unknown>;
  isError: boolean;
}

describe.skipIf(!available)('the MCP server', () => {
  let database: TestDatabase;
  let server: RunningServer;
  let orgAId: string;
  let orgBId: string;
  let orgAProfileIds: string[];
  let profileA: string;
  let profileB: string;
  let amazonProfileA: string;
  let orgBProfile: string;
  let tokenA: string;
  let tokenB: string;
  let keyAId: string;
  let window: { start: string; end: string };

  beforeAll(async () => {
    database = await createTestDatabase('mcp');

    // The dev seed is the synthetic org: four profiles, sixty days of facts,
    // generated from a fixed seed so this suite reads the same numbers twice.
    process.env['DATABASE_URL'] = database.connectionString;
    await seedDevData(['--days', '60']);

    const orgs = await database.sql<{ id: string }[]>`
      select id from public.orgs where slug = ${ORG_SLUG}
    `;
    orgAId = orgs[0]?.id ?? '';

    const profiles = await database.sql<{ id: string; amazon_profile_id: string }[]>`
      select id, amazon_profile_id from public.ad_profiles
       where org_id = ${orgAId} order by amazon_profile_id
    `;
    orgAProfileIds = profiles.map((profile) => profile.id);
    profileA = profiles[0]?.id ?? '';
    amazonProfileA = profiles[0]?.amazon_profile_id ?? '';
    profileB = profiles[1]?.id ?? '';

    // A second org, from the RLS fixture: one row in every tenant table.
    const bravo = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('bravo', ${OTHER_ORG_USER}, 'owner')
    `;
    orgBId = bravo[0]?.seed_tenant_fixture ?? '';
    const bravoProfiles = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgBId}
    `;
    orgBProfile = bravoProfiles[0]?.id ?? '';

    // The last seven completed days. The newest day is provisional by design,
    // so it is excluded: a window that ends on a still-attributing day answers
    // a different question than the one asked.
    const latest = await database.sql<{ end: string; start: string }[]>`
      select (max(date) - 1)::text as end, (max(date) - 7)::text as start
        from public.fact_profile_daily where profile_id = ${profileA}
    `;
    window = { start: latest[0]?.start ?? '', end: latest[0]?.end ?? '' };

    // Spend with no sales, in two profiles under the same key, sharing target
    // ids. If the profile predicate is not applied, these collide visibly.
    for (const [index, targetId] of WASTED.entries()) {
      for (const [profileIndex, profileId] of [profileA, profileB].entries()) {
        await database.sql`
          insert into public.fact_sp_target_daily
            (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, target_id,
             target_kind, match_type, impressions, clicks, cost, purchases_7d, sales_7d, units_sold_7d)
          values (${orgAId}, ${profileId}, ${window.end}::date, 'SP', 'dev-c1', 'dev-ag1',
                  ${targetId}, 'keyword', 'broad', 900, 30,
                  ${(index + 1) * 10 + profileIndex * 1000}, 0, 0, 0)
        `;
      }
    }

    await database.sql`
      update public.ad_profiles
         set target_acos = 0.30, monthly_budget = 3000, goal_lens = 'scale'
       where id = ${profileA}
    `;

    const keyA = await issueApiKey(database, {
      orgId: orgAId,
      label: 'suite key A',
      profileIds: orgAProfileIds,
      expiresAt: futureExpiry(),
    });
    const keyB = await issueApiKey(database, {
      orgId: orgBId,
      label: 'suite key B',
      profileIds: [orgBProfile],
      expiresAt: futureExpiry(),
    });
    tokenA = keyA.token;
    tokenB = keyB.token;
    keyAId = keyA.record.id;

    server = await startHttpServer({ config: testConfig(database.connectionString), handle: database });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await database?.drop();
  });

  // -------------------------------------------------------------------------

  it('serves an analytical-read-only production catalog', async () => {
    const client = await connect(server, tokenA);
    try {
      expect(client.getServerVersion()).toMatchObject({
        name: 'openspell',
        version: '0.1.0',
      });
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      expect(names).toEqual(
        [
          'download_data',
          'get_entity_data',
          'get_flags',
          'get_pacing',
          'get_experiment',
          'get_recommendations',
          'get_sync_status',
          'group_by',
          'list_experiments',
          'list_profiles',
          'query',
        ].sort(),
      );
      expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
      expect(tools.every((tool) => tool.annotations?.destructiveHint !== true)).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('answers "top 10 wasted-spend targets last week" the same way SQL does', async () => {
    const client = await connect(server, tokenA);
    try {
      const result = await call(client, 'get_entity_data', {
        entity: 'keyword',
        profile_id: profileA,
        date_range: window,
        filters: [{ key: 'SALES', operator: '=', values: ['0'] }],
        sort: [{ column: 'spend', direction: 'desc' }],
        limit: 10,
      });
      expect(result.isError).toBe(false);

      const expected = await database.sql<{ target_id: string; spend: number }[]>`
        select target_id, sum(cost)::float8 as spend
          from public.fact_sp_target_daily
         where org_id = ${orgAId} and profile_id = ${profileA}
           and date >= ${window.start}::date and date <= ${window.end}::date
           and target_kind = 'keyword'
         group by target_id
        having sum(sales_7d) = 0
         order by spend desc
         limit 10
      `;

      const rows = result.payload['rows'] as { target_id: string; spend: number }[];
      expect(expected.length).toBeGreaterThan(0);
      expect(rows.map((row) => row.target_id)).toEqual(expected.map((row) => row.target_id));
      for (const [index, row] of rows.entries()) {
        expect(row.spend).toBeCloseTo(expected[index]?.spend ?? -1, 6);
      }
      // The planted rows are the wasted ones, and they are the only ones.
      expect(rows.map((row) => row.target_id).sort()).toEqual([...WASTED].sort());
    } finally {
      await client.close();
    }
  });

  it('returns ONLY the named profile, even when another profile shares target ids', async () => {
    const client = await connect(server, tokenA);
    try {
      const first = await call(client, 'get_entity_data', {
        entity: 'keyword',
        profile_id: profileA,
        date_range: window,
        filters: [{ key: 'TARGET_ID', operator: 'IN', values: WASTED }],
        limit: 100,
      });
      const second = await call(client, 'get_entity_data', {
        entity: 'keyword',
        profile_id: profileB,
        date_range: window,
        filters: [{ key: 'TARGET_ID', operator: 'IN', values: WASTED }],
        limit: 100,
      });

      const spendOf = (result: ToolCall): Map<string, number> =>
        new Map(
          (result.payload['rows'] as { target_id: string; spend: number }[]).map((row) => [
            row.target_id,
            row.spend,
          ]),
        );

      const a = spendOf(first);
      const b = spendOf(second);
      expect([...a.keys()].sort()).toEqual([...WASTED].sort());
      expect([...b.keys()].sort()).toEqual([...WASTED].sort());

      // Profile B's planted rows are 1000 higher. Equal numbers here would mean
      // the two profiles were summed together, which is the AdLabs bug.
      for (const targetId of WASTED) {
        expect(b.get(targetId)).toBeCloseTo((a.get(targetId) ?? 0) + 1000, 6);
      }

      const combined = await database.sql<{ spend: number }[]>`
        select sum(cost)::float8 as spend from public.fact_sp_target_daily
         where org_id = ${orgAId} and target_id = any(${database.sql.array([...WASTED])}::text[])
           and date >= ${window.start}::date and date <= ${window.end}::date
      `;
      const totalA = [...a.values()].reduce((sum, value) => sum + value, 0);
      expect(totalA).toBeLessThan(combined[0]?.spend ?? 0);
    } finally {
      await client.close();
    }
  });

  it('recomputes ratios from summed bases when grouping', async () => {
    const client = await connect(server, tokenA);
    try {
      const result = await call(client, 'group_by', {
        entity: 'keyword',
        profile_id: profileA,
        date_range: window,
        group_by: ['campaign_id'],
        limit: 50,
      });

      const expected = await database.sql<
        { campaign_id: string; spend: number; sales: number; acos: number | null }[]
      >`
        select campaign_id, sum(cost)::float8 as spend, sum(sales_7d)::float8 as sales,
               (sum(cost) / nullif(sum(sales_7d), 0))::float8 as acos
          from public.fact_sp_target_daily
         where org_id = ${orgAId} and profile_id = ${profileA}
           and date >= ${window.start}::date and date <= ${window.end}::date
           and target_kind = 'keyword'
         group by campaign_id
      `;

      const rows = result.payload['rows'] as {
        campaign_id: string;
        acos: number | null;
        spend: number;
      }[];
      expect(rows.length).toBe(expected.length);
      for (const row of rows) {
        const match = expected.find((candidate) => candidate.campaign_id === row.campaign_id);
        expect(match).toBeDefined();
        expect(row.spend).toBeCloseTo(match?.spend ?? -1, 6);
        if (match?.acos === null) expect(row.acos).toBeNull();
        else expect(row.acos ?? Number.NaN).toBeCloseTo(match?.acos ?? -1, 9);
      }
      expect(rows.some((row) => row.acos !== null)).toBe(true);

      // And the same number is NOT the average of the per-keyword ACOSes.
      const naive = await database.sql<{ campaign_id: string; acos: number }[]>`
        select per_target.campaign_id, avg(per_target.acos)::float8 as acos from (
          select campaign_id, target_id, sum(cost) / nullif(sum(sales_7d), 0) as acos
            from public.fact_sp_target_daily
           where org_id = ${orgAId} and profile_id = ${profileA}
             and date >= ${window.start}::date and date <= ${window.end}::date
             and target_kind = 'keyword'
           group by campaign_id, target_id
        ) per_target
        group by per_target.campaign_id
      `;
      const correct = rows.find((row) => row.acos !== null);
      const averaged = naive.find((row) => row.campaign_id === correct?.campaign_id);
      expect(correct?.acos).not.toBeCloseTo(averaged?.acos ?? -1, 4);
    } finally {
      await client.close();
    }
  });

  it('adds the four-column delta model against the preceding period', async () => {
    const client = await connect(server, tokenA);
    try {
      const result = await call(client, 'get_entity_data', {
        entity: 'profile',
        profile_id: profileA,
        date_range: window,
        compare: true,
        metrics: ['spend'],
        limit: 5,
      });

      const columns = (result.payload['columns'] as { name: string }[]).map((column) => column.name);
      expect(columns).toEqual(['spend', 'spend_comparison', 'spend_delta_absolute', 'spend_delta_percent']);

      const row = (result.payload['rows'] as Record<string, number>[])[0];
      const expected = await database.sql<{ current: number; prior: number }[]>`
        select
          (select sum(cost)::float8 from public.fact_profile_daily
            where profile_id = ${profileA}
              and date >= ${window.start}::date and date <= ${window.end}::date) as current,
          (select sum(cost)::float8 from public.fact_profile_daily
            where profile_id = ${profileA}
              and date >= (${window.start}::date - 7) and date <= (${window.end}::date - 7)) as prior
      `;
      const current = expected[0]?.current ?? 0;
      const prior = expected[0]?.prior ?? 0;
      expect(row?.['spend']).toBeCloseTo(current, 6);
      expect(row?.['spend_comparison']).toBeCloseTo(prior, 6);
      expect(row?.['spend_delta_absolute']).toBeCloseTo(current - prior, 6);
      // A true percent, not a ratio.
      expect(row?.['spend_delta_percent']).toBeCloseTo(((current - prior) / Math.abs(prior)) * 100, 6);
    } finally {
      await client.close();
    }
  });

  it('returns daily rows from query and a matching count from SQL', async () => {
    const client = await connect(server, tokenA);
    try {
      const result = await call(client, 'query', {
        entity: 'search_term',
        profile_id: profileA,
        date_range: { start: window.end, end: window.end },
        limit: 500,
      });

      const expected = await database.sql<{ count: string }[]>`
        select count(*)::text as count from public.fact_search_term_daily
         where org_id = ${orgAId} and profile_id = ${profileA} and date = ${window.end}::date
      `;
      expect(result.payload['rowCount']).toBe(Number(expected[0]?.count));
      expect(result.payload['grain']).toBe('daily');
    } finally {
      await client.close();
    }
  });

  it('exports the same rows as CSV, and says how many it wrote', async () => {
    const client = await connect(server, tokenA);
    try {
      const result = await call(client, 'download_data', {
        entity: 'keyword',
        profile_id: profileA,
        date_range: window,
        limit: 1000,
      });

      const csv = result.payload['csv'] as string;
      const lines = csv.trimEnd().split('\n');
      expect(lines[0]?.startsWith('target_id,')).toBe(true);
      expect(lines.length - 1).toBe(result.payload['rowsWritten']);
      expect(result.payload['rowsWritten']).toBe(result.payload['rowsOffered']);
    } finally {
      await client.close();
    }
  });

  it('reports what the product level could not attribute', async () => {
    const client = await connect(server, tokenA);
    try {
      const result = await call(client, 'get_entity_data', {
        entity: 'product',
        profile_id: profileA,
        date_range: window,
        limit: 50,
      });
      const attribution = result.payload['attribution'] as Record<string, number>;
      expect(attribution).toBeDefined();
      expect(attribution['totalSpend']).toBeGreaterThan(0);
      expect(attribution['attributedSpend']).toBeLessThanOrEqual(attribution['totalSpend'] ?? 0);
    } finally {
      await client.close();
    }
  });

  it('serves the instructions resource and a per-profile context resource', async () => {
    const before = await readAuditEntries(database, orgAId, 500);
    const client = await connect(server, tokenA);
    try {
      const instructions = await client.readResource({ uri: 'wizardads://instructions' });
      const text = textOf(instructions.contents[0]);
      expect(text).toContain('# OpenSpell MCP');
      expect(text).toContain('read-only');
      expect(text).toContain('never averaged');

      const listed = await client.listResources();
      expect(listed.resources.some((resource) => resource.uri.startsWith('wizardads://profiles/'))).toBe(
        true,
      );

      const context = await client.readResource({ uri: `wizardads://profiles/${profileA}` });
      const parsed = JSON.parse(textOf(context.contents[0]) || '{}') as Record<string, unknown>;
      expect((parsed['profile'] as { id: string }).id).toBe(profileA);
      expect((parsed['counts'] as { keywords: number }).keywords).toBeGreaterThan(0);
      expect(parsed['sync']).toBeDefined();
    } finally {
      await client.close();
    }

    const after = await readAuditEntries(database, orgAId, 500);
    const added = after.slice(0, after.length - before.length);
    expect(added.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        'mcp.resource.instructions.read',
        'mcp.resource.profile-context.list',
        'mcp.resource.profile-context.read',
      ]),
    );
    const profileRead = added.find(
      (entry) => entry.action === 'mcp.resource.profile-context.read',
    );
    expect(profileRead?.targetId).toBe(profileA);
    expect(profileRead?.payload['outcome']).toBe('ok');
    expect(JSON.stringify(added)).not.toContain(tokenA);
  });

  it('audits a refused out-of-scope resource read', async () => {
    const client = await connect(server, tokenA);
    try {
      await expect(
        client.readResource({ uri: `wizardads://profiles/${orgBProfile}` }),
      ).rejects.toThrow();
    } finally {
      await client.close();
    }

    const entries = await readAuditEntries(database, orgAId, 500);
    const refused = entries.find(
      (entry) =>
        entry.action === 'mcp.resource.profile-context.read' &&
        entry.payload['outcome'] === 'error',
    );
    expect((refused?.payload['summary'] as Record<string, unknown>)['code']).toBe('not_found');
  });

  it('computes flags and pacing through the doctrine engine', async () => {
    const client = await connect(server, tokenA);
    try {
      const flags = await call(client, 'get_flags', { profile_id: profileA });
      expect(flags.isError).toBe(false);
      expect(Array.isArray(flags.payload['active'])).toBe(true);
      expect(Array.isArray(flags.payload['suppressed'])).toBe(true);
      expect((flags.payload['goalLens'] as { key: string }).key).toBe('scale');

      const pacing = await call(client, 'get_pacing', { profile_id: profileA });
      expect(pacing.isError).toBe(false);
      const result = pacing.payload['pacing'] as { monthlyBudget: number; pace: number } | null;
      expect(result?.monthlyBudget).toBe(3000);
      expect(typeof result?.pace).toBe('number');

      // A profile with no budget gets a null pacing and a reason, not a guess.
      const other = await call(client, 'get_pacing', { profile_id: profileB });
      expect(other.payload['pacing']).toBeNull();
      expect((other.payload['notes'] as string[]).join(' ')).toContain('No monthly budget');
    } finally {
      await client.close();
    }
  });

  it('returns the latest run with each proposal\'s inputs provenance intact', async () => {
    const runs = await database.sql<{ id: string }[]>`
      insert into public.recommendation_runs
        (org_id, profile_id, status, lookback_days, window_start, window_end, engine_version,
         proposals_count, finished_at)
      values (${orgAId}, ${profileA}, 'succeeded', 30, ${window.start}::date, ${window.end}::date,
              'core@test', 1, now())
      returning id
    `;
    await database.sql`
      insert into public.recommendations
        (run_id, org_id, profile_id, reason, entity_type, entity_id, entity_name, field,
         current_value, proposed_value, inputs)
      values (${runs[0]?.id ?? ''}, ${orgAId}, ${profileA}, 'high_acos', 'keyword', 'waste-alpha',
              'waste alpha', 'bid', '0.90'::jsonb, '0.55'::jsonb,
              ${jsonText({
                rpc: 1.83,
                clicks: 30,
                cvrSourceLevel: 'ad_group',
                ceilingApplied: 'max_affordable_cpc',
                capClamped: true,
              })}::jsonb)
    `;

    const client = await connect(server, tokenA);
    try {
      const result = await call(client, 'get_recommendations', { profile_id: profileA, limit: 50 });
      const run = result.payload['run'] as {
        engineVersion: string;
        recommendations: { entityId: string; inputs: Record<string, unknown> }[];
      };
      expect(run.engineVersion).toBe('core@test');
      const proposal = run.recommendations[0];
      expect(proposal?.entityId).toBe('waste-alpha');
      // The differentiator: a proposal nobody can audit is a black box with
      // better manners, so every input travels with it.
      expect(proposal?.inputs['rpc']).toBe(1.83);
      expect(proposal?.inputs['cvrSourceLevel']).toBe('ad_group');
      expect(proposal?.inputs['ceilingApplied']).toBe('max_affordable_cpc');
      expect(proposal?.inputs['capClamped']).toBe(true);

      // A filter that matches nothing returns an empty list, not the whole run.
      const dismissed = await call(client, 'get_recommendations', {
        profile_id: profileA,
        status: 'dismissed',
        limit: 50,
      });
      expect((dismissed.payload['run'] as { recommendations: unknown[] }).recommendations).toEqual([]);
    } finally {
      await client.close();
    }
  });

  // -------------------------------------------------------------------------
  // Isolation, gating, auditing
  // -------------------------------------------------------------------------

  it("refuses org B's key access to org A's profile, at the tool layer", async () => {
    const client = await connect(server, tokenB);
    try {
      const profiles = await call(client, 'list_profiles', {});
      const visible = profiles.payload['profiles'] as { id: string }[];
      expect(visible.map((profile) => profile.id)).toEqual([orgBProfile]);

      for (const tool of ['get_entity_data', 'get_sync_status', 'get_flags', 'get_recommendations']) {
        const result = await call(client, tool, {
          entity: 'keyword',
          profile_id: profileA,
          date_range: window,
          limit: 10,
        });
        expect(result.isError, tool).toBe(true);
        expect(result.payload['error'], tool).toBe('not_found');
        // The message must not confirm that the profile exists elsewhere.
        expect(String(result.payload['message'])).not.toContain(ORG_SLUG);
      }
    } finally {
      await client.close();
    }
  });

  it('honours a per-key profile allowlist', async () => {
    const scoped = await issueApiKey(database, {
      orgId: orgAId,
      label: 'one profile only',
      profileIds: [profileB],
      expiresAt: futureExpiry(),
    });
    const client = await connect(server, scoped.token);
    try {
      const profiles = await call(client, 'list_profiles', {});
      expect((profiles.payload['profiles'] as { id: string }[]).map((p) => p.id)).toEqual([profileB]);

      const denied = await call(client, 'get_entity_data', {
        entity: 'keyword',
        profile_id: profileA,
        date_range: window,
        limit: 10,
      });
      expect(denied.isError).toBe(true);
      expect(denied.payload['error']).toBe('not_found');
    } finally {
      await client.close();
    }
  });

  it('writes every call to the audit log with its parameters', async () => {
    const before = await readAuditEntries(database, orgAId, 500);
    const client = await connect(server, tokenA);
    try {
      await call(client, 'get_entity_data', {
        entity: 'campaign',
        profile_id: profileA,
        date_range: window,
        limit: 3,
      });
      await call(client, 'list_profiles', {});
    } finally {
      await client.close();
    }

    const after = await readAuditEntries(database, orgAId, 500);
    expect(after.length).toBe(before.length + 2);

    const entry = after.find((row) => row.action === 'mcp.get_entity_data');
    expect(entry?.actorType).toBe('mcp');
    expect(entry?.actorId).toBe(keyAId);
    expect(entry?.targetId).toBe(profileA);
    const params = entry?.payload['params'] as Record<string, unknown>;
    expect(params['entity']).toBe('campaign');
    expect((entry?.payload['summary'] as Record<string, unknown>)['rows']).toBeGreaterThan(0);
    // The token never reaches a tool, so it can never reach the log.
    expect(JSON.stringify(after)).not.toContain(tokenA);
  });

  it('records a failed call too, so the log can support a negative claim', async () => {
    const client = await connect(server, tokenA);
    try {
      const result = await call(client, 'get_entity_data', {
        entity: 'keyword',
        profile_id: profileA,
        date_range: window,
        filters: [{ key: 'NOT_A_COLUMN', operator: '=', values: ['1'] }],
        limit: 10,
      });
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }

    const entries = await readAuditEntries(database, orgAId, 500);
    const failure = entries.find((entry) => entry.payload['outcome'] === 'error');
    expect(failure?.action).toBe('mcp.get_entity_data');
  });

  it('accepts a profile by its Amazon id as well as its internal id', async () => {
    const client = await connect(server, tokenA);
    try {
      const result = await call(client, 'get_sync_status', { profile_id: amazonProfileA });
      expect(result.isError).toBe(false);
      expect(result.payload['profileId']).toBe(profileA);
    } finally {
      await client.close();
    }
  });

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  it('issues only bounded, explicitly profile-scoped keys for profiles owned by the org', async () => {
    const valid = await issueApiKey(database, {
      orgId: orgAId,
      label: '  bounded key  ',
      profileIds: [profileA, profileB],
      expiresAt: futureExpiry(MAX_API_KEY_LIFETIME_DAYS),
    });
    expect(valid.record.label).toBe('bounded key');
    expect(valid.record.profileIds).toEqual([profileA, profileB]);
    expect(valid.record.expiresAt).not.toBeNull();

    const missingProfiles = {
      orgId: orgAId,
      label: 'missing profiles',
      expiresAt: futureExpiry(),
    } as IssueApiKeyInput;
    await expect(issueApiKey(database, missingProfiles)).rejects.toThrow(
      'at least one profile',
    );
    await expect(
      issueApiKey(database, {
        orgId: orgAId,
        label: 'duplicate profiles',
        profileIds: [profileA, profileA],
        expiresAt: futureExpiry(),
      }),
    ).rejects.toThrow('must not contain duplicates');
    await expect(
      issueApiKey(database, {
        orgId: orgAId,
        label: 'invalid profile',
        profileIds: ['not-a-uuid'],
        expiresAt: futureExpiry(),
      }),
    ).rejects.toThrow('valid UUID');
    await expect(
      issueApiKey(database, {
        orgId: orgAId,
        label: 'foreign profile',
        profileIds: [orgBProfile],
        expiresAt: futureExpiry(),
      }),
    ).rejects.toThrow('belong to the selected organization');
    await expect(
      issueApiKey(database, {
        orgId: orgAId,
        label: 'past expiry',
        profileIds: [profileA],
        expiresAt: new Date(Date.now() - 1_000),
      }),
    ).rejects.toThrow('must be in the future');
    await expect(
      issueApiKey(database, {
        orgId: orgAId,
        label: 'too long',
        profileIds: [profileA],
        expiresAt: futureExpiry(MAX_API_KEY_LIFETIME_DAYS + 1),
      }),
    ).rejects.toThrow(`cannot exceed ${MAX_API_KEY_LIFETIME_DAYS} days`);
  });

  it('rejects a missing, malformed, revoked or expired key with 401', async () => {
    const doomed = await issueApiKey(database, {
      orgId: orgAId,
      label: 'to be revoked',
      profileIds: [profileA],
      expiresAt: futureExpiry(),
    });
    const working = await connect(server, doomed.token);
    await working.close();
    expect(await status(server, doomed.token)).toBe(200);

    expect(await revokeApiKey(database, doomed.record.id)).toBe(true);
    expect(await status(server, doomed.token)).toBe(401);

    const expired = await issueApiKey(database, {
      orgId: orgAId,
      label: 'already expired',
      profileIds: [profileA],
      expiresAt: futureExpiry(),
    });
    await database.sql`update mcp.api_keys set expires_at = now() - interval '1 second' where id = ${expired.record.id}`;
    expect(await status(server, expired.token)).toBe(401);

    const wrongScope = await issueApiKey(database, {
      orgId: orgAId,
      label: 'legacy write scope',
      profileIds: [profileA],
      expiresAt: futureExpiry(),
    });
    await database.sql`update mcp.api_keys set scope = 'write' where id = ${wrongScope.record.id}`;
    expect(await status(server, wrongScope.token)).toBe(401);
    expect(await status(server, undefined)).toBe(401);
    expect(await status(server, 'not-a-key')).toBe(401);
    expect(await status(server, 'wza_totally-made-up-token-value-here-padded')).toBe(401);

    // And the client cannot get past it either.
    await expect(connect(server, doomed.token)).rejects.toThrow();
  });

  it('rejects legacy keys with all-profile, empty, missing, or overlong constraints', async () => {
    const legacy = await Promise.all(
      ['null profiles', 'empty profiles', 'null expiry', 'overlong expiry'].map((label) =>
        issueApiKey(database, {
          orgId: orgAId,
          label,
          profileIds: [profileA],
          expiresAt: futureExpiry(),
        }),
      ),
    );
    const [nullProfiles, emptyProfiles, nullExpiry, overlongExpiry] = legacy;
    if (!nullProfiles || !emptyProfiles || !nullExpiry || !overlongExpiry) {
      throw new Error('legacy key setup failed');
    }

    await database.sql`update mcp.api_keys set profile_ids = null where id = ${nullProfiles.record.id}`;
    await database.sql`update mcp.api_keys set profile_ids = '{}'::uuid[] where id = ${emptyProfiles.record.id}`;
    await database.sql`update mcp.api_keys set expires_at = null where id = ${nullExpiry.record.id}`;
    await database.sql`
      update mcp.api_keys
         set expires_at = created_at + make_interval(days => ${MAX_API_KEY_LIFETIME_DAYS + 1})
       where id = ${overlongExpiry.record.id}
    `;

    for (const key of legacy) expect(await status(server, key.token)).toBe(401);
  });

  it('stores no plaintext token and stamps last-used on the key', async () => {
    const rows = await database.sql<{ token_hash: string; key_prefix: string; last_used_at: Date | null }[]>`
      select token_hash, key_prefix, last_used_at from mcp.api_keys where id = ${keyAId}
    `;
    const row = rows[0];
    expect(row?.token_hash).not.toBe(tokenA);
    expect(row?.token_hash).toHaveLength(64);
    expect(tokenA.startsWith(row?.key_prefix ?? 'nope')).toBe(true);
    expect(row?.last_used_at).not.toBeNull();
  });

  it('answers a health check and refuses anything but POST on the MCP path', async () => {
    const base = server.url.replace('/mcp', '');
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      status: 'ready',
      service: 'openspell',
      product: 'OpenSpell',
      version: '0.1.0',
      revision: 'abcdef123456',
      checks: { database: 'ready' },
    });
    expect((await fetch(server.url)).status).toBe(405);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------

function testConfig(connectionString: string): McpConfig {
  return {
    connectionString,
    // Port 0: the kernel picks a free one, so two suites can run at once.
    port: 0,
    host: '127.0.0.1',
    webBaseUrl: 'http://localhost:3000',
    revision: 'abcdef123456',
    poolSize: 4,
    statementTimeoutSeconds: 30,
    maxRows: DEFAULT_MAX_ROWS,
    maxDownloadBytes: DEFAULT_MAX_DOWNLOAD_BYTES,
  };
}

async function connect(server: RunningServer, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'openspell-test-client', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

function futureExpiry(days = 30): Date {
  return new Date(Date.now() + days * 86_400_000);
}

/** Resource contents are text or binary; this suite only ever asks for text. */
function textOf(content: unknown): string {
  const text = (content as { text?: unknown } | undefined)?.text;
  return typeof text === 'string' ? text : '';
}

/** Raw HTTP status for an initialize request carrying (or missing) a token. */
async function status(server: RunningServer, token: string | undefined): Promise<number> {
  const response = await fetch(server.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'probe', version: '0' },
      },
    }),
  });
  if (response.status === 401) {
    expect(response.headers.get('www-authenticate')).toBe('Bearer realm="openspell"');
  }
  return response.status;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCall> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  const text = result.content.find((entry) => entry.type === 'text')?.text ?? '{}';
  return { payload: JSON.parse(text) as Record<string, unknown>, isError: result.isError === true };
}
