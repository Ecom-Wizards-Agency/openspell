/**
 * The one entry point for this app's browser tests.
 *
 * ## Why there are two suites and not one
 *
 * `apps/web` carries two end-to-end suites that need mutually exclusive
 * servers, so they run one after the other rather than under a single config:
 *
 *  - **tags-goto** (WP-08, and WP-15's feedback surfaces) serves a
 *    **production** build. `next dev`'s client
 *    bootstraps through an HMR websocket that never completes behind
 *    Playwright's extra request headers, so the page never hydrates and every
 *    interaction test fails for a reason unrelated to the code under test.
 *  - **auth** (WP-04) serves `next dev`. Supabase Auth is a hosted service — a
 *    magic link means an inbox — so the suite signs in through a test-only
 *    seam (`WIZARD_ADS_E2E_AUTH=1`) that *refuses to run under
 *    `NODE_ENV=production` by design*. Running it against `next start` would
 *    mean disabling that guard, which is the guard's whole point.
 *
 * Merging them would mean weakening one guard or accepting a suite that cannot
 * hydrate. Sequential is the honest answer: two named configs, one runner.
 *
 * Each suite owns its own database, and the two never overlap: this file
 * creates and drops the tags-goto database, while the auth suite's
 * `global-setup.ts` creates and drops its own (plus the fake Amazon and the dev
 * server). The admin connection comes from `WIZARD_ADS_TEST_DATABASE_URL` (or
 * `DATABASE_URL`), the same variable the Vitest database suites use.
 *
 *   pnpm --filter @wizard-ads/web test:e2e             # both, in order
 *   pnpm --filter @wizard-ads/web test:e2e:tags-goto   # just WP-08
 *   pnpm --filter @wizard-ads/web test:e2e:auth        # just WP-04
 *
 * Anything after the suite name is forwarded to Playwright (`--grep`, `-x`, …).
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import { createGotoLink } from '@wizard-ads/db';
import { ROADMAP_ITEMS, seedRoadmap } from '../../../supabase/seed/seed-roadmap.js';

const SUITES = ['tags-goto', 'auth'] as const;
type Suite = (typeof SUITES)[number];

const USER_A = '8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a8a';
const USER_B = '8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b';
/** A second member of org A, so WP-15's role matrix has a role to refuse. */
const USER_VIEWER = '8e8e8e8e-8e8e-4e8e-8e8e-8e8e8e8e8e8e';
const BRIDGE_SECRET = ['synthetic', 'e2e', 'auth', 'bridge', 'value'].join('-');
const SIGNING_SECRET = ['synthetic', 'e2e', 'goto', 'signing', 'material', 'value'].join('-');

const APP_DIRECTORY = fileURLToPath(new URL('..', import.meta.url));

/** An unused loopback port, so a parallel run cannot collide with this one. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not allocate a port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const child = spawn(command, args, { cwd: APP_DIRECTORY, stdio: 'inherit', env });
  return new Promise<number>((resolve) => {
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/**
 * WP-08: tags and `/go/[token]`, against a production build.
 *
 * `WIZARD_ADS_E2E_AUTH_BRIDGE=1` is what arms the header bridge in
 * `src/server/request-context.ts`. Without it the routes resolve their actor
 * from the real Supabase session instead, which is exactly what a deployed
 * instance does — see that file's header for the boundary.
 */
async function tagsGoto(playwrightArgs: string[]): Promise<number> {
  const database = await createTestDatabase('wp08_e2e');
  try {
    const [a] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('e2e-alpha', ${USER_A}, 'owner')
    `;
    const [b] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('e2e-bravo', ${USER_B}, 'owner')
    `;
    const orgA = a?.seed_tenant_fixture ?? '';
    const orgB = b?.seed_tenant_fixture ?? '';
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgA} limit 1
    `;
    const profileA = profile?.id ?? '';

    // The fixture seeds one campaign, already carrying its 'Client' tag. Two
    // more untagged ones make "tag a campaign set, then filter by that tag" a
    // real assertion rather than a one-row coincidence.
    const seededCampaigns = [
      { id: 'c-2', name: 'Second campaign' },
      { id: 'c-3', name: 'Third campaign' },
    ];
    for (const campaign of seededCampaigns) {
      await database.sql`
        insert into public.campaigns
          (org_id, profile_id, amazon_id, ad_product, name, state, budget_amount, budget_type)
        values
          (${orgA}, ${profileA}, ${campaign.id}, 'SP', ${campaign.name}, 'enabled', 10.00, 'daily')
      `;
    }
    const [campaignCount] = await database.sql<{ count: string }[]>`
      select count(*) as count from public.campaigns where org_id = ${orgA}
    `;
    const expectedCampaigns = seededCampaigns.length + 1;
    if (Number(campaignCount?.count ?? 0) !== expectedCampaigns) {
      throw new Error(`Seeded ${expectedCampaigns} campaigns, found ${campaignCount?.count ?? 0}`);
    }

    // WP-15: a viewer in org A, the seeded roadmap, and org B's own feedback
    // item — the three things the feedback suite needs that the tag fixture
    // does not already provide.
    await database.sql`select public.auth_user_stub(${USER_VIEWER})`;
    await database.sql`
      insert into public.org_members (org_id, user_id, role)
      values (${orgA}, ${USER_VIEWER}, 'viewer')
    `;
    const roadmap = await seedRoadmap(database, { orgId: orgA });
    if (roadmap.created !== ROADMAP_ITEMS.length) {
      throw new Error(`Seeded ${ROADMAP_ITEMS.length} roadmap items, wrote ${roadmap.created}`);
    }
    const [foreignItem] = await database.sql<{ id: string }[]>`
      select id from public.feedback_items where org_id = ${orgB} limit 1
    `;

    const expired = await createGotoLink(database, {
      orgId: orgA,
      route: '/tags',
      state: { tagFilter: { tagIds: [], mode: 'any' } },
      signingSecret: SIGNING_SECRET,
      expiresAt: new Date('2020-01-01T00:00:00.000Z'),
      label: 'expired',
    });
    const foreign = await createGotoLink(database, {
      orgId: orgB,
      route: '/tags',
      state: { tagFilter: { tagIds: [], mode: 'any' } },
      signingSecret: SIGNING_SECRET,
      label: 'other tenant',
    });

    const port = await freePort();

    // Playwright serves a production build; see the note at the top of the file.
    const buildCode = await run('pnpm', ['exec', 'next', 'build', '--webpack'], process.env);
    if (buildCode !== 0) return buildCode;

    return await run(
      'pnpm',
      ['exec', 'playwright', 'test', '-c', 'playwright.tags-goto.config.ts', ...playwrightArgs],
      {
        ...process.env,
        DATABASE_URL: database.connectionString,
        GOTO_LINK_SIGNING_SECRET: SIGNING_SECRET,
        WIZARD_ADS_E2E_AUTH_BRIDGE: '1',
        WIZARD_ADS_AUTH_BRIDGE_SECRET: BRIDGE_SECRET,
        WIZARD_ADS_E2E_PORT: String(port),
        WIZARD_ADS_E2E_USER_A: USER_A,
        WIZARD_ADS_E2E_ORG_A: orgA,
        WIZARD_ADS_E2E_EXPIRED_TOKEN: expired.token,
        WIZARD_ADS_E2E_FOREIGN_TOKEN: foreign.token,
        WIZARD_ADS_E2E_CAMPAIGN_TOTAL: String(expectedCampaigns),
        WIZARD_ADS_E2E_USER_VIEWER: USER_VIEWER,
        WIZARD_ADS_E2E_USER_B: USER_B,
        WIZARD_ADS_E2E_ORG_B: orgB,
        WIZARD_ADS_E2E_FOREIGN_ITEM: foreignItem?.id ?? '',
        WIZARD_ADS_E2E_ROADMAP_SEEDED: String(roadmap.created),
      },
    );
  } finally {
    await database.drop();
  }
}

/**
 * WP-04: login, the Amazon OAuth round trip and the role matrix, against
 * `next dev`.
 *
 * Everything this suite needs — database, fake Amazon, dev server — is brought
 * up by `e2e/global-setup.ts`, because the server's environment depends on
 * values that file computes. The header bridge is deliberately *not* armed
 * here: these specs exercise the real session cookie path.
 */
async function auth(playwrightArgs: string[]): Promise<number> {
  const env = { ...process.env };
  delete env['WIZARD_ADS_E2E_AUTH_BRIDGE'];
  delete env['WIZARD_ADS_AUTH_BRIDGE_SECRET'];
  return await run(
    'pnpm',
    ['exec', 'playwright', 'test', '-c', 'playwright.auth.config.ts', ...playwrightArgs],
    env,
  );
}

function parse(argv: string[]): { suites: Suite[]; playwrightArgs: string[] } {
  const [first, ...rest] = argv;
  if (first === undefined || first === 'all' || first.startsWith('-')) {
    return { suites: [...SUITES], playwrightArgs: first === undefined ? [] : argv };
  }
  if (!(SUITES as readonly string[]).includes(first)) {
    throw new Error(`Unknown suite '${first}'. Expected one of: ${SUITES.join(', ')}, all.`);
  }
  return { suites: [first as Suite], playwrightArgs: rest };
}

async function main(): Promise<number> {
  const { suites, playwrightArgs } = parse(process.argv.slice(2));

  if (!(await databaseAvailable())) {
    throw new Error(
      'No Postgres reachable. Set WIZARD_ADS_TEST_DATABASE_URL to an admin connection string.',
    );
  }

  let worst = 0;
  for (const suite of suites) {
    console.log(`\n=== e2e suite: ${suite} ===\n`);
    const code = suite === 'tags-goto' ? await tagsGoto(playwrightArgs) : await auth(playwrightArgs);
    // Every suite runs even when an earlier one fails: a red run should report
    // the whole picture, not just the first thing that broke.
    if (code !== 0) worst = code;
  }
  return worst;
}

process.exitCode = await main();
