/**
 * The experiment list and the create write.
 *
 * Reading is every member's right, so the GET checks membership and nothing
 * more. Creating needs `manageExperiments` (analyst or better), and the created
 * row is stamped with the actor as its author so the "edit your own" rule the
 * database enforces has something to match.
 */
import {
  EXPERIMENT_METRICS,
  EXPERIMENT_STATUSES,
  EXPERIMENT_TYPES,
  createExperiment,
  listExperiments,
  normalizeScope,
} from '@wizard-ads/db';
import type { ExperimentMetric, ExperimentStatus, ExperimentType } from '@wizard-ads/db';
import { openWebDatabase, requestActor } from '../../../src/server/request-context';
import { requireCapability, requireOrgRole } from '../../../src/server/org-role';
import { experimentErrorResponse } from '../../../src/experiments/http';
import { can } from '../../../src/auth/roles';

export const runtime = 'nodejs';

const asStatus = (value: string | null): ExperimentStatus | null =>
  value !== null && (EXPERIMENT_STATUSES as readonly string[]).includes(value)
    ? (value as ExperimentStatus)
    : null;

export async function GET(request: Request): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    const role = await requireOrgRole(database, actor);
    const query = new URL(request.url).searchParams;
    const items = await listExperiments(database, {
      orgId: actor.orgId,
      profileId: query.get('profile'),
      status: asStatus(query.get('status')),
    });
    return Response.json({
      items,
      role,
      canManage: can(role, 'manageExperiments'),
    });
  } catch (error) {
    return experimentErrorResponse(error);
  } finally {
    await database.close();
  }
}

export async function POST(request: Request): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    await requireCapability(database, actor, 'manageExperiments');
    const body = (await request.json()) as {
      profileId?: unknown;
      name?: unknown;
      hypothesis?: unknown;
      type?: unknown;
      metricFocus?: unknown;
      scope?: unknown;
      startAt?: unknown;
      status?: unknown;
    };

    if (typeof body.profileId !== 'string') throw new Error('profileId is required');
    if (typeof body.name !== 'string') throw new Error('name is required');
    if (typeof body.type !== 'string' || !(EXPERIMENT_TYPES as readonly string[]).includes(body.type)) {
      throw new Error(`type must be one of: ${EXPERIMENT_TYPES.join(', ')}`);
    }
    if (
      typeof body.metricFocus !== 'string' ||
      !(EXPERIMENT_METRICS as readonly string[]).includes(body.metricFocus)
    ) {
      throw new Error(`metricFocus must be one of: ${EXPERIMENT_METRICS.join(', ')}`);
    }
    const status = asStatus(typeof body.status === 'string' ? body.status : null);
    // Only planned or running may be chosen at creation: a test cannot be born
    // already ended.
    if (status !== null && status !== 'planned' && status !== 'running') {
      throw new Error('a new experiment can only be planned or running');
    }

    const item = await createExperiment(database, {
      orgId: actor.orgId,
      profileId: body.profileId,
      createdBy: actor.userId,
      name: body.name,
      hypothesis: typeof body.hypothesis === 'string' ? body.hypothesis : '',
      type: body.type as ExperimentType,
      metricFocus: body.metricFocus as ExperimentMetric,
      scope: normalizeScope(body.scope),
      startAt: typeof body.startAt === 'string' ? body.startAt : null,
      ...(status ? { status } : {}),
    });
    return Response.json({ item }, { status: 201 });
  } catch (error) {
    return experimentErrorResponse(error);
  } finally {
    await database.close();
  }
}
