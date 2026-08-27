/**
 * The experiments API at the HTTP boundary.
 *
 * The database suite proves the tenancy of the reads; this proves the one write
 * that takes a profile id from the caller. `profile_id` on `experiments` is a
 * foreign key to `ad_profiles (id)` and nothing more, so another tenant's
 * profile satisfied it perfectly well: a member of org A could file an
 * experiment against org B's profile, and every chart and window query keyed on
 * that profile then carried it.
 *
 * A foreign profile and an unknown one answer the same 404, so the response
 * cannot be used to find out which profile ids exist.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import { POST } from '../app/api/experiments/route.js';
import { listProfileOptions } from './experiments/data.js';

const available = await databaseAvailable();
const OWNER_A = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a';
const OWNER_B = '7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b7b';
const BRIDGE_SECRET = ['synthetic', 'experiments', 'route', 'bridge'].join('-');

describe.skipIf(!available)('POST /api/experiments', () => {
  let database: TestDatabase;
  let orgA: string;
  let profileA: string;
  let profileB: string;
  const previous = {
    databaseUrl: process.env['DATABASE_URL'],
    bridgeSecret: process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'],
    bridgeEnabled: process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'],
  };

  const create = (body: Record<string, unknown>): Promise<Response> =>
    POST(
      new Request('http://localhost/api/experiments', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-wizard-ads-auth-bridge': BRIDGE_SECRET,
          'x-wizard-ads-user-id': OWNER_A,
          'x-wizard-ads-org-id': orgA,
        },
        body: JSON.stringify(body),
      }),
    );

  beforeAll(async () => {
    database = await createTestDatabase('web_experiments_route');
    const [a] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('exp-route-alpha', ${OWNER_A}, 'owner')
    `;
    const [b] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('exp-route-bravo', ${OWNER_B}, 'owner')
    `;
    orgA = a?.seed_tenant_fixture ?? '';
    const orgB = b?.seed_tenant_fixture ?? '';
    const [first] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgA} limit 1
    `;
    const [second] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgB} limit 1
    `;
    profileA = first?.id ?? '';
    profileB = second?.id ?? '';

    process.env['DATABASE_URL'] = database.connectionString;
    process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'] = BRIDGE_SECRET;
    process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'] = '1';
  }, 60_000);

  afterAll(async () => {
    if (previous.databaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = previous.databaseUrl;
    if (previous.bridgeSecret === undefined) delete process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'];
    else process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'] = previous.bridgeSecret;
    if (previous.bridgeEnabled === undefined) delete process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'];
    else process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'] = previous.bridgeEnabled;
    await database?.drop();
  });

  it('creates against the actor\'s own profile', async () => {
    const response = await create({
      profileId: profileA,
      name: 'Own profile',
      type: 'bid_push',
      metricFocus: 'acos',
    });
    expect(response.status).toBe(201);
    const { item } = (await response.json()) as { item: { profileId: string } };
    expect(item.profileId).toBe(profileA);
  });

  it('loads only syncing profile options and includes the marketplace suffix data', async () => {
    await database.sql`
      update public.ad_profiles
         set account_name = 'Duplicate label', country_code = 'US', sync_enabled = true
       where id = ${profileA}
    `;
    const [off] = await database.sql<{ id: string }[]>`
      insert into public.ad_profiles
        (org_id, amazon_profile_id, region, country_code, currency_code, timezone,
         account_name, sync_enabled)
      values
        (${orgA}, 'exp-sync-off', 'EU', 'DE', 'EUR', 'Europe/Berlin', 'Duplicate label', false)
      returning id
    `;

    const options = await listProfileOptions(database, orgA);
    expect(options).toContainEqual({
      id: profileA,
      label: 'Duplicate label',
      currencyCode: 'USD',
      countryCode: 'US',
    });
    expect(options.some((profile) => profile.id === off?.id)).toBe(false);
  });

  it('refuses another org\'s profile with a 404, and writes nothing', async () => {
    const response = await create({
      profileId: profileB,
      name: 'Cross-tenant',
      type: 'bid_push',
      metricFocus: 'acos',
    });
    expect(response.status).toBe(404);

    const [rows] = await database.sql<{ n: string }[]>`
      select count(*) as n from public.experiments
       where org_id = ${orgA} and profile_id = ${profileB}
    `;
    expect(Number(rows?.n)).toBe(0);
  });

  it('refuses an unknown profile the same way, not with a 500', async () => {
    for (const profileId of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      const response = await create({
        profileId,
        name: 'Unknown profile',
        type: 'bid_push',
        metricFocus: 'acos',
      });
      expect(response.status).toBe(404);
    }
  });
});
