import { requestActor, errorResponse, openWebDatabase, requireOrgMembership } from '../../../../src/server/request-context';
import { deleteTag, updateTag } from '@wizard-ads/db';
import type { DeleteTagMode } from '@wizard-ads/db';

export const runtime = 'nodejs';
type RouteContext = { params: Promise<{ tagId: string }> };

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    await requireOrgMembership(database, actor);
    const { tagId } = await context.params;
    const body = (await request.json()) as {
      name?: unknown;
      parentId?: unknown;
      color?: unknown;
    };
    const tag = await updateTag(database, {
      orgId: actor.orgId,
      tagId,
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(body.parentId === null || typeof body.parentId === 'string'
        ? { parentId: body.parentId }
        : {}),
      ...(body.color === null || typeof body.color === 'string' ? { color: body.color } : {}),
    });
    return Response.json({ tag });
  } catch (error) {
    return errorResponse(error);
  } finally {
    await database.close();
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    await requireOrgMembership(database, actor);
    const { tagId } = await context.params;
    const body = (await request.json()) as { mode?: unknown; targetTagId?: unknown };
    let disposition: DeleteTagMode;
    if (body.mode === 'detach') disposition = { mode: 'detach' };
    else if (body.mode === 'reassign' && typeof body.targetTagId === 'string') {
      disposition = { mode: 'reassign', targetTagId: body.targetTagId };
    } else {
      throw new Error('Delete requires detach or a reassignment target');
    }
    return Response.json({ result: await deleteTag(database, { orgId: actor.orgId, tagId, disposition }) });
  } catch (error) {
    return errorResponse(error);
  } finally {
    await database.close();
  }
}
