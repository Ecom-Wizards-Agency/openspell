/**
 * Vitest owns the unit and route tests under `src/`; Playwright owns `e2e/`.
 * Without this exclude Vitest's default `**\/*.spec.ts` glob would collect the
 * browser specs and fail on the Playwright imports.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/.next/**', 'e2e/**'],
  },
});
