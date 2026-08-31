import { exportAcceptedContextualNegatives, type RequestDatabase } from '@wizard-ads/db';
import {
  errorResponse,
  openWebDatabase,
  requestActor,
} from '../../../../../src/server/request-context';
import { requireCapability } from '../../../../../src/server/org-role';
import { parseExportRequest, readBoundedReviewJson } from '../../../../../src/query-intelligence/review-http';
import { contextualNegativeReviewErrorResponse } from '../../../../../src/query-intelligence/review-errors';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  let database: RequestDatabase | null = null;
  try {
    database = openWebDatabase();
    const actor = await requestActor(request.headers);
    await requireCapability(database, actor, 'exportBatches');
    const body = parseExportRequest(await readBoundedReviewJson(request));
    const result = await exportAcceptedContextualNegatives(database, {
      orgId: actor.orgId,
      profileId: body.profileId,
      marketplaceId: body.marketplaceId,
      proposals: body.proposals,
      actorId: actor.userId,
      note: body.note,
    });
    const base = `/api/query-intelligence/negatives/export/${result.exportId}`;
    return Response.json({
      ...result,
      exported: result.stamped,
      downloads: {
        csv: `${base}?format=csv`,
        json: `${base}?format=json`,
      },
      amazonUpdated: false,
    }, { status: 201 });
  } catch (error) {
    return contextualNegativeReviewErrorResponse(error) ?? errorResponse(error);
  } finally {
    await database?.close();
  }
}
