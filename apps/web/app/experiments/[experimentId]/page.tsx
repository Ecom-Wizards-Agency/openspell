/**
 * `/experiments/[id]` — one experiment, whole.
 *
 * Everything the operator needs to run and read a test in one place: its status
 * and the moves it can make next, a trend chart with the test window shaded, the
 * before / during / after comparison derived from the facts, what actually
 * changed inside the window (from `entity_changes`), and the transition log.
 *
 * The comparison is honest about what it is — a rough measurement against the
 * rest of the account, not a randomized test — and the note on it says so.
 */
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import {
  computeComparison,
  getExperiment,
  listEntityChangesInWindow,
  listExperimentEvents,
} from '@wizard-ads/db';
import { isUnauthenticated, openWebDatabase, requestActor } from '../../../src/server/request-context';
import { requireOrgRole } from '../../../src/server/org-role';
import { can } from '../../../src/auth/roles';
import { listProfileOptions, loadExperimentSpendSeries } from '../../../src/experiments/data';
import { heading, muted, page } from '../../../src/ui/tokens';
import { ExperimentDetail } from './detail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteParams = Promise<{ experimentId: string }>;

export default async function ExperimentDetailPage({ params }: { params: RouteParams }) {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(await headers());
    const role = await requireOrgRole(database, actor);
    const { experimentId } = await params;
    const experiment = await getExperiment(database, { orgId: actor.orgId, experimentId });
    if (!experiment) notFound();

    const now = new Date();
    const [comparison, changes, events, profiles] = await Promise.all([
      computeComparison(database, experiment, now),
      listEntityChangesInWindow(database, experiment, now),
      listExperimentEvents(database, { orgId: actor.orgId, experimentId }),
      listProfileOptions(database, actor.orgId),
    ]);

    const currencyCode = profiles.find((profile) => profile.id === experiment.profileId)?.currencyCode ?? 'USD';

    const spanStart = comparison.windows[0]?.start ?? experiment.startAt.toISOString().slice(0, 10);
    const spanEnd = comparison.windows[comparison.windows.length - 1]?.end ?? now.toISOString().slice(0, 10);
    const trend = await loadExperimentSpendSeries(database, {
      orgId: actor.orgId,
      profileId: experiment.profileId,
      start: spanStart,
      end: spanEnd,
      ...(experiment.scope.campaignIds ? { campaignIds: experiment.scope.campaignIds } : {}),
      ...(experiment.scope.targetIds ? { targetIds: experiment.scope.targetIds } : {}),
    });

    return (
      <ExperimentDetail
        experiment={{
          id: experiment.id,
          profileId: experiment.profileId,
          name: experiment.name,
          hypothesis: experiment.hypothesis,
          type: experiment.type,
          metricFocus: experiment.metricFocus,
          status: experiment.status,
          scope: experiment.scope,
          resultNote: experiment.resultNote,
          startAt: experiment.startAt.toISOString(),
          endAt: experiment.endAt ? experiment.endAt.toISOString() : null,
        }}
        comparison={comparison}
        changes={changes.map((change) => ({
          id: change.id,
          entityType: change.entityType,
          amazonId: change.amazonId,
          entityName: change.entityName,
          field: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
          source: change.source,
          observedAt: change.observedAt.toISOString(),
        }))}
        events={events.map((event) => ({
          id: event.id,
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          note: event.note,
          createdAt: event.createdAt.toISOString(),
        }))}
        trend={trend}
        currencyCode={currencyCode}
        canManage={can(role, 'manageExperiments')}
      />
    );
  } catch (error) {
    if (isUnauthenticated(error)) redirect('/login');
    const message = error instanceof Error ? error.message : 'Experiment is unavailable';
    return (
      <main style={page}>
        <h1 style={heading}>Experiment</h1>
        <p role="alert">{message}</p>
        <p style={muted}>Nothing was read; this is the page refusing, not an empty experiment.</p>
      </main>
    );
  } finally {
    await database.close();
  }
}
