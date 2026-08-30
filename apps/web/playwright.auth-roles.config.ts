/**
 * The settings and role matrix in a fresh authenticated Next dev process.
 *
 * It deliberately inherits every safety property of the primary auth config:
 * the same production-refusing cookie seam, one worker, no retries, and the
 * same isolated database lifecycle. Only test selection and artifacts differ.
 */
import { defineConfig, devices } from '@playwright/test';
import authConfig from './playwright.auth.config';

export default defineConfig({
  ...authConfig,
  testMatch: /roles\.spec\.ts$/,
  outputDir: './node_modules/.cache/playwright/auth-roles',
  reporter: process.env['CI']
    ? [
        ['list'],
        [
          'html',
          {
            outputFolder: './node_modules/.cache/playwright/reports/auth-roles',
            open: 'never',
          },
        ],
      ]
    : [['list']],
  projects: [{ name: 'auth-roles', use: { ...devices['Desktop Chrome'] } }],
});
