/**
 * End-to-end configuration for the tag and goto surfaces (WP-08).
 *
 * There is no default `playwright.config.ts` in this app on purpose: the two
 * browser suites need two incompatible servers, so each has a named config and
 * `e2e/run.ts` is the only supported entry point. See the header of that file
 * for why the split exists.
 *
 * The database, the seed data and the environment are prepared by `e2e/run.ts`,
 * which is what `pnpm --filter @wizard-ads/web test:e2e` runs. Starting
 * Playwright directly will fail on the missing variables rather than silently
 * testing an empty database.
 *
 * Authentication here is the e2e-only header bridge (see
 * `src/server/request-context.ts`): the browser context supplies the same
 * verified-actor headers WP-04's session layer would produce, and every request
 * the page makes carries them, navigations included. The bridge is inert unless
 * `WIZARD_ADS_E2E_AUTH_BRIDGE=1` is set on the server, which only `e2e/run.ts`
 * does — outside this suite the same routes resolve their actor from the real
 * Supabase session.
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
  // WP-15's feedback specs and WP-07's recommendation specs ride this config:
  // they need the same header bridge against the same production build, and
  // standing up another server per work package would buy nothing.
  testMatch: /(tags-goto|feedback|recommendations|experiments|time-machine|campaigns)\.spec\.ts$/,
  outputDir: './node_modules/.cache/playwright/tags-goto',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env['CI']
    ? [
        ['list'],
        [
          'html',
          {
            outputFolder: './node_modules/.cache/playwright/reports/tags-goto',
            open: 'never',
          },
        ],
      ]
    : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    extraHTTPHeaders: {
      'x-wizard-ads-auth-bridge': required('WIZARD_ADS_AUTH_BRIDGE_SECRET'),
      'x-wizard-ads-user-id': required('WIZARD_ADS_E2E_USER_A'),
      'x-wizard-ads-org-id': required('WIZARD_ADS_E2E_ORG_A'),
    },
  },
  projects: [{ name: 'tags-goto', use: { ...devices['Desktop Chrome'] } }],
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
