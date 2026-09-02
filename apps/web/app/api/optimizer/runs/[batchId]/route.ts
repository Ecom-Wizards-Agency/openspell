import {
  PostgresRecommendationRunStore,
  RecommendationPreviewError,
} from '@wizard-ads/worker';
import { createDb } from '@wizard-ads/db';
import {
  errorResponse,
  requestActor,
} from '../../../../../src/server/request-context';
import { requireOrgRole } from '../../../../../src/server/org-role';
import {
  OptimizerPreviewHttpError,
  optimizerPreviewUuid,
} from '../../../../../src/optimizer/preview-http';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ batchId: string }> };

/** Read the bounded aggregate status of one tenant-scoped preview batch. */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) return Response.json({ error: 'Database is not configured' }, { status: 503 });
  const database = createDb({ connectionString, max: 1, statementTimeoutSeconds: 15 });
  try {
    const actor = await requestActor(request.headers);
    await requireOrgRole(database, actor);
    const parameters = await context.params;
    const batchId = optimizerPreviewUuid(parameters.batchId, 'batchId');
    const profileId = optimizerPreviewUuid(
      new URL(request.url).searchParams.get('profileId'),
      'profileId',
    );
    const status = await new PostgresRecommendationRunStore(database)
      .getRecommendationPreviewBatchStatus({
        orgId: actor.orgId,
        profileId,
        batchId,
      });
    if (status === null) return Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json(status);
  } catch (error) {
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
  } finally {
    await database.close();
  }
}
