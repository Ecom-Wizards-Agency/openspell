import { redirect } from 'next/navigation';
import { gate } from '../../src/auth/guard';
import { listProfiles, requestedProfileId, selectProfile } from '../_lib/profiles';

// This compatibility route resolves authentication and the active profile at
// request time. It must never be prerendered with the build process's anonymous
// state, which would permanently bake a redirect to /login into the artifact.
export const dynamic = 'force-dynamic';

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
      const destination = '/dashboard?' + new URLSearchParams({ profile: active.id }).toString();
      redirect(destination + '#operating-status');
    }
  }
  redirect(`/dashboard${profile === undefined ? '' : `?profile=${encodeURIComponent(profile)}`}#operating-status`);
}
