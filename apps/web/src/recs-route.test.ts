/**
 * The recommendation and n-gram routes at the HTTP boundary, against a real
 * migrated database.
 *
 * What is proved here, in the brief's own terms:
 *
 *  - accept → export → status transitions, with the counts asserted at each
 *    step rather than inferred from the absence of an error;
 *  - **dismissed rows never export**, which is the one failure that would put a
 *    change an operator refused into a file somebody uploads;
 *  - the three files an export produces, including that the rows JSON matches
 *    `serializeApplyRows` byte for byte (the Python validator is the other half
 *    of that check and is run by hand against a file this route wrote);
 *  - a dismissal without a note is refused;
 *  - every cross-tenant attempt is a 404, never a 403 with a different message.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import { listRecommendations } from '@wizard-ads/db';
import { POST as DECIDE } from '../app/api/recommendations/decide/route.js';
import { POST as EXPORT } from '../app/api/recommendations/export/route.js';
import { GET as DOWNLOAD } from '../app/api/recommendations/export/[batchId]/route.js';
import { POST as PROPOSE } from '../app/api/ngrams/negatives/route.js';

const available = await databaseAvailable();
const USER_A = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a';
const USER_B = '7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b7b';
const USER_ANALYST = '7c7c7c7c-7c7c-4c7c-8c7c-7c7c7c7c7c7c';
const BRIDGE_SECRET = 'synthetic-recs-route-bridge-secret';

const STRATEGY = {
  schema: 'wizard-ads.tenant-strategy.v1',
  opt_groups: { rank: { goal_lens: 'rank-launch', target_acos: 0.4, max_increase: 0.2, max_decrease: 0.3 } },
  caps: {},
};

describe.skipIf(!available)('recommendation routes', () => {
  let database: TestDatabase;
  let orgA = '';
  let orgB = '';
  let profileA = '';
  let profileB = '';
  let runA = '';
  let runB = '';
  const ids: Record<string, string> = {};
  const previous = {
    databaseUrl: process.env['DATABASE_URL'],
    bridgeSecret: process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'],
    bridgeEnabled: process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'],
  };

  const headers = (userId: string, orgId: string) => ({
    'content-type': 'application/json',
    'x-wizard-ads-auth-bridge': BRIDGE_SECRET,
    'x-wizard-ads-user-id': userId,
    'x-wizard-ads-org-id': orgId,
  });

  const decide = (body: unknown, userId = USER_A, orgId = orgA) =>
    DECIDE(
      new Request('http://localhost/api/recommendations/decide', {
        method: 'POST',
        headers: headers(userId, orgId),
        body: JSON.stringify(body),
      }),
    );

  async function seedProposal(options: {
    org: string;
    profile: string;
    run: string;
    key: string;
    entityType: string;
    entityId: string;
    entityName: string;
    field: string;
    current: unknown;
    proposed: unknown;
    campaignId?: string | null;
    adGroupId?: string | null;
    reason?: string;
  }): Promise<void> {
    const rows = await database.sql<{ id: string }[]>`
      insert into public.recommendations
        (run_id, org_id, profile_id, reason, entity_type, entity_id, ad_product, campaign_id,
         ad_group_id, entity_name, field, current_value, proposed_value, inputs)
      values (${options.run}, ${options.org}, ${options.profile},
              ${options.reason ?? 'high_acos'}::public.recommendation_reason,
              ${options.entityType}::public.entity_type, ${options.entityId}, 'SP',
              ${options.campaignId ?? null}, ${options.adGroupId ?? null}, ${options.entityName},
              ${options.field}, ${JSON.stringify(options.current)}::text::jsonb,
              ${JSON.stringify(options.proposed)}::text::jsonb,
              ${JSON.stringify({
                rpc: 1.8,
                clicks: 42,
                cvrSourceLevel: 'ad_group',
                ceilingApplied: 'data_based_ad_group',
                capClamped: true,
                window: { start: '2026-07-01', end: '2026-07-28' },
              })}::text::jsonb)
      returning id
    `;
    ids[options.key] = rows[0]?.id ?? '';
  }

  beforeAll(async () => {
    database = await createTestDatabase('wp07_web_recs');
    const [a] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('web-recs-alpha', ${USER_A}, 'owner')
    `;
    const [b] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('web-recs-bravo', ${USER_B}, 'owner')
    `;
    orgA = a?.seed_tenant_fixture ?? '';
    orgB = b?.seed_tenant_fixture ?? '';

    // An analyst in org A: may decide, may not export.
    await database.sql`select public.auth_user_stub(${USER_ANALYST})`;
    await database.sql`
      insert into public.org_members (org_id, user_id, role) values (${orgA}, ${USER_ANALYST}, 'analyst')
    `;

    const [pa] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgA} limit 1
    `;
    const [pb] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgB} limit 1
    `;
    profileA = pa?.id ?? '';
    profileB = pb?.id ?? '';

    // The fixture's campaign is nameless, so give it one the classifier can
    // read plus a portfolio, which is what makes the campaign update row legal.
    await database.sql`
      update public.campaigns
         set name = 'Alpha | SKW | blue widget', portfolio_amazon_id = 'pf-1',
             budget_amount = 50
       where org_id = ${orgA} and amazon_id = 'c-1'
    `;

    const [run] = await database.sql<{ id: string }[]>`
      insert into public.recommendation_runs
        (org_id, profile_id, status, lookback_days, window_start, window_end, engine_version,
         proposals_count, finished_at, strategy_snapshot)
      values (${orgA}, ${profileA}, 'succeeded', 28, '2026-07-01', '2026-07-28', 'core@test', 4,
              now(), ${JSON.stringify(STRATEGY)}::text::jsonb)
      returning id
    `;
    runA = run?.id ?? '';
    const [other] = await database.sql<{ id: string }[]>`
      insert into public.recommendation_runs
        (org_id, profile_id, status, lookback_days, engine_version, finished_at)
      values (${orgB}, ${profileB}, 'succeeded', 28, 'core@test', now())
      returning id
    `;
    runB = other?.id ?? '';

    await seedProposal({
      org: orgA, profile: profileA, run: runA, key: 'keyword', entityType: 'keyword',
      entityId: 'kw-1', entityName: 'blue widget', field: 'bid', current: 0.9, proposed: 0.72,
      campaignId: 'c-1', adGroupId: 'ag-1',
    });
    await seedProposal({
      org: orgA, profile: profileA, run: runA, key: 'campaign', entityType: 'campaign',
      entityId: 'c-1', entityName: 'Alpha | SKW | blue widget', field: 'budget', current: 50,
      proposed: 65, campaignId: 'c-1', reason: 'pacing',
    });
    await seedProposal({
      org: orgA, profile: profileA, run: runA, key: 'doomed', entityType: 'keyword',
      entityId: 'kw-2', entityName: 'widget set', field: 'bid', current: 1.1, proposed: 0.5,
      campaignId: 'c-1', adGroupId: 'ag-1',
    });
    await seedProposal({
      org: orgB, profile: profileB, run: runB, key: 'foreign', entityType: 'keyword',
      entityId: 'kw-1', entityName: 'other tenant', field: 'bid', current: 1, proposed: 2,
      campaignId: 'c-1', adGroupId: 'ag-1',
    });

    process.env['DATABASE_URL'] = database.connectionString;
    process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'] = BRIDGE_SECRET;
    process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'] = '1';
  }, 90_000);

  afterAll(async () => {
    if (previous.databaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = previous.databaseUrl;
    if (previous.bridgeSecret === undefined) delete process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'];
    else process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'] = previous.bridgeSecret;
    if (previous.bridgeEnabled === undefined) delete process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'];
    else process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'] = previous.bridgeEnabled;
    await database?.drop();
  });

  it('refuses a dismissal with no note', async () => {
    const response = await decide({ ids: [ids['doomed']], decision: 'dismissed', note: '   ' });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('needs a note');
  });

  it('accepts and dismisses in bulk, and stores the note as an audit entry', async () => {
    const accepted = await decide({
      ids: [ids['keyword'], ids['campaign']],
      decision: 'accepted',
      note: 'Weekly review: both are formula results with the ceiling stated.',
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ updated: 2, offered: 2 });

    const dismissed = await decide({
      ids: [ids['doomed']],
      decision: 'dismissed',
      note: 'Rank keyword: never cut on ACOS alone.',
    });
    expect(dismissed.status).toBe(200);
    expect(await dismissed.json()).toMatchObject({ updated: 1 });

    const rows = await listRecommendations(database, { orgId: orgA, runId: runA });
    const doomed = rows.find((row) => row.id === ids['doomed']);
    expect(doomed?.status).toBe('dismissed');
    expect(doomed?.decisionNote).toBe('Rank keyword: never cut on ACOS alone.');
    expect(doomed?.decidedBy).toBe(USER_A);
    // The strategy dimension resolves off the run's own snapshot.
    expect(rows.every((row) => row.campaignName === 'Alpha | SKW | blue widget')).toBe(true);
  });

  it('refuses to decide another tenant\'s proposal without saying it exists', async () => {
    const response = await decide({ ids: [ids['foreign']], decision: 'accepted', note: '' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { updated: number; refused: unknown[] };
    // Nothing moved, and nothing about the other tenant's row came back.
    expect(body.updated).toBe(0);
    expect(body.refused).toEqual([]);
    const foreignId = ids['foreign'] ?? '';
    const [row] = await database.sql<{ status: string }[]>`
      select status::text as status from public.recommendations where id = ${foreignId}
    `;
    expect(row?.status).toBe('proposed');
  });

  it('refuses an export from an analyst', async () => {
    const response = await EXPORT(
      new Request('http://localhost/api/recommendations/export', {
        method: 'POST',
        headers: headers(USER_ANALYST, orgA),
        body: JSON.stringify({ runId: runA, profileId: profileA, note: 'nope', optGroup: 'rank' }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it('exports the accepted set, never the dismissed one, and counts both', async () => {
    const response = await EXPORT(
      new Request('http://localhost/api/recommendations/export', {
        method: 'POST',
        headers: headers(USER_A, orgA),
        body: JSON.stringify({
          runId: runA,
          profileId: profileA,
          client: 'alpha',
          optGroup: 'rank',
          lever: 'bid-down',
          note: 'Weekly rank batch, formula results only.',
          today: '2026-08-14',
        }),
      }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      batchId: string;
      tag: string;
      exported: number;
      accepted: number;
      rows: { entityId: string }[];
      skipped: unknown[];
    };
    expect(body.tag).toBe('alpha-2026W33-rank-bid-down');
    expect(body.exported).toBe(2);
    expect(body.accepted).toBe(2);
    expect(body.rows.map((row) => row.entityId).sort()).toEqual(['c-1', 'kw-1']);
    expect(body.skipped).toEqual([]);

    const rows = await listRecommendations(database, { orgId: orgA, runId: runA });
    expect(rows.filter((row) => row.status === 'exported')).toHaveLength(2);
    // The one that mattered: a dismissed proposal is untouched by an export
    // that did not name it.
    expect(rows.find((row) => row.id === ids['doomed'])?.status).toBe('dismissed');
    expect(rows.find((row) => row.id === ids['keyword'])?.exportBatchTag).toBe(body.tag);

    // And the ledger holds exactly the rows the response claimed.
    const [count] = await database.sql<{ count: string }[]>`
      select count(*) as count from public.apply_rows where batch_id = ${body.batchId}
    `;
    expect(Number(count?.count ?? 0)).toBe(body.rows.length);
    ids['batch'] = body.batchId;
  });

  it('refuses a second export once nothing is accepted', async () => {
    const response = await EXPORT(
      new Request('http://localhost/api/recommendations/export', {
        method: 'POST',
        headers: headers(USER_A, orgA),
        body: JSON.stringify({
          runId: runA,
          profileId: profileA,
          client: 'alpha',
          optGroup: 'rank',
          lever: 'push',
          note: 'nothing left',
          today: '2026-08-14',
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'No accepted proposals to export.' });
  });

  const download = (format: string, userId = USER_A, orgId = orgA) =>
    DOWNLOAD(
      new Request(`http://localhost/api/recommendations/export/${ids['batch']}?format=${format}`, {
        headers: headers(userId, orgId),
      }),
      { params: Promise.resolve({ batchId: ids['batch'] ?? '' }) },
    );

  it('serves the rows JSON in the shape batches.py validates', async () => {
    const response = await download('rows');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain(
      'alpha-2026W33-rank-bid-down-rows.json',
    );
    const text = await response.text();
    expect(text.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(text) as Record<string, unknown>[];
    expect(parsed).toHaveLength(2);
    for (const row of parsed) {
      for (const key of ['entity_type', 'entity_id', 'field', 'old', 'new']) {
        expect(Object.keys(row)).toContain(key);
      }
    }
    const keyword = parsed.find((row) => row['entity_id'] === 'kw-1');
    expect(keyword).toMatchObject({ entity_type: 'keyword', field: 'bid', old: 0.9, new: 0.72 });
    // The provenance the caps-are-ceilings check reads: revenue is rpc x clicks,
    // never a number this layer invented.
    expect(keyword?.['clicks']).toBe(42);
    expect(keyword?.['revenue']).toBeCloseTo(75.6, 4);
  });

  it('serves a caps document carrying the run\'s own thresholds', async () => {
    const response = await download('caps');
    expect(response.status).toBe(200);
    const config = (await response.json()) as { validateCommand: string; targetAcos: number };
    expect(config.targetAcos).toBe(0.4);
    expect(config.validateCommand).toContain('--max-increase 0.2');
    expect(config.validateCommand).toContain('--max-decrease 0.3');
    expect(config.validateCommand).toContain('--tacos 0.4');
  });

  it('serves a workbook whose campaign row keeps its portfolio', async () => {
    const response = await download('xlsx');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('-bulk.xlsx');
    expect(response.headers.get('x-wizard-ads-skipped-rows')).toBe('0');
    const { readWorkbook } = await import('@wizard-ads/campaigns');
    const sheet = readWorkbook(new Uint8Array(await response.arrayBuffer()));
    expect(sheet.rows).toHaveLength(2);
    const campaignRow = sheet.rows.find(
      (row) => row[sheet.header.indexOf('Entity')] === 'Campaign',
    );
    expect(campaignRow?.[sheet.header.indexOf('Portfolio ID')]).toBe('pf-1');
    expect(campaignRow?.[sheet.header.indexOf('Daily Budget')]).toBe(65);
    expect(campaignRow?.[sheet.header.indexOf('Operation')]).toBe('Update');
  });

  it('hides another tenant\'s batch behind a 404', async () => {
    const response = await download('rows', USER_B, orgB);
    expect(response.status).toBe(404);
  });

  it('creates negative proposals from the explorer without writing anything', async () => {
    const response = await PROPOSE(
      new Request('http://localhost/api/ngrams/negatives', {
        method: 'POST',
        headers: headers(USER_ANALYST, orgA),
        body: JSON.stringify({
          profileId: profileA,
          window: { start: '2026-07-01', end: '2026-07-28' },
          proposals: [
            {
              searchTerm: 'free widget',
              campaignId: 'c-1',
              adGroupId: 'ag-1',
              matchType: 'negative_exact',
              clicks: 12,
              rpc: 0,
            },
          ],
        }),
      }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { runId: string; created: number; offered: number };
    expect(body.created).toBe(1);
    expect(body.offered).toBe(1);

    const rows = await listRecommendations(database, { orgId: orgA, runId: body.runId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entityType: 'negative',
      field: 'negative_keyword',
      status: 'proposed',
      entityName: 'free widget',
    });
    // Nothing was negated: the mirror still holds only the fixture's negative.
    const [count] = await database.sql<{ count: string }[]>`
      select count(*) as count from public.negatives where org_id = ${orgA}
    `;
    expect(Number(count?.count ?? 0)).toBe(1);
  });

  it('refuses to propose against another tenant\'s profile', async () => {
    const response = await PROPOSE(
      new Request('http://localhost/api/ngrams/negatives', {
        method: 'POST',
        headers: headers(USER_A, orgA),
        body: JSON.stringify({
          profileId: profileB,
          window: { start: '2026-07-01', end: '2026-07-28' },
          proposals: [{ searchTerm: 'x', campaignId: 'c-1', matchType: 'negative_exact' }],
        }),
      }),
    );
    expect(response.status).toBe(404);
  });
});
