/**
 * `@wizard-ads/analyst` (owned by WP-13).
 *
 * A scheduled, headless daily analyst. It connects to the wizard-ads MCP server
 * with a read-only key, reads each sync-enabled profile's data through the read
 * tools and the per-profile context resource, analyzes it against the profile's
 * target ACOS, goal lens and doctrine flags, writes a structured insight, and
 * returns a per-profile Markdown digest for the operator to hand downstream to
 * the guarded Wizards AI Slack helper. It posts nothing itself.
 *
 * The acceptance guarantee is structural: reads only ever travel through the MCP
 * client in `mcp-client.ts`, which exposes no write tool, so the MCP audit log
 * records zero write calls by the analyst's key. The single insight write goes
 * over a separate database handle that never carries a read.
 */
export const PACKAGE_NAME = '@wizard-ads/analyst' as const;

export * from './config.js';
export * from './mcp-client.js';
export * from './analyze.js';
export * from './digest.js';
export * from './insights-writer.js';
export * from './analyst.js';
