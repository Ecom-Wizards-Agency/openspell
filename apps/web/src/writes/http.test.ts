import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { exportAcceptedRecommendations } from '@wizard-ads/db';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { executeSyntheticKeywordWrite } from '@wizard-ads/db/testing/sp-write';
import { SpWriteAdmission, SpWriteOperationDetail, SpWritePreview } from '@wizard-ads/shared/sp-write-application';
import { POST as preview } from '../../app/api/sp-writes/preview/route.js';
import { POST as approve } from '../../app/api/sp-writes/approve/route.js';
import { POST as inverse } from '../../app/api/sp-writes/inverse-preview/route.js';
import { GET as status } from '../../app/api/sp-writes/status/route.js';

const available = await databaseAvailable();
const OWNER = '31313131-3131-4131-8131-313131313131';
const OTHER = '42424242-4242-4242-8242-424242424242';
const ANALYST = '53535353-5353-4353-8353-535353535353';
const BRIDGE = 'synthetic-write-route-bridge';
const ORIGIN = 'http://localhost:3000';

describe.skipIf(!available)('SP write HTTP application', () => {
  let database: TestDatabase;
  let orgId: string;
  let otherOrgId: string;
  let profileId: string;
  let runId: string;

  beforeAll(async () => {
    database = await createTestDatabase('sp_write_http');
    const [tenants] = await database.sql<{ own: string; other: string }[]>`
      select app.seed_tenant_fixture('write-http-own', ${OWNER}, 'owner') as own,
             app.seed_tenant_fixture('write-http-other', ${OTHER}, 'owner') as other
    `;
    orgId = tenants!.own;
    otherOrgId = tenants!.other;
    const [profile] = await database.sql<{ id: string }[]>`select id::text from public.ad_profiles where org_id = ${orgId}`;
    profileId = profile!.id;
    const [run] = await database.sql<{ id: string }[]>`select id::text from public.recommendation_runs where org_id = ${orgId} and profile_id = ${profileId}`;
    runId = run!.id;
    await database.sql`select public.auth_user_stub(${ANALYST})`;
    await database.sql`insert into public.org_members (org_id, user_id, role) values (${orgId}, ${ANALYST}, 'analyst')`;
    const version = randomUUID();
    await database.sql`
      insert into public.sp_write_profile_grant_versions
        (grant_id, version_id, org_id, profile_id, enabled, amazon_profile_id,
         connection_id, region, marketplace_id, currency_code, api_dialect, created_by)
      select grant_id, ${version}, org_id, profile_id, true, amazon_profile_id,
             connection_id, region, marketplace_id, currency_code, api_dialect, created_by
      from public.sp_write_profile_grant_versions where org_id = ${orgId} and profile_id = ${profileId}
    `;
    await database.sql`update public.sp_write_profile_grant_heads set version_id = ${version}
      where org_id = ${orgId} and profile_id = ${profileId}`;
    vi.stubEnv('DATABASE_URL', database.connectionString);
    vi.stubEnv('WIZARD_ADS_E2E_AUTH_BRIDGE', '1');
    vi.stubEnv('WIZARD_ADS_AUTH_BRIDGE_SECRET', BRIDGE);
    vi.stubEnv('WIZARD_ADS_APP_URL', ORIGIN);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
  }, 60_000);
  afterAll(async () => { vi.unstubAllEnvs(); await database?.drop(); });

  function headers(user = OWNER, org = orgId) {
    return { origin: ORIGIN, 'content-type': 'application/json',
      'x-wizard-ads-auth-bridge': BRIDGE, 'x-wizard-ads-user-id': user, 'x-wizard-ads-org-id': org };
  }
  function post(body: unknown, user = OWNER, org = orgId) {
    return new Request(`${ORIGIN}/api/sp-writes`, { method: 'POST', headers: headers(user, org), body: JSON.stringify(body) });
  }
  async function source() {
    const id = randomUUID();
    await database.sql`
      insert into public.recommendations
        (id, run_id, org_id, profile_id, reason, entity_type, entity_id, field, current_value, proposed_value, inputs, status)
      values (${id}, ${runId}, ${orgId}, ${profileId}, 'high_acos', 'keyword', 'kw-1', 'bid',
        '0.9'::jsonb, '0.7'::jsonb, '{}'::jsonb, 'accepted')
    `;
    const batch = await exportAcceptedRecommendations(database, {
      orgId, profileId, runId, ids: [id], tag: randomUUID(), optGroup: 'synthetic', lever: 'bid-down',
      note: 'Synthetic HTTP write', actorId: OWNER,
    });
    return { requestId: randomUUID(), profileId, applyBatchId: batch.batchId };
  }
  function approval(frozen: SpWritePreview) {
    return { profileId, approval: { approvalRequestId: randomUUID(), plan: frozen.binding,
      approvalMode: 'manual', confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
      boundedAuthorization: null, preapprovedInversePlan: null } };
  }
  async function detail(operation: SpWriteAdmission['operation']) {
    const response = await status(new Request(`${ORIGIN}/api/sp-writes/status?${new URLSearchParams({ profileId, ...operation })}`, { headers: headers() }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    return SpWriteOperationDetail.parse(await response.json());
  }

  it('requires authentication, an owner/admin, the current tenant, exact JSON and the fixed origin', async () => {
    const body = await source();
    const unauthenticated = new Request(`${ORIGIN}/api/sp-writes/preview`, { method: 'POST', body: '{}' });
    expect((await preview(unauthenticated)).status).toBe(401);
    expect((await preview(post(body, ANALYST))).status).toBe(403);
    expect((await preview(post(body, OTHER, otherOrgId))).status).toBe(404);
    expect((await preview(post({ ...body, userId: OWNER }))).status).toBe(400);
    const foreign = post(body);
    foreign.headers.set('origin', 'https://unrelated.example');
    expect((await preview(foreign)).status).toBe(403);
    const text = post(body);
    text.headers.set('content-type', 'text/plain');
    expect((await preview(text)).status).toBe(415);
    const huge = post({ padding: 'x'.repeat(17_000) });
    huge.headers.set('content-length', '2');
    expect((await preview(huge)).status).toBe(413);
  });

  it('keeps preview read-only and refuses approval while the environment gate is closed', async () => {
    const body = await source();
    const response = await preview(post(body));
    expect(response.status).toBe(200);
    const frozen = SpWritePreview.parse(await response.json());
    expect((await approve(post(approval(frozen)))).status).toBe(409);
    const [counts] = await database.sql<{ receipts: number; wakes: number }[]>`
      select (select count(*)::int from public.sp_write_authorization_receipts where plan_id = ${frozen.plan.id}) as receipts,
             (select count(*)::int from public.sp_write_outbox where plan_id = ${frozen.plan.id}) as wakes
    `;
    expect(counts).toEqual({ receipts: 0, wakes: 0 });
  });

  it('uses HTTP preview, exact confirmation, replay, status and linked inverse without an MCP process', async () => {
    const environmentVersion = randomUUID();
    await database.sql`insert into public.sp_write_environment_gate_versions
      (version_id, enabled, max_unresolved_calls) values (${environmentVersion}, true, 1)`;
    await database.sql`insert into public.sp_write_environment_gate_head (singleton, version_id) values (true, ${environmentVersion})`;
    const body = await source();
    const frozen = SpWritePreview.parse(await (await preview(post(body))).json());
    const confirmation = approval(frozen);
    const wrong = structuredClone(confirmation);
    wrong.approval.plan.counts = { logicalChanges: 2, providerRows: 2, uniqueEntities: 2,
      byRoute: { ...wrong.approval.plan.counts.byRoute, 'sp.v3.keywords.update': 2 } };
    expect((await approve(post(wrong))).status).toBe(400);
    const first = await approve(post(confirmation));
    expect(first.status).toBe(200);
    const admission = SpWriteAdmission.parse(await first.json());
    expect(admission.kind).toBe('queued');
    expect(await (await approve(post(confirmation))).json()).toEqual(admission);
    const queued = await detail(admission.operation);
    expect(queued.snapshot.accounting.pendingDispatch).toBe(1);
    await executeSyntheticKeywordWrite(database, frozen.plan, queued.receipt);
    try {
      expect((await detail(admission.operation)).snapshot.accounting.observedRequested).toBe(1);
      const inverseResponse = await inverse(post({ requestId: randomUUID(), profileId, original: admission.operation }));
      expect(inverseResponse.status).toBe(200);
      const inversePreview = SpWritePreview.parse(await inverseResponse.json());
      const inverseAdmission = SpWriteAdmission.parse(await (await approve(post(approval(inversePreview)))).json());
      const inverseQueued = await detail(inverseAdmission.operation);
      expect(inverseQueued.original).toEqual(admission.operation);
      expect((await detail(admission.operation)).inverses).toEqual([inverseAdmission.operation]);
      await executeSyntheticKeywordWrite(database, inversePreview.plan, inverseQueued.receipt);
      expect((await detail(inverseAdmission.operation)).snapshot.accounting.observedRequested).toBe(1);
    } finally {
      await database.sql`update public.keywords set bid = 0.9 where org_id = ${orgId} and amazon_id = 'kw-1'`;
    }
  });

  it('refuses changed previews and returns controlled errors without exposing database diagnostics', async () => {
    const body = await source();
    const frozen = SpWritePreview.parse(await (await preview(post(body))).json());
    await database.sql`update public.keywords set bid = 1.1 where org_id = ${orgId} and amazon_id = 'kw-1'`;
    try {
      const refused = await approve(post(approval(frozen)));
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ code: 'source_changed' });
    } finally {
      await database.sql`update public.keywords set bid = 0.9 where org_id = ${orgId} and amazon_id = 'kw-1'`;
    }
    const unknown = await source();
    await database.sql.unsafe(`
      create function app.test_write_http_storage_fault() returns trigger language plpgsql as $$
      begin raise exception 'synthetic internal database diagnostic'; end $$;
      create trigger test_write_http_storage_fault before insert on public.sp_write_preview_evidence
      for each row execute function app.test_write_http_storage_fault();
    `);
    try {
      const response = await preview(post(unknown));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: 'outcome_unknown' });
    } finally {
      await database.sql.unsafe('drop trigger test_write_http_storage_fault on public.sp_write_preview_evidence; drop function app.test_write_http_storage_fault()');
    }
    const duplicate = await status(new Request(`${ORIGIN}/api/sp-writes/status?profileId=${profileId}&profileId=${profileId}`, { headers: headers() }));
    expect(duplicate.status).toBe(400);
  });
});
