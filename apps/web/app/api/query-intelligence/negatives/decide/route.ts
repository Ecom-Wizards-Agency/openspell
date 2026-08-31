import { decideContextualNegativeProposals, type RequestDatabase } from '@wizard-ads/db';
import {
  errorResponse,
  openWebDatabase,
  requestActor,
} from '../../../../../src/server/request-context';
import { requireCapability } from '../../../../../src/server/org-role';
import { parseDecisionRequest, readBoundedReviewJson } from '../../../../../src/query-intelligence/review-http';
import { contextualNegativeReviewErrorResponse } from '../../../../../src/query-intelligence/review-errors';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  let database: RequestDatabase | null = null;
  try {
    database = openWebDatabase();
    const actor = await requestActor(request.headers);
    await requireCapability(database, actor, 'editTargets');
    const body = parseDecisionRequest(await readBoundedReviewJson(request));
    const result = await decideContextualNegativeProposals(database, {
      orgId: actor.orgId,
      profileId: body.profileId,
      marketplaceId: body.marketplaceId,
      proposals: body.proposals,
      decision: body.decision,
      actorId: actor.userId,
      note: body.note,
    });
    return Response.json(result);
  } catch (error) {
    return contextualNegativeReviewErrorResponse(error) ?? errorResponse(error);
  } finally {
    await database?.close();
  }
}
