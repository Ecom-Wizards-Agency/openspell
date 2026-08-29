/**
 * End-to-end configuration for auth, OAuth and roles (WP-04).
 *
 * There is no default `playwright.config.ts` in this app on purpose: the two
 * browser suites need two incompatible servers, so each has a named config and
 * `e2e/run.ts` is the only supported entry point. See the header of that file
 * for why the split exists.
 *
 * One worker and no retries: every spec in this suite shares one database and
 * one connected Amazon account, and a parallel run of tests that toggle the
 * same profile proves nothing except that races exist. The flow under test is
 * a handful of page loads, so serial costs seconds.
 *
 * Artifacts go under `node_modules/.cache` so a run leaves the working tree
 * exactly as it found it, and no `.gitignore` entry has to be maintained for a
 * directory that only ever holds screenshots of failures.
 */
import { defineConfig, devices } from '@playwright/test';
import { BASE_URL } from './e2e/support/fixture';

export default defineConfig({
  testDir: './e2e',
  // `guards.spec.ts` rides this config because it needs the same thing the
  // other two do and one thing only this suite has: a session that can be
  // absent. The WP-08 config arms the header bridge, so every request there is
  // authenticated before it is routed and "anonymous" cannot be expressed.
  testMatch: /(oauth|roles|guards|members|dashboard|grid|profile-context)\.spec\.ts$/,
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  outputDir: './node_modules/.cache/playwright/auth',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  // Next dev compiles a route on first request; the first navigation in a run
  // can genuinely take a while.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env['CI']
    ? [
        ['list'],
        [
          'html',
          {
            outputFolder: './node_modules/.cache/playwright/reports/auth',
            open: 'never',
          },
        ],
      ]
    : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'auth', use: { ...devices['Desktop Chrome'] } }],
});
