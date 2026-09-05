import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DbHandle } from '@wizard-ads/db';
import { previewMcpBidChanges, applyMcpBidChanges, readMcpWriteStatus } from '@wizard-ads/db/mcp-writes';
import { SpWriteApplicationError } from '@wizard-ads/db/sp-write-application';
import { Uuid } from '@wizard-ads/shared';
import {
  McpBidPreviewRequest, McpBidApplyRequest, McpWriteStatusRequest, McpWriteCredential,
} from '@wizard-ads/shared/mcp-writes';
import { writeAuditEntry } from './audit.js';

const WRITE_TOOLS = ['preview_bid_changes', 'apply_bid_changes', 'get_write_status'] as const;
type WriteTool = typeof WRITE_TOOLS[number];

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function uuid(value: unknown): string | null {
  const parsed = Uuid.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Before SDK validation: record only known identifiers, never arbitrary input or token text. */
export async function recordMcpWriteToolAttempt(
  handle: DbHandle, orgId: string, keyId: string, body: unknown,
): Promise<void> {
  const request = object(body);
  const params = object(request?.['params']);
  if (request?.['method'] !== 'tools/call'
    || !WRITE_TOOLS.some((tool) => tool === params?.['name'])) return;
  const args = object(params?.['arguments']);
  const lookup = object(args?.['lookup']);
  const source = object(args?.['source']);
  const profileId = uuid(args?.['profileId']);
  const requestId = uuid(args?.['requestId']) ?? uuid(lookup?.['requestId']);
  await writeAuditEntry(handle, {
    orgId, keyId, tool: `${String(params?.['name'])}.attempt`, outcome: 'attempted',
    params: { requestId, profileId }, profileId, durationMs: 0,
    summary: { sourceKind: ['apply_batch', 'keyword_proposals', 'inverse'].includes(String(source?.['kind']))
      ? source?.['kind'] : null },
  });
}

/** Every mutation outcome is durable in SQL; response/error formatting cannot undo admission. */
export function registerMcpWriteTools(
  server: McpServer, handle: DbHandle, rawCredential: McpWriteCredential,
): void {
  const credential = McpWriteCredential.parse(rawCredential);

  async function run(tool: WriteTool, args: unknown, call: () => Promise<unknown>) {
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(await call()) }] };
    } catch (error) {
      const code = error instanceof SpWriteApplicationError ? error.code : 'outcome_unknown';
      const input = object(args);
      const requestId = uuid(input?.['requestId']) ?? uuid(object(input?.['lookup'])?.['requestId']);
      const profileId = uuid(input?.['profileId']);
      // The preceding HTTP attempt audit already exists. A diagnostic failure
      // cannot rewrite an admitted outcome or justify a new client request ID.
      try {
        await writeAuditEntry(handle, { orgId: credential.orgId, keyId: credential.keyId,
          tool: `${tool}.error`, params: { requestId, profileId }, outcome: 'error',
          summary: { code }, profileId, durationMs: 0 });
      } catch { /* Return the original uncertainty; SQL remains the mutation evidence. */ }
      const message = code === 'outcome_unknown'
        ? tool === 'apply_bid_changes'
          ? 'The outcome is unknown. Check get_write_status with this requestId or retry the exact same apply request.'
          : tool === 'preview_bid_changes'
            ? 'The preview outcome is unknown. Retry the exact same preview request and requestId.'
            : 'The status could not be read. Retry the same lookup; this does not establish whether a write was admitted.'
        : code === 'authorization_refused'
          ? 'Current key authority, profile permissions or write limits do not allow this request.'
          : code === 'identity_conflict'
            ? 'This request identity or plan is already bound to another operation. Recover the original request before proceeding.'
            : code === 'source_changed'
              ? 'The saved source or current values changed. Prepare and review a new preview.'
              : 'The write request is invalid, unavailable or unsupported.';
      return { isError: true, content: [{ type: 'text' as const,
        text: JSON.stringify({ error: code, message, requestId, profileId }) }] };
    }
  }

  server.registerTool('preview_bid_changes', {
    title: 'Preview keyword bid changes',
    description: 'Save an immutable Sponsored Products keyword bid preview from direct proposals, an existing apply batch, '
      + 'or an inverse of a fully observed operation. Review exact old/new values and limits before applying. '
      + 'This creates a draft and sends no change to Amazon. Keep requestId for exact retries.',
    inputSchema: McpBidPreviewRequest,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, (args) => run('preview_bid_changes', args, () => previewMcpBidChanges(handle, credential, args)));

  server.registerTool('apply_bid_changes', {
    title: 'Apply a reviewed keyword bid preview to Amazon',
    description: 'Admit the exact saved plan and fingerprint within the separately operator-issued key delegation. '
      + 'This queues real Amazon changes and permanently charges the daily row allowance. Queued is not applied. '
      + 'Retain requestId before sending; retry the same payload/ID or recover with get_write_status after uncertainty. '
      + 'An inverse requires its own preview, apply request and available allowance.',
    inputSchema: McpBidApplyRequest,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, (args) => run('apply_bid_changes', args, () => applyMcpBidChanges(handle, credential, args)));

  server.registerTool('get_write_status', {
    title: 'Read an MCP write outcome',
    description: 'Read this key’s admitted operation by its operation identity or original apply requestId. '
      + 'Reports attempted, accepted, observed and refused counts with original/inverse links. '
      + 'An unresolved request is not proof that no write was admitted. Changes and inverses also appear in Time Machine.',
    inputSchema: McpWriteStatusRequest,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, (args) => run('get_write_status', args, () => readMcpWriteStatus(handle, credential, args)));
}
