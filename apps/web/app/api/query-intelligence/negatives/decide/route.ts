import {
  decideContextualNegativeProposals,
  type ContextualNegativeDecision,
} from '@wizard-ads/db';
import {
  errorResponse,
  openWebDatabase,
  requestActor,
} from '../../../../../src/server/request-context';
import { requireCapability } from '../../../../../src/server/org-role';

export const runtime = 'nodejs';

const DECISIONS: readonly string[] = ['accepted', 'dismissed', 'proposed'];

export async function POST(request: Request): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    await requireCapability(database, actor, 'editTargets');
    const body = (await request.json()) as {
      profileId?: unknown;
      marketplaceId?: unknown;
      ids?: unknown;
      decision?: unknown;
      note?: unknown;
    };
    if (typeof body.profileId !== 'string') throw new Error('profileId is required');
    if (typeof body.marketplaceId !== 'string' || body.marketplaceId.trim().length === 0) {
      throw new Error('marketplaceId is required');
    }
    if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string')) {
      throw new Error('ids must be an array of proposal ids');
    }
    if (typeof body.decision !== 'string' || !DECISIONS.includes(body.decision)) {
      throw new Error(`decision must be one of: ${DECISIONS.join(', ')}`);
    }
    const result = await decideContextualNegativeProposals(database, {
      orgId: actor.orgId,
      profileId: body.profileId,
      marketplaceId: body.marketplaceId,
      proposalIds: body.ids as string[],
      decision: body.decision as ContextualNegativeDecision,
      actorId: actor.userId,
      note: typeof body.note === 'string' ? body.note : null,
    });
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  } finally {
    await database.close();
  }
}
