import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import { POST } from '../app/api/mcp-keys/route';

const available = await databaseAvailable();
const USER_A = '30303030-3030-4030-8030-303030303030';
const USER_B = '40404040-4040-4040-8040-404040404040';
const BRIDGE_SECRET = 'synthetic-mcp-key-route-bridge-secret';

describe.skipIf(!available)('MCP key issue route', () => {
  let database: TestDatabase;
  let orgA = '';
  let profileA = '';
  let profileB = '';
  const previous = {
    databaseUrl: process.env['DATABASE_URL'],
    bridgeSecret: process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'],
    bridgeEnabled: process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'],
  };

  const request = (body: unknown) =>
    POST(
      new Request('http://localhost/api/mcp-keys', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-wizard-ads-auth-bridge': BRIDGE_SECRET,
          'x-wizard-ads-user-id': USER_A,
          'x-wizard-ads-org-id': orgA,
        },
        body: JSON.stringify(body),
      }),
    );

  beforeAll(async () => {
    database = await createTestDatabase('wp54d_mcp_keys_route');
    const [a] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('mcp-key-route-alpha', ${USER_A}, 'owner')
    `;
    const [b] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('mcp-key-route-bravo', ${USER_B}, 'owner')
    `;
    orgA = a?.seed_tenant_fixture ?? '';
    const [ownProfile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgA} limit 1
    `;
    const [foreignProfile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${b?.seed_tenant_fixture ?? ''} limit 1
    `;
    profileA = ownProfile?.id ?? '';
    profileB = foreignProfile?.id ?? '';
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

  it('issues only a read-only, expiring key for the submitted allowlist', async () => {
    const response = await request({
      label: 'Synthetic route client',
      profileIds: [profileA],
      expiresInDays: 7,
      scope: 'write',
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      key: { scope: string; profileIds: string[]; expiresAt: string };
      token: string;
    };
    expect(body.key.scope).toBe('read');
    expect(body.key.profileIds).toEqual([profileA]);
    expect(new Date(body.key.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(typeof body.token).toBe('string');

    const beforeDefaultIssue = Date.now();
    const defaultExpiryResponse = await request({
      label: 'Default expiry client',
      profileIds: [profileA],
    });
    expect(defaultExpiryResponse.status).toBe(201);
    const defaultExpiryBody = (await defaultExpiryResponse.json()) as {
      key: { expiresAt: string };
    };
    const defaultLifetimeDays =
      (new Date(defaultExpiryBody.key.expiresAt).getTime() - beforeDefaultIssue) /
      (24 * 60 * 60 * 1_000);
    expect(defaultLifetimeDays).toBeGreaterThan(29.99);
    expect(defaultLifetimeDays).toBeLessThan(30.01);
  });

  it('rejects empty or foreign allowlists and an unsupported expiry without inserting', async () => {
    const [{ count: before = 0 } = {}] = await database.sql<{ count: number }[]>`
      select count(*)::int as count from mcp.api_keys where org_id = ${orgA}
    `;
    const attempts = await Promise.all([
      request({ label: 'No profile', profileIds: [], expiresInDays: 30 }),
      request({ label: 'Foreign profile', profileIds: [profileB], expiresInDays: 30 }),
      request({ label: 'Long lived', profileIds: [profileA], expiresInDays: 365 }),
    ]);
    expect(attempts.map((response) => response.status)).toEqual([400, 400, 400]);
    const [{ count: after = 0 } = {}] = await database.sql<{ count: number }[]>`
      select count(*)::int as count from mcp.api_keys where org_id = ${orgA}
    `;
    expect(after).toBe(before);
  });
});
