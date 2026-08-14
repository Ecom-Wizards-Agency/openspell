/**
 * `@wizard-ads/crosscheck-cli/pure` — everything with no I/O in it.
 *
 * The web tier imports this entry point, not the package root: the panel needs
 * the view model and the verdict vocabulary, and has no business pulling a
 * database driver or `node:fs` into a page bundle.
 */
export * from './csv.js';
export * from './contract.js';
export * from './compare.js';
export * from './panel.js';
export * from './exit-report.js';
export type { StoredResult } from './results.js';
