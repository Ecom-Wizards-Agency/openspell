import {
  ContextualNegativeReviewConflictError,
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
      proposals?: unknown;
      decision?: unknown;
      note?: unknown;
    };
    if (typeof body.profileId !== 'string') throw new Error('profileId is required');
    if (typeof body.marketplaceId !== 'string' || body.marketplaceId.trim().length === 0) {
      throw new Error('marketplaceId is required');
    }
    if (!Array.isArray(body.proposals) || body.proposals.length === 0 ||
      body.proposals.some((proposal) => {
        if (typeof proposal !== 'object' || proposal === null) return true;
        const row = proposal as Record<string, unknown>;
        return typeof row['id'] !== 'string' ||
          typeof row['expectedFingerprint'] !== 'string';
      })) {
      throw new Error('proposals must be a non-empty array of ids and review fingerprints');
    }
    if (typeof body.decision !== 'string' || !DECISIONS.includes(body.decision)) {
      throw new Error(`decision must be one of: ${DECISIONS.join(', ')}`);
    }
    const result = await decideContextualNegativeProposals(database, {
      orgId: actor.orgId,
      profileId: body.profileId,
      marketplaceId: body.marketplaceId,
      proposals: body.proposals as { id: string; expectedFingerprint: string }[],
      decision: body.decision as ContextualNegativeDecision,
      actorId: actor.userId,
      note: typeof body.note === 'string' ? body.note : null,
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof ContextualNegativeReviewConflictError) {
      return Response.json({
        error: error.message,
        staleProposalIds: error.proposalIds,
        reloadRequired: true,
      }, { status: 409 });
    }
    return errorResponse(error);
  } finally {
    await database.close();
  }
}
