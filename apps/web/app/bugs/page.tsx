/** The tenant-visible bug board, projected from feedback items. */
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { listBugBoard } from '@wizard-ads/db';
import { can } from '../../src/auth/roles';
import { toUiItem } from '../../src/feedback/ui';
import { requireOrgRole } from '../../src/server/org-role';
import { isUnauthenticated, openWebDatabase, requestActor } from '../../src/server/request-context';
import { heading, muted, page } from '../../src/ui/tokens';
import { BugBoardView } from './board';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function BugsPage() {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(await headers());
    const role = await requireOrgRole(database, actor);
    const board = await listBugBoard(database, { orgId: actor.orgId, viewerId: actor.userId });
    const map = (items: typeof board.open) => items.map((item) => toUiItem(item, actor.userId));
    return (
      <BugBoardView
        open={map(board.open)}
        inProgress={map(board.inProgress)}
        fixed={map(board.fixed)}
        declined={map(board.declined)}
        duplicates={map(board.duplicates)}
        canTriage={can(role, 'triageFeedback')}
      />
    );
  } catch (error) {
    if (isUnauthenticated(error)) redirect('/login');
    const message = error instanceof Error ? error.message : 'The bug board is unavailable';
    return (
      <main style={page}>
        <h1 style={heading}>Bugs</h1>
        <p role="alert">{message}</p>
        <p style={muted}>Nothing was read; this is the board refusing, not an empty board.</p>
      </main>
    );
  } finally {
    await database.close();
  }
}
