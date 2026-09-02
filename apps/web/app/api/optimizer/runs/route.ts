import {
  PostgresRecommendationRunStore,
  RecommendationPreviewError,
} from '@wizard-ads/worker';
import { createDb } from '@wizard-ads/db';
import {
  errorResponse,
  requestActor,
} from '../../../../src/server/request-context';
import { requireCapability } from '../../../../src/server/org-role';
import {
  OptimizerPreviewHttpError,
  readOptimizerPreviewRequest,
} from '../../../../src/optimizer/preview-http';
import {
  OPTIMIZER_PREVIEW_UNAVAILABLE_MESSAGE,
  resolveOptimizerPreviewReadiness,
} from '../../../../src/optimizer/readiness';

export const runtime = 'nodejs';

/** Queue one read-only, immutable campaign-scoped recommendation preview batch. */
export async function POST(request: Request): Promise<Response> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) return Response.json({ error: 'Database is not configured' }, { status: 503 });
  const database = createDb({ connectionString, max: 1, statementTimeoutSeconds: 15 });
  try {
    const actor = await requestActor(request.headers);
    await requireCapability(database, actor, 'editTargets');
    const body = await readOptimizerPreviewRequest(request);
    const readiness = await resolveOptimizerPreviewReadiness(database);
    if (!readiness.ready) {
      return Response.json(
        { error: OPTIMIZER_PREVIEW_UNAVAILABLE_MESSAGE },
        { status: 503 },
      );
    }
    const accepted = await new PostgresRecommendationRunStore(database)
      .enqueueRecommendationPreviewBatch({
        orgId: actor.orgId,
        profileId: body.profileId,
        actorId: actor.userId,
        clientRequestId: body.clientRequestId,
        scope: body.scope,
      });
    return Response.json(accepted, { status: 202 });
  } catch (error) {
    return previewErrorResponse(error);
  } finally {
    await database.close();
  }
}

function previewErrorResponse(error: unknown): Response {
  if (error instanceof OptimizerPreviewHttpError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof RecommendationPreviewError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.httpStatus },
    );
  }
  return errorResponse(error);
}
