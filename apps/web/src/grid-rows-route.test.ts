/** Auth, tenancy, count, and cache contract for the complete Grid row route. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import { GET, parseGridRowsQuery } from '../app/api/grid/rows/route.js';

const available = await databaseAvailable();
const USER_A = '14141414-1414-4414-8414-141414141414';
const USER_B = '24242424-2424-4424-8424-242424242424';
const UNKNOWN_PROFILE = '34343434-3434-4434-8434-343434343434';
const BRIDGE_SECRET = 'synthetic-grid-rows-route-bridge';
const midpoint = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 15));
const TEST_DATE = midpoint.toISOString().slice(0, 10);
const COMPARISON_DATE = new Date(midpoint.getTime() - 86_400_000).toISOString().slice(0, 10);
const PERIOD = { from: TEST_DATE, to: TEST_DATE } as const;

describe('Grid rows route contract', () => {
  it('accepts only a real, ordered date window and supported entity', () => {
    const query = parseGridRowsQuery(
      `http://localhost/api/grid/rows?profile=${UNKNOWN_PROFILE}&entity=search_terms&from=${TEST_DATE}&to=${TEST_DATE}`,
    );
    expect(query).toEqual({
      profileId: UNKNOWN_PROFILE,
      entity: 'search_terms',
      period: { start: TEST_DATE, end: TEST_DATE },
    });
    expect(() => parseGridRowsQuery(
      `http://localhost/api/grid/rows?profile=${UNKNOWN_PROFILE}&entity=accounts&from=${TEST_DATE}&to=${TEST_DATE}`,
    )).toThrow('entity must be one of');
    expect(() => parseGridRowsQuery(
      `http://localhost/api/grid/rows?profile=${UNKNOWN_PROFILE}&entity=targets&from=2026-02-30&to=2026-02-30`,
    )).toThrow('ordered ISO date window');
  });

  it('contains no Amazon client, mutation, credential, or outbound fetch path', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../app/api/grid/rows/route.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/ads-api|sp-api|amazon token|enqueue|\bfetch\s*\(/i);
    expect(source).toContain('loadGridRows');
  });
});

describe.skipIf(!available)('Grid rows route', () => {
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

  const request = (
    options: {
      profile?: string;
      entity?: string;
      from?: string;
      to?: string;
      userId?: string;
      orgId?: string;
      secret?: string;
    } = {},
  ) => {
    const query = new URLSearchParams({
      profile: options.profile ?? profileA,
      entity: options.entity ?? 'targets',
      from: options.from ?? PERIOD.from,
      to: options.to ?? PERIOD.to,
    });
    return GET(
      new Request(`http://localhost/api/grid/rows?${query.toString()}`, {
        headers: {
          'x-wizard-ads-auth-bridge': options.secret ?? BRIDGE_SECRET,
          'x-wizard-ads-user-id': options.userId ?? USER_A,
          'x-wizard-ads-org-id': options.orgId ?? orgA,
        },
      }),
    );
  };

  beforeAll(async () => {
    database = await createTestDatabase('wp142_web_grid_rows');
    const [a] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('grid-route-alpha', ${USER_A}, 'owner', ${PERIOD.to}::date)
    `;
    const [b] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('grid-route-bravo', ${USER_B}, 'owner', ${PERIOD.to}::date)
    `;
    orgA = a?.seed_tenant_fixture ?? '';
    orgB = b?.seed_tenant_fixture ?? '';
    const [ownProfile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgA} limit 1
    `;
    const [foreignProfile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgB} limit 1
    `;
    profileA = ownProfile?.id ?? '';
    profileB = foreignProfile?.id ?? '';

    // The preceding day is not accepted from the browser. Its presence in the
    // response proves the route derived the equal-length comparison itself.
    await database.sql`
      insert into public.fact_sp_target_daily
        (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, target_id,
         target_kind, match_type, impressions, clicks, cost, purchases_7d, sales_7d,
         units_sold_7d)
      values (${orgA}, ${profileA}, ${COMPARISON_DATE}::date, 'SP', 'c-1', 'ag-1', 'kw-1',
              'keyword', 'exact', 50, 2, 1.50, 1, 10.00, 1)
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

  it('returns one counted complete payload with server-owned currency and comparison', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('vary')).toBe('Cookie');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');

    const payload = (await response.json()) as {
      rows: Array<{ currencyCode: string; comparison: { spend: number } | null }>;
      rowCount: number;
      truncated: boolean;
    };
    expect(payload.rowCount).toBe(1);
    expect(payload.rows).toHaveLength(payload.rowCount);
    expect(payload.truncated).toBe(false);
    expect(payload.rows[0]).toMatchObject({ currencyCode: 'USD', comparison: { spend: 1.5 } });
  });

  it('requires a vouched-for member and hides foreign or unknown profiles equally', async () => {
    expect((await request({ secret: 'wrong-bridge-secret' })).status).toBe(401);
    expect((await request({ orgId: orgB })).status).toBe(403);

    const foreign = await request({ profile: profileB });
    const unknown = await request({ profile: UNKNOWN_PROFILE });
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await foreign.json()).toEqual(await unknown.json());
  });

  it('rejects unsupported entities and impossible or inverted dates before querying rows', async () => {
    const attempts = await Promise.all([
      request({ entity: 'accounts' }),
      request({ from: '2026-02-30', to: '2026-02-30' }),
      request({ from: '2026-07-01', to: '2026-06-30' }),
      request({ profile: 'not-a-profile' }),
    ]);
    expect(attempts.map((response) => response.status)).toEqual([400, 400, 400, 400]);
  });

});
