/** HTTP boundary for conflict-safe Time Machine exports. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordEntityChanges } from '@wizard-ads/db';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import { POST } from '../app/api/time-machine/reversion/route.js';

const available = await databaseAvailable();
const OWNER = '74747474-7474-4474-8474-747474747474';
const OTHER = '75757575-7575-4575-8575-757575757575';
const ANALYST = '76767676-7676-4676-8676-767676767676';
const BRIDGE = 'synthetic-time-machine-route-bridge';

describe.skipIf(!available)('Time Machine reversion route', () => {
  let database: TestDatabase;
  let orgId = '';
  let otherOrgId = '';
  let profileId = '';
  let batchId = '';
  const previous = {
    databaseUrl: process.env['DATABASE_URL'],
    bridgeSecret: process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'],
    bridgeEnabled: process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'],
  };

  const request = (body: Record<string, unknown>, userId = OWNER, actorOrgId = orgId) =>
    POST(
      new Request('http://localhost/api/time-machine/reversion', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-wizard-ads-auth-bridge': BRIDGE,
          'x-wizard-ads-user-id': userId,
          'x-wizard-ads-org-id': actorOrgId,
        },
        body: JSON.stringify(body),
      }),
    );

  beforeAll(async () => {
    database = await createTestDatabase('wp61_web_route');
    const [ownerTenant] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('tm-route-owner', ${OWNER}, 'owner')
    `;
    const [otherTenant] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('tm-route-other', ${OTHER}, 'owner')
    `;
    orgId = ownerTenant?.seed_tenant_fixture ?? '';
    otherOrgId = otherTenant?.seed_tenant_fixture ?? '';
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId} limit 1
    `;
    profileId = profile?.id ?? '';
    await database.sql`select public.auth_user_stub(${ANALYST})`;
    await database.sql`
      insert into public.org_members (org_id, user_id, role) values (${orgId}, ${ANALYST}, 'analyst')
    `;
    await database.sql`
      insert into public.keywords
        (org_id, profile_id, amazon_id, ad_product, name, state, campaign_id,
         ad_group_id, keyword_text, match_type, bid, synced_at)
      values (${orgId}, ${profileId}, 'kw-route', 'SP', 'Route keyword', 'enabled',
              'c-1', 'ag-1', 'route keyword', 'exact', 0.71, now())
    `;
    const [batch] = await database.sql<{ id: string }[]>`
      insert into public.apply_batches
        (org_id, profile_id, tag, opt_group, lever, note, exported_at,
         artifact_sha256, exported_proposals, reversible_rows, unsupported_rows)
      values (${orgId}, ${profileId}, 'tm-route-source', 'rank', 'push', 'synthetic',
              now() - interval '1 hour', ${'d'.repeat(64)}, 1, 1, 0)
      returning id
    `;
    batchId = batch?.id ?? '';
    await database.sql`
      insert into public.apply_rows
        (batch_id, org_id, profile_id, entity_type, entity_id, entity_name,
         field, old_value, new_value)
      values (${batchId}, ${orgId}, ${profileId}, 'keyword', 'kw-route', 'Route keyword',
              'bid', '0.9'::jsonb, '0.71'::jsonb)
    `;
    await recordEntityChanges(database, [{
      orgId,
      profileId,
      entityType: 'keyword',
      amazonId: 'kw-route',
      entityName: 'Route keyword',
      field: 'bid',
      oldValue: 0.9,
      newValue: 0.71,
      source: 'sync',
    }]);

    process.env['DATABASE_URL'] = database.connectionString;
    process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'] = BRIDGE;
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

  const validBody = () => ({
    batchId,
    profileId,
    expectedRows: 1,
    note: 'Synthetic operator reversion',
    confirmation: 'Yes, export reversion',
  });

  it('requires the exact confirmation and current row count', async () => {
    const missing = await request({ ...validBody(), confirmation: 'yes' });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: expect.stringContaining('Confirmation') });

    const stale = await request({ ...validBody(), expectedRows: 2 });
    expect(stale.status).toBe(400);
    expect(await stale.json()).toMatchObject({ error: expect.stringContaining('changed since preview') });
  });

  it('allows only owner and admin exports and hides foreign batches', async () => {
    expect((await request(validBody(), ANALYST, orgId)).status).toBe(403);
    expect((await request(validBody(), OTHER, otherOrgId)).status).toBe(404);
  });

  it('creates a counted inverse file without claiming an Amazon update', async () => {
    const response = await request(validBody());
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      batchId: string;
      sourceBatchId: string;
      rows: number;
      amazonUpdated: boolean;
      downloads: { rows: string };
    };
    expect(body).toMatchObject({ sourceBatchId: batchId, rows: 1, amazonUpdated: false });
    expect(body.downloads.rows).toContain(body.batchId);

    const [counts] = await database.sql<{ batches: number; rows: number; audits: number }[]>`
      select
        (select count(*)::int from public.apply_batches
          where org_id = ${orgId} and source_batch_id = ${batchId}) as batches,
        (select count(*)::int from public.apply_rows ar
          join public.apply_batches ab on ab.id = ar.batch_id
          where ab.org_id = ${orgId} and ab.source_batch_id = ${batchId}) as rows,
        (select count(*)::int from public.audit_log
          where org_id = ${orgId} and action = 'reversion.exported') as audits
    `;
    expect(counts).toEqual({ batches: 1, rows: 1, audits: 1 });
  });
});
