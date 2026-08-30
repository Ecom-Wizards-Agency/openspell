/** Cross-route operator acceptance in a fresh authenticated Next process. */
import { defineConfig, devices } from '@playwright/test';
import { BASE_URL } from './e2e/support/fixture';

export default defineConfig({
  testDir: './e2e',
  testMatch: /route-acceptance\.dashboard\.spec\.ts$/,
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  outputDir: './node_modules/.cache/playwright/route-acceptance',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env['CI']
    ? [
        ['list'],
        [
          'html',
          {
            outputFolder: './node_modules/.cache/playwright/reports/route-acceptance',
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
  projects: [{ name: 'route-acceptance', use: { ...devices['Desktop Chrome'] } }],
});
