/** HTTP-boundary proof for tenant-scoped, role-gated optimizer previews. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import { POST } from '../app/api/optimizer/runs/route.js';
import { GET } from '../app/api/optimizer/runs/[batchId]/route.js';

const available = await databaseAvailable();
const OWNER_A = '71717171-7171-4717-8171-717171717171';
const VIEWER_A = '72727272-7272-4727-8272-727272727272';
const OWNER_B = '73737373-7373-4737-8373-737373737373';
const BRIDGE_SECRET = 'synthetic-optimizer-route-bridge-secret';

describe.skipIf(!available)('optimizer preview routes', () => {
  let database: TestDatabase;
  let orgA: string;
  let orgB: string;
  let profileA: string;
  let profileB: string;
  let foreignBatchId: string;
  let acceptedBatchId: string;
  const previous = {
    databaseUrl: process.env['DATABASE_URL'],
    bridgeSecret: process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'],
    bridgeEnabled: process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'],
  };

  const headers = (userId: string, orgId: string, bridge = BRIDGE_SECRET) => ({
    'content-type': 'application/json',
    'x-wizard-ads-auth-bridge': bridge,
    'x-wizard-ads-user-id': userId,
    'x-wizard-ads-org-id': orgId,
  });
  const params = (batchId: string) => ({ params: Promise.resolve({ batchId }) });
  const previewRequest = (userId: string, orgId: string, profileId: string): Request =>
    new Request('http://localhost/api/optimizer/runs', {
      method: 'POST',
      headers: headers(userId, orgId),
      body: JSON.stringify({
        profileId,
        clientRequestId: crypto.randomUUID(),
        scope: { mode: 'selected', campaignIds: ['c-1'] },
      }),
    });

  beforeAll(async () => {
    database = await createTestDatabase('wp195_web_routes');
    const [tenantA] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('optimizer-route-alpha', ${OWNER_A}, 'owner')
    `;
    const [tenantB] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('optimizer-route-bravo', ${OWNER_B}, 'owner')
    `;
    orgA = tenantA?.seed_tenant_fixture ?? '';
    orgB = tenantB?.seed_tenant_fixture ?? '';
    await database.sql`select public.auth_user_stub(${VIEWER_A})`;
    await database.sql`
      insert into public.org_members (org_id, user_id, role)
      values (${orgA}, ${VIEWER_A}, 'viewer')
    `;
    const [a] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgA}
    `;
    const [b] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgB}
    `;
    const [foreignBatch] = await database.sql<{ id: string }[]>`
      select id from public.recommendation_preview_batches where org_id = ${orgB}
    `;
    if (!a || !b || !foreignBatch) throw new Error('optimizer route fixture is incomplete');
    profileA = a.id;
    profileB = b.id;
    foreignBatchId = foreignBatch.id;

    // Keep c-1 eligible and unassigned, so group-specific safety state is irrelevant.
    await database.sql`delete from public.campaign_optimization_assignments where org_id = ${orgA}`;

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

  it('refuses viewers and untrusted actors before writing preview artifacts', async () => {
    const [before] = await database.sql<{ count: number }[]>`
      select count(*)::integer as count
        from public.recommendation_preview_batches where org_id = ${orgA}
    `;
    const viewer = await POST(previewRequest(VIEWER_A, orgA, profileA));
    expect(viewer.status).toBe(403);
    const untrusted = await POST(new Request('http://localhost/api/optimizer/runs', {
      method: 'POST',
      headers: headers(OWNER_A, orgA, 'wrong-bridge-secret'),
      body: JSON.stringify({
        profileId: profileA,
        clientRequestId: crypto.randomUUID(),
        scope: { mode: 'selected', campaignIds: ['c-1'] },
      }),
    }));
    expect(untrusted.status).toBe(401);
    const [after] = await database.sql<{ count: number }[]>`
      select count(*)::integer as count
        from public.recommendation_preview_batches where org_id = ${orgA}
    `;
    expect(after?.count).toBe(before?.count);
  });

  it('queues for an authorized owner and returns its truthful scoped status', async () => {
    const response = await POST(previewRequest(OWNER_A, orgA, profileA));
    expect(response.status).toBe(202);
    const accepted = await response.json() as {
      batchId: string;
      scope: { mode: string; campaignCount: number };
      childCount: number;
    };
    acceptedBatchId = accepted.batchId;
    expect(accepted).toMatchObject({
      scope: { mode: 'selected', campaignCount: 1 },
      childCount: 1,
    });

    const status = await GET(
      new Request(
        `http://localhost/api/optimizer/runs/${acceptedBatchId}?profileId=${profileA}`,
        { headers: headers(VIEWER_A, orgA) },
      ),
      params(acceptedBatchId),
    );
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      batchId: acceptedBatchId,
      status: 'queued',
      campaignCount: 1,
      children: [{ campaignCount: 1, status: 'queued' }],
    });
  });

  it('returns the same 404 for foreign batch and profile combinations', async () => {
    const attempts = [
      GET(
        new Request(
          `http://localhost/api/optimizer/runs/${foreignBatchId}?profileId=${profileA}`,
          { headers: headers(OWNER_A, orgA) },
        ),
        params(foreignBatchId),
      ),
      GET(
        new Request(
          `http://localhost/api/optimizer/runs/${acceptedBatchId}?profileId=${profileB}`,
          { headers: headers(OWNER_B, orgB) },
        ),
        params(acceptedBatchId),
      ),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'Not found' });
    }
  });

  it('maps malformed status identity to a bounded safe error', async () => {
    const response = await GET(
      new Request(
        `http://localhost/api/optimizer/runs/not-a-uuid?profileId=${profileA}`,
        { headers: headers(OWNER_A, orgA) },
      ),
      params('not-a-uuid'),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'batchId must be a UUID' });
  });
});
