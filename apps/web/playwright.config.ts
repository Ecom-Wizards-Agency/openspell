/**
 * End-to-end configuration.
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
  testMatch: '**/*.spec.ts',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  outputDir: './node_modules/.cache/playwright/results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Next dev compiles a route on first request; the first navigation in a run
  // can genuinely take a while.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
