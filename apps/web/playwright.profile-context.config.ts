/**
 * Account-scope and same-document navigation in a fresh authenticated Next
 * process. The sidebar layout regression rides here because it needs the same
 * authenticated frame and adds only a handful of dashboard loads.
 */
import { defineConfig, devices } from '@playwright/test';
import authConfig from './playwright.auth.config';

export default defineConfig({
  ...authConfig,
  testMatch: /(profile-context|sidebar-layout)\.spec\.ts$/,
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
