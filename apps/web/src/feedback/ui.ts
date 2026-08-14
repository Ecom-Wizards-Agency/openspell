/**
 * The shape the feedback screens render.
 *
 * A server component may not hand a client component a `Date` and a nested
 * `JsonValue` and expect either side to agree about them later, so the record
 * is flattened once, here, and both the tracker and the roadmap read the same
 * flattening. "Is this mine" is resolved on the server too: the client never
 * sees another member's user id just to compare it against its own.
 */
import type { FeedbackItemRecord } from '@wizard-ads/db';

export interface UiFeedbackItem {
  id: string;
  type: 'bug' | 'feature';
  title: string;
  body: string;
  severity: string | null;
  status: string;
  adminNote: string | null;
  votes: number;
  viewerHasVoted: boolean;
  viewerIsAuthor: boolean;
  route: string | null;
  profileId: string | null;
  createdAt: string;
}

/** Read one string field out of a page-context document that may be anything. */
function contextField(context: unknown, field: string): string | null {
  if (typeof context !== 'object' || context === null || Array.isArray(context)) return null;
  const value = (context as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : null;
}

export function toUiItem(item: FeedbackItemRecord, viewerId: string | null): UiFeedbackItem {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    body: item.body,
    severity: item.severity,
    status: item.status,
    adminNote: item.adminNote,
    votes: item.votes,
    viewerHasVoted: item.viewerHasVoted,
    viewerIsAuthor: viewerId !== null && item.authorId === viewerId,
    route: contextField(item.pageContext, 'route'),
    profileId: contextField(item.pageContext, 'profileId'),
    createdAt: item.createdAt.toISOString(),
  };
}

export const STATUS_LABELS: Record<string, string> = {
  new: 'New',
  triaged: 'Triaged',
  planned: 'Planned',
  in_progress: 'In progress',
  shipped: 'Shipped',
  declined: 'Declined',
};
