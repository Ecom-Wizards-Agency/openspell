import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listContextualNegativeProposals } from '@wizard-ads/db';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import { POST as DECIDE } from '../../app/api/query-intelligence/negatives/decide/route.js';
import { POST as EXPORT } from '../../app/api/query-intelligence/negatives/export/route.js';
import { GET as DOWNLOAD } from '../../app/api/query-intelligence/negatives/export/[exportId]/route.js';

const available = await databaseAvailable();
const OWNER = '89898989-8989-4989-8989-898989898989';
const ANALYST = '90909090-9090-4090-8090-909090909090';
const OTHER_OWNER = '91919191-9191-4191-8191-919191919191';
const BRIDGE_SECRET = 'synthetic-query-review-bridge';
const MARKETPLACE = 'route-test-marketplace';

describe.skipIf(!available)('Query Intelligence review routes', () => {
  let database: TestDatabase;
  let orgId = '';
  let otherOrgId = '';
  let profileId = '';
  let proposalIds: string[] = [];
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

  const expectations = async (ids: readonly string[]) => {
    const proposals = await listContextualNegativeProposals(database, {
      orgId,
      profileId,
      marketplaceId: MARKETPLACE,
    });
    const byId = new Map(proposals.map((row) => [row.id, row.reviewFingerprint] as const));
    return ids.map((id) => ({ id, expectedFingerprint: byId.get(id) ?? '0'.repeat(64) }));
  };

  beforeAll(async () => {
    database = await createTestDatabase('wp86_web_routes');
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('query-route-a', ${OWNER}, 'owner')
    `;
    const [other] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('query-route-b', ${OTHER_OWNER}, 'owner')
    `;
    orgId = org?.seed_tenant_fixture ?? '';
    otherOrgId = other?.seed_tenant_fixture ?? '';
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId} limit 1
    `;
    profileId = profile?.id ?? '';
    await database.sql`select public.auth_user_stub(${ANALYST})`;
    await database.sql`
      insert into public.org_members (org_id, user_id, role)
      values (${orgId}, ${ANALYST}, 'analyst')
    `;
    const rows = await database.sql<{ id: string; campaign_id: string }[]>`
      insert into public.contextual_negative_proposals
        (org_id, profile_id, marketplace_id, campaign_id, ad_group_id,
         search_term, normalized_query, category, source_group_role,
         match_type, reason)
      values
        (${orgId}, ${profileId}, ${MARKETPLACE}, 'route-campaign-1', 'route-group-1',
         'Synthetic route query one', 'synthetic route query one', 'excluded',
         'profit', 'negative_exact', 'Synthetic export reason, with comma.'),
        (${orgId}, ${profileId}, ${MARKETPLACE}, 'route-campaign-2', 'route-group-2',
         'Synthetic route query two', 'synthetic route query two', 'competitor',
         'rank', 'negative_phrase', 'Synthetic routing isolation reason.'),
        (${orgId}, ${profileId}, ${MARKETPLACE}, 'route-campaign-3', 'route-group-3',
         'Synthetic route query three', 'synthetic route query three', 'excluded',
         'discovery', 'negative_exact', 'Synthetic dismissal reason.')
      returning id, campaign_id
    `;
    proposalIds = rows.sort((left, right) => left.campaign_id.localeCompare(right.campaign_id)).map((row) => row.id);

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

  it('accepts and dismisses exact selected rows and requires the dismissal note', async () => {
    const missingNote = await DECIDE(new Request('http://localhost/api/query-intelligence/negatives/decide', {
      method: 'POST',
      headers: headers(ANALYST),
      body: JSON.stringify({
        profileId,
        marketplaceId: MARKETPLACE,
        proposals: await expectations([proposalIds[2] ?? '']),
        decision: 'dismissed',
        note: '',
      }),
    }));
    expect(missingNote.status).toBe(400);

    const accepted = await DECIDE(new Request('http://localhost/api/query-intelligence/negatives/decide', {
      method: 'POST',
      headers: headers(ANALYST),
      body: JSON.stringify({
        profileId,
        marketplaceId: MARKETPLACE,
        proposals: await expectations(proposalIds.slice(0, 2)),
        decision: 'accepted',
        note: 'Analyst reviewed both routes.',
      }),
    }));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ offered: 2, matched: 2, updated: 2 });

    const dismissed = await DECIDE(new Request('http://localhost/api/query-intelligence/negatives/decide', {
      method: 'POST',
      headers: headers(ANALYST),
      body: JSON.stringify({
        profileId,
        marketplaceId: MARKETPLACE,
        proposals: await expectations([proposalIds[2] ?? '']),
        decision: 'dismissed',
        note: 'Keep this route active.',
      }),
    }));
    expect(dismissed.status).toBe(200);
    expect(await dismissed.json()).toMatchObject({ offered: 1, matched: 1, updated: 1 });
  });

  it('requires owner/admin export capability and an explicit confirmation', async () => {
    const body = {
      profileId,
      marketplaceId: MARKETPLACE,
      proposals: await expectations(proposalIds),
      note: 'Offline operator export.',
      confirmed: true,
    };
    const analyst = await EXPORT(new Request('http://localhost/api/query-intelligence/negatives/export', {
      method: 'POST',
      headers: headers(ANALYST),
      body: JSON.stringify(body),
    }));
    expect(analyst.status).toBe(403);

    const unconfirmed = await EXPORT(new Request('http://localhost/api/query-intelligence/negatives/export', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ ...body, confirmed: false }),
    }));
    expect(unconfirmed.status).toBe(400);

    const empty = await EXPORT(new Request('http://localhost/api/query-intelligence/negatives/export', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ ...body, proposals: [] }),
    }));
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({
      error: expect.stringContaining('non-empty'),
    });

    await database.sql`
      update public.contextual_negative_proposals
         set updated_at = updated_at + interval '1 second'
       where id = ${proposalIds[0] ?? ''}
    `;
    const stale = await EXPORT(new Request('http://localhost/api/query-intelligence/negatives/export', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ reloadRequired: true });

    const response = await EXPORT(new Request('http://localhost/api/query-intelligence/negatives/export', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ ...body, proposals: await expectations(proposalIds) }),
    }));
    expect(response.status).toBe(201);
    const result = await response.json() as {
      exportId: string;
      offered: number;
      matched: number;
      accepted: number;
      exported: number;
      skipped: unknown[];
      exportedIds: string[];
      downloads: { csv: string; json: string };
      amazonUpdated: boolean;
    };
    exportId = result.exportId;
    expect(result).toMatchObject({
      offered: 3,
      matched: 3,
      accepted: 2,
      exported: 2,
      amazonUpdated: false,
    });
    expect(result.skipped).toEqual([{ id: proposalIds[2], status: 'dismissed' }]);
    expect(result.exportedIds.sort()).toEqual(proposalIds.slice(0, 2).sort());
    expect(result.downloads.csv).toContain(exportId);
    expect(result.downloads.json).toContain(exportId);
  });

  it('returns a reload-required conflict for a stale browser decision', async () => {
    const id = proposalIds[2] ?? '';
    const stale = await expectations([id]);
    await database.sql`
      update public.contextual_negative_proposals
         set reason = 'Newer synthetic route evidence.'
       where id = ${id}
    `;
    const response = await DECIDE(new Request('http://localhost/api/query-intelligence/negatives/decide', {
      method: 'POST',
      headers: headers(ANALYST),
      body: JSON.stringify({
        profileId,
        marketplaceId: MARKETPLACE,
        proposals: stale,
        decision: 'accepted',
      }),
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      reloadRequired: true,
      staleProposalIds: [id],
    });
  });

  it('downloads exact immutable CSV and JSON rows without implying an Amazon write', async () => {
    const download = (format: 'csv' | 'json', userId = OWNER, actorOrgId = orgId) =>
      DOWNLOAD(
        new Request(`http://localhost/api/query-intelligence/negatives/export/${exportId}?format=${format}`, {
          headers: headers(userId, actorOrgId),
        }),
        { params: Promise.resolve({ exportId }) },
      );

    const csvResponse = await download('csv');
    expect(csvResponse.status).toBe(200);
    expect(csvResponse.headers.get('x-wizard-ads-exported-rows')).toBe('2');
    expect(csvResponse.headers.get('x-wizard-ads-amazon-updated')).toBe('false');
    const csv = await csvResponse.text();
    expect(csv.split('\n').filter(Boolean)).toHaveLength(3);
    expect(csv).toContain('"Synthetic export reason, with comma."');
    expect(csv).not.toContain('Synthetic route query three');

    const jsonResponse = await download('json');
    expect(jsonResponse.status).toBe(200);
    const artifact = JSON.parse(await jsonResponse.text()) as {
      schema: string;
      rowCount: number;
      amazonUpdated: boolean;
      rows: { proposal_id: string }[];
    };
    expect(artifact).toMatchObject({
      schema: 'wizard-ads.contextual-negative-export.v1',
      rowCount: 2,
      amazonUpdated: false,
    });
    expect(artifact.rows.map((row) => row.proposal_id)).toEqual(proposalIds.slice(0, 2));

    const hidden = await download('json', OTHER_OWNER, otherOrgId);
    expect(hidden.status).toBe(404);
  });
});
