/**
 * Runner for the end-to-end suite.
 *
 * Playwright needs a migrated, seeded database before the Next server starts,
 * and the server has to be told about it through the environment. Doing that
 * inside `playwright.config.ts` would mean importing the TypeScript test
 * harness from a file Playwright transpiles itself; this script owns the
 * lifecycle instead, so the config stays declarative:
 *
 *   create database -> apply every migration -> seed two tenants ->
 *   run playwright -> drop the database, whatever happened.
 *
 * The admin connection comes from `WIZARD_ADS_TEST_DATABASE_URL` (or
 * `DATABASE_URL`), the same variable the Vitest database suites use.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import { createGotoLink } from '@wizard-ads/db';

const USER_A = '8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a8a';
const USER_B = '8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b';
const BRIDGE_SECRET = ['synthetic', 'e2e', 'auth', 'bridge', 'value'].join('-');
const SIGNING_SECRET = ['synthetic', 'e2e', 'goto', 'signing', 'material', 'value'].join('-');

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

async function main(): Promise<number> {
  if (!(await databaseAvailable())) {
    throw new Error(
      'No Postgres reachable. Set WIZARD_ADS_TEST_DATABASE_URL to an admin connection string.',
    );
  }

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
      throw new Error(
        `Seeded ${expectedCampaigns} campaigns, found ${campaignCount?.count ?? 0}`,
      );
    }

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
    const appDirectory = fileURLToPath(new URL('..', import.meta.url));

    // Playwright serves a production build; see the note in playwright.config.ts.
    const build = spawn('pnpm', ['exec', 'next', 'build', '--webpack'], {
      cwd: appDirectory,
      stdio: 'inherit',
    });
    const buildCode = await new Promise<number>((resolve) => {
      build.on('exit', (code) => resolve(code ?? 1));
    });
    if (buildCode !== 0) return buildCode;

    const child = spawn(
      'pnpm',
      ['exec', 'playwright', 'test', ...process.argv.slice(2)],
      {
        cwd: appDirectory,
        stdio: 'inherit',
        env: {
          ...process.env,
          DATABASE_URL: database.connectionString,
          GOTO_LINK_SIGNING_SECRET: SIGNING_SECRET,
          WIZARD_ADS_AUTH_BRIDGE_SECRET: BRIDGE_SECRET,
          WIZARD_ADS_E2E_PORT: String(port),
          WIZARD_ADS_E2E_USER_A: USER_A,
          WIZARD_ADS_E2E_ORG_A: orgA,
          WIZARD_ADS_E2E_EXPIRED_TOKEN: expired.token,
          WIZARD_ADS_E2E_FOREIGN_TOKEN: foreign.token,
          WIZARD_ADS_E2E_CAMPAIGN_TOTAL: String(expectedCampaigns),
        },
      },
    );
    return await new Promise<number>((resolve) => {
      child.on('exit', (code) => resolve(code ?? 1));
    });
  } finally {
    await database.drop();
  }
}

process.exitCode = await main();
