import { actorFromHeaders, errorResponse, openWebDatabase, requireOrgMembership } from '../../../src/server/wp08-context';
import { createTag, listTagTree } from '../../../src/server/wp08-service';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = actorFromHeaders(request.headers);
    await requireOrgMembership(database, actor);
    return Response.json({ tags: await listTagTree(database, actor.orgId) });
  } catch (error) {
    return errorResponse(error);
  } finally {
    await database.close();
  }
}

export async function POST(request: Request): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = actorFromHeaders(request.headers);
    await requireOrgMembership(database, actor);
    const body = (await request.json()) as {
      name?: unknown;
      parentId?: unknown;
      color?: unknown;
    };
    if (typeof body.name !== 'string') throw new Error('name is required');
    const parentId = body.parentId === null || typeof body.parentId === 'string' ? body.parentId : null;
    const color = body.color === null || typeof body.color === 'string' ? body.color : null;
    const tag = await createTag(database, {
      orgId: actor.orgId,
      createdBy: actor.userId,
      name: body.name,
      parentId,
      color,
    });
    return Response.json({ tag }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  } finally {
    await database.close();
  }
}
