/**
 * @wizard-ads/campaigns (owned by WP-14).
 *
 * Generate complete Sponsored Products campaign structures from keyword
 * research or a brief: a typed plan, a bulk-upload workbook, and the QA gates
 * that refuse to hand over a file Amazon would reject.
 *
 * Three properties hold everywhere in here, and each is load-bearing:
 *
 * 1. **Pure.** No clock, no filesystem, no network. `today` is an argument.
 *    That is what lets the parity suite replay the Python reference's goldens
 *    against this port at all.
 * 2. **Paused by default.** A generated campaign's state comes from the config
 *    and the config's own default is `paused`. A file uploaded by accident
 *    spends nothing. Creating campaigns through the API is WP-14b, not here.
 * 3. **No doctrine.** Budgets, bids, bands and caps arrive in a `TenantStrategy`
 *    at runtime. This repository is public; the numbers are not in it.
 */
export const PACKAGE_NAME = '@wizard-ads/campaigns' as const;

export * from './constants.js';
export * from './types.js';
export * from './naming.js';
export * from './resolve.js';
export * from './generate.js';
export * from './plan.js';
export * from './preflight.js';
export * from './validate.js';
export * from './keywords.js';
export * from './strategy.js';
export * from './export.js';
export * from './update.js';
export * from './util.js';
export { columnIndex, columnName, readWorkbook, writeWorkbook } from './xlsx/index.js';
