/** Member and invitation flows in a fresh authenticated Next dev process. */
import { defineConfig, devices } from '@playwright/test';
import authConfig from './playwright.auth.config';

export default defineConfig({
  ...authConfig,
  testMatch: /members\.spec\.ts$/,
  outputDir: './node_modules/.cache/playwright/auth-members',
  reporter: process.env['CI']
    ? [
        ['list'],
        [
          'html',
          {
            outputFolder: './node_modules/.cache/playwright/reports/auth-members',
            open: 'never',
          },
        ],
      ]
    : [['list']],
  projects: [{ name: 'auth-members', use: { ...devices['Desktop Chrome'] } }],
});
