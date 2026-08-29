/** Create an exact inverse export after re-checking synchronized evidence. */
import { createReversionExport, getReversionBatchPreview } from '@wizard-ads/db';
import { exportFilenames } from '../../../../src/recommendations/export';
import { reversionBatchTag } from '../../../../src/time-machine/reversion';
import { requireCapability } from '../../../../src/server/org-role';
import {
  errorResponse,
  openWebDatabase,
  requestActor,
} from '../../../../src/server/request-context';

export const runtime = 'nodejs';

const CONFIRMATION = 'Yes, export reversion';

export async function POST(request: Request): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    await requireCapability(database, actor, 'exportBatches');
    const body = (await request.json()) as {
      batchId?: unknown;
      profileId?: unknown;
      expectedRows?: unknown;
      note?: unknown;
      confirmation?: unknown;
    };
    if (typeof body.batchId !== 'string') throw new Error('batchId is required');
    if (typeof body.profileId !== 'string') throw new Error('profileId is required');
    if (!Number.isInteger(body.expectedRows) || Number(body.expectedRows) < 1) {
      throw new Error('expectedRows must be a positive integer');
    }
    if (body.confirmation !== CONFIRMATION) {
      throw new Error(`Confirmation must read “${CONFIRMATION}”.`);
    }
    if (typeof body.note !== 'string' || body.note.trim().length === 0) {
      throw new Error('A reversion export requires a note.');
    }

    const preview = await getReversionBatchPreview(database, {
      orgId: actor.orgId,
      batchId: body.batchId,
    });
    if (preview === null || preview.profileId !== body.profileId) throw new Error('Not found');
    if (!preview.exportAllowed) throw new Error(`Reversion blocked: ${preview.reason}`);
    if (preview.readyRows !== body.expectedRows) {
      throw new Error(
        `Reversion changed since preview: expected ${String(body.expectedRows)} rows, ` +
          `now ${preview.readyRows} are ready. Review it again.`,
      );
    }

    const now = new Date();
    const tag = reversionBatchTag({
      sourceTag: preview.tag,
      sourceBatchId: preview.batchId,
      exportedAt: now,
    });
    const result = await createReversionExport(database, {
      orgId: actor.orgId,
      batchId: preview.batchId,
      tag,
      note: body.note,
      actorId: actor.userId,
    });
    const files = exportFilenames(result.tag);

    return Response.json(
      {
        batchId: result.batchId,
        sourceBatchId: result.sourceBatchId,
        tag: result.tag,
        rows: result.rows.length,
        artifactSha256: result.artifactSha256,
        files: { rows: files.rows },
        downloads: {
          rows: `/api/recommendations/export/${result.batchId}?format=rows`,
        },
        amazonUpdated: false,
        guardrail: 'This is a review file only. Wizard Ads did not update Amazon.',
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  } finally {
    await database.close();
  }
}
