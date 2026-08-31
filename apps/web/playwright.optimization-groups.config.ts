/** WP-171's optimization-group workflow in a fresh authenticated Next process. */
import { defineConfig, devices } from '@playwright/test';
import authConfig from './playwright.auth.config';

export default defineConfig({
  ...authConfig,
  testMatch: /optimization-groups\.spec\.ts$/,
  outputDir: './node_modules/.cache/playwright/optimization-groups',
  reporter: process.env['CI']
    ? [
        ['list'],
        [
          'html',
          {
            outputFolder: './node_modules/.cache/playwright/reports/optimization-groups',
            open: 'never',
          },
        ],
      ]
    : [['list']],
  projects: [{ name: 'optimization-groups', use: { ...devices['Desktop Chrome'] } }],
});
