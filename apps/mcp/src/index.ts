/**
 * `@wizard-ads/mcp` (owned by WP-09).
 *
 * OpenSpell's own MCP server: authenticated analytical reads over Streamable HTTP,
 * per-org API keys that are hashed, scoped, expirable and revocable, and every
 * call written to `audit_log` with its parameters.
 *
 * It is modeled on the AdLabs MCP surface, which is both the model and the bar.
 * Four of their documented traps are closed here by construction rather than by
 * instruction: `profile_id` is a predicate on the fact scan and not a hint;
 * ratios are recomputed from summed bases at every aggregation level; archived
 * entities keep their spend; and a key is read-only because it cannot be issued
 * any other way.
 */
export const PACKAGE_NAME = '@wizard-ads/mcp' as const;

export * from './config.js';
export * from './errors.js';
export * from './keys.js';
export * from './audit.js';
export * from './metrics.js';
export * from './catalog.js';
export * from './sql.js';
export * from './csv.js';
export * from './data.js';
export * from './analysis.js';
export * from './instructions.js';
export * from './server.js';
export * from './http.js';
