/**
 * Revoke an MCP API key.
 *
 * Revocation is immediate — the MCP server rejects a revoked key on its next
 * request — and idempotent, so a double-click keeps the first timestamp. Scoped
 * to the actor's org, so a key id pasted from another tenant returns 404 rather
 * than touching a key that is not theirs.
 */
import { revokeMcpKey } from '../../../../../src/data/mcp-keys';
import { handleMcpKeyMutation } from '../../../../../src/server/mcp-key-mutations';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ keyId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return handleMcpKeyMutation(request, async (database, actor) => {
    const { keyId } = await context.params;

    const revoked = await revokeMcpKey(database, actor, keyId);
    if (!revoked) return Response.json({ error: 'Key not found' }, { status: 404 });
    return Response.json({ revoked: true });
  });
}
