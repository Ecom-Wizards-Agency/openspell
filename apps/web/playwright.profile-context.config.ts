/** Account-scope and same-document navigation in a fresh authenticated Next process. */
import { defineConfig, devices } from '@playwright/test';
import authConfig from './playwright.auth.config';

export default defineConfig({
  ...authConfig,
  testMatch: /profile-context\.spec\.ts$/,
  outputDir: './node_modules/.cache/playwright/profile-context',
  reporter: process.env['CI']
    ? [
        ['list'],
        [
          'html',
          {
            outputFolder: './node_modules/.cache/playwright/reports/profile-context',
            open: 'never',
          },
        ],
      ]
    : [['list']],
  projects: [{ name: 'profile-context', use: { ...devices['Desktop Chrome'] } }],
});
