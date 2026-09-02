/**
 * The Drizzle mirror of `supabase/migrations`.
 *
 * Direction of truth, stated once so nobody has to guess: the SQL migrations
 * are the schema. This package mirrors them so queries are typed. Nothing here
 * generates DDL, `drizzle-kit` is deliberately not a dependency, and
 * `schema.test.ts` asserts the mirror against a freshly migrated database so
 * the two cannot drift quietly.
 */
export * from './columns.js';
export * from './enums.js';
export * from './tenancy.js';
export * from './entities.js';
export * from './facts.js';
export * from './bid-series.js';
export * from './economics.js';
export * from './sync.js';
export * from './analysis.js';
export * from './apply.js';
export * from './experiments.js';
export * from './integrations.js';
export * from './surface.js';
export * from './seams.js';
export * from './operator-intelligence.js';
export * from './sp-writes.js';
export * from './sp-write-outbox.js';
