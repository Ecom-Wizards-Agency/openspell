/**
 * Vitest owns `src/**` and `app/**`; Playwright owns `e2e/**`.
 *
 * Without the exclusion Vitest collects the `.spec.ts` files, imports
 * `@playwright/test`, and fails with an error about a test runner rather than
 * about anything under test.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'app/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
  },
});
