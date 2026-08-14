/**
 * `@wizard-ads/adlabs-backfill` — the AdLabs history backfill, Phases 0 and 1.
 *
 * What this package does NOT do: talk to AdLabs. The exports are pulled by an
 * operator-side agent through the AdLabs MCP (`get_entity_data` → `query` →
 * `download_data`, strictly read-only) and land in `_local/backfill/`. This
 * package is everything after that: the naming contract that keeps those files
 * away from the crosscheck's inbox, the normalisers, the loaders, and the
 * counting that makes a load auditable.
 *
 * Phase 2 — the daily walk — is not here and is gated on an operator decision.
 * See the README.
 */
export * from './pure.js';
export * from './manifest.js';
export * from './load.js';
