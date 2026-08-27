/** Authenticated, org-scoped read contract for the per-target bid-history modal. */
import { profileBelongsToOrg } from '@wizard-ads/db';
import { loadBidHistory } from '../../_lib/bid-corridor';
import {
  errorResponse,
  openWebDatabase,
  requestActor,
} from '../../../src/server/request-context';
import { requireOrgRole } from '../../../src/server/org-role';

export const runtime = 'nodejs';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    await requireOrgRole(database, actor);
    const query = new URL(request.url).searchParams;
    const profileId = query.get('profile');
    const targetId = query.get('target');
    const from = query.get('from');
    const to = query.get('to');
    if (!profileId || !targetId) throw new Error('profile and target are required');
    if (!from || !to || !ISO_DATE.test(from) || !ISO_DATE.test(to) || from > to) {
      throw new Error('from and to must be an ordered ISO date window');
    }
    if (!(await profileBelongsToOrg(database, { orgId: actor.orgId, profileId }))) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    const history = await loadBidHistory(database, {
      orgId: actor.orgId,
      profileId,
      targetId,
      from,
      to,
    });
    if (history === null) return Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json(history);
  } catch (error) {
    return errorResponse(error);
  } finally {
    await database.close();
  }
}
