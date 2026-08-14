/**
 * Vitest owns the unit and route tests under `src/**` and `app/**`; Playwright
 * owns `e2e/**`.
 *
 * Without the exclusion Vitest's default `**\/*.spec.ts` glob would collect the
 * browser specs, import `@playwright/test`, and fail with an error about a test
 * runner rather than about anything under test. The explicit `include` says the
 * same thing from the other side, so an `e2e/**` helper never gets picked up by
 * accident either.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `tsconfig.json` sets `jsx: preserve`, which is what Next wants and what
  // Vite refuses: it honours that setting and hands `.tsx` to the import
  // analyser as invalid JS. Telling the transformer to compile JSX instead is
  // the whole fix, and it is scoped to the test run — the build still goes
  // through Next.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: ['src/**/*.test.ts', 'app/**/*.test.ts'],
    exclude: ['e2e/**', '**/node_modules/**', '**/.next/**'],
  },
});
