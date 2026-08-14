import { actorFromHeaders, openWebDatabase, requireOrgMembership } from '../../../src/server/request-context';
import { gotoRedirectLocation, resolveGotoLink } from '@wizard-ads/db';

export const runtime = 'nodejs';
type RouteContext = { params: Promise<{ token: string }> };

const notFound = () => new Response('Not found', { status: 404 });

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = actorFromHeaders(request.headers);
    await requireOrgMembership(database, actor);
    const signingSecret = process.env['GOTO_LINK_SIGNING_SECRET'];
    if (!signingSecret) return notFound();
    const { token } = await context.params;
    const link = await resolveGotoLink(database, {
      orgId: actor.orgId,
      token,
      signingSecret,
    });
    if (!link) return notFound();
    const location = new URL(gotoRedirectLocation(link.route, link.state), request.url);
    return Response.redirect(location, 307);
  } catch {
    // Authentication, membership, malformed tokens, and absent links are
    // deliberately indistinguishable so this route cannot enumerate tenants.
    return notFound();
  } finally {
    await database.close();
  }
}
