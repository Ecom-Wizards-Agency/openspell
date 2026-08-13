/**
 * @wizard-ads/strategy (owned by WP-05).
 *
 * Tenant config resolution: neutral defaults, then the goal lens, then the
 * tenant document, then the profile override, with a provenance record saying
 * which layer supplied each value.
 *
 * NO DOCTRINE VALUES LIVE HERE. This package ships structure and merge order;
 * the numbers are per-tenant database data, seeded by an operator-run script
 * from a gitignored local file. The tracked template that shows the document's
 * shape with every value replaced by a placeholder is `_local/strategy.TEMPLATE.json`
 * at the repository root, and `strategy.template.test.ts` fails if a real
 * number ever appears in it.
 */
export const PACKAGE_NAME = '@wizard-ads/strategy' as const;

export * from './defaults.js';
export * from './merge.js';
export * from './resolve.js';
export * from './loader.js';
