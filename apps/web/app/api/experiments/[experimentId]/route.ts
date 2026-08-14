/**
 * One experiment: read it, move its status, or edit its fields.
 *
 * The web tier connects as the application's own role, so RLS is not what
 * constrains a write here — the checks are. Any write needs `manageExperiments`;
 * beyond that, an analyst may only touch their own experiment while an admin may
 * touch anyone's. The database's policies and guard enforce the same rule, so a
 * 403 here is the outer of three fences, not the only one.
 */
import {
  EXPERIMENT_METRICS,
  EXPERIMENT_STATUSES,
  EXPERIMENT_TYPES,
  getExperiment,
  normalizeScope,
  transitionExperiment,
  updateExperiment,
} from '@wizard-ads/db';
import type { ExperimentMetric, ExperimentStatus, ExperimentType } from '@wizard-ads/db';
import { openWebDatabase, requestActor, RequestAuthError } from '../../../../src/server/request-context';
import { requireCapability, requireOrgRole } from '../../../../src/server/org-role';
import { experimentErrorResponse } from '../../../../src/experiments/http';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ experimentId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    await requireOrgRole(database, actor);
    const { experimentId } = await context.params;
    const item = await getExperiment(database, { orgId: actor.orgId, experimentId });
    if (!item) return Response.json({ error: 'Experiment not found' }, { status: 404 });
    return Response.json({ item });
  } catch (error) {
    return experimentErrorResponse(error);
  } finally {
    await database.close();
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    const role = await requireCapability(database, actor, 'manageExperiments');
    const { experimentId } = await context.params;

    const existing = await getExperiment(database, { orgId: actor.orgId, experimentId });
    // A foreign or missing experiment is a 404 either way, so the two are
    // indistinguishable from outside.
    if (!existing) return Response.json({ error: 'Experiment not found' }, { status: 404 });
    // An analyst edits only their own; an admin edits anyone's.
    const isAdmin = role === 'owner' || role === 'admin';
    if (!isAdmin && existing.createdBy !== actor.userId) {
      throw new RequestAuthError('Only the author or an admin may change this experiment', 403);
    }

    const body = (await request.json()) as {
      status?: unknown;
      note?: unknown;
      resultNote?: unknown;
      name?: unknown;
      hypothesis?: unknown;
      type?: unknown;
      metricFocus?: unknown;
      scope?: unknown;
      startAt?: unknown;
    };

    const wantsTransition = body.status !== undefined || body.resultNote !== undefined;
    const wantsEdit =
      body.name !== undefined ||
      body.hypothesis !== undefined ||
      body.type !== undefined ||
      body.metricFocus !== undefined ||
      body.scope !== undefined ||
      body.startAt !== undefined;
    if (wantsTransition && wantsEdit) {
      throw new Error('A status change and a field edit are separate requests');
    }

    if (wantsTransition) {
      if (body.status !== undefined && typeof body.status !== 'string') {
        throw new Error('status must be a string');
      }
      if (
        typeof body.status === 'string' &&
        !(EXPERIMENT_STATUSES as readonly string[]).includes(body.status)
      ) {
        throw new Error(`status must be one of: ${EXPERIMENT_STATUSES.join(', ')}`);
      }
      // No status given means "just set the result note", which is a move to the
      // same status: harmless and eventless.
      const to = (typeof body.status === 'string' ? body.status : existing.status) as ExperimentStatus;
      const item = await transitionExperiment(database, {
        orgId: actor.orgId,
        experimentId,
        to,
        actorId: actor.userId,
        ...(typeof body.note === 'string' ? { note: body.note } : {}),
        ...(body.resultNote === undefined
          ? {}
          : { resultNote: typeof body.resultNote === 'string' ? body.resultNote : null }),
      });
      return Response.json({ item });
    }

    if (!wantsEdit) throw new Error('Nothing to change');
    if (body.type !== undefined && !(EXPERIMENT_TYPES as readonly string[]).includes(String(body.type))) {
      throw new Error(`type must be one of: ${EXPERIMENT_TYPES.join(', ')}`);
    }
    if (
      body.metricFocus !== undefined &&
      !(EXPERIMENT_METRICS as readonly string[]).includes(String(body.metricFocus))
    ) {
      throw new Error(`metricFocus must be one of: ${EXPERIMENT_METRICS.join(', ')}`);
    }
    const item = await updateExperiment(database, {
      orgId: actor.orgId,
      experimentId,
      actorId: actor.userId,
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(typeof body.hypothesis === 'string' ? { hypothesis: body.hypothesis } : {}),
      ...(typeof body.type === 'string' ? { type: body.type as ExperimentType } : {}),
      ...(typeof body.metricFocus === 'string' ? { metricFocus: body.metricFocus as ExperimentMetric } : {}),
      ...(body.scope === undefined ? {} : { scope: normalizeScope(body.scope) }),
      ...(typeof body.startAt === 'string' ? { startAt: body.startAt } : {}),
    });
    return Response.json({ item });
  } catch (error) {
    return experimentErrorResponse(error);
  } finally {
    await database.close();
  }
}
