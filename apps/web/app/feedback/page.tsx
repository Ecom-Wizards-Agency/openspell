/**
 * The tracker: everything filed, filtered, counted and votable.
 *
 * The first page load is server-rendered from the database; every filter change
 * afterwards re-reads `/api/feedback`, which is the same query with the same
 * org predicate. That is deliberate — a filter that narrowed a list in the
 * browser would be a different question than the one the counts answer.
 */
import { headers } from 'next/headers';
import { countFeedback, listFeedbackItems } from '@wizard-ads/db';
import { openWebDatabase, requestActor } from '../../src/server/request-context';
import { requireOrgRole } from '../../src/server/org-role';
import { can } from '../../src/auth/roles';
import { toUiItem } from '../../src/feedback/ui';
import { heading, muted, page } from '../../src/ui/tokens';
import { FeedbackTracker } from './tracker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function FeedbackPage() {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(await headers());
    const role = await requireOrgRole(database, actor);
    const [items, counts] = await Promise.all([
      listFeedbackItems(database, { orgId: actor.orgId, viewerId: actor.userId }),
      countFeedback(database, actor.orgId),
    ]);
    return (
      <FeedbackTracker
        items={items.map((item) => toUiItem(item, actor.userId))}
        counts={counts}
        canTriage={can(role, 'triageFeedback')}
        role={role}
      />
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Feedback is unavailable';
    return (
      <main style={page}>
        <h1 style={heading}>Feedback</h1>
        <p role="alert">{message}</p>
        <p style={muted}>This surface requires an authenticated request context.</p>
      </main>
    );
  } finally {
    await database.close();
  }
}
