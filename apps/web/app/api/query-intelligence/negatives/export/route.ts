import {
  ContextualNegativeReviewConflictError,
  exportAcceptedContextualNegatives,
} from '@wizard-ads/db';
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
      proposals?: unknown;
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
    if (!Array.isArray(body.proposals) || body.proposals.length === 0 ||
      body.proposals.some((proposal) => {
        if (typeof proposal !== 'object' || proposal === null) return true;
        const row = proposal as Record<string, unknown>;
        return typeof row['id'] !== 'string' ||
          typeof row['expectedFingerprint'] !== 'string';
      })) {
      throw new Error('proposals must be a non-empty array of ids and review fingerprints');
    }
    const result = await exportAcceptedContextualNegatives(database, {
      orgId: actor.orgId,
      profileId: body.profileId,
      marketplaceId: body.marketplaceId,
      proposals: body.proposals as { id: string; expectedFingerprint: string }[],
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
