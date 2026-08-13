/**
 * @wizard-ads/worker (owned by WP-03).
 *
 * The sync worker (Fly.io). Claims jobs with FOR UPDATE SKIP LOCKED, runs the
 * three-pass report pipeline, holds the per-region token buckets. Every Amazon
 * API call in the system happens here.
 *
 * Scaffold stub: WP-03 replaces this file. WP-00 owns only the manifest,
 * the tsconfig and the dependency wiring.
 */
export const PACKAGE_NAME = '@wizard-ads/worker' as const;
