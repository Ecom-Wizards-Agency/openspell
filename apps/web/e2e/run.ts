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
import type { TestDatabase } from '@wizard-ads/db/testing';
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
 * WP-07: a finished recommendation run and the search terms behind it.
 *
 * The dates matter. The review screen reads a run, but the n-gram explorer
 * defaults to the window ending *yesterday* — today's numbers are still
 * attributing and would read as a collapse — so seeding facts on `current_date`
 * would leave the explorer legitimately empty and the spec chasing a bug that
 * is not there.
 */
async function seedRecommendations(
  database: TestDatabase,
  orgId: string,
  profileId: string,
): Promise<{ runId: string; proposals: number; searchTerms: number }> {
  const strategy = {
    schema: 'wizard-ads.tenant-strategy.v1',
    // Synthetic shape, not doctrine: the point is that a snapshot exists and
    // the objective column resolves off it.
    opt_groups: { Rank: { goal_lens: 'rank-launch', target_acos: 0.4, max_increase: 0.2, max_decrease: 0.3 } },
  };

  await database.sql`
    update public.campaigns
       set name = 'E2E | SKW | blue widget', portfolio_amazon_id = 'pf-1'
     where org_id = ${orgId} and amazon_id = 'c-1'
  `;

  const [run] = await database.sql<{ id: string }[]>`
    insert into public.recommendation_runs
      (org_id, profile_id, status, lookback_days, window_start, window_end, engine_version,
       proposals_count, finished_at, strategy_snapshot)
    values (${orgId}, ${profileId}, 'succeeded', 28,
            (current_date - 28), (current_date - 1), 'core@e2e', 3, now(),
            ${JSON.stringify(strategy)}::text::jsonb)
    returning id
  `;
  const runId = run?.id ?? '';

  const inputs = (ceiling: string | null, capped: boolean) =>
    JSON.stringify({
      rpc: 1.8,
      clicks: 42,
      cvrSourceLevel: 'ad_group',
      ceilingApplied: ceiling,
      capClamped: capped,
      window: { start: '2026-07-01', end: '2026-07-28' },
    });

  const proposals = [
    { reason: 'high_acos', type: 'keyword', id: 'kw-1', name: 'blue widget', field: 'bid', old: 0.9, next: 0.72, ag: 'ag-1', ceiling: 'data_based_ad_group', capped: true },
    { reason: 'low_visibility', type: 'target', id: 'tg-1', name: 'B0TEST0002', field: 'bid', old: 0.6, next: 0.66, ag: 'ag-1', ceiling: null, capped: false },
    { reason: 'pacing', type: 'campaign', id: 'c-1', name: 'E2E | SKW | blue widget', field: 'budget', old: 10, next: 12, ag: null, ceiling: null, capped: false },
  ];
  let written = 0;
  for (const proposal of proposals) {
    const rows = await database.sql<{ id: string }[]>`
      insert into public.recommendations
        (run_id, org_id, profile_id, reason, entity_type, entity_id, ad_product, campaign_id,
         ad_group_id, entity_name, field, current_value, proposed_value, inputs)
      values (${runId}, ${orgId}, ${profileId}, ${proposal.reason}::public.recommendation_reason,
              ${proposal.type}::public.entity_type, ${proposal.id}, 'SP', 'c-1', ${proposal.ag},
              ${proposal.name}, ${proposal.field},
              ${JSON.stringify(proposal.old)}::text::jsonb,
              ${JSON.stringify(proposal.next)}::text::jsonb,
              ${inputs(proposal.ceiling, proposal.capped)}::text::jsonb)
      returning id
    `;
    written += rows.length;
  }
  if (written !== proposals.length) {
    throw new Error(`Seeded ${proposals.length} proposals, wrote ${written}`);
  }

  const terms = ['blue widget online', 'blue widget set', 'cheap blue widget'];
  let termRows = 0;
  for (const [index, term] of terms.entries()) {
    const rows = await database.sql<{ search_term: string }[]>`
      insert into public.fact_search_term_daily
        (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, target_id, search_term,
         match_type, impressions, clicks, cost, purchases_7d, sales_7d, units_sold_7d)
      values (${orgId}, ${profileId}, (current_date - 1), 'SP', 'c-1', 'ag-1', 'kw-1', ${term},
              'exact', ${100 + index * 10}, ${5 + index}, ${2.5 + index}, ${index === 0 ? 1 : 0},
              ${index === 0 ? 25 : 0}, ${index === 0 ? 1 : 0})
      returning search_term
    `;
    termRows += rows.length;
  }
  if (termRows !== terms.length) {
    throw new Error(`Seeded ${terms.length} search terms, wrote ${termRows}`);
  }

  return { runId, proposals: written, searchTerms: termRows };
}

/**
 * WP-30: Time Machine. The tenant fixture already seeds one sync-detected
 * `entity_changes` row and one operator `apply_batch`/`apply_row` per org, which
 * is the two-source timeline the page renders. This adds one change that only
 * org A has — a distinctive campaign-budget edit — so the cross-tenant assertion
 * can prove org B never sees it rather than merely seeing a different count of
 * identical fixture rows.
 */
export const TIME_MACHINE_MARKER = 'ZZ Time Machine Marker';

async function seedTimeMachine(
  database: TestDatabase,
  orgId: string,
  profileId: string,
): Promise<void> {
  const rows = await database.sql<{ id: string }[]>`
    insert into public.entity_changes
      (org_id, profile_id, entity_type, amazon_id, entity_name, field, old_value, new_value, source)
    values (${orgId}, ${profileId}, 'campaign', 'c-1', ${TIME_MACHINE_MARKER}, 'budget',
            '10'::jsonb, '15'::jsonb, 'sync')
    returning id
  `;
  if (rows.length !== 1) throw new Error(`Seeded 1 Time Machine change, wrote ${rows.length}`);
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

    // WP-07: a run to review, and the search terms its explorer aggregates.
    const recommendations = await seedRecommendations(database, orgA, profileA);

    // WP-30: the org-A-only change the Time Machine cross-tenant test looks for.
    await seedTimeMachine(database, orgA, profileA);
    const [profileBRow] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgB} limit 1
    `;
    const profileB = profileBRow?.id ?? '';

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
        WIZARD_ADS_E2E_PROFILE_A: profileA,
        WIZARD_ADS_E2E_PROFILE_B: profileB,
        WIZARD_ADS_E2E_REC_RUN: recommendations.runId,
        WIZARD_ADS_E2E_REC_PROPOSALS: String(recommendations.proposals),
        WIZARD_ADS_E2E_REC_SEARCH_TERMS: String(recommendations.searchTerms),
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
