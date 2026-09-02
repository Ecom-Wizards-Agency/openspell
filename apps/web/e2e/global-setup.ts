/**
 * Bring up everything the end-to-end suite needs, in one place.
 *
 * Three things, in order: a migrated database with two orgs and four users, the
 * fake Amazon, and a Next dev server pointed at both. Playwright's built-in
 * `webServer` is not used, because the server's environment depends on values
 * this file computes and the launch order between the two is not something to
 * rely on.
 *
 * Dev mode rather than `next start` is not laziness: `next start` sets
 * `NODE_ENV=production`, and the test-only auth seam refuses to run in a
 * production build by design. Running the suite against `next start` would have
 * to disable that guard, which is the guard's whole point.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDb } from '@wizard-ads/db';
import { adminConnectionString, applySqlFile, migrationFiles } from '@wizard-ads/db/testing';
import { createE2EResourceCleanup } from '../src/e2e-resource-cleanup.js';
import type { E2EResourceCleanupTask } from '../src/e2e-resource-cleanup.js';
import { startAmazonMock } from './support/amazon-mock';
import type { AmazonMock } from './support/amazon-mock';
import {
  APP_PORT,
  BASE_URL,
  DATABASE_NAME,
  EMAILS,
  GRANT,
  MOCK_PORT,
  STATE_KEY,
  USERS,
  WEB_ROOT,
  writeState,
} from './support/fixture';

const REPO_ROOT = new URL('../../../', import.meta.url).pathname;
const MIGRATIONS = `${REPO_ROOT}supabase/migrations`;
const SHIM = `${REPO_ROOT}supabase/tests/supabase-platform-shim.sql`;
const FIXTURE = `${REPO_ROOT}supabase/tests/tenant-fixture.sql`;

/** Assembled from fragments; nothing in this repository may look like a credential. */
const RENEWAL_VALUE = ['synthetic', 'e2e', 'renewal', 'value'].join('-');

interface AcquiredE2EResource<T> {
  resource: T;
  cleanup: E2EResourceCleanupTask;
}

/** Injectable boundary used to prove cleanup at each real setup cut. */
export interface E2EGlobalSetupOperations<Mock, Server> {
  installTeardown(teardown: () => Promise<void>): void;
  acquireDatabase(registerDrop: (drop: E2EResourceCleanupTask) => void): Promise<string>;
  prepareDatabase(connectionString: string): Promise<void>;
  acquireMock(): Promise<AcquiredE2EResource<Mock>>;
  acquireServer(
    connectionString: string,
    mock: Mock,
  ): AcquiredE2EResource<Server> | Promise<AcquiredE2EResource<Server>>;
  waitUntilReady(server: Server): Promise<void>;
}

export async function runE2EGlobalSetup<Mock, Server>(
  operations: E2EGlobalSetupOperations<Mock, Server>,
): Promise<void> {
  const cleanup = createE2EResourceCleanup();

  // Teardown is attached before acquisition starts. Setup failures use this
  // same idempotent stack, so Playwright may still invoke global teardown
  // without running any resource cleanup twice.
  operations.installTeardown(cleanup.cleanup);

  try {
    const connectionString = await operations.acquireDatabase((drop) => cleanup.register(drop));
    await operations.prepareDatabase(connectionString);

    const mock = await operations.acquireMock();
    cleanup.register(mock.cleanup);

    const server = await operations.acquireServer(connectionString, mock.resource);
    cleanup.register(server.cleanup);
    await operations.waitUntilReady(server.resource);
  } catch (error) {
    await cleanup.cleanupAfterFailure(error);
  }
}

export default async function globalSetup(): Promise<void> {
  await runE2EGlobalSetup({
    installTeardown: (teardown) => {
      (globalThis as Record<string, unknown>)['__wizardAdsE2E'] = teardown;
    },
    acquireDatabase: async (registerDrop) => {
      const admin = adminConnectionString();
      return await createDatabase(admin, () => registerDrop(() => dropDatabase(admin)));
    },
    prepareDatabase: async (connectionString) => {
      await migrateDatabase(connectionString);
      const state = await seed(connectionString);
      await writeState({ connectionString, ...state });
    },
    acquireMock: async () => {
      const mock = await startAmazonMock({
        port: MOCK_PORT,
        perRegion: { na: GRANT.na, eu: GRANT.eu },
        renewal: RENEWAL_VALUE,
      });
      return { resource: mock, cleanup: () => mock.close() };
    },
    acquireServer: (connectionString, mock) => {
      const server = spawnWebServer(connectionString, mock);
      return { resource: server, cleanup: () => stopProcess(server.child) };
    },
    waitUntilReady: async (server) => {
      await waitForE2EServerOrFailure(
        (signal) => waitForServer(`${BASE_URL}/login`, 120_000, signal),
        server.failedBeforeReady,
      );
    },
  });
}

/** Cancel the losing readiness poll before setup cleanup or another suite starts. */
export async function waitForE2EServerOrFailure(
  waitUntilReady: (signal: AbortSignal) => Promise<void>,
  failedBeforeReady: Promise<never>,
): Promise<void> {
  const controller = new AbortController();
  const readiness = waitUntilReady(controller.signal);
  try {
    await Promise.race([readiness, failedBeforeReady]);
  } finally {
    controller.abort();
    // Observe cancellation before returning so no fetch or timer can outlive
    // this setup process and mistake the next suite's fixed port for success.
    await readiness.catch(() => undefined);
  }
}

async function stopProcess(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
    return;
  }

  await new Promise<void>((resolveStop, rejectStop) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
    }, 15_000);

    child.once('exit', () => {
      clearTimeout(timeout);
      resolveStop();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectStop(error);
    });
    if (!child.kill('SIGTERM')) {
      clearTimeout(timeout);
      resolveStop();
    }
  });
}

async function createDatabase(admin: string, ownCreateAttempt: () => void): Promise<string> {
  const adminHandle = createDb({ connectionString: admin, max: 1 });
  try {
    // A fixed name, so an interrupted run leaves one database behind and the
    // next run reclaims it instead of accumulating them.
    await adminHandle.sql.unsafe(`drop database if exists "${DATABASE_NAME}" with (force)`);
    // The CREATE result can be unknown if the connection fails while the
    // server commits it. Own the idempotent drop before issuing CREATE so both
    // that case and a later admin-handle close failure remain recoverable.
    ownCreateAttempt();
    await adminHandle.sql.unsafe(`create database "${DATABASE_NAME}"`);
  } finally {
    await adminHandle.close();
  }

  const url = new URL(admin);
  url.pathname = `/${DATABASE_NAME}`;
  return url.toString();
}

async function migrateDatabase(connectionString: string): Promise<void> {
  const handle = createDb({ connectionString, max: 2 });
  try {
    await applySqlFile(handle, SHIM);
    for (const file of await migrationFiles()) {
      await applySqlFile(handle, `${MIGRATIONS}/${file}`);
    }
    await applySqlFile(handle, FIXTURE);
  } finally {
    await handle.close();
  }
}

async function seed(connectionString: string): Promise<{
  orgId: string;
  otherOrgId: string;
  fixtureProfileId: string;
}> {
  const handle = createDb({ connectionString, max: 2 });
  try {
    const [org] = await handle.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('e2e', ${USERS.admin}, 'admin')
    `;
    const orgId = org?.seed_tenant_fixture ?? '';

    const [other] = await handle.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('e2e-other', ${USERS.outsider}, 'owner')
    `;

    for (const [userId, role] of [
      [USERS.analyst, 'analyst'],
      [USERS.viewer, 'viewer'],
    ] as const) {
      await handle.sql`select public.auth_user_stub(${userId})`;
      await handle.sql`
        insert into public.org_members (org_id, user_id, role)
        values (${orgId}, ${userId}, ${role}::public.org_role)
      `;
    }

    const identities = Object.entries(USERS) as Array<[keyof typeof USERS, string]>;
    let emailsWritten = 0;
    for (const [key, userId] of identities) {
      const rows = await handle.sql<{ id: string }[]>`
        update auth.users set email = ${EMAILS[key]} where id = ${userId} returning id
      `;
      emailsWritten += rows.length;
    }
    if (emailsWritten !== identities.length) {
      throw new Error(`Seeded ${identities.length} Auth emails, wrote ${emailsWritten}`);
    }

    // The tenant fixture ships a connection row so the RLS suite has one in
    // every table. This suite is about *making* that row, so it starts from a
    // genuinely unconnected org; the fixture profile survives, with a null
    // connection, which is also the state a revoked grant leaves behind.
    await handle.sql`delete from public.ads_connections where org_id = ${orgId}`;

    const [profile] = await handle.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId} limit 1
    `;
    const fixtureProfileId = profile?.id ?? '';
    const dashboardFacts = await handle.sql<{ date: string }[]>`
      insert into public.fact_profile_daily
        (org_id, profile_id, date, currency_code, impressions, clicks, cost,
         purchases_7d, sales_7d, units_sold_7d, provisional)
      values (${orgId}, ${fixtureProfileId}, current_date - 2, 'USD', 400, 24, 18,
              4, 90, 4, false)
      returning date::text
    `;
    if (dashboardFacts.length !== 1) {
      throw new Error(`Seeded 1 dashboard fact, wrote ${dashboardFacts.length}`);
    }

    if (process.env['WIZARD_ADS_E2E_SUITE'] === 'optimization-groups') {
      const revision = process.env['OPENSPELL_RECOMMENDATION_LANE_REVISION'];
      if (revision === undefined || !/^[0-9a-f]{40}$/.test(revision)) {
        throw new Error('The optimization-groups fixture requires an exact recommendation revision');
      }
      const authority = await handle.sql<{ authorized_revision: string }[]>`
        update app.recommendation_claim_authority
           set protocol = 'fenced', admission = 'scoped', epoch = epoch + 1,
               authorized_revision = ${revision}, updated_at = now()
         where singleton
        returning authorized_revision
      `;
      if (authority.length !== 1 || authority[0]?.authorized_revision !== revision) {
        throw new Error('The optimization-groups fixture did not bind recommendation authority');
      }
    }

    const gridFacts = await handle.sql<{ target_id: string }[]>`
      insert into public.fact_sp_target_daily
        (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, target_id,
         target_kind, match_type, impressions, clicks, cost, purchases_7d, sales_7d,
         units_sold_7d)
      values (${orgId}, ${fixtureProfileId}, current_date - 2, 'SP', 'c-1', 'ag-1',
              'kw-1', 'keyword', 'exact', 300, 18, 14, 3, 75, 3)
      returning target_id
    `;
    if (gridFacts.length !== 1) {
      throw new Error(`Seeded 1 grid fact, wrote ${gridFacts.length}`);
    }

    return {
      orgId,
      otherOrgId: other?.seed_tenant_fixture ?? '',
      fixtureProfileId,
    };
  } finally {
    await handle.close();
  }
}

interface SpawnedWebServer {
  child: ChildProcess;
  failedBeforeReady: Promise<never>;
}

function spawnWebServer(connectionString: string, amazon: AmazonMock): SpawnedWebServer {
  const child = spawn(
    resolve(WEB_ROOT, 'node_modules/.bin/next'),
    // `--webpack` for the reason next.config.ts documents: Turbopack cannot
    // resolve the workspace packages' `.js` specifiers to their `.ts` sources.
    ['dev', '--webpack', '--port', String(APP_PORT), '--hostname', '127.0.0.1'],
    {
      cwd: WEB_ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        // Each authenticated suite owns one bounded dev process. Retain the
        // existing heap ceiling without allowing a development-memory restart
        // to discard an in-process fixture.
        NODE_OPTIONS: appendNodeOption(
          process.env['NODE_OPTIONS'],
          '--max-old-space-size=4096',
        ),
        NODE_ENV: 'development',
        DATABASE_URL: connectionString,
        WIZARD_ADS_APP_URL: BASE_URL,
        WIZARD_ADS_E2E_AUTH: '1',
        AMAZON_LWA_CLIENT_ID: 'amzn1.application-oa2-client.e2e',
        AMAZON_LWA_CLIENT_SECRET: 'synthetic-e2e-client-secret',
        AMAZON_OAUTH_REDIRECT_URI: `${BASE_URL}/api/amazon/oauth/callback`,
        AMAZON_OAUTH_STATE_KEY: STATE_KEY,
        AMAZON_LWA_AUTHORIZE_URL: amazon.authorizeUrl,
        AMAZON_LWA_TOKEN_URL: amazon.tokenUrl,
        AMAZON_ADS_HOST_NA: amazon.hosts.NA,
        AMAZON_ADS_HOST_EU: amazon.hosts.EU,
        AMAZON_ADS_HOST_FE: amazon.hosts.FE,
      },
    },
  );
  // Attach before returning: a missing executable or an immediate exit emits
  // asynchronously and must reject setup rather than become an uncaught event
  // while the readiness poll waits for its full timeout.
  const failedBeforeReady = new Promise<never>((_resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      reject(new Error(`Next exited before readiness (code=${String(code)}, signal=${String(signal)})`));
    });
  });
  return { child, failedBeforeReady };
}

function appendNodeOption(current: string | undefined, option: string): string {
  return [current, option].filter((value): value is string => Boolean(value)).join(' ');
}

async function waitForServer(
  url: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const response = await fetch(url, { redirect: 'manual', signal });
      if (response.status < 500) return;
      lastError = new Error(`status ${response.status}`);
    } catch (error) {
      signal.throwIfAborted();
      lastError = error;
    }
    await delay(500, undefined, { signal });
  }
  throw new Error(`the web server never answered at ${url}: ${String(lastError)}`);
}

async function dropDatabase(admin: string): Promise<void> {
  const handle = createDb({ connectionString: admin, max: 1 });
  try {
    await handle.sql.unsafe(`drop database if exists "${DATABASE_NAME}" with (force)`);
  } finally {
    await handle.close();
  }
}
