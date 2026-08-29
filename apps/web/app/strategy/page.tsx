import { redirect } from 'next/navigation';
import { gate } from '../../src/auth/guard';

interface PageProps {
  searchParams: Promise<{ profile?: string }>;
}

/** Backward-compatible deep links now land on the integrated dashboard section. */
export default async function StrategyRedirect({ searchParams }: PageProps): Promise<never> {
  // Preserve the same anonymous boundary as every other operator screen before
  // forwarding old bookmarks to the integrated dashboard section. Otherwise
  // the hash can survive the dashboard's auth redirect as `/login#...`.
  await gate();
  const { profile } = await searchParams;
  redirect(`/dashboard${profile === undefined ? '' : `?profile=${encodeURIComponent(profile)}`}#operating-status`);
}
