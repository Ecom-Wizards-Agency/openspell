/**
 * `/experiments` — the tracker of deliberate tests.
 *
 * Server-rendered from the database on first load, then the client re-reads
 * `/api/experiments` when the profile or status filter changes, so the list is
 * always an answer to the same org-scoped query rather than a browser-side
 * narrowing. Authentication is the header-bridge / session path the feedback and
 * tag surfaces use, not the dashboard's gate, so this screen is reachable in the
 * same e2e harness the rest of the write surfaces are tested in.
 */
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { listExperiments } from '@wizard-ads/db';
import { isUnauthenticated, openWebDatabase, requestActor } from '../../src/server/request-context';
import { requireOrgRole } from '../../src/server/org-role';
import { can } from '../../src/auth/roles';
import { listProfileOptions, listProposedTests, selectProfileId } from '../../src/experiments/data';
import { heading, muted, page } from '../../src/ui/tokens';
import { toUiExperiment } from '../../src/experiments/ui';
import { ExperimentsList } from './list';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const single = (value: string | string[] | undefined): string | null =>
  typeof value === 'string' ? value : null;

export default async function ExperimentsPage({ searchParams }: { searchParams: SearchParams }) {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(await headers());
    const role = await requireOrgRole(database, actor);
    const query = await searchParams;
    const profiles = await listProfileOptions(database, actor.orgId);
    const selectedProfileId = selectProfileId(profiles, single(query['profile']));
    const [items, proposedTests] = selectedProfileId
      ? await Promise.all([
          listExperiments(database, { orgId: actor.orgId, profileId: selectedProfileId }),
          listProposedTests(database, { orgId: actor.orgId, profileId: selectedProfileId }),
        ])
      : [[], []];

    return (
      <ExperimentsList
        items={items.map(toUiExperiment)}
        profiles={profiles}
        selectedProfileId={selectedProfileId}
        proposedTests={proposedTests}
        canManage={can(role, 'manageExperiments')}
        role={role}
      />
    );
  } catch (error) {
    if (isUnauthenticated(error)) redirect('/login');
    const message = error instanceof Error ? error.message : 'Experiments are unavailable';
    return (
      <main style={page}>
        <h1 style={heading}>Experiments</h1>
        <p role="alert">{message}</p>
        <p style={muted}>Nothing was read; this is the tracker refusing, not an empty tracker.</p>
      </main>
    );
  } finally {
    await database.close();
  }
}
