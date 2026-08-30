/** The retired tracker: old item links are routed to their new typed home. */
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getFeedbackItem } from '@wizard-ads/db';
import { authenticationDestination, openWebDatabase, requestActor } from '../../src/server/request-context';
import { requireOrgRole } from '../../src/server/org-role';
import { LegacyFeedbackRedirect } from './legacy-redirect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const single = (value: string | string[] | undefined): string | null =>
  typeof value === 'string' ? value : null;

export default async function FeedbackPage({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  const candidate = single(query['item']) ?? single(query['id']) ?? single(query['feedback']);

  // A fragment is not present in the HTTP request. This bridge gets one client
  // turn to convert #feedback-<id> into ?item=<id>, then comes back through the
  // authenticated, tenant-scoped lookup below.
  if (candidate === null) return <LegacyFeedbackRedirect />;
  if (!UUID.test(candidate)) redirect('/bugs');

  const database = openWebDatabase();
  let destination = '/bugs';
  try {
    const actor = await requestActor(await headers());
    await requireOrgRole(database, actor);
    const item = await getFeedbackItem(database, {
      orgId: actor.orgId,
      itemId: candidate,
      viewerId: actor.userId,
    });
    if (item?.type === 'feature') destination = `/roadmap#roadmap-${item.id}`;
    if (item?.type === 'bug') destination = `/bugs#bug-${item.id}`;
  } catch (error) {
    const authDestination = authenticationDestination(error);
    if (authDestination !== null) redirect(authDestination);
  } finally {
    await database.close();
  }
  redirect(destination);
}
