import { actorFromHeaders, errorResponse, openWebDatabase, requireOrgMembership } from '../../../src/server/wp08-context';
import { createGotoLink } from '../../../src/server/wp08-service';
import type { JsonValue } from '../../../src/server/wp08-service';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = actorFromHeaders(request.headers);
    await requireOrgMembership(database, actor);
    const body = (await request.json()) as {
      route?: unknown;
      state?: unknown;
      label?: unknown;
      expiresAt?: unknown;
    };
    if (typeof body.route !== 'string') throw new Error('route is required');
    const expiresAt =
      typeof body.expiresAt === 'string' ? new Date(body.expiresAt) : body.expiresAt === null ? null : undefined;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new Error('expiresAt is invalid');
    const signingSecret = process.env['GOTO_LINK_SIGNING_SECRET'];
    if (!signingSecret) throw new Error('GOTO_LINK_SIGNING_SECRET is not configured');
    const link = await createGotoLink(database, {
      orgId: actor.orgId,
      route: body.route,
      state: (body.state ?? {}) as JsonValue,
      signingSecret,
      expiresAt,
      label: typeof body.label === 'string' ? body.label : null,
      createdBy: actor.userId,
    });
    return Response.json({
      token: link.token,
      path: `/go/${link.token}`,
      expiresAt: link.expiresAt,
    }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  } finally {
    await database.close();
  }
}
