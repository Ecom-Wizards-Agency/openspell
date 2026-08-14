import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import { createGotoLink, stateFromGotoRedirect } from '@wizard-ads/db';
import { POST } from '../app/api/goto/route.js';
import { GET } from '../app/go/[token]/route.js';

const available = await databaseAvailable();
const USER_A = '85858585-8585-4585-8585-858585858585';
const USER_B = '86868686-8686-4686-8686-868686868686';
const SIGNING_SECRET = 'synthetic-route-signing-secret-for-tests';
const BRIDGE_SECRET = 'synthetic-auth-bridge-secret';

describe.skipIf(!available)('/go/[token] route', () => {
  let database: TestDatabase;
  let orgA: string;
  let orgB: string;
  const previous = {
    databaseUrl: process.env['DATABASE_URL'],
    signingSecret: process.env['GOTO_LINK_SIGNING_SECRET'],
    bridgeSecret: process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'],
    bridgeEnabled: process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'],
  };

  const requestHeaders = (userId: string, orgId: string) => ({
    'content-type': 'application/json',
    'x-wizard-ads-auth-bridge': BRIDGE_SECRET,
    'x-wizard-ads-user-id': userId,
    'x-wizard-ads-org-id': orgId,
  });

  beforeAll(async () => {
    database = await createTestDatabase('wp08_web_goto');
    const [a] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('web-goto-alpha', ${USER_A}, 'owner')
    `;
    const [b] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('web-goto-bravo', ${USER_B}, 'owner')
    `;
    orgA = a?.seed_tenant_fixture ?? '';
    orgB = b?.seed_tenant_fixture ?? '';
    process.env['DATABASE_URL'] = database.connectionString;
    process.env['GOTO_LINK_SIGNING_SECRET'] = SIGNING_SECRET;
    // These handlers resolve their actor from the real session unless the
    // e2e header bridge is armed; this suite drives them as plain functions,
    // so it arms it.
    process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'] = BRIDGE_SECRET;
    process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'] = '1';
  }, 60_000);

  afterAll(async () => {
    if (previous.databaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = previous.databaseUrl;
    if (previous.signingSecret === undefined) delete process.env['GOTO_LINK_SIGNING_SECRET'];
    else process.env['GOTO_LINK_SIGNING_SECRET'] = previous.signingSecret;
    if (previous.bridgeSecret === undefined) delete process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'];
    else process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'] = previous.bridgeSecret;
    if (previous.bridgeEnabled === undefined) delete process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'];
    else process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'] = previous.bridgeEnabled;
    await database?.drop();
  });

  it('POST creates a token and GET redirects with structurally exact filter state', async () => {
    const state = { tagFilter: { tagIds: ['tag-1'], mode: 'any', includeDescendants: true } };
    const created = await POST(
      new Request('http://localhost/api/goto', {
        method: 'POST',
        headers: requestHeaders(USER_A, orgA),
        body: JSON.stringify({ route: '/tags?view=campaigns', state }),
      }),
    );
    expect(created.status).toBe(201);
    const payload = (await created.json()) as { token: string };
    const response = await GET(
      new Request(`http://localhost/go/${payload.token}`, {
        headers: requestHeaders(USER_A, orgA),
      }),
      { params: Promise.resolve({ token: payload.token }) },
    );
    expect(response.status).toBe(307);
    expect(stateFromGotoRedirect(response.headers.get('location') ?? '')).toEqual(state);
  });

  it('returns 404 for an expired token and a token owned by another org', async () => {
    const expired = await createGotoLink(database, {
      orgId: orgA,
      route: '/tags',
      state: {},
      signingSecret: SIGNING_SECRET,
      expiresAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    const foreign = await createGotoLink(database, {
      orgId: orgB,
      route: '/tags',
      state: {},
      signingSecret: SIGNING_SECRET,
    });
    for (const token of [expired.token, foreign.token]) {
      const response = await GET(
        new Request(`http://localhost/go/${token}`, {
          headers: requestHeaders(USER_A, orgA),
        }),
        { params: Promise.resolve({ token }) },
      );
      expect(response.status).toBe(404);
    }
  });
});
