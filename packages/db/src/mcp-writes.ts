/** Operator key management and, later, bounded MCP admission. Never calls Amazon. */
export { issueMcpWriteDelegation, listMcpWriteDelegations, revokeMcpKeyAsOperator } from './queries/mcp-writes.js';

export { previewMcpBidChanges, applyMcpBidChanges, readMcpWriteStatus } from './queries/mcp-write-application.js';
