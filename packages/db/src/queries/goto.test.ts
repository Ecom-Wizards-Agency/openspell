import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser } from '../testing/rls.js';
import { createTestDatabase, databaseAvailable } from '../testing/harness.js';
import type { TestDatabase } from '../testing/harness.js';
import { createRequestDatabase } from './request-client.js';
import {
  createGotoLink,
  createSignedGotoToken,
  gotoRedirectLocation,
  isValidGotoToken,
  resolveGotoLink,
  stateFromGotoRedirect,
  validateGotoRoute,
} from './goto.js';

const available = await databaseAvailable();
const USER_A = '83838383-8383-4383-8383-838383838383';
const USER_B = '84848484-8484-4484-8484-848484848484';
const SECRET = ['synthetic', 'goto', 'signing', 'material', 'for', 'tests'].join('-');

describe('WP-08 signed token primitives', () => {
  it('signs opaque short tokens, rejects tampering, and prevents external redirects', () => {
    const token = createSignedGotoToken(SECRET);
    expect(token.length).toBeLessThan(64);
    expect(isValidGotoToken(token, SECRET)).toBe(true);
    expect(isValidGotoToken(`${token}x`, SECRET)).toBe(false);
    expect(() => validateGotoRoute('//outside.example/path')).toThrow(/internal/i);
  });
});

describe.skipIf(!available)('WP-08 goto links', () => {
  let database: TestDatabase;
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    database = await createTestDatabase('wp08_goto');
    const [a] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('goto-alpha', ${USER_A}, 'owner')
    `;
    const [b] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('goto-bravo', ${USER_B}, 'owner')
    `;
    orgA = a?.seed_tenant_fixture ?? '';
    orgB = b?.seed_tenant_fixture ?? '';
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('round-trips nested filter state exactly and records use', async () => {
    const state = {
      tagFilter: {
        tagIds: ['one', 'two'],
        mode: 'all',
        includeDescendants: true,
      },
      grid: { columns: ['name', 'cost'], page: 3 },
    };
    const link = await createGotoLink(database, {
      orgId: orgA,
      route: '/tags?view=campaigns',
      state,
      signingSecret: SECRET,
      createdBy: USER_A,
    });
    const resolved = await resolveGotoLink(database, {
      orgId: orgA,
      token: link.token,
      signingSecret: SECRET,
    });
    expect(resolved?.state).toEqual(state);
    expect(resolved?.uses).toBe(1);
    expect(stateFromGotoRedirect(gotoRedirectLocation(link.route, resolved?.state ?? null))).toEqual(
      state,
    );
  });

  /**
   * The web routes open a plain postgres.js client; the worker and the tests
   * open one with Drizzle attached, which replaces the jsonb and timestamp
   * serializers on the client it is given. A query layer that behaves
   * differently on the two is a bug that only production sees, so the same
   * round trip runs on both handles and the results must be identical.
   */
  it('round-trips state and timestamps identically without Drizzle attached', async () => {
    const state = { tagFilter: { tagIds: ['a', 'b'], mode: 'all' }, page: 2, deep: { n: null } };
    const expiresAt = new Date('2030-06-01T12:00:00.000Z');
    const web = createRequestDatabase(database.connectionString);
    try {
      const created = await createGotoLink(web, {
        orgId: orgA,
        route: '/tags?view=campaigns',
        state,
        signingSecret: SECRET,
        expiresAt,
      });
      const viaPlainClient = await resolveGotoLink(web, {
        orgId: orgA,
        token: created.token,
        signingSecret: SECRET,
      });
      const viaDrizzleClient = await resolveGotoLink(database, {
        orgId: orgA,
        token: created.token,
        signingSecret: SECRET,
      });

      // The stored document, not a JSON string of it.
      expect(viaPlainClient?.state).toEqual(state);
      expect(viaDrizzleClient?.state).toEqual(state);
      expect(typeof viaPlainClient?.state).toBe('object');
      // Declared as Date, so it has to be one on both handles.
      expect(viaPlainClient?.expiresAt).toBeInstanceOf(Date);
      expect(viaDrizzleClient?.expiresAt).toBeInstanceOf(Date);
      expect(viaPlainClient?.expiresAt?.toISOString()).toBe(expiresAt.toISOString());
      expect(viaDrizzleClient?.expiresAt?.toISOString()).toBe(expiresAt.toISOString());
      expect(viaPlainClient?.createdAt).toBeInstanceOf(Date);
      expect(viaDrizzleClient?.createdAt).toBeInstanceOf(Date);
      expect(viaPlainClient?.lastUsedAt).toBeInstanceOf(Date);
      // Two resolves, counted.
      expect(viaDrizzleClient?.uses).toBe(2);
    } finally {
      await web.close();
    }
  });

  it('returns no link for expired or tampered tokens', async () => {
    const expired = await createGotoLink(database, {
      orgId: orgA,
      route: '/tags',
      state: { tagFilter: { tagIds: [], mode: 'any' } },
      signingSecret: SECRET,
      expiresAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    expect(
      await resolveGotoLink(database, {
        orgId: orgA,
        token: expired.token,
        signingSecret: SECRET,
        now: new Date('2026-01-01T00:00:00.000Z'),
      }),
    ).toBeNull();
    expect(
      await resolveGotoLink(database, {
        orgId: orgA,
        token: `${expired.token}x`,
        signingSecret: SECRET,
      }),
    ).toBeNull();
  });

  it('RLS denies org A visibility and resolution of org B goto_links', async () => {
    const foreign = await createGotoLink(database, {
      orgId: orgB,
      route: '/tags',
      state: { scope: 'foreign' },
      signingSecret: SECRET,
      createdBy: USER_B,
    });
    await asUser(database, USER_A, async (sql) => {
      expect(await sql`select * from public.goto_links where org_id = ${orgB}`).toHaveLength(0);
      expect(
        await resolveGotoLink(
          { sql },
          { orgId: orgB, token: foreign.token, signingSecret: SECRET },
        ),
      ).toBeNull();
      await expect(
        sql`
          insert into public.goto_links (org_id, token, route)
          values (${orgB}, 'foreign-write-token', '/tags')
        `,
      ).rejects.toThrow(/row-level security/i);
    });
  });
});
