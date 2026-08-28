/**
 * Issue an MCP API key.
 *
 * The same gate as connecting Amazon (`manageConnection` — owner/admin only): a
 * key that can read selected advertising profiles is exactly as sensitive as
 * the Amazon grant, and should sit behind the same role. The plaintext token is
 * in the response once and never again, which the UI states plainly next to it.
 */
import { issueMcpKey } from '../../../src/data/mcp-keys';
import {
  DEFAULT_MCP_KEY_EXPIRY_DAYS,
  isMcpKeyExpiryDays,
} from '../../../src/mcp-key-policy';
import { errorResponse, openWebDatabase, requestActor } from '../../../src/server/request-context';
import { requireCapability } from '../../../src/server/org-role';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    await requireCapability(database, actor, 'manageConnection');

    const body = (await request.json()) as {
      label?: unknown;
      profileIds?: unknown;
      expiresInDays?: unknown;
    };
    if (typeof body.label !== 'string' || body.label.trim().length === 0) {
      throw new Error('A key needs a label so you can tell your keys apart.');
    }
    if (
      !Array.isArray(body.profileIds) ||
      body.profileIds.length === 0 ||
      !body.profileIds.every((profileId) => typeof profileId === 'string')
    ) {
      throw new Error('Select at least one profile for this key.');
    }
    const expiresInDays = body.expiresInDays ?? DEFAULT_MCP_KEY_EXPIRY_DAYS;
    if (!isMcpKeyExpiryDays(expiresInDays)) {
      throw new Error('Choose one of the available expiry periods.');
    }

    const issued = await issueMcpKey(database, {
      orgId: actor.orgId,
      label: body.label,
      profileIds: body.profileIds,
      expiresInDays,
      createdBy: actor.userId,
    });
    return Response.json({ key: issued.record, token: issued.token }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  } finally {
    await database.close();
  }
}
