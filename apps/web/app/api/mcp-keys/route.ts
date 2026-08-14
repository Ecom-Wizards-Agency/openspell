/**
 * Issue an MCP API key.
 *
 * The same gate as connecting Amazon (`manageConnection` — owner/admin only): a
 * key that can read the whole org's advertising data is exactly as sensitive as
 * the Amazon grant, and should sit behind the same role. The plaintext token is
 * in the response once and never again, which the UI states plainly next to it.
 */
import { issueMcpKey } from '../../../src/data/mcp-keys';
import { errorResponse, openWebDatabase, requestActor } from '../../../src/server/request-context';
import { requireCapability } from '../../../src/server/org-role';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    await requireCapability(database, actor, 'manageConnection');

    const body = (await request.json()) as { label?: unknown };
    if (typeof body.label !== 'string' || body.label.trim().length === 0) {
      throw new Error('A key needs a label so you can tell your keys apart.');
    }

    const issued = await issueMcpKey(database, {
      orgId: actor.orgId,
      label: body.label,
      createdBy: actor.userId,
    });
    return Response.json({ key: issued.record, token: issued.token }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  } finally {
    await database.close();
  }
}
