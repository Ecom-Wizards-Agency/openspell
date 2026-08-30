/** Auth, tenancy, count, and cache contract for the complete Grid row route. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import { createRequestDatabase } from '@wizard-ads/db';
import type { RequestDatabase } from '@wizard-ads/db';
import type { TestDatabase } from '@wizard-ads/db/testing';
import type { GridRow } from '@wizard-ads/ui';
import { createGridRowsGet, GET, parseGridRowsQuery } from '../app/api/grid/rows/route.js';
import {
  GRID_RESPONSE_BODY_BUDGET_BYTES,
  serializeGridPayloadWithinBudget,
} from '../app/api/grid/rows/serialize.js';
import { GRID_SERVER_TIMING_SPANS } from '../app/api/grid/rows/server-timing.js';
import { RequestAuthError } from './server/request-context.js';
import {
  createGridRequestAuthorizer,
  resolveGridReadReceipt,
} from './grid/request-context.js';
import { listMemberships } from './data/orgs.js';

const available = await databaseAvailable();
const USER_A = '14141414-1414-4414-8414-141414141414';
const USER_B = '24242424-2424-4424-8424-242424242424';
const USER_DUPLICATE_NAMES = '30303030-3030-4030-8030-303030303030';
const UNKNOWN_PROFILE = '34343434-3434-4434-8434-343434343434';
const LOWER_DUPLICATE_ORG = '10101010-1010-4010-8010-101010101010';
const HIGHER_DUPLICATE_ORG = '90909090-9090-4090-8090-909090909090';
const LOWER_DUPLICATE_PROFILE = '12121212-1212-4212-8212-121212121212';
const BRIDGE_SECRET = 'synthetic-grid-rows-route-bridge';
const midpoint = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 15));
const TEST_DATE = midpoint.toISOString().slice(0, 10);
const COMPARISON_DATE = new Date(midpoint.getTime() - 86_400_000).toISOString().slice(0, 10);
const PERIOD = { from: TEST_DATE, to: TEST_DATE } as const;

function representativeRow(index: number): GridRow {
  return {
    id: `transport-row-${index}`,
    dimensions: {
      search_term: `synthetic query ${index} ${'detail '.repeat(12)}`,
      campaign_name: `Synthetic campaign ${index % 19}`,
      ad_group_name: `Synthetic ad group ${index % 31}`,
      match_type: index % 2 === 0 ? 'exact' : 'phrase',
      ad_product: 'SP',
      harvested: index % 3 === 0,
    },
    totals: {
      impressions: index * 10,
      clicks: index,
      spend: index / 10,
      sales: index / 5,
      orders: index % 5,
      units: index % 7,
    },
    comparison: null,
    currencyCode: 'USD',
  };
}

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
    const source = (
      await Promise.all([
        readFile(
          fileURLToPath(new URL('../app/api/grid/rows/route.ts', import.meta.url)),
          'utf8',
        ),
        readFile(
          fileURLToPath(new URL('./grid/request-context.ts', import.meta.url)),
          'utf8',
        ),
      ])
    ).join('\n');
    expect(source).not.toMatch(/ads-api|sp-api|amazon token|enqueue|\bfetch\s*\(/i);
    expect(source).toContain('loadGridRows');
    expect(source).toContain('getClaims()');
  });
});

describe('Grid response byte budget', () => {
  it('preserves the complete 3,597-row reference payload below the raw-byte budget', () => {
    const rows = Array.from({ length: 3_597 }, (_, index) => representativeRow(index + 1));
    const serialized = serializeGridPayloadWithinBudget({
      rows,
      rowCount: rows.length,
      truncated: false,
    });
    const parsed = JSON.parse(serialized.body) as {
      rows: GridRow[];
      rowCount: number;
      truncated: boolean;
    };

    expect(serialized.byteLength).toBe(new TextEncoder().encode(serialized.body).byteLength);
    expect(serialized.byteLength).toBeLessThanOrEqual(GRID_RESPONSE_BODY_BUDGET_BYTES);
    expect(parsed.rowCount).toBe(3_597);
    expect(parsed.rows).toHaveLength(3_597);
    expect(parsed.rows.at(-1)?.id).toBe('transport-row-3597');
    expect(parsed.truncated).toBe(false);
  });

  it('returns the largest safe prefix of a representative 50,000-row payload', () => {
    const rows = Array.from({ length: 50_000 }, (_, index) => representativeRow(index + 1));
    const serialized = serializeGridPayloadWithinBudget({
      rows,
      rowCount: rows.length,
      truncated: false,
    });
    const parsed = JSON.parse(serialized.body) as {
      rows: GridRow[];
      rowCount: number;
      truncated: boolean;
    };

    expect(serialized.byteLength).toBe(new TextEncoder().encode(serialized.body).byteLength);
    expect(serialized.byteLength).toBeLessThanOrEqual(GRID_RESPONSE_BODY_BUDGET_BYTES);
    expect(parsed.rowCount).toBeGreaterThan(0);
    expect(parsed.rowCount).toBeLessThan(50_000);
    expect(parsed.rows).toHaveLength(parsed.rowCount);
    expect(parsed.rows.at(-1)?.id).toBe(`transport-row-${parsed.rowCount}`);
    expect(parsed.truncated).toBe(true);

    const withNextRow = rows.slice(0, parsed.rowCount + 1);
    const nextAttempt = serializeGridPayloadWithinBudget({
      rows: withNextRow,
      rowCount: withNextRow.length,
      truncated: false,
    });
    expect(nextAttempt.payload.rowCount).toBe(parsed.rowCount);
  });
});

describe('Grid rows route runtime', () => {
  const validQuery = new URLSearchParams({
    profile: UNKNOWN_PROFILE,
    entity: 'targets',
    from: TEST_DATE,
    to: TEST_DATE,
  }).toString();
  const request = (query = validQuery) => new Request(`http://localhost/api/grid/rows?${query}`);

  function database() {
    const close = vi.fn(async () => {});
    const sql = vi.fn() as unknown as RequestDatabase['sql'];
    return { handle: { sql, close }, close };
  }

  it('passes one request handle and only receipt-owned scope to the row loader, then closes once', async () => {
    const { handle, close } = database();
    const seen: unknown[] = [];
    const get = createGridRowsGet({
      authorizeRequest: createGridRequestAuthorizer({
        identify: async () => ({
          userId: USER_A,
          organization: { mode: 'preferred' as const, orgId: null },
        }),
        openDatabase: () => handle,
        resolveReceipt: async (received, _subject, candidateProfileId) => {
          seen.push(received, candidateProfileId);
          return {
            orgId: '45454545-4545-4545-8545-454545454545',
            role: 'viewer',
            profileId: UNKNOWN_PROFILE,
            currencyCode: 'GBP',
          };
        },
      }),
      loadRows: async (received, entity, options) => {
        seen.push(received, entity, options);
        return { rows: [], rowCount: 0, truncated: false };
      },
    });

    const response = await get(request());
    expect(response.status).toBe(200);
    expect(seen[0]).toBe(handle);
    expect(seen[1]).toBe(UNKNOWN_PROFILE);
    expect(seen[2]).toBe(handle);
    expect(seen[3]).toBe('targets');
    expect(seen[4]).toMatchObject({
      orgId: '45454545-4545-4545-8545-454545454545',
      profileId: UNKNOWN_PROFILE,
      currencyCode: 'GBP',
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(response.headers.get('server-timing')).toContain('close;dur=');
  });

  it('keeps identity, membership, input, and profile refusal in that order', async () => {
    const invalidQuery = 'profile=not-a-profile&entity=accounts&from=nope&to=nope';

    const identityDatabase = database();
    const identityOpen = vi.fn(() => identityDatabase.handle);
    const identityGet = createGridRowsGet({
      authorizeRequest: createGridRequestAuthorizer({
        identify: async () => {
          throw new RequestAuthError('Authentication required', 401);
        },
        openDatabase: identityOpen,
        resolveReceipt: async () => {
          throw new Error('authorization must not run');
        },
      }),
      loadRows: async () => {
        throw new Error('rows must not run');
      },
    });
    const identity = await identityGet(request(invalidQuery));
    expect(identity.status).toBe(401);
    expect(identityOpen).not.toHaveBeenCalled();

    const membershipDatabase = database();
    const membershipGet = createGridRowsGet({
      authorizeRequest: createGridRequestAuthorizer({
        identify: async () => ({
          userId: USER_A,
          organization: { mode: 'preferred' as const, orgId: null },
        }),
        openDatabase: () => membershipDatabase.handle,
        resolveReceipt: async () => {
          throw new RequestAuthError('Resource not found', 403);
        },
      }),
      loadRows: async () => {
        throw new Error('rows must not run');
      },
    });
    const membership = await membershipGet(request(invalidQuery));
    expect(membership.status).toBe(403);
    expect(membershipDatabase.close).toHaveBeenCalledTimes(1);

    const inputDatabase = database();
    const inputGet = createGridRowsGet({
      authorizeRequest: createGridRequestAuthorizer({
        identify: async () => ({
          userId: USER_A,
          organization: { mode: 'preferred' as const, orgId: null },
        }),
        openDatabase: () => inputDatabase.handle,
        resolveReceipt: async (_handle, _subject, candidateProfileId) => {
          expect(candidateProfileId).toBeNull();
          return {
            orgId: '45454545-4545-4545-8545-454545454545',
            role: 'viewer',
            profileId: null,
            currencyCode: null,
          };
        },
      }),
      loadRows: async () => {
        throw new Error('rows must not run');
      },
    });
    const input = await inputGet(request(invalidQuery));
    expect(input.status).toBe(400);
    expect(inputDatabase.close).toHaveBeenCalledTimes(1);

    const profileDatabase = database();
    const profileGet = createGridRowsGet({
      authorizeRequest: createGridRequestAuthorizer({
        identify: async () => ({
          userId: USER_A,
          organization: { mode: 'preferred' as const, orgId: null },
        }),
        openDatabase: () => profileDatabase.handle,
        resolveReceipt: async () => ({
          orgId: '45454545-4545-4545-8545-454545454545',
          role: 'viewer',
          profileId: null,
          currencyCode: null,
        }),
      }),
      loadRows: async () => {
        throw new Error('rows must not run');
      },
    });
    const profile = await profileGet(request());
    expect(profile.status).toBe(404);
    expect(profileDatabase.close).toHaveBeenCalledTimes(1);

    for (const response of [identity, membership, input, profile]) {
      expect(response.headers.has('server-timing')).toBe(false);
    }
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
      bridgeValue?: string;
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
          'x-wizard-ads-auth-bridge': options.bridgeValue ?? BRIDGE_SECRET,
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
    const serverTiming = response.headers.get('server-timing') ?? '';
    expect(serverTiming.split(', ').map((span) => span.split(';')[0])).toEqual([
      ...GRID_SERVER_TIMING_SPANS,
      'total',
    ]);
    expect(serverTiming).toMatch(
      /^actor;dur=\d+\.\d{2}, role;dur=\d+\.\d{2}, profile;dur=\d+\.\d{2}, rows;dur=\d+\.\d{2}, serialize;dur=\d+\.\d{2}, close;dur=\d+\.\d{2}, total;dur=\d+\.\d{2}$/,
    );
    expect(serverTiming).not.toContain(profileA);
    expect(serverTiming).not.toContain(orgA);

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
    const invalidBridgeValue = ['wrong', 'bridge', 'value'].join('-');
    const unauthorized = await request({ bridgeValue: invalidBridgeValue });
    const forbidden = await request({ orgId: orgB });
    const malformedUnauthorized = await request({
      profile: 'not-a-profile',
      entity: 'accounts',
      from: 'nope',
      to: 'nope',
      bridgeValue: invalidBridgeValue,
    });
    const malformedForbidden = await request({
      profile: 'not-a-profile',
      entity: 'accounts',
      from: 'nope',
      to: 'nope',
      orgId: orgB,
    });
    expect(unauthorized.status).toBe(401);
    expect(forbidden.status).toBe(403);
    expect(malformedUnauthorized.status).toBe(401);
    expect(malformedForbidden.status).toBe(403);
    expect(unauthorized.headers.has('server-timing')).toBe(false);
    expect(forbidden.headers.has('server-timing')).toBe(false);

    const foreign = await request({ profile: profileB });
    const unknown = await request({ profile: UNKNOWN_PROFILE });
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await foreign.json()).toEqual(await unknown.json());
    expect(foreign.headers.has('server-timing')).toBe(false);
    expect(unknown.headers.has('server-timing')).toBe(false);
  });

  it('rejects unsupported entities and impossible or inverted dates before querying rows', async () => {
    const attempts = await Promise.all([
      request({ entity: 'accounts' }),
      request({ from: '2026-02-30', to: '2026-02-30' }),
      request({ from: '2026-07-01', to: '2026-06-30' }),
      request({ profile: 'not-a-profile' }),
    ]);
    expect(attempts.map((response) => response.status)).toEqual([400, 400, 400, 400]);
    expect(attempts.every((response) => !response.headers.has('server-timing'))).toBe(true);
  });

  it('selects a valid preference, falls back deterministically, and keeps bridge orgs exact', async () => {
    const requestDatabase = createRequestDatabase(database.connectionString);
    try {
      const fallback = await resolveGridReadReceipt(
        requestDatabase,
        { userId: USER_A, organization: { mode: 'preferred', orgId: null } },
        profileA,
      );
      expect(fallback).toMatchObject({ orgId: orgA, profileId: profileA, currencyCode: 'USD' });

      await database.sql`
        insert into public.org_members (org_id, user_id, role)
        values (${orgB}, ${USER_A}, 'analyst')
      `;

      const preferred = await resolveGridReadReceipt(
        requestDatabase,
        { userId: USER_A, organization: { mode: 'preferred', orgId: orgB } },
        profileB,
      );
      expect(preferred).toMatchObject({
        orgId: orgB,
        role: 'analyst',
        profileId: profileB,
        currencyCode: 'USD',
      });

      const deterministicFallback = await resolveGridReadReceipt(
        requestDatabase,
        { userId: USER_A, organization: { mode: 'preferred', orgId: null } },
        profileA,
      );
      expect(deterministicFallback).toMatchObject({ orgId: orgA, profileId: profileA });

      const exact = await resolveGridReadReceipt(
        requestDatabase,
        { userId: USER_A, organization: { mode: 'exact', orgId: orgB } },
        profileB,
      );
      expect(exact).toEqual(preferred);

      await expect(
        resolveGridReadReceipt(
          requestDatabase,
          {
            userId: USER_A,
            organization: { mode: 'exact', orgId: UNKNOWN_PROFILE },
          },
          profileA,
        ),
      ).rejects.toMatchObject({ status: 403 });
    } finally {
      await requestDatabase.close();
    }
  });

  it('uses the same UUID tie-break as the page when organization names are duplicated', async () => {
    // Insert the higher UUID first so physical/insertion order cannot make this
    // test pass accidentally. Organization display names are intentionally not
    // unique, while slugs remain unique as the production schema requires.
    await database.sql`
      insert into auth.users (id) values (${USER_DUPLICATE_NAMES})
    `;
    await database.sql`
      insert into public.orgs (id, slug, name)
      values
        (${HIGHER_DUPLICATE_ORG}, 'duplicate-name-higher', 'Duplicate display'),
        (${LOWER_DUPLICATE_ORG}, 'duplicate-name-lower', 'Duplicate display')
    `;
    await database.sql`
      insert into public.org_members (org_id, user_id, role)
      values
        (${HIGHER_DUPLICATE_ORG}, ${USER_DUPLICATE_NAMES}, 'viewer'),
        (${LOWER_DUPLICATE_ORG}, ${USER_DUPLICATE_NAMES}, 'analyst')
    `;
    await database.sql`
      insert into public.ad_profiles
        (id, org_id, amazon_profile_id, region, country_code, currency_code, timezone)
      values
        (${LOWER_DUPLICATE_PROFILE}, ${LOWER_DUPLICATE_ORG}, 'duplicate-name-profile',
         'NA', 'US', 'USD', 'UTC')
    `;

    const pageMemberships = await listMemberships(database, USER_DUPLICATE_NAMES);
    expect(pageMemberships.map((membership) => membership.orgId)).toEqual([
      LOWER_DUPLICATE_ORG,
      HIGHER_DUPLICATE_ORG,
    ]);

    const requestDatabase = createRequestDatabase(database.connectionString);
    try {
      const gridReceipt = await resolveGridReadReceipt(
        requestDatabase,
        {
          userId: USER_DUPLICATE_NAMES,
          organization: { mode: 'preferred', orgId: null },
        },
        LOWER_DUPLICATE_PROFILE,
      );
      expect(gridReceipt.orgId).toBe(pageMemberships[0]?.orgId);
      expect(gridReceipt).toMatchObject({
        orgId: LOWER_DUPLICATE_ORG,
        role: 'analyst',
        profileId: LOWER_DUPLICATE_PROFILE,
        currencyCode: 'USD',
      });
    } finally {
      await requestDatabase.close();
    }
  });

});
