/** Signed-in frame and guarded routes in a fresh authenticated-test Next process. */
import { defineConfig, devices } from '@playwright/test';
import authConfig from './playwright.auth.config';

export default defineConfig({
  ...authConfig,
  testMatch: /guards-signed-in\.spec\.ts$/,
  outputDir: './node_modules/.cache/playwright/auth-guards-signed-in',
  reporter: process.env['CI']
    ? [
        ['list'],
        [
          'html',
          {
            outputFolder: './node_modules/.cache/playwright/reports/auth-guards-signed-in',
            open: 'never',
          },
        ],
      ]
    : [['list']],
  projects: [{ name: 'auth-guards-signed-in', use: { ...devices['Desktop Chrome'] } }],
});
