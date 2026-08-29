/**
 * `list_experiments` and `get_experiment` (WP-19).
 *
 * Read-only, audit-logged like every other tool, and scoped to the key's org
 * and — when the key is profile-scoped — its profiles. Creating and moving
 * experiments stays in the web UI for v1.x; a model reads them so it can reason
 * about a window ("spend jumped here, and there was a bid-push experiment
 * running") instead of mistaking a deliberate change for a mystery.
 *
 * The tools live in their own file and are registered from `server.ts` in one
 * place, so `apps/mcp` gains two tools rather than a rewrite. They import only
 * types from `server.ts`, so there is no runtime import cycle.
 */
import { z } from 'zod';
import {
  EXPERIMENT_STATUSES,
  computeComparison,
  getExperiment,
  listEntityChangesInWindow,
  listExperimentEvents,
  listExperiments,
} from '@wizard-ads/db';
import type { ExperimentRecord, ExperimentStatus } from '@wizard-ads/db';
import { ToolError } from './errors.js';
import type { ServerContext, ToolOutcome } from './server.js';

export const LIST_EXPERIMENTS_TITLE = 'List experiments';
export const LIST_EXPERIMENTS_DESCRIPTION =
  'Deliberate tests recorded in OpenSpell — bid pushes, creative and price changes — with their ' +
  'windows, scope and status. Read this before concluding a metric moved on its own: a shaded ' +
  'window here is a change somebody chose to make. Filter by profile or status.';

export const GET_EXPERIMENT_TITLE = 'Get one experiment';
export const GET_EXPERIMENT_DESCRIPTION =
  'One experiment in full: its hypothesis, scope and status, the before/during/after comparison ' +
  'derived from the facts (a rough measurement, not a randomized test), the entity changes that ' +
  'landed inside its window, and its transition log.';

export const listExperimentsInputSchema = {
  profile_id: z
    .string()
    .optional()
    .describe('Internal or Amazon profile id. Omit to list every profile this key can see.'),
  status: z.enum(EXPERIMENT_STATUSES).optional().describe('Filter to one status'),
};

export const getExperimentInputSchema = {
  experiment_id: z.string().min(1).describe('The experiment id, as returned by list_experiments'),
};

/** The internal profile id for an Amazon or internal id, honouring the key scope. */
async function resolveScopedProfileId(context: ServerContext, profileRef: string): Promise<string> {
  const { handle, scope } = context;
  const rows = await handle.sql<{ id: string }[]>`
    select id from public.ad_profiles
     where org_id = ${scope.orgId} and (id::text = ${profileRef} or amazon_profile_id = ${profileRef})
     limit 1
  `;
  const id = rows[0]?.id;
  if (!id || (scope.profileIds !== null && !scope.profileIds.includes(id))) {
    throw new ToolError('not_found', `no profile ${profileRef} is visible to this key`);
  }
  return id;
}

function withinScope(context: ServerContext, profileId: string): boolean {
  return context.scope.profileIds === null || context.scope.profileIds.includes(profileId);
}

const summarize = (experiment: ExperimentRecord) => ({
  id: experiment.id,
  profileId: experiment.profileId,
  name: experiment.name,
  type: experiment.type,
  metricFocus: experiment.metricFocus,
  status: experiment.status,
  startAt: experiment.startAt.toISOString(),
  endAt: experiment.endAt ? experiment.endAt.toISOString() : null,
  scope: experiment.scope,
});

export async function listExperimentsTool(
  context: ServerContext,
  args: { profile_id?: string; status?: ExperimentStatus },
): Promise<ToolOutcome> {
  const { handle, scope } = context;
  const profileId = args.profile_id ? await resolveScopedProfileId(context, args.profile_id) : null;

  const all = await listExperiments(handle, {
    orgId: scope.orgId,
    profileId,
    ...(args.status ? { status: args.status } : {}),
  });
  // When the key is profile-scoped and no explicit profile was named, hide the
  // experiments of profiles the key cannot see.
  const visible = profileId === null ? all.filter((experiment) => withinScope(context, experiment.profileId)) : all;

  return {
    payload: {
      count: visible.length,
      experiments: visible.map(summarize),
      note:
        'A window here is a deliberate change. Cross-reference it with get_entity_data over the ' +
        'same dates before reading a metric move as organic.',
    },
    summary: { rows: visible.length },
    ...(profileId ? { profileId } : {}),
  };
}

export async function getExperimentTool(
  context: ServerContext,
  args: { experiment_id: string },
): Promise<ToolOutcome> {
  const { handle, scope } = context;
  const experiment = await getExperiment(handle, { orgId: scope.orgId, experimentId: args.experiment_id });
  if (!experiment || !withinScope(context, experiment.profileId)) {
    throw new ToolError('not_found', `no experiment ${args.experiment_id} is visible to this key`);
  }

  const [comparison, changes, events] = await Promise.all([
    computeComparison(handle, experiment),
    listEntityChangesInWindow(handle, experiment),
    listExperimentEvents(handle, { orgId: scope.orgId, experimentId: experiment.id }),
  ]);

  return {
    payload: {
      experiment: {
        ...summarize(experiment),
        hypothesis: experiment.hypothesis,
        resultNote: experiment.resultNote,
      },
      comparison: {
        note: 'This is a rough measurement, not a randomized test. Ratios are recomputed from summed bases.',
        hasScopedFacts: comparison.hasScopedFacts,
        windowDays: comparison.windowDays,
        windows: comparison.windows,
      },
      entityChangesInWindow: changes.map((change) => ({
        entityType: change.entityType,
        amazonId: change.amazonId,
        field: change.field,
        oldValue: change.oldValue,
        newValue: change.newValue,
        source: change.source,
        observedAt: change.observedAt.toISOString(),
      })),
      timeline: events.map((event) => ({
        from: event.fromStatus,
        to: event.toStatus,
        note: event.note,
        at: event.createdAt.toISOString(),
      })),
    },
    summary: { id: experiment.id, status: experiment.status, changes: changes.length },
    profileId: experiment.profileId,
  };
}
