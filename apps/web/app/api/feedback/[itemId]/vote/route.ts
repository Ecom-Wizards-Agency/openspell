/**
 * One person's vote on one item, as a toggle.
 *
 * POST rather than PUT/DELETE because the client never has to know which of the
 * two it wants: the response says what the state became and what the count is
 * now, both read back from the database after the write. Voting needs no
 * capability beyond membership — a viewer's vote is the point of having votes.
 */
import { toggleFeedbackVote } from '@wizard-ads/db';
import { requestActor, openWebDatabase } from '../../../../../src/server/request-context';
import { requireOrgRole } from '../../../../../src/server/org-role';
import { feedbackErrorResponse } from '../../../../../src/feedback/http';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ itemId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    await requireOrgRole(database, actor);
    const { itemId } = await context.params;
    const result = await toggleFeedbackVote(database, {
      orgId: actor.orgId,
      itemId,
      userId: actor.userId,
    });
    return Response.json(result);
  } catch (error) {
    return feedbackErrorResponse(error);
  } finally {
    await database.close();
  }
}
