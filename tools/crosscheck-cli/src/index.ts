/**
 * `@wizard-ads/crosscheck-cli` (owned by WP-10).
 *
 * The trust machine. Every write feature in this product is gated on it, so it
 * is a package rather than a script: the `crosscheck.ingest` job handler, the
 * comparison, the verdict store, the panel's view model and the v1 exit-report
 * generator are one body of code with one set of tests, imported by the worker
 * (WP-03) and the web app (WP-06) rather than reimplemented in either.
 *
 * Three boundaries hold it together:
 *
 *  - The **verdict model** is not here. It is `crossCheck` in
 *    `@wizard-ads/core`, the port of `crosscheck.py`, with the parity goldens
 *    behind it. This package decides what to compare; that one decides what
 *    agreement means.
 *  - The **exports are evidence**. Files are parsed, counted, filtered to the
 *    profile in the job, and archived rather than deleted, because a disputed
 *    verdict is settled by re-reading the file that produced it.
 *  - The **provisional day is excluded and shown**. Sales restate for 14+ days
 *    and the incumbent's totals read 0 for the in-progress day; a comparison
 *    that judges it produces a daily false alarm and the verdict stops meaning
 *    anything.
 */
export const PACKAGE_NAME = '@wizard-ads/crosscheck-cli' as const;

export * from './pure.js';
export * from './facts.js';
export * from './inbox.js';
export * from './job.js';
export * from './load.js';
export * from './results.js';
