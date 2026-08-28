/** `/campaigns` — guided planning, preflight, and manual bulksheet export. */
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  isUnauthenticated,
  openWebDatabase,
  requestActor,
  requireOrgMembership,
} from '../../src/server/request-context';
import { listOrgProfiles, selectOrgProfile } from '../../src/recommendations/data';
import { PageHeader } from '../../src/ui/primitives';
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
    const profile = selectOrgProfile(profiles, one(query['profile']));
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
    if (isUnauthenticated(error)) redirect('/login');
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
