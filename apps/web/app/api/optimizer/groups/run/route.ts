import { PostgresRecommendationRunStore } from '@wizard-ads/worker';
import { createDb } from '@wizard-ads/db';
import { requestActor, errorResponse } from '../../../../../src/server/request-context';
import { requireCapability } from '../../../../../src/server/org-role';
import {
  OPTIMIZER_PREVIEW_UNAVAILABLE_MESSAGE,
  resolveOptimizerPreviewReadiness,
} from '../../../../../src/optimizer/readiness';

export const runtime = 'nodejs';

/** Queue an OpenSpell preview for one group. No Amazon write occurs. */
export async function POST(request: Request): Promise<Response> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) return Response.json({ error: 'Database is not configured' }, { status: 503 });
  const database = createDb({ connectionString, max: 1, statementTimeoutSeconds: 15 });
  try {
    const actor = await requestActor(request.headers);
    await requireCapability(database, actor, 'editTargets');
    const body = await request.json() as { profileId?: unknown; groupId?: unknown };
    if (typeof body.profileId !== 'string' || body.profileId.length === 0) {
      throw new Error('profileId is required');
    }
    if (typeof body.groupId !== 'string' || body.groupId.length === 0) {
      throw new Error('groupId is required');
    }
    const readiness = await resolveOptimizerPreviewReadiness(database);
    if (!readiness.ready) {
      return Response.json(
        { error: OPTIMIZER_PREVIEW_UNAVAILABLE_MESSAGE },
        { status: 503 },
      );
    }
    const queued = await new PostgresRecommendationRunStore(database).enqueueRecommendationRun({
      orgId: actor.orgId,
      profileId: body.profileId,
      groupId: body.groupId,
      source: 'web',
    });
    return Response.json(queued, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  } finally {
    await database.close();
  }
}
