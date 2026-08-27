/**
 * The feature roadmap, arranged by status from request through shipped.
 *
 * It is a view, not a second data set — a card is on the board because its
 * status says so, and it moves when an admin changes that status. Declined
 * items are on the page too, collapsed, with the note that explains them:
 * Telling somebody why their request is not happening is cheaper than letting
 * them ask again in six weeks.
 */
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { listFeedbackItems } from '@wizard-ads/db';
import { can } from '../../src/auth/roles';
import { isUnauthenticated, openWebDatabase, requestActor } from '../../src/server/request-context';
import { requireOrgRole } from '../../src/server/org-role';
import { toUiItem } from '../../src/feedback/ui';
import { heading, muted, page } from '../../src/ui/tokens';
import { RoadmapBoardView } from './board';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function RoadmapPage() {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(await headers());
    const role = await requireOrgRole(database, actor);
    const items = await listFeedbackItems(database, {
      orgId: actor.orgId,
      viewerId: actor.userId,
      type: 'feature',
      sort: 'votes',
    });
    const mapped = items.map((item) => toUiItem(item, actor.userId));
    return (
      <RoadmapBoardView
        planned={mapped.filter((item) => ['planned', 'new', 'triaged'].includes(item.status))}
        inProgress={mapped.filter((item) => item.status === 'in_progress')}
        shipped={mapped.filter((item) => item.status === 'shipped')}
        declined={mapped.filter((item) => item.status === 'declined')}
        canTriage={can(role, 'triageFeedback')}
      />
    );
  } catch (error) {
    // A page, not an API: an anonymous visitor gets the login screen.
    if (isUnauthenticated(error)) redirect('/login');
    const message = error instanceof Error ? error.message : 'The roadmap is unavailable';
    return (
      <main style={page}>
        <h1 style={heading}>Roadmap</h1>
        <p role="alert">{message}</p>
        <p style={muted}>Nothing was read; this is the board refusing, not an empty board.</p>
      </main>
    );
  } finally {
    await database.close();
  }
}
