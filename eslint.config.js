// Flat ESLint config for the whole workspace.
//
// Beyond ordinary TypeScript hygiene this file is where the dependency direction
// from AGENTS.md is mechanically enforced:
//
//   shared  <-  core / strategy / ads-api / db  <-  web / worker / mcp
//
// `core` never imports `db` or `ads-api`; `apps/web` never imports `ads-api`
// (every Amazon call lives in the worker); `shared` imports nothing of ours.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Build a no-restricted-imports rule entry for a set of forbidden workspace packages. */
const forbid = (pairs) => [
  'error',
  {
    paths: pairs.map(([name, message]) => ({ name, message })),
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      'fixtures/golden/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['packages/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': forbid([
        ['@wizard-ads/db', 'shared is the contract package: it depends on nothing of ours.'],
        ['@wizard-ads/core', 'shared is the contract package: it depends on nothing of ours.'],
        ['@wizard-ads/strategy', 'shared is the contract package: it depends on nothing of ours.'],
        ['@wizard-ads/ads-api', 'shared is the contract package: it depends on nothing of ours.'],
        ['@wizard-ads/ui', 'shared is the contract package: it depends on nothing of ours.'],
      ]),
    },
  },
  {
    files: ['packages/core/**/*.ts', 'packages/strategy/**/*.ts'],
    rules: {
      'no-restricted-imports': forbid([
        ['@wizard-ads/db', 'core and strategy are pure: zero I/O, no database.'],
        ['@wizard-ads/ads-api', 'core and strategy are pure: zero I/O, no Amazon calls.'],
      ]),
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': forbid([
        ['@wizard-ads/ads-api', 'every Amazon API call lives in apps/worker, never in the web app.'],
      ]),
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
