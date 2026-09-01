/**
 * Explicit, inert Sponsored Products write-persistence boundary.
 *
 * This module is intentionally absent from the package root and worker barrels.
 * Importing it supplies database capabilities only; it registers no job, worker,
 * provider, route, schedule, or deployment behavior.
 */
export * from './queries/sp-write-persistence.js';
