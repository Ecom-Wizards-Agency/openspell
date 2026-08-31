import { getContextualNegativeExport, type RequestDatabase } from '@wizard-ads/db';
import {
  errorResponse,
  openWebDatabase,
  requestActor,
  requireOrgMembership,
} from '../../../../../../src/server/request-context';
import { parseExportFormat } from '../../../../../../src/query-intelligence/review-http';
import { contextualNegativeReviewErrorResponse } from '../../../../../../src/query-intelligence/review-errors';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ exportId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  let database: RequestDatabase | null = null;
  try {
    database = openWebDatabase();
    const actor = await requestActor(request.headers);
    await requireOrgMembership(database, actor);
    const { exportId } = await context.params;
    const format = parseExportFormat(new URL(request.url).searchParams.get('format'));
    const artifact = await getContextualNegativeExport(database, {
      orgId: actor.orgId,
      exportId,
      format,
    });
    if (artifact === null) return Response.json({ error: 'Not found' }, { status: 404 });

    const date = artifact.createdAt.toISOString().slice(0, 10);
    const filename = `openspell-contextual-negatives-${date}-${artifact.exportId.slice(0, 8)}.${format}`;
    const body = Uint8Array.from(artifact.bytes).buffer;
    return new Response(body, {
      headers: {
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="${filename}"`,
        'content-length': String(artifact.bytes.byteLength),
        'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
        etag: `"${artifact.sha256}"`,
        'x-content-type-options': 'nosniff',
        'x-openspell-amazon-updated': 'false',
        'x-openspell-exported-rows': String(artifact.rowCount),
      },
    });
  } catch (error) {
    return contextualNegativeReviewErrorResponse(error) ?? errorResponse(error);
  } finally {
    await database?.close();
  }
}
