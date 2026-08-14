import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser } from '../testing/rls.js';
import { createTestDatabase, databaseAvailable } from '../testing/harness.js';
import type { TestDatabase } from '../testing/harness.js';
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
const SECRET = 'synthetic-goto-signing-secret-for-tests-only';

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
