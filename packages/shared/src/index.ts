/**
 * `@wizard-ads/shared` is THE contract package.
 *
 * Rules, from AGENTS.md:
 *  - Schemas and inferred types only. No logic, no I/O, no dependency but zod.
 *  - Every shape that crosses a package boundary lives here.
 *  - Contracts are frozen. Changing one is WP-00's call with manager sign-off,
 *    because six packages are built in parallel against them.
 */
export * from './primitives.js';
export * from './entities.js';
export * from './facts.js';
export * from './recommendations.js';
export * from './apply.js';
export * from './strategy.js';
export * from './jobs.js';
export * from './creative.js';
export * from './query-intelligence.js';
export * from './optimization.js';
export * from './reporting.js';
export * from './dayparting.js';
export * from './amazon-writes.js';
export * from './campaign-creation.js';
