/** `/` is an entry route, not a second product screen. */
import { redirect } from 'next/navigation';
import { rootDashboardPath } from './_lib/root-route';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ profile?: string | string[] }>;
}

export default async function Page({ searchParams }: PageProps) {
  const { profile } = await searchParams;
  redirect(rootDashboardPath(profile));
}
