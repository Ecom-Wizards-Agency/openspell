import { exportAcceptedContextualNegatives } from '@wizard-ads/db';
import {
  errorResponse,
  openWebDatabase,
  requestActor,
} from '../../../../../src/server/request-context';
import { requireCapability } from '../../../../../src/server/org-role';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    await requireCapability(database, actor, 'exportBatches');
    const body = (await request.json()) as {
      profileId?: unknown;
      marketplaceId?: unknown;
      ids?: unknown;
      note?: unknown;
      confirmed?: unknown;
    };
    if (body.confirmed !== true) {
      throw new Error('Confirm “Yes, export negatives” before exporting.');
    }
    if (typeof body.profileId !== 'string') throw new Error('profileId is required');
    if (typeof body.marketplaceId !== 'string' || body.marketplaceId.trim().length === 0) {
      throw new Error('marketplaceId is required');
    }
    if (typeof body.note !== 'string' || body.note.trim().length === 0) {
      throw new Error('note is required');
    }
    if (body.ids !== null && body.ids !== undefined &&
      (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string'))) {
      throw new Error('ids must be an array of proposal ids');
    }
    const ids = Array.isArray(body.ids) ? body.ids as string[] : null;
    const result = await exportAcceptedContextualNegatives(database, {
      orgId: actor.orgId,
      profileId: body.profileId,
      marketplaceId: body.marketplaceId,
      proposalIds: ids,
      actorId: actor.userId,
      note: body.note,
    });
    const downloadBase = ['/api', 'query-intelligence', 'negatives', 'export', result.exportId].join('/');
    return Response.json(
      {
        ...result,
        downloads: {
          csv: `${downloadBase}?format=csv`,
          json: `${downloadBase}?format=json`,
        },
        amazonUpdated: false,
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  } finally {
    await database.close();
  }
}
