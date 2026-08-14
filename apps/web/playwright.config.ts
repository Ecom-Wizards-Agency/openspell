/**
 * End-to-end configuration for the tag and goto surfaces.
 *
 * The database, the seed data and the environment are prepared by
 * `e2e/run.ts`, which is what `pnpm --filter @wizard-ads/web test:e2e` runs.
 * Starting Playwright directly will fail on the missing variables rather than
 * silently testing an empty database.
 *
 * Authentication is a header bridge (see `src/server/request-context.ts`):
 * WP-04 owns the browser session and its middleware is not in the tree yet, so
 * the browser context supplies the same verified-actor headers the middleware
 * will. Every request the page makes carries them, navigations included.
 */
import { defineConfig, devices } from '@playwright/test';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Run this suite through e2e/run.ts.`);
  return value;
}

const port = Number(required('WIZARD_ADS_E2E_PORT'));
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    extraHTTPHeaders: {
      'x-wizard-ads-auth-bridge': required('WIZARD_ADS_AUTH_BRIDGE_SECRET'),
      'x-wizard-ads-user-id': required('WIZARD_ADS_E2E_USER_A'),
      'x-wizard-ads-org-id': required('WIZARD_ADS_E2E_ORG_A'),
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // A production server, not `next dev`: the dev client bootstraps through an
    // HMR websocket that never completes behind Playwright's request headers,
    // and a page that never hydrates fails every interaction test for a reason
    // that has nothing to do with the code under test. `e2e/run.ts` builds
    // first.
    command: `pnpm exec next start --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
