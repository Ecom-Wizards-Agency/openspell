import { redirect } from 'next/navigation';
import { gate } from '../../src/auth/guard';
import { listProfiles, requestedProfileId, selectProfile } from '../_lib/profiles';

interface PageProps {
  searchParams: Promise<{ profile?: string }>;
}

/** Backward-compatible deep links now land on the integrated dashboard section. */
export default async function StrategyRedirect({ searchParams }: PageProps): Promise<never> {
  // Preserve the same anonymous boundary as every other operator screen before
  // forwarding old bookmarks to the integrated dashboard section. Otherwise
  // the hash can survive the dashboard's auth redirect as `/login#...`.
  const entry = await gate();
  const { profile } = await searchParams;
  if (entry.state === 'ok') {
    const requested = await requestedProfileId(profile);
    const profiles = await listProfiles(entry.handle, entry.context.active?.orgId ?? '');
    const active = selectProfile(profiles, requested);
    if (active !== null) {
      redirect(`/dashboard?profile=${encodeURIComponent(active.id)}#operating-status`);
    }
  }
  redirect(`/dashboard${profile === undefined ? '' : `?profile=${encodeURIComponent(profile)}`}#operating-status`);
}
