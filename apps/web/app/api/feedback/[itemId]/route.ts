/**
 * One item: read it, triage it, or correct it.
 *
 * PATCH carries two different requests and therefore two different checks. A
 * status or an admin note is triage, and needs the `triageFeedback` capability;
 * a title, description or severity is the author correcting their own
 * submission, and needs to be the author of an untriaged item — which the
 * query layer and the database's guard trigger both enforce, so a 403 here is
 * the third fence rather than the only one.
 */
import { getFeedbackItem, setFeedbackStatus, updateFeedbackContent } from '@wizard-ads/db';
import { FEEDBACK_STATUSES } from '@wizard-ads/db';
import type { FeedbackSeverity, FeedbackStatus } from '@wizard-ads/db';
import { requestActor, openWebDatabase } from '../../../../src/server/request-context';
import { requireCapability, requireOrgRole } from '../../../../src/server/org-role';
import { feedbackErrorResponse } from '../../../../src/feedback/http';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ itemId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    await requireOrgRole(database, actor);
    const { itemId } = await context.params;
    const item = await getFeedbackItem(database, {
      orgId: actor.orgId,
      itemId,
      viewerId: actor.userId,
    });
    if (!item) return Response.json({ error: 'Feedback item not found' }, { status: 404 });
    return Response.json({ item });
  } catch (error) {
    return feedbackErrorResponse(error);
  } finally {
    await database.close();
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    const { itemId } = await context.params;
    const body = (await request.json()) as {
      status?: unknown;
      adminNote?: unknown;
      title?: unknown;
      body?: unknown;
      severity?: unknown;
    };

    const wantsTriage = body.status !== undefined || body.adminNote !== undefined;
    const wantsEdit =
      body.title !== undefined || body.body !== undefined || body.severity !== undefined;
    if (wantsTriage && wantsEdit) {
      throw new Error('Triage and an author edit are separate requests');
    }

    if (wantsTriage) {
      await requireCapability(database, actor, 'triageFeedback');
      if (body.status !== undefined && typeof body.status !== 'string') {
        throw new Error('status must be a string');
      }
      if (
        typeof body.status === 'string' &&
        !(FEEDBACK_STATUSES as readonly string[]).includes(body.status)
      ) {
        throw new Error(`status must be one of: ${FEEDBACK_STATUSES.join(', ')}`);
      }
      const item = await setFeedbackStatus(database, {
        orgId: actor.orgId,
        itemId,
        viewerId: actor.userId,
        ...(typeof body.status === 'string' ? { status: body.status as FeedbackStatus } : {}),
        ...(body.adminNote === undefined
          ? {}
          : { adminNote: typeof body.adminNote === 'string' ? body.adminNote : null }),
      });
      return Response.json({ item });
    }

    if (!wantsEdit) throw new Error('Nothing to change');
    await requireOrgRole(database, actor);
    const item = await updateFeedbackContent(database, {
      orgId: actor.orgId,
      itemId,
      authorId: actor.userId,
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.body === 'string' ? { body: body.body } : {}),
      ...(body.severity === undefined
        ? {}
        : {
            severity:
              typeof body.severity === 'string' ? (body.severity as FeedbackSeverity) : null,
          }),
    });
    return Response.json({ item });
  } catch (error) {
    return feedbackErrorResponse(error);
  } finally {
    await database.close();
  }
}
