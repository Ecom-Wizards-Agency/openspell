import { exportDaypartingSchedule } from '@wizard-ads/worker';
import { readDaypartingProposal } from '../../../../src/dayparting/data';
import {
  errorResponse,
  openWebDatabase,
  requestActor,
} from '../../../../src/server/request-context';
import { requireOrgRole } from '../../../../src/server/org-role';

export const runtime = 'nodejs';
export const DAYPARTING_EXPORT_EFFECT = 'export-only' as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseDaypartingExportFormat(value: string | null): 'csv' | 'json' {
  if (value === null || value === 'csv') return 'csv';
  if (value === 'json') return 'json';
  throw new Error('format must be csv or json');
}

export async function GET(request: Request): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    await requireOrgRole(database, actor);
    const url = new URL(request.url);
    const proposalId = url.searchParams.get('id') ?? '';
    const profileId = url.searchParams.get('profileId') ?? '';
    if (!UUID.test(proposalId)) throw new Error('valid proposal id is required');
    if (!UUID.test(profileId)) throw new Error('valid profile id is required');
    const format = parseDaypartingExportFormat(url.searchParams.get('format'));
    const proposal = await readDaypartingProposal(database, {
      orgId: actor.orgId,
      profileId,
      proposalId,
    });
    if (!proposal) return Response.json({ error: 'Not found' }, { status: 404 });
    const artifact = exportDaypartingSchedule(proposal);
    const body = format === 'csv' ? artifact.csv : artifact.json;
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="dayparting-schedule-${proposalId}.${format}"`,
        'x-wizard-ads-effect': DAYPARTING_EXPORT_EFFECT,
      },
    });
  } catch (error) {
    return errorResponse(error);
  } finally {
    await database.close();
  }
}
