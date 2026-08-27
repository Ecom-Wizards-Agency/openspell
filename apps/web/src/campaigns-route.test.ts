/** WP-50 at the HTTP boundary: synced ids in, reviewed file out, no Amazon or DB write. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import { readWorkbook } from '@wizard-ads/campaigns';
import { POST as BUILD } from '../app/api/campaigns/build/route.js';

const available = await databaseAvailable();
const USER_A = '50505050-5050-4050-8050-505050505061';
const USER_B = '50505050-5050-4050-8050-505050505062';
const BRIDGE_SECRET = 'synthetic-campaign-builder-route-secret';

describe.skipIf(!available)('campaign builder route', () => {
  let database: TestDatabase;
  let orgA = '';
  let orgB = '';
  let profileA = '';
  let profileB = '';
  const previous = {
    databaseUrl: process.env['DATABASE_URL'],
    bridgeSecret: process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'],
    bridgeEnabled: process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'],
  };

  const headers = (userId = USER_A, orgId = orgA) => ({
    'content-type': 'application/json',
    'x-wizard-ads-auth-bridge': BRIDGE_SECRET,
    'x-wizard-ads-user-id': userId,
    'x-wizard-ads-org-id': orgId,
  });

  const build = (body: unknown, userId = USER_A, orgId = orgA) => BUILD(
    new Request('http://localhost/api/campaigns/build', {
      method: 'POST',
      headers: headers(userId, orgId),
      body: JSON.stringify(body),
    }),
  );

  beforeAll(async () => {
    database = await createTestDatabase('wp50_web_campaigns');
    const [a] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('web-campaign-builder-alpha', ${USER_A}, 'owner')
    `;
    const [b] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('web-campaign-builder-bravo', ${USER_B}, 'owner')
    `;
    orgA = a?.seed_tenant_fixture ?? '';
    orgB = b?.seed_tenant_fixture ?? '';
    const [pa] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgA} limit 1
    `;
    const [pb] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgB} limit 1
    `;
    profileA = pa?.id ?? '';
    profileB = pb?.id ?? '';
    await database.sql`
      insert into public.campaigns
        (org_id, profile_id, amazon_id, ad_product, name, state, portfolio_amazon_id,
         budget_amount, budget_type, targeting_type, bidding_strategy, end_date)
      values (${orgA}, ${profileA}, '1001', 'SP', 'Synthetic live campaign', 'enabled',
              '9001', 20.00, 'daily', 'manual', 'legacy_for_sales', '2026-12-31')
    `;

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

  const updateBody = (output: 'preview' | 'xlsx') => ({
    mode: 'update',
    output,
    profileId: profileA,
    config: {
      allowEndDateClear: false,
      changes: { campaigns: [{ campaignId: '1001', dailyBudget: 25 }] },
    },
  });

  it('preflights against the selected profile and returns every diff row', async () => {
    const response = await build(updateBody('preview'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ready: boolean;
      exportable: boolean;
      rows: Record<string, string | number>[];
      counts: { update: number; archive: number; create: number };
    };
    expect(body.ready).toBe(true);
    expect(body.exportable).toBe(true);
    expect(body.rows).toHaveLength(1);
    expect(body.counts).toEqual({ update: 1, archive: 0, create: 0 });
    expect(body.rows[0]).toMatchObject({
      Entity: 'Campaign',
      Operation: 'Update',
      'Campaign ID': '1001',
      'Daily Budget': 25,
      'Portfolio ID': '9001',
      'End Date': '20261231',
    });
  });

  it('downloads those sparse rows and changes nothing in the mirror', async () => {
    const response = await build(updateBody('xlsx'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('spreadsheetml');
    expect(response.headers.get('content-disposition')).toContain('_SP_bulk_UPDATE.xlsx');
    expect(response.headers.get('x-wizard-ads-bulk-rows')).toBe('1');
    const workbook = readWorkbook(new Uint8Array(await response.arrayBuffer()));
    expect(workbook.rows).toHaveLength(1);
    expect(workbook.rows[0]?.[workbook.header.indexOf('Operation')]).toBe('Update');
    expect(workbook.rows[0]?.[workbook.header.indexOf('Portfolio ID')]).toBe('9001');

    const [stored] = await database.sql<{ budget_amount: string }[]>`
      select budget_amount from public.campaigns
       where org_id = ${orgA} and profile_id = ${profileA} and amazon_id = '1001'
    `;
    expect(Number(stored?.budget_amount)).toBe(20);
  });

  it('surfaces an unmatched id in preflight and refuses its workbook', async () => {
    const body = {
      ...updateBody('preview'),
      config: { changes: { campaigns: [{ campaignId: '9999', dailyBudget: 25 }] } },
    };
    const previewResponse = await build(body);
    const preview = (await previewResponse.json()) as { ready: boolean; rows: unknown[]; issues: string[] };
    expect(preview.ready).toBe(false);
    expect(preview.rows).toEqual([]);
    expect(preview.issues[0]).toContain("campaign_id '9999' not found");

    const exportResponse = await build({ ...body, output: 'xlsx' });
    expect(exportResponse.status).toBe(422);
    expect(await exportResponse.json()).toMatchObject({ preview: { exportable: false } });
  });

  it('hides another tenant profile behind a 404', async () => {
    const response = await build({ ...updateBody('preview'), profileId: profileB });
    expect(response.status).toBe(404);
  });

  it('keeps CREATE mode available on the same surface', async () => {
    const response = await build({
      mode: 'create',
      output: 'preview',
      config: {
        client: 'Synthetic route',
        marketplace: 'US',
        naming: {
          variableOrder: ['Goal', 'SP', 'MatchType', 'ProductName', 'TargetDescriptor', 'EW'],
          delimiter: ' | ', suffix: 'EW', custom1Value: '', custom2Value: '',
        },
        defaults: { dailyBudget: 10, keywordBid: 0.5, state: 'paused' },
        campaigns: [{ campaignType: 'Halo', productName: 'Widget', targetDescriptor: 'long-tail',
                      sku: ['SKU-1'], keywords: ['synthetic keyword'] }],
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      mode: 'create',
      ready: true,
      exportable: true,
      counts: { create: 4 },
    });
  });
});
