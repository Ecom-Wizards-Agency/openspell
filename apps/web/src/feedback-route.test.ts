/**
 * The feedback API at the HTTP boundary.
 *
 * The database suite proves the policies and the guard trigger; this one proves
 * the routes never hand a caller a way around either. Two properties matter:
 * a role that may not triage is refused at the route as well as in the
 * database, and every cross-tenant attempt comes back as a 404 rather than a
 * 403 — the difference between those two answers tells a caller whether the id
 * exists.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import { createFeedbackItem } from '@wizard-ads/db';
import { GET, POST } from '../app/api/feedback/route.js';
import { GET as GET_ITEM, PATCH } from '../app/api/feedback/[itemId]/route.js';
import { POST as VOTE } from '../app/api/feedback/[itemId]/vote/route.js';
import { GET as GET_SIMILAR } from '../app/api/feedback/similar/route.js';

const available = await databaseAvailable();
const OWNER_A = '9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a';
const VIEWER_A = '9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b9b';
const OWNER_B = '9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c9c';
const BRIDGE_SECRET = 'synthetic-feedback-route-bridge-secret';

interface ItemBody {
  item: {
    id: string;
    title: string;
    status: string;
    severity: string | null;
    votes: number;
    pageContext: Record<string, unknown>;
    adminNote: string | null;
  };
}

describe.skipIf(!available)('feedback routes', () => {
  let database: TestDatabase;
  let orgA: string;
  let orgB: string;
  let foreignItemId: string;
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
  const params = (itemId: string) => ({ params: Promise.resolve({ itemId }) });

  beforeAll(async () => {
    database = await createTestDatabase('wp15_web_feedback');
    const [a] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('web-feedback-alpha', ${OWNER_A}, 'owner')
    `;
    const [b] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('web-feedback-bravo', ${OWNER_B}, 'owner')
    `;
    orgA = a?.seed_tenant_fixture ?? '';
    orgB = b?.seed_tenant_fixture ?? '';

    await database.sql`select public.auth_user_stub(${VIEWER_A})`;
    await database.sql`
      insert into public.org_members (org_id, user_id, role) values (${orgA}, ${VIEWER_A}, 'viewer')
    `;

    foreignItemId = (
      await createFeedbackItem(database, {
        orgId: orgB,
        authorId: OWNER_B,
        type: 'feature',
        title: 'Other tenant request',
      })
    ).id;

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

  const file = async (
    user: string,
    org: string,
    body: Record<string, unknown>,
  ): Promise<Response> =>
    POST(
      new Request('http://localhost/api/feedback', {
        method: 'POST',
        headers: headers(user, org),
        body: JSON.stringify(body),
      }),
    );

  it('files a bug from a profile page with the context attached', async () => {
    const response = await file(VIEWER_A, orgA, {
      type: 'bug',
      title: 'Sync status shows yesterday',
      body: 'The freshness row is a day behind.',
      severity: 'high',
      pageContext: {
        route: '/settings/profiles?region=NA',
        profileId: '8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a8a',
        appVersion: '0.1.0',
      },
    });
    expect(response.status).toBe(201);
    const { item } = (await response.json()) as ItemBody;
    expect(item.status).toBe('new');
    expect(item.severity).toBe('high');
    expect(item.pageContext).toEqual({
      route: '/settings/profiles?region=NA',
      profileId: '8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a8a',
      appVersion: '0.1.0',
      actorType: 'user',
    });

    const listed = await GET(
      new Request('http://localhost/api/feedback?type=bug', { headers: headers(VIEWER_A, orgA) }),
    );
    const payload = (await listed.json()) as {
      items: { id: string; type: string }[];
      counts: { openBugs: number; total: number };
      canTriage: boolean;
    };
    expect(payload.items.map((row) => row.id)).toContain(item.id);
    expect(payload.items.every((row) => row.type === 'bug')).toBe(true);
    // The fixture seeds one bug per org, and this is the second.
    expect(payload.counts.openBugs).toBe(2);
    expect(payload.canTriage).toBe(false);
  });

  it('rejects a severity on a feature request with a 400, not a 500', async () => {
    const response = await file(OWNER_A, orgA, {
      type: 'feature',
      title: 'Severity does not apply',
      severity: 'critical',
    });
    expect(response.status).toBe(400);
  });

  it('scopes similar open bug titles to the requesting organisation', async () => {
    const title = 'Bulk export loses the selected sort';
    const ours = await file(OWNER_A, orgA, { type: 'bug', title });
    const oursId = ((await ours.json()) as ItemBody).item.id;
    const foreign = await createFeedbackItem(database, {
      orgId: orgB,
      authorId: OWNER_B,
      type: 'bug',
      title,
    });

    const response = await GET_SIMILAR(
      new Request('http://localhost/api/feedback/similar?q=loses%20the%20selected%20sort', {
        headers: headers(VIEWER_A, orgA),
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { items: { id: string; type: string }[] };
    expect(payload.items.map((item) => item.id)).toContain(oursId);
    expect(payload.items.map((item) => item.id)).not.toContain(foreign.id);
    expect(payload.items.every((item) => item.type === 'bug')).toBe(true);
  });

  it('toggles a vote and reports the resulting count', async () => {
    const created = await file(OWNER_A, orgA, { type: 'feature', title: 'Saved views' });
    const { item } = (await created.json()) as ItemBody;

    const on = await VOTE(
      new Request(`http://localhost/api/feedback/${item.id}/vote`, {
        method: 'POST',
        headers: headers(VIEWER_A, orgA),
      }),
      params(item.id),
    );
    expect(await on.json()).toEqual({ itemId: item.id, voted: true, votes: 1 });

    const off = await VOTE(
      new Request(`http://localhost/api/feedback/${item.id}/vote`, {
        method: 'POST',
        headers: headers(VIEWER_A, orgA),
      }),
      params(item.id),
    );
    expect(await off.json()).toEqual({ itemId: item.id, voted: false, votes: 0 });
  });

  it('refuses triage to a viewer and allows it to an owner', async () => {
    const created = await file(VIEWER_A, orgA, { type: 'bug', title: 'Triage subject' });
    const { item } = (await created.json()) as ItemBody;

    const refused = await PATCH(
      new Request(`http://localhost/api/feedback/${item.id}`, {
        method: 'PATCH',
        headers: headers(VIEWER_A, orgA),
        body: JSON.stringify({ status: 'planned' }),
      }),
      params(item.id),
    );
    expect(refused.status).toBe(403);

    const allowed = await PATCH(
      new Request(`http://localhost/api/feedback/${item.id}`, {
        method: 'PATCH',
        headers: headers(OWNER_A, orgA),
        body: JSON.stringify({ status: 'planned', adminNote: 'Queued behind the grid work.' }),
      }),
      params(item.id),
    );
    expect(allowed.status).toBe(200);
    const triaged = (await allowed.json()) as ItemBody;
    expect(triaged.item.status).toBe('planned');
    expect(triaged.item.adminNote).toBe('Queued behind the grid work.');

    // And the author can no longer correct it, because it is no longer new.
    const tooLate = await PATCH(
      new Request(`http://localhost/api/feedback/${item.id}`, {
        method: 'PATCH',
        headers: headers(VIEWER_A, orgA),
        body: JSON.stringify({ title: 'Renamed after triage' }),
      }),
      params(item.id),
    );
    expect(tooLate.status).toBe(403);
  });

  it('lets an author correct their own untriaged item and nobody else’s', async () => {
    const created = await file(VIEWER_A, orgA, { type: 'bug', title: 'Draft title' });
    const { item } = (await created.json()) as ItemBody;

    const edited = await PATCH(
      new Request(`http://localhost/api/feedback/${item.id}`, {
        method: 'PATCH',
        headers: headers(VIEWER_A, orgA),
        body: JSON.stringify({ title: 'Corrected title', body: 'with steps to reproduce' }),
      }),
      params(item.id),
    );
    expect(edited.status).toBe(200);
    expect(((await edited.json()) as ItemBody).item.title).toBe('Corrected title');

    // An owner may triage it, but "edit somebody else's text" is not a thing
    // any role does.
    const notMine = await PATCH(
      new Request(`http://localhost/api/feedback/${item.id}`, {
        method: 'PATCH',
        headers: headers(OWNER_A, orgA),
        body: JSON.stringify({ title: 'Rewritten by an admin' }),
      }),
      params(item.id),
    );
    expect(notMine.status).toBe(403);
  });

  it('answers 404 for every operation on another tenant’s item', async () => {
    const attempts = [
      GET_ITEM(
        new Request(`http://localhost/api/feedback/${foreignItemId}`, {
          headers: headers(OWNER_A, orgA),
        }),
        params(foreignItemId),
      ),
      PATCH(
        new Request(`http://localhost/api/feedback/${foreignItemId}`, {
          method: 'PATCH',
          headers: headers(OWNER_A, orgA),
          body: JSON.stringify({ status: 'shipped' }),
        }),
        params(foreignItemId),
      ),
      VOTE(
        new Request(`http://localhost/api/feedback/${foreignItemId}/vote`, {
          method: 'POST',
          headers: headers(OWNER_A, orgA),
        }),
        params(foreignItemId),
      ),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(response.status).toBe(404);
    }

    // Untouched, and unvoted.
    const [row] = await database.sql<{ status: string; votes: string }[]>`
      select status::text as status,
             (select count(*) from public.feedback_votes v where v.item_id = i.id) as votes
        from public.feedback_items i where i.id = ${foreignItemId}
    `;
    expect(row?.status).toBe('new');
    expect(Number(row?.votes)).toBe(0);

    // And org A's list never mentions it.
    const listed = await GET(
      new Request('http://localhost/api/feedback', { headers: headers(OWNER_A, orgA) }),
    );
    expect(JSON.stringify(await listed.json())).not.toContain(foreignItemId);
  });

  it('refuses a request the auth bridge does not vouch for, and a non-member', async () => {
    const wrongSecret = await GET(
      new Request('http://localhost/api/feedback', {
        headers: headers(OWNER_A, orgA, 'not-the-bridge-secret'),
      }),
    );
    expect(wrongSecret.status).toBe(401);

    const noMembership = await GET(
      new Request('http://localhost/api/feedback', { headers: headers(OWNER_A, orgB) }),
    );
    expect(noMembership.status).toBe(403);
  });
});
