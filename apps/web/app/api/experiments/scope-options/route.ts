/** Profile-scoped, current entity choices for the experiment creation form. */
import { profileBelongsToOrg } from '@wizard-ads/db';
import { listExperimentScopeOptions } from '../../../../src/experiments/data';
import { experimentErrorResponse } from '../../../../src/experiments/http';
import { requireCapability } from '../../../../src/server/org-role';
import { openWebDatabase, requestActor } from '../../../../src/server/request-context';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    await requireCapability(database, actor, 'manageExperiments');
    const profileId = new URL(request.url).searchParams.get('profile');
    if (profileId === null || profileId.trim() === '') {
      throw new Error('profile is required');
    }
    if (!(await profileBelongsToOrg(database, { orgId: actor.orgId, profileId }))) {
      return Response.json({ error: 'Profile not found' }, { status: 404 });
    }

    const options = await listExperimentScopeOptions(database, {
      orgId: actor.orgId,
      profileId,
    });
    return Response.json(options);
  } catch (error) {
    return experimentErrorResponse(error);
  } finally {
    await database.close();
  }
}
