/**
 * Start a new experiment.
 *
 * A grid selection arrives as query parameters — `?profile=…&campaigns=…` or
 * `&targets=…` — put there by the "Start an experiment" action on the data grid,
 * so the scope is pre-filled from what the operator had in view. The parameters
 * are normalised on the server before the form ever shows them, so what the user
 * is asked to approve is exactly what will be stored.
 */
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { authenticationDestination, openWebDatabase, requestActor } from '../../../src/server/request-context';
import { requireCapability } from '../../../src/server/org-role';
import { idList } from '../../../src/experiments/http';
import {
  listExperimentScopeOptions,
  listProfileOptions,
  selectProfileId,
} from '../../../src/experiments/data';
import { heading, muted, page } from '../../../src/ui/tokens';
import { NewExperimentForm } from './form';
import type { PrefilledScope } from './form';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const single = (value: string | string[] | undefined): string | null =>
  typeof value === 'string' ? value : null;

export default async function NewExperimentPage({ searchParams }: { searchParams: SearchParams }) {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(await headers());
    // Filing an experiment needs the capability, so refuse a viewer here rather
    // than letting them fill a form the API will reject.
    await requireCapability(database, actor, 'manageExperiments');
    const query = await searchParams;
    const profiles = await listProfileOptions(database, actor.orgId);
    const selectedProfileId = selectProfileId(profiles, single(query['profile']));
    const scopeOptions =
      selectedProfileId === null
        ? { campaigns: [], products: [] }
        : await listExperimentScopeOptions(database, {
            orgId: actor.orgId,
            profileId: selectedProfileId,
          });

    const scope: PrefilledScope = {
      campaignIds: idList(query['campaigns']) ?? [],
      adGroupIds: idList(query['adgroups']) ?? [],
      targetIds: idList(query['targets']) ?? [],
      asins: idList(query['asins']) ?? [],
      searchTerms: idList(query['terms']) ?? [],
    };

    return (
      <NewExperimentForm
        profiles={profiles}
        selectedProfileId={selectedProfileId}
        prefillName={single(query['name']) ?? ''}
        scope={scope}
        initialScopeOptions={scopeOptions}
      />
    );
  } catch (error) {
    const authDestination = authenticationDestination(error);
    if (authDestination !== null) redirect(authDestination);
    const message = error instanceof Error ? error.message : 'Experiments are unavailable';
    return (
      <main style={page}>
        <h1 style={heading}>New experiment</h1>
        <p role="alert">{message}</p>
        <p style={muted}>Nothing was filed; this is the form refusing to open.</p>
      </main>
    );
  } finally {
    await database.close();
  }
}
