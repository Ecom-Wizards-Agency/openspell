import { RecommendationRevisionSelection } from '@wizard-ads/shared/recommendation-revisions';
/**
 * Accept, dismiss or re-open proposals — one, or a filtered set in bulk.
 *
 * Bulk is the point. The recon calls bulk edit over a filtered preview "the
 * single most valuable interaction in the product" (`04-optimizer.md` §3), so
 * the client sends the ids its current filter resolved to and this route takes
 * them as one decision with one note. The note is mandatory on a dismissal and
 * recorded either way; `decideRecommendations` refuses an empty one.
 */
import { decideRecommendations } from '@wizard-ads/db';
import type { RecommendationDecision } from '@wizard-ads/db';
import {
  errorResponse,
  openWebDatabase,
  requestActor,
} from '../../../../src/server/request-context';
import { requireCapability } from '../../../../src/server/org-role';

export const runtime = 'nodejs';

const DECISIONS: readonly string[] = ['accepted', 'dismissed', 'proposed'];

export async function POST(request: Request): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    // Deciding a proposal is exactly what `editTargets` means, and it is the
    // same role set the `recommendations` update policy grants.
    await requireCapability(database, actor, 'editTargets');

    const body = (await request.json()) as {
      ids?: unknown;
      decision?: unknown;
      note?: unknown;
      expectedRevisions?: unknown;
    };
    if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string')) {
      throw new Error('ids must be an array of proposal ids');
    }
    if (typeof body.decision !== 'string' || !DECISIONS.includes(body.decision)) {
      throw new Error(`decision must be one of: ${DECISIONS.join(', ')}`);
    }
    const note = typeof body.note === 'string' ? body.note : null;

    const result = await decideRecommendations(database, {
      orgId: actor.orgId,
      ids: body.ids as string[],
      decision: body.decision as RecommendationDecision,
      actorId: actor.userId,
      note,
      ...(body.expectedRevisions === undefined ? {} : { expectedRevisions: RecommendationRevisionSelection.parse(body.expectedRevisions) }),
    });
    // Offered against changed: a bulk decision that silently moved fewer rows
    // than it was given is the failure mode worth naming in the response.
    return Response.json({ ...result, offered: (body.ids as string[]).length });
  } catch (error) {
    return errorResponse(error);
  } finally {
    await database.close();
  }
}
