/**
 * Test utilities: a migrated throwaway database, and the role switching that
 * makes an RLS assertion mean something.
 *
 * Exported from `@wizard-ads/db/testing` so another package can assert its own
 * policies against the real schema without depending on the test files here.
 */
export * from './errors.js';
export * from './harness.js';
export * from './rls.js';
