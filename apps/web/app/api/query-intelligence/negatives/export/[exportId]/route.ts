import { getContextualNegativeExport } from '@wizard-ads/db';
import {
  errorResponse,
  openWebDatabase,
  requestActor,
  requireOrgMembership,
} from '../../../../../../src/server/request-context';
import {
  contextualNegativeExportCsv,
  contextualNegativeExportFilename,
  contextualNegativeExportJson,
} from '../../../../../../src/query-intelligence/export';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  context: { params: Promise<{ exportId: string }> },
): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    await requireOrgMembership(database, actor);
    const { exportId } = await context.params;
    const artifact = await getContextualNegativeExport(database, { orgId: actor.orgId, exportId });
    if (artifact === null) return Response.json({ error: 'Not found' }, { status: 404 });
    const format = new URL(request.url).searchParams.get('format') ?? 'csv';
    if (format !== 'csv' && format !== 'json') {
      return Response.json({ error: 'format must be csv or json' }, { status: 400 });
    }
    const body = format === 'csv'
      ? contextualNegativeExportCsv(artifact)
      : contextualNegativeExportJson(artifact);
    return new Response(body, {
      headers: {
        'content-type': format === 'csv'
          ? 'text/csv; charset=utf-8'
          : 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${contextualNegativeExportFilename(artifact, format)}"`,
        'x-wizard-ads-exported-rows': String(artifact.rowCount),
        'x-wizard-ads-amazon-updated': 'false',
      },
    });
  } catch (error) {
    return errorResponse(error);
  } finally {
    await database.close();
  }
}
