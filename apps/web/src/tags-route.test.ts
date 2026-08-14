/**
 * The tag API at the HTTP boundary.
 *
 * The database suites prove RLS; these prove the routes never hand a caller a
 * way around it. Every cross-tenant attempt has to come back as a 404, not as
 * a 403 with a different message, because the difference between the two tells
 * an attacker whether the id exists.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import { createTag } from '@wizard-ads/db';
import { GET, POST } from '../app/api/tags/route.js';
import { DELETE, PATCH } from '../app/api/tags/[tagId]/route.js';
import { POST as ASSIGN, DELETE as UNASSIGN } from '../app/api/tags/[tagId]/assign/route.js';

const available = await databaseAvailable();
const USER_A = '8c8c8c8c-8c8c-4c8c-8c8c-8c8c8c8c8c8c';
const USER_B = '8d8d8d8d-8d8d-4d8d-8d8d-8d8d8d8d8d8d';
const BRIDGE_SECRET = 'synthetic-tags-route-bridge-secret';

describe.skipIf(!available)('tag routes', () => {
  let database: TestDatabase;
  let orgA: string;
  let orgB: string;
  let foreignTagId: string;
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
  const params = (tagId: string) => ({ params: Promise.resolve({ tagId }) });

  beforeAll(async () => {
    database = await createTestDatabase('wp08_web_tags');
    const [a] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('web-tag-alpha', ${USER_A}, 'owner')
    `;
    const [b] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('web-tag-bravo', ${USER_B}, 'owner')
    `;
    orgA = a?.seed_tenant_fixture ?? '';
    orgB = b?.seed_tenant_fixture ?? '';
    foreignTagId = (await createTag(database, { orgId: orgB, name: 'Other tenant taxonomy' })).id;
    process.env['DATABASE_URL'] = database.connectionString;
    // These handlers resolve their actor from the real session unless the
    // e2e header bridge is armed; this suite drives them as plain functions,
    // so it arms it.
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

  it('creates a nested tag and returns it in the tree, scoped to the caller org', async () => {
    const created = await POST(
      new Request('http://localhost/api/tags', {
        method: 'POST',
        headers: headers(USER_A, orgA),
        body: JSON.stringify({ name: 'Markets', color: '#2563eb' }),
      }),
    );
    expect(created.status).toBe(201);
    const { tag } = (await created.json()) as { tag: { id: string; slug: string } };
    expect(tag.slug).toBe('markets');

    const child = await POST(
      new Request('http://localhost/api/tags', {
        method: 'POST',
        headers: headers(USER_A, orgA),
        body: JSON.stringify({ name: 'Northern region', parentId: tag.id }),
      }),
    );
    expect(child.status).toBe(201);

    const listed = await GET(
      new Request('http://localhost/api/tags', { headers: headers(USER_A, orgA) }),
    );
    const { tags } = (await listed.json()) as {
      tags: { id: string; name: string; children: { name: string }[] }[];
    };
    const markets = tags.find((node) => node.id === tag.id);
    expect(markets?.children.map((node) => node.name)).toEqual(['Northern region']);
    // Nothing belonging to the other tenant leaks into the tree.
    expect(JSON.stringify(tags)).not.toContain(foreignTagId);
  });

  it('rejects a duplicate sibling name with a 409 rather than a 500', async () => {
    const body = JSON.stringify({ name: 'Duplicate sibling' });
    const first = await POST(
      new Request('http://localhost/api/tags', {
        method: 'POST',
        headers: headers(USER_A, orgA),
        body,
      }),
    );
    expect(first.status).toBe(201);
    const second = await POST(
      new Request('http://localhost/api/tags', {
        method: 'POST',
        headers: headers(USER_A, orgA),
        body,
      }),
    );
    expect(second.status).toBe(409);
  });

  it('answers 404 for every operation on another tenant tag', async () => {
    const attempts = [
      PATCH(
        new Request(`http://localhost/api/tags/${foreignTagId}`, {
          method: 'PATCH',
          headers: headers(USER_A, orgA),
          body: JSON.stringify({ name: 'Renamed by a stranger' }),
        }),
        params(foreignTagId),
      ),
      DELETE(
        new Request(`http://localhost/api/tags/${foreignTagId}`, {
          method: 'DELETE',
          headers: headers(USER_A, orgA),
          body: JSON.stringify({ mode: 'detach' }),
        }),
        params(foreignTagId),
      ),
      ASSIGN(
        new Request(`http://localhost/api/tags/${foreignTagId}/assign`, {
          method: 'POST',
          headers: headers(USER_A, orgA),
          body: JSON.stringify({ filter: { entityType: 'campaign', entityIds: ['c-1'] } }),
        }),
        params(foreignTagId),
      ),
      UNASSIGN(
        new Request(`http://localhost/api/tags/${foreignTagId}/assign`, {
          method: 'DELETE',
          headers: headers(USER_A, orgA),
          body: JSON.stringify({ filter: { entityType: 'campaign', entityIds: ['c-1'] } }),
        }),
        params(foreignTagId),
      ),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(response.status).toBe(404);
    }
    // And the tag is untouched.
    const [row] = await database.sql<{ name: string }[]>`
      select name from public.tags where id = ${foreignTagId}
    `;
    expect(row?.name).toBe('Other tenant taxonomy');
  });

  it('refuses a request whose actor is not vouched for by the auth bridge', async () => {
    const wrongSecret = await GET(
      new Request('http://localhost/api/tags', {
        headers: headers(USER_A, orgA, 'not-the-bridge-secret'),
      }),
    );
    expect(wrongSecret.status).toBe(401);

    const noMembership = await GET(
      new Request('http://localhost/api/tags', { headers: headers(USER_A, orgB) }),
    );
    expect(noMembership.status).toBe(403);
  });
});
