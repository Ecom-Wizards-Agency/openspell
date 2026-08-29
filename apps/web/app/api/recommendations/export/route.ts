/**
 * Export accepted proposals as a staged-apply batch.
 *
 * This is v1's whole apply path and it writes nothing to Amazon: the batch and
 * its rows land in our ledger, the proposals move to `exported`, and the files
 * are produced from the stored rows by the download route next door. Splitting
 * "decide the export" from "fetch a file" is what makes the JSON, the caps
 * document and the workbook three views of one recorded act rather than three
 * chances to export slightly different sets.
 *
 * Roles: owner and admin only, through the shared `exportBatches` capability,
 * mirroring the apply-ledger RLS policy. The route check is the first fence and
 * RLS remains the second.
 */
import {
  exportAcceptedRecommendations,
  getRecommendationRun,
} from '@wizard-ads/db';
import { errorResponse, openWebDatabase, requestActor } from '../../../../src/server/request-context';
import { requireCapability } from '../../../../src/server/org-role';
import { batchTag, exportFilenames } from '../../../../src/recommendations/export';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    await requireCapability(database, actor, 'exportBatches');

    const body = (await request.json()) as {
      runId?: unknown;
      profileId?: unknown;
      optGroup?: unknown;
      lever?: unknown;
      note?: unknown;
      client?: unknown;
      today?: unknown;
      ids?: unknown;
    };
    if (typeof body.runId !== 'string') throw new Error('runId is required');
    if (typeof body.profileId !== 'string') throw new Error('profileId is required');
    if (typeof body.note !== 'string' || body.note.trim().length === 0) {
      throw new Error('note is required: it is the note the staged apply carries');
    }
    const optGroup = typeof body.optGroup === 'string' && body.optGroup.trim() ? body.optGroup.trim() : 'ungrouped';
    const lever = typeof body.lever === 'string' && body.lever.trim() ? body.lever.trim() : 'bid-down';
    const ids = Array.isArray(body.ids) ? (body.ids.filter((id) => typeof id === 'string') as string[]) : null;

    const run = await getRecommendationRun(database, { orgId: actor.orgId, runId: body.runId });
    if (run === null) throw new Error('Not found');
    if (run.profileId !== body.profileId) throw new Error('Not found');

    const today =
      typeof body.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.today)
        ? body.today
        : new Date().toISOString().slice(0, 10);
    const client = typeof body.client === 'string' && body.client.trim() ? body.client : body.profileId;
    const tag = batchTag({ client, date: today, optGroup, lever });

    const result = await exportAcceptedRecommendations(database, {
      orgId: actor.orgId,
      profileId: body.profileId,
      runId: body.runId,
      ids,
      tag,
      optGroup,
      lever,
      note: body.note,
      actorId: actor.userId,
    });

    return Response.json(
      {
        ...result,
        files: exportFilenames(result.tag),
        downloads: {
          rows: `/api/recommendations/export/${result.batchId}?format=rows`,
          caps: `/api/recommendations/export/${result.batchId}?format=caps`,
          workbook: `/api/recommendations/export/${result.batchId}?format=xlsx`,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  } finally {
    await database.close();
  }
}
