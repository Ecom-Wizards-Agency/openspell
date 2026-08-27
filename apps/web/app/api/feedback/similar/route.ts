/**
 * Deterministic duplicate hints for the bug widget.
 *
 * This route does no semantic work. It resolves one member in one organisation
 * and delegates the bounded, open-bug-only title match to the database layer.
 */
import { findSimilarOpenBugs } from '@wizard-ads/db';
import { feedbackErrorResponse } from '../../../../src/feedback/http';
import { toUiItem } from '../../../../src/feedback/ui';
import { requireOrgRole } from '../../../../src/server/org-role';
import { openWebDatabase, requestActor } from '../../../../src/server/request-context';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    await requireOrgRole(database, actor);
    const query = new URL(request.url).searchParams.get('q') ?? '';
    const items = await findSimilarOpenBugs(database, {
      orgId: actor.orgId,
      viewerId: actor.userId,
      query,
    });
    return Response.json({ items: items.map((item) => toUiItem(item, actor.userId)) });
  } catch (error) {
    return feedbackErrorResponse(error);
  } finally {
    await database.close();
  }
}
