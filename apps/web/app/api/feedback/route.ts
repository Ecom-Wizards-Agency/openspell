/**
 * The tracker's list and the submit form's write.
 *
 * Both go through the same actor boundary the tag routes use: the request
 * resolves to one user in one org, and every query names that org. The role is
 * read here too, so the client can hide the triage controls — the hiding is
 * decoration, and `[itemId]/route.ts` is the enforcement.
 */
import {
  FEEDBACK_STATUSES,
  FEEDBACK_TYPES,
  countFeedback,
  createFeedbackItem,
  listFeedbackItems,
} from '@wizard-ads/db';
import type { FeedbackSeverity, FeedbackStatus, FeedbackType } from '@wizard-ads/db';
import { requestActor, openWebDatabase } from '../../../src/server/request-context';
import { requireOrgRole } from '../../../src/server/org-role';
import { feedbackErrorResponse } from '../../../src/feedback/http';
import { pageContext } from '../../../src/feedback/page-context';
import { toUiItem } from '../../../src/feedback/ui';
import { can } from '../../../src/auth/roles';

export const runtime = 'nodejs';

const asType = (value: string | null): FeedbackType | null =>
  value !== null && (FEEDBACK_TYPES as readonly string[]).includes(value)
    ? (value as FeedbackType)
    : null;

const asStatus = (value: string | null): FeedbackStatus | null =>
  value !== null && (FEEDBACK_STATUSES as readonly string[]).includes(value)
    ? (value as FeedbackStatus)
    : null;

export async function GET(request: Request): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    const role = await requireOrgRole(database, actor);
    const query = new URL(request.url).searchParams;
    const [items, counts] = await Promise.all([
      listFeedbackItems(database, {
        orgId: actor.orgId,
        viewerId: actor.userId,
        type: asType(query.get('type')),
        status: asStatus(query.get('status')),
        sort: query.get('sort') === 'votes' ? 'votes' : 'newest',
      }),
      countFeedback(database, actor.orgId),
    ]);
    return Response.json({
      // The same flattening the server-rendered first load uses, so the list
      // does not change shape the first time a filter is touched.
      items: items.map((item) => toUiItem(item, actor.userId)),
      counts,
      role,
      canTriage: can(role, 'triageFeedback'),
    });
  } catch (error) {
    return feedbackErrorResponse(error);
  } finally {
    await database.close();
  }
}

export async function POST(request: Request): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    // Filing feedback is every member's right, so membership is the only check.
    await requireOrgRole(database, actor);
    const body = (await request.json()) as {
      type?: unknown;
      title?: unknown;
      body?: unknown;
      severity?: unknown;
      pageContext?: { route?: unknown; profileId?: unknown; appVersion?: unknown };
    };

    const type = asType(typeof body.type === 'string' ? body.type : null);
    if (type === null) throw new Error('type must be bug or feature');
    if (typeof body.title !== 'string') throw new Error('title is required');

    const context = pageContext({
      route: typeof body.pageContext?.route === 'string' ? body.pageContext.route : null,
      profileId:
        typeof body.pageContext?.profileId === 'string' ? body.pageContext.profileId : null,
      appVersion:
        typeof body.pageContext?.appVersion === 'string' ? body.pageContext.appVersion : null,
      actorType: 'user',
    });

    const item = await createFeedbackItem(database, {
      orgId: actor.orgId,
      authorId: actor.userId,
      type,
      title: body.title,
      body: typeof body.body === 'string' ? body.body : '',
      severity: typeof body.severity === 'string' ? (body.severity as FeedbackSeverity) : null,
      pageContext: { ...context },
    });
    return Response.json({ item }, { status: 201 });
  } catch (error) {
    return feedbackErrorResponse(error);
  } finally {
    await database.close();
  }
}
