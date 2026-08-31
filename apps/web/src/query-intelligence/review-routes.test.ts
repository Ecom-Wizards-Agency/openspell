import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getContextualNegativeExport,
  loadContextualNegativeReview,
} from '@wizard-ads/db';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import { POST as DECIDE } from '../../app/api/query-intelligence/negatives/decide/route';
import { POST as EXPORT } from '../../app/api/query-intelligence/negatives/export/route';
import { GET as DOWNLOAD } from '../../app/api/query-intelligence/negatives/export/[exportId]/route';
import { CONTEXTUAL_NEGATIVE_REQUEST_BYTE_LIMIT } from './review-http';

const available = await databaseAvailable();
const OWNER = '81818181-8181-4181-8181-818181818181';
const ANALYST = '82828282-8282-4282-8282-828282828282';
const VIEWER = '83838383-8383-4383-8383-838383838383';
const OTHER_OWNER = '84848484-8484-4484-8484-848484848484';
const BRIDGE_SECRET = 'synthetic-contextual-review-bridge';
const MARKETPLACE = 'SYNTHETIC_REVIEW_MARKET';

describe.skipIf(!available)('contextual-negative web routes', () => {
  let database: TestDatabase;
  let orgId = '';
  let otherOrgId = '';
  let profileId = '';
  let proposalId = '';
  let exportId = '';
  const previous = {
    databaseUrl: process.env['DATABASE_URL'],
    bridgeSecret: process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'],
    bridgeEnabled: process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'],
  };

  const headers = (userId = OWNER, actorOrgId = orgId) => ({
    'content-type': 'application/json',
    'x-wizard-ads-auth-bridge': BRIDGE_SECRET,
    'x-wizard-ads-user-id': userId,
    'x-wizard-ads-org-id': actorOrgId,
  });

  async function expectation() {
    const review = await loadContextualNegativeReview(database, {
      orgId,
      profileId,
      marketplaceId: MARKETPLACE,
    });
    if (review.status !== 'ready') throw new Error('synthetic review scope exceeded capacity');
    const proposal = review.proposals.find((row) => row.id === proposalId);
    if (!proposal) throw new Error('synthetic proposal not found');
    return { id: proposal.id, expectedFingerprint: proposal.reviewFingerprint };
  }

  beforeAll(async () => {
    database = await createTestDatabase('wp182_web_routes');
    const [tenant] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('query-review-route-a', ${OWNER}, 'owner')
    `;
    const [other] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('query-review-route-b', ${OTHER_OWNER}, 'owner')
    `;
    orgId = tenant?.seed_tenant_fixture ?? '';
    otherOrgId = other?.seed_tenant_fixture ?? '';
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId} limit 1
    `;
    profileId = profile?.id ?? '';
    await database.sql`select public.auth_user_stub(${ANALYST}), public.auth_user_stub(${VIEWER})`;
    await database.sql`
      insert into public.org_members (org_id, user_id, role)
      values (${orgId}, ${ANALYST}, 'analyst'), (${orgId}, ${VIEWER}, 'viewer')
    `;
    const [proposal] = await database.sql<{ id: string }[]>`
      insert into public.contextual_negative_proposals
        (org_id, profile_id, marketplace_id, campaign_id, ad_group_id,
         search_term, normalized_query, category, source_group_role,
         match_type, reason)
      values (
        ${orgId}, ${profileId}, ${MARKETPLACE}, 'campaign-route', 'ad-group-route',
        'Synthetic excluded query', 'synthetic excluded query', 'excluded', 'profit',
        'negative_exact', 'Synthetic route evidence, with comma.'
      )
      returning id
    `;
    proposalId = proposal?.id ?? '';

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

  it('returns a structured 503 when the request database is not configured', async () => {
    const configured = process.env['DATABASE_URL'];
    delete process.env['DATABASE_URL'];
    try {
      const response = await DECIDE(new Request(
        'http://localhost/api/query-intelligence/negatives/decide',
        { method: 'POST', headers: headers(), body: '{}' },
      ));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Database is not configured' });
    } finally {
      if (configured === undefined) delete process.env['DATABASE_URL'];
      else process.env['DATABASE_URL'] = configured;
    }
  });

  it('enforces the review role and rejects body-supplied actor scope', async () => {
    const selection = [await expectation()];
    const viewer = await DECIDE(new Request('http://localhost/api/query-intelligence/negatives/decide', {
      method: 'POST',
      headers: headers(VIEWER),
      body: JSON.stringify({ profileId, marketplaceId: MARKETPLACE, proposals: selection, decision: 'accepted' }),
    }));
    expect(viewer.status).toBe(403);

    const oversized = await DECIDE(new Request('http://localhost/api/query-intelligence/negatives/decide', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        profileId,
        marketplaceId: MARKETPLACE,
        proposals: selection,
        decision: 'accepted',
        ignored: 'x'.repeat(CONTEXTUAL_NEGATIVE_REQUEST_BYTE_LIMIT),
      }),
    }));
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({ error: expect.stringContaining('exceeds') });

    const spoof = await DECIDE(new Request('http://localhost/api/query-intelligence/negatives/decide', {
      method: 'POST',
      headers: headers(ANALYST),
      body: JSON.stringify({
        profileId,
        marketplaceId: MARKETPLACE,
        proposals: selection,
        decision: 'accepted',
        orgId: otherOrgId,
        actorId: OWNER,
      }),
    }));
    expect(spoof.status).toBe(400);
    expect(await spoof.json()).toMatchObject({ error: expect.stringContaining('derived from the authenticated request') });

    const accepted = await DECIDE(new Request('http://localhost/api/query-intelligence/negatives/decide', {
      method: 'POST',
      headers: headers(ANALYST),
      body: JSON.stringify({ profileId, marketplaceId: MARKETPLACE, proposals: selection, decision: 'accepted' }),
    }));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      offered: 1,
      matched: 1,
      updated: 1,
      unchanged: 0,
      amazonUpdated: false,
    });

    const stale = await DECIDE(new Request('http://localhost/api/query-intelligence/negatives/decide', {
      method: 'POST',
      headers: headers(ANALYST),
      body: JSON.stringify({
        profileId,
        marketplaceId: MARKETPLACE,
        proposals: selection,
        decision: 'dismissed',
        note: 'Synthetic stale decision.',
      }),
    }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ reloadRequired: true, amazonUpdated: false });
  });

  it('requires owner/admin export capability and explicit confirmation', async () => {
    const selection = [await expectation()];
    const body = { profileId, marketplaceId: MARKETPLACE, proposals: selection, note: 'Offline evidence.', confirmed: true };
    const analyst = await EXPORT(new Request('http://localhost/api/query-intelligence/negatives/export', {
      method: 'POST', headers: headers(ANALYST), body: JSON.stringify(body),
    }));
    expect(analyst.status).toBe(403);

    const unconfirmed = await EXPORT(new Request('http://localhost/api/query-intelligence/negatives/export', {
      method: 'POST', headers: headers(), body: JSON.stringify({ ...body, confirmed: false }),
    }));
    expect(unconfirmed.status).toBe(400);

    const exported = await EXPORT(new Request('http://localhost/api/query-intelligence/negatives/export', {
      method: 'POST', headers: headers(), body: JSON.stringify(body),
    }));
    expect(exported.status).toBe(201);
    const result = await exported.json() as {
      exportId: string;
      exported: number;
      downloads: { csv: string; json: string };
      amazonUpdated: boolean;
    };
    exportId = result.exportId;
    expect(result).toMatchObject({ exported: 1, amazonUpdated: false });
    expect(result.downloads.csv).toContain(exportId);
    expect(result.downloads.json).toContain(exportId);
  });

  it('returns exact stored bytes with tenant hiding and no-Amazon headers', async () => {
    const stored = await getContextualNegativeExport(database, { orgId, exportId, format: 'csv' });
    if (stored === null) throw new Error('stored synthetic artifact not found');
    const download = (actorOrgId = orgId, userId = OWNER) => DOWNLOAD(
      new Request(`http://localhost/api/query-intelligence/negatives/export/${exportId}?format=csv`, {
        headers: headers(userId, actorOrgId),
      }),
      { params: Promise.resolve({ exportId }) },
    );

    const response = await download();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(stored.bytes.byteLength));
    expect(response.headers.get('x-openspell-exported-rows')).toBe('1');
    expect(response.headers.get('x-openspell-amazon-updated')).toBe('false');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(stored.bytes);

    const hidden = await download(otherOrgId, OTHER_OWNER);
    expect(hidden.status).toBe(404);
  });

  it('returns a generic server error when stored evidence fails integrity verification', async () => {
    const [corrupt] = await database.sql<{ id: string }[]>`
      insert into public.contextual_negative_exports
        (org_id, profile_id, marketplace_id, note, row_count,
         json_artifact, json_sha256, csv_artifact, csv_sha256, created_by)
      values (
        ${orgId}, ${profileId}, ${MARKETPLACE}, 'Synthetic corrupt evidence.', 1,
        convert_to('{"fixture":true}' || chr(10), 'UTF8'), ${'a'.repeat(64)},
        convert_to('fixture' || chr(10), 'UTF8'), ${'b'.repeat(64)}, ${OWNER}
      )
      returning id
    `;
    if (corrupt === undefined) throw new Error('corrupt route fixture was not inserted');
    const response = await DOWNLOAD(
      new Request(
        `http://localhost/api/query-intelligence/negatives/export/${corrupt.id}?format=json`,
        { headers: headers() },
      ),
      { params: Promise.resolve({ exportId: corrupt.id }) },
    );
    expect(response.status).toBe(500);
    const payload = await response.json() as { error: string; amazonUpdated: boolean };
    expect(payload).toEqual({
      error: 'Stored contextual-negative evidence failed integrity verification',
      amazonUpdated: false,
    });
    expect(payload.error).not.toMatch(/hash|row count|csv|json/i);
  });
});
