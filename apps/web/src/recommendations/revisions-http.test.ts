import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readWorkbook } from '@wizard-ads/campaigns';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { RecommendationRevisionReceipt } from '@wizard-ads/shared/recommendation-revisions';
import { POST as REVISE } from '../../app/api/recommendations/revise/route';
import { POST as DECIDE } from '../../app/api/recommendations/decide/route';
import { POST as EXPORT } from '../../app/api/recommendations/export/route';
import { GET as DOWNLOAD } from '../../app/api/recommendations/export/[batchId]/route';

const available = await databaseAvailable();
const OWNER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01';
const ANALYST = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02';
const VIEWER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee03';
const ORIGIN = 'http://localhost:3000';
const BRIDGE = 'synthetic-revision-http-bridge';

describe.skipIf(!available)('proposal revision HTTP lifecycle', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  let runId: string;
  beforeAll(async () => {
    database = await createTestDatabase('revision_http');
    const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture('revision-http', ${OWNER}, 'owner') as id`;
    orgId = org!.id;
    const [run] = await database.sql<{ id: string; profile_id: string }[]>`
      select id, profile_id from public.recommendation_runs where org_id = ${orgId} limit 1`;
    runId = run!.id; profileId = run!.profile_id;
    for (const [user, role] of [[ANALYST, 'analyst'], [VIEWER, 'viewer']] as const) {
      await database.sql`select public.auth_user_stub(${user})`;
      await database.sql`insert into public.org_members (org_id,user_id,role) values (${orgId},${user},${role}::public.org_role)`;
    }
    vi.stubEnv('DATABASE_URL', database.connectionString);
    vi.stubEnv('WIZARD_ADS_E2E_AUTH_BRIDGE', '1');
    vi.stubEnv('WIZARD_ADS_AUTH_BRIDGE_SECRET', BRIDGE);
    vi.stubEnv('WIZARD_ADS_APP_URL', ORIGIN);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
  }, 60_000);
  afterAll(async () => { vi.unstubAllEnvs(); await database?.drop(); });

  function headers(user = OWNER) {
    return { origin: ORIGIN, 'content-type': 'application/json',
      'x-wizard-ads-auth-bridge': BRIDGE, 'x-wizard-ads-user-id': user, 'x-wizard-ads-org-id': orgId };
  }
  function post(path: string, body: unknown, user = OWNER) {
    return new Request(`${ORIGIN}/api/recommendations/${path}`, { method: 'POST', headers: headers(user), body: JSON.stringify(body) });
  }
  async function proposal() {
    const [rec] = await database.sql<{ id: string }[]>`insert into public.recommendations
      (org_id,profile_id,run_id,reason,entity_type,entity_id,ad_product,campaign_id,ad_group_id,entity_name,field,current_value,proposed_value,inputs)
      values (${orgId},${profileId},${runId},'high_acos','keyword','kw-1','SP','c-1','ag-1','Synthetic keyword','bid','0.9'::jsonb,'0.7'::jsonb,'{}'::jsonb)
      returning id`;
    return { requestId: randomUUID(), profileId, recommendationId: rec!.id,
      expectedRevisionId: null, proposedValue: ' 00.812300 ', note: 'Reviewed synthetic proposal' };
  }

  it('keeps exact edited money and revision identity through review and both real download formats', async () => {
    const [before] = await database.sql`select count(*)::integer as approvals from public.sp_write_approval_requests where org_id = ${orgId}`;
    const request = await proposal();
    const response = await REVISE(post('revise', request, ANALYST));
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const receipt = RecommendationRevisionReceipt.parse(await response.json());
    expect(receipt.actor).toEqual({ orgId, userId: ANALYST });
    expect(receipt.proposedValue).toBe('0.8123');
    const retry = await REVISE(post('revise', request, ANALYST));
    expect(await retry.json()).toEqual(receipt);
    const staleDecision = await DECIDE(post('decide', { ids: [request.recommendationId], decision: 'accepted' }, ANALYST));
    expect(await staleDecision.json()).toMatchObject({ offered: 1, updated: 0,
      refused: [{ id: request.recommendationId, status: 'revision_changed' }] });
    const refs = [{ recommendationId: request.recommendationId, revisionId: receipt.revisionId }];
    const decision = await DECIDE(post('decide', { ids: [request.recommendationId], expectedRevisions: refs, decision: 'accepted' }, ANALYST));
    expect(await decision.json()).toMatchObject({ offered: 1, updated: 1, refused: [] });
    const exported = await EXPORT(post('export', { runId, profileId, ids: [request.recommendationId], expectedRevisions: refs,
      client: 'synthetic', optGroup: 'synthetic', lever: 'bid', note: 'Reviewed synthetic export' }));
    expect(exported.status).toBe(201);
    const batch = await exported.json() as { batchId: string; exported: number; rows: Array<{ old: number; new: number }> };
    expect(batch.exported).toBe(1); expect(batch.rows).toHaveLength(1);
    expect(batch.rows[0]).toMatchObject({ old: 0.9, new: 0.8123 });
    const download = (format: string) => DOWNLOAD(new Request(`${ORIGIN}/api/recommendations/export/${batch.batchId}?format=${format}`, {
      headers: headers(),
    }), { params: Promise.resolve({ batchId: batch.batchId }) });
    const json = await download('rows'); expect(json.status).toBe(200);
    const rows = await json.json() as Array<{ new: unknown }>;
    expect(rows).toHaveLength(1); expect(typeof rows[0]!.new).toBe('number');
    expect(JSON.stringify(rows[0]!.new)).toBe('0.8123');
    const workbook = await download('xlsx'); expect(workbook.status).toBe(200);
    const sheet = readWorkbook(new Uint8Array(await workbook.arrayBuffer()));
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0]![sheet.header.indexOf('Bid')]).toBe(0.8123);
    const frozen = await REVISE(post('revise', { ...request, requestId: randomUUID(), expectedRevisionId: receipt.revisionId, proposedValue: '0.6' }));
    expect(frozen.status).toBe(409);
    const [counts] = await database.sql`select
      (select count(*)::integer from public.recommendation_proposal_revisions where recommendation_id = ${request.recommendationId}) as revisions,
      (select count(*)::integer from public.sp_write_approval_requests where org_id = ${orgId}) as approvals`;
    expect(counts!.revisions).toBe(1);
    expect(counts!.approvals).toBe(before!.approvals);
  });

  it('rejects caller actors, cross-origin bodies and viewers before any edit', async () => {
    const request = await proposal();
    expect((await REVISE(post('revise', { ...request, actor: { orgId, userId: OWNER } }))).status).toBe(400);
    expect((await REVISE(post('revise', request, VIEWER))).status).toBe(403);
    const foreign = post('revise', request); foreign.headers.set('origin', 'https://foreign.example');
    expect((await REVISE(foreign)).status).toBe(403);
    const oversized = post('revise', { ...request, note: 'x'.repeat(17_000) });
    expect((await REVISE(oversized)).status).toBe(413);
    const [row] = await database.sql`select count(*)::integer as count from public.recommendation_proposal_revisions where recommendation_id = ${request.recommendationId}`;
    expect(row!.count).toBe(0);
  });
});
