/** `/campaigns` — guided planning, preflight, and manual bulksheet export. */
import { headers } from 'next/headers';
import { redirect, unstable_rethrow } from 'next/navigation';
import {
  authenticationDestination,
  openWebDatabase,
  requestActor,
  requireOrgMembership,
} from '../../src/server/request-context';
import { canonicalProfilePath } from '../../src/data/active-profile';
import { listOrgProfiles, selectOrgProfile } from '../../src/recommendations/data';
import { PageHeader } from '../../src/ui/primitives';
import { requestedProfileId } from '../_lib/profiles';
import { CampaignBuilder } from './builder';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function CampaignsPage({ searchParams }: { searchParams: SearchParams }) {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(await headers());
    await requireOrgMembership(database, actor);
    const query = await searchParams;
    const profiles = await listOrgProfiles(database, actor.orgId);
    const requested = await requestedProfileId(one(query['profile']));
    const profile = selectOrgProfile(profiles, requested);
    if (profile !== null) {
      const canonical = canonicalProfilePath('/campaigns', query, profile.id);
      if (canonical !== null) redirect(canonical);
    }
    const label = profile?.label ?? 'Selected profile';
    const marketplace = profile?.countryCode ?? 'US';

    return (
      <main className="wa-page" data-interactive="true">
        <PageHeader
          title="Campaign Builder"
          subtitle="Plan new Sponsored Products campaigns or review changes against synced entities. Every workflow ends with a bulksheet for manual review and upload."
          meta={
            profile === null ? null : (
              <span className="wa-hint">
                Update source · {profile.label} · {profile.countryCode} · synced mirror
              </span>
            )
          }
        />
        <CampaignBuilder
          profileId={profile?.id ?? null}
          profileLabel={label}
          marketplace={marketplace}
        />
      </main>
    );
  } catch (error) {
    unstable_rethrow(error);
    const authDestination = authenticationDestination(error);
    if (authDestination !== null) redirect(authDestination);
    const message = error instanceof Error ? error.message : 'Campaign Builder is unavailable';
    return (
      <main className="wa-page">
        <PageHeader title="Campaign Builder" />
        <p role="alert">{message}</p>
      </main>
    );
  } finally {
    await database.close();
  }
}
