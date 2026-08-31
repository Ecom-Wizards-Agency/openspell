/**
 * End-to-end configuration for auth, OAuth and operator navigation (WP-04).
 *
 * There is no default `playwright.config.ts` in this app on purpose: the
 * browser suites have different server or process-isolation needs, so each has
 * a named config and `e2e/run.ts` is the only supported entry point. See the
 * header of that file for why the split exists.
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
  // other authenticated specs do and one thing only this suite has: a session that can be
  // absent. The WP-08 config arms the header bridge, so every request there is
  // authenticated before it is routed and "anonymous" cannot be expressed.
  // The 3,597-row Grid performance fixture has its own process/configuration.
  // Keeping it here makes Next dev retain that route graph and payload while
  // compiling every guarded route, eventually exhausting the bounded E2E heap
  // on shared runners for reasons unrelated to the later role assertions.
  // The settings-heavy role matrix has its own fresh authenticated process.
  // Keeping it here made Next retain both the complete operator route graph
  // and every settings graph until the runner reached its bounded heap after
  // all preceding assertions had already passed.
  testMatch: /(oauth|guards|members|dashboard|grid)\.spec\.ts$/,
  // The cross-route dashboard acceptance file compiles several large operator
  // routes and owns a fresh Next process through its dedicated configuration.
  testIgnore: /route-acceptance\.dashboard\.spec\.ts$/,
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
