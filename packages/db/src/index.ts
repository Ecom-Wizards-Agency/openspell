/**
 * `@wizard-ads/db` (owned by WP-01).
 *
 * The database layer: a Drizzle mirror of `supabase/migrations`, typed query
 * helpers over it, and RLS test utilities (exported separately from
 * `@wizard-ads/db/testing`).
 *
 * Three things this package will not do, each one deliberate:
 *
 *  - It does not generate the schema. The SQL migrations are the source of
 *    truth; `drizzle-kit` is not a dependency and the mirror is asserted
 *    against a freshly migrated database instead of trusted.
 *  - It does not reimplement anything atomic. Claiming a job, enqueueing due
 *    schedules, moving a credential in or out of Vault and rolling up a
 *    partition are all SQL functions; the helpers here call them.
 *  - It does not report success it has not verified. Every loader counts rows
 *    written against rows offered and throws on a mismatch.
 */
export const PACKAGE_NAME = '@wizard-ads/db' as const;

export * from './client.js';
export * from './schema/index.js';
export * from './queries/entities.js';
export * from './queries/facts.js';
export * from './queries/feedback.js';
export * from './queries/goto.js';
export * from './queries/jobs.js';
export * from './queries/partitions.js';
export * from './queries/profiles.js';
export * from './queries/tags.js';
export * from './queries/tokens.js';
export * from './queries/request-client.js';
