/**
 * Feedback items, votes, and the roadmap read model (WP-15).
 *
 * Every function here takes an `orgId` and puts it in the WHERE clause, even
 * where RLS would already do it. The web request handle connects as the
 * application's own role rather than as `authenticated`, so RLS is the second
 * fence and not the first: a query that forgets the org predicate would be a
 * cross-tenant read in the browser even though the same query is safe from
 * PostgREST. The two layers are tested separately for that reason.
 *
 * The author/status rules are likewise enforced twice: `app.feedback_guard_update`
 * refuses the write in the database, and the update helpers below scope their
 * statements so a refused write affects zero rows and throws here. The trigger
 * is the truth; these predicates are what turn "nothing happened" into an error
 * the route can turn into a 403.
 */
import type { DbHandle } from '../client.js';
import type { JsonValue } from './goto.js';
import { toDate } from './pg-time.js';

export type FeedbackQueryHandle = Pick<DbHandle, 'sql'>;

export const FEEDBACK_TYPES = ['bug', 'feature'] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

export const FEEDBACK_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type FeedbackSeverity = (typeof FEEDBACK_SEVERITIES)[number];

export const FEEDBACK_STATUSES = [
  'new',
  'triaged',
  'planned',
  'in_progress',
  'shipped',
  'declined',
] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** The three roadmap columns, in the order they are shown. */
export const ROADMAP_STATUSES = ['planned', 'in_progress', 'shipped'] as const;

/** Open means "still on somebody's plate": not shipped, not declined. */
export const OPEN_FEEDBACK_STATUSES = ['new', 'triaged', 'planned', 'in_progress'] as const;

export type FeedbackSort = 'votes' | 'newest';

export interface FeedbackItemRecord {
  id: string;
  orgId: string;
  authorId: string | null;
  type: FeedbackType;
  title: string;
  body: string;
  severity: FeedbackSeverity | null;
  status: FeedbackStatus;
  adminNote: string | null;
  pageContext: JsonValue;
  votes: number;
  /** Whether the viewer named in the query has voted. False when none was. */
  viewerHasVoted: boolean;
  createdAt: Date;
  updatedAt: Date;
  statusChangedAt: Date;
}

export interface FeedbackCounts {
  openBugs: number;
  openFeatures: number;
  shipped: number;
  declined: number;
  total: number;
}

export interface CreateFeedbackInput {
  orgId: string;
  authorId?: string | null;
  type: FeedbackType;
  title: string;
  body?: string;
  severity?: FeedbackSeverity | null;
  pageContext?: JsonValue;
}

export interface ListFeedbackInput {
  orgId: string;
  viewerId?: string | null;
  type?: FeedbackType | null;
  status?: FeedbackStatus | null;
  statuses?: readonly FeedbackStatus[] | null;
  sort?: FeedbackSort;
  limit?: number;
}

export interface RoadmapBoard {
  planned: FeedbackItemRecord[];
  inProgress: FeedbackItemRecord[];
  shipped: FeedbackItemRecord[];
  /** Shown collapsed, with the admin note: honesty beats silence. */
  declined: FeedbackItemRecord[];
}

interface FeedbackRow {
  id: string;
  org_id: string;
  author_id: string | null;
  type: FeedbackType;
  title: string;
  body: string;
  severity: FeedbackSeverity | null;
  status: FeedbackStatus;
  admin_note: string | null;
  page_context: JsonValue;
  votes: string | number;
  viewer_has_voted: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  status_changed_at: Date | string;
}

const toItem = (row: FeedbackRow): FeedbackItemRecord => ({
  id: row.id,
  orgId: row.org_id,
  authorId: row.author_id,
  type: row.type,
  title: row.title,
  body: row.body,
  severity: row.severity,
  status: row.status,
  adminNote: row.admin_note,
  pageContext: row.page_context,
  votes: Number(row.votes),
  viewerHasVoted: row.viewer_has_voted,
  createdAt: toDate(row.created_at),
  updatedAt: toDate(row.updated_at),
  statusChangedAt: toDate(row.status_changed_at),
});

export class FeedbackNotFound extends Error {
  constructor(message = 'Feedback item not found') {
    super(message);
    this.name = 'FeedbackNotFound';
  }
}

export class FeedbackNotEditable extends Error {
  constructor(message = 'A feedback item can only be edited by its author while it is new') {
    super(message);
    this.name = 'FeedbackNotEditable';
  }
}

export function normalizeFeedbackTitle(title: string): string {
  const normalized = title.trim().replace(/\s+/g, ' ');
  if (!normalized) throw new Error('A feedback title cannot be empty');
  if (normalized.length > 200) throw new Error('A feedback title cannot exceed 200 characters');
  return normalized;
}

export function normalizeFeedbackBody(body: string | undefined): string {
  const normalized = (body ?? '').trim();
  if (normalized.length > 20_000) {
    throw new Error('A feedback description cannot exceed 20000 characters');
  }
  return normalized;
}

/**
 * Severity belongs to bugs. Rejected here as well as by the check constraint,
 * because a caller deserves the reason rather than a constraint name.
 */
export function normalizeFeedbackSeverity(
  type: FeedbackType,
  severity: FeedbackSeverity | null | undefined,
): FeedbackSeverity | null {
  if (severity === null || severity === undefined) return null;
  if (type !== 'bug') throw new Error('Only a bug report carries a severity');
  if (!FEEDBACK_SEVERITIES.includes(severity)) throw new Error(`Unknown severity: ${severity}`);
  return severity;
}

function serializeContext(context: JsonValue | undefined): string {
  const serialized = JSON.stringify(context ?? {});
  if (serialized === undefined) throw new Error('Feedback page context must be JSON-serializable');
  return serialized;
}

export async function createFeedbackItem(
  handle: FeedbackQueryHandle,
  input: CreateFeedbackInput,
): Promise<FeedbackItemRecord> {
  if (!FEEDBACK_TYPES.includes(input.type)) throw new Error(`Unknown feedback type: ${input.type}`);
  const title = normalizeFeedbackTitle(input.title);
  const body = normalizeFeedbackBody(input.body);
  const severity = normalizeFeedbackSeverity(input.type, input.severity);

  const rows = await handle.sql<{ id: string }[]>`
    insert into public.feedback_items
      (org_id, author_id, type, title, body, severity, page_context)
    values (
      ${input.orgId}, ${input.authorId ?? null}, ${input.type}::public.feedback_type,
      ${title}, ${body}, ${severity}::public.feedback_severity,
      ${serializeContext(input.pageContext)}::text::jsonb
    )
    returning id
  `;
  const id = rows[0]?.id;
  if (!id) throw new Error('Creating a feedback item returned no row');
  const created = await getFeedbackItem(handle, {
    orgId: input.orgId,
    itemId: id,
    viewerId: input.authorId ?? null,
  });
  if (!created) throw new Error('A feedback item was created but could not be read back');
  return created;
}

export async function getFeedbackItem(
  handle: FeedbackQueryHandle,
  input: { orgId: string; itemId: string; viewerId?: string | null },
): Promise<FeedbackItemRecord | null> {
  const viewerId = input.viewerId ?? null;
  const rows = await handle.sql<FeedbackRow[]>`
    select i.id, i.org_id, i.author_id, i.type::text as type, i.title, i.body,
           i.severity::text as severity, i.status::text as status, i.admin_note, i.page_context,
           (select count(*) from public.feedback_votes v where v.item_id = i.id) as votes,
           exists(
             select 1 from public.feedback_votes v
              where v.item_id = i.id and v.user_id = ${viewerId}::uuid
           ) as viewer_has_voted,
           i.created_at, i.updated_at, i.status_changed_at
      from public.feedback_items i
     where i.org_id = ${input.orgId} and i.id = ${input.itemId}
  `;
  return rows[0] ? toItem(rows[0]) : null;
}

export async function listFeedbackItems(
  handle: FeedbackQueryHandle,
  input: ListFeedbackInput,
): Promise<FeedbackItemRecord[]> {
  const viewerId = input.viewerId ?? null;
  const statuses = input.statuses?.length ? [...input.statuses] : null;
  const sort: FeedbackSort = input.sort ?? 'newest';
  const limit = input.limit ?? 500;

  const rows = await handle.sql<FeedbackRow[]>`
    select i.id, i.org_id, i.author_id, i.type::text as type, i.title, i.body,
           i.severity::text as severity, i.status::text as status, i.admin_note, i.page_context,
           (select count(*) from public.feedback_votes v where v.item_id = i.id) as votes,
           exists(
             select 1 from public.feedback_votes v
              where v.item_id = i.id and v.user_id = ${viewerId}::uuid
           ) as viewer_has_voted,
           i.created_at, i.updated_at, i.status_changed_at
      from public.feedback_items i
     where i.org_id = ${input.orgId}
       and (${input.type ?? null}::text is null or i.type::text = ${input.type ?? null})
       and (${input.status ?? null}::text is null or i.status::text = ${input.status ?? null})
       and (${statuses}::text[] is null or i.status::text = any(${statuses}::text[]))
     -- One statement rather than two, so the projection cannot drift between
     -- the two orderings. The CASE collapses to a constant per query.
     order by (case when ${sort} = 'votes'
                    then (select count(*) from public.feedback_votes v where v.item_id = i.id)
                    else 0 end) desc,
              i.created_at desc, i.id
     limit ${limit}
  `;
  return rows.map(toItem);
}

export async function countFeedback(
  handle: FeedbackQueryHandle,
  orgId: string,
): Promise<FeedbackCounts> {
  const rows = await handle.sql<
    { open_bugs: string; open_features: string; shipped: string; declined: string; total: string }[]
  >`
    -- The open statuses are spelled out rather than bound: they are constants
    -- of this module, and an enum array parameter is the one shape the driver
    -- and the server disagree about.
    select
      count(*) filter (
        where type = 'bug' and status in ('new', 'triaged', 'planned', 'in_progress')
      ) as open_bugs,
      count(*) filter (
        where type = 'feature' and status in ('new', 'triaged', 'planned', 'in_progress')
      ) as open_features,
      count(*) filter (where status = 'shipped') as shipped,
      count(*) filter (where status = 'declined') as declined,
      count(*) as total
    from public.feedback_items
   where org_id = ${orgId}
  `;
  const row = rows[0];
  return {
    openBugs: Number(row?.open_bugs ?? 0),
    openFeatures: Number(row?.open_features ?? 0),
    shipped: Number(row?.shipped ?? 0),
    declined: Number(row?.declined ?? 0),
    total: Number(row?.total ?? 0),
  };
}

/**
 * The board. One query, split in memory, so the three columns are guaranteed to
 * come from the same snapshot and the same vote counts.
 */
export async function listRoadmap(
  handle: FeedbackQueryHandle,
  input: { orgId: string; viewerId?: string | null },
): Promise<RoadmapBoard> {
  const items = await listFeedbackItems(handle, {
    orgId: input.orgId,
    viewerId: input.viewerId ?? null,
    statuses: [...ROADMAP_STATUSES, 'declined'],
    sort: 'votes',
  });
  return {
    planned: items.filter((item) => item.status === 'planned'),
    inProgress: items.filter((item) => item.status === 'in_progress'),
    shipped: items.filter((item) => item.status === 'shipped'),
    declined: items.filter((item) => item.status === 'declined'),
  };
}

/**
 * Cast or withdraw one person's vote, and report the resulting count.
 *
 * A delete that removed a row means the vote was on; otherwise it is inserted.
 * `on conflict do nothing` covers the double-click that races itself, and the
 * returned count is read after the write rather than incremented in memory.
 */
export async function toggleFeedbackVote(
  handle: FeedbackQueryHandle,
  input: { orgId: string; itemId: string; userId: string },
): Promise<{ itemId: string; voted: boolean; votes: number }> {
  const exists = await handle.sql<{ id: string }[]>`
    select id from public.feedback_items
     where org_id = ${input.orgId} and id = ${input.itemId}
  `;
  if (!exists[0]) throw new FeedbackNotFound();

  const removed = await handle.sql<{ item_id: string }[]>`
    delete from public.feedback_votes
     where org_id = ${input.orgId} and item_id = ${input.itemId} and user_id = ${input.userId}
    returning item_id
  `;
  if (removed.length === 0) {
    await handle.sql`
      insert into public.feedback_votes (item_id, org_id, user_id)
      values (${input.itemId}, ${input.orgId}, ${input.userId})
      on conflict (item_id, user_id) do nothing
    `;
  }

  const counted = await handle.sql<{ votes: string; voted: boolean }[]>`
    select
      (select count(*) from public.feedback_votes v where v.item_id = ${input.itemId}) as votes,
      exists(
        select 1 from public.feedback_votes v
         where v.item_id = ${input.itemId} and v.user_id = ${input.userId}
      ) as voted
  `;
  return {
    itemId: input.itemId,
    voted: counted[0]?.voted ?? false,
    votes: Number(counted[0]?.votes ?? 0),
  };
}

/** Triage. Owner/admin only; the caller checks the role, the database checks it again. */
export async function setFeedbackStatus(
  handle: FeedbackQueryHandle,
  input: {
    orgId: string;
    itemId: string;
    status?: FeedbackStatus;
    adminNote?: string | null;
    viewerId?: string | null;
  },
): Promise<FeedbackItemRecord> {
  if (input.status === undefined && input.adminNote === undefined) {
    throw new Error('A triage update must change the status or the note');
  }
  if (input.status !== undefined && !FEEDBACK_STATUSES.includes(input.status)) {
    throw new Error(`Unknown feedback status: ${input.status}`);
  }
  // "Clear the note" and "leave the note alone" are different requests, and a
  // plain coalesce cannot tell them apart: the flag is what keeps an empty
  // string from being read as "no opinion".
  const noteProvided = input.adminNote !== undefined;
  const note = noteProvided ? (input.adminNote?.trim() || null) : null;

  const rows = await handle.sql<{ id: string }[]>`
    update public.feedback_items
       set status = coalesce(${input.status ?? null}::public.feedback_status, status),
           admin_note = case when ${noteProvided} then ${note}::text else admin_note end
     where org_id = ${input.orgId} and id = ${input.itemId}
    returning id
  `;
  const id = rows[0]?.id;
  if (!id) throw new FeedbackNotFound();
  const item = await getFeedbackItem(handle, {
    orgId: input.orgId,
    itemId: id,
    viewerId: input.viewerId ?? null,
  });
  if (!item) throw new FeedbackNotFound();
  return item;
}

/** The author's own correction, allowed only while the item is untriaged. */
export async function updateFeedbackContent(
  handle: FeedbackQueryHandle,
  input: {
    orgId: string;
    itemId: string;
    authorId: string;
    title?: string;
    body?: string;
    severity?: FeedbackSeverity | null;
  },
): Promise<FeedbackItemRecord> {
  if (input.title === undefined && input.body === undefined && input.severity === undefined) {
    throw new Error('An edit must change the title, the description or the severity');
  }
  const current = await getFeedbackItem(handle, {
    orgId: input.orgId,
    itemId: input.itemId,
    viewerId: input.authorId,
  });
  if (!current) throw new FeedbackNotFound();
  if (current.authorId !== input.authorId || current.status !== 'new') {
    throw new FeedbackNotEditable();
  }

  const title = input.title === undefined ? current.title : normalizeFeedbackTitle(input.title);
  const body = input.body === undefined ? current.body : normalizeFeedbackBody(input.body);
  const severity =
    input.severity === undefined
      ? current.severity
      : normalizeFeedbackSeverity(current.type, input.severity);

  const rows = await handle.sql<{ id: string }[]>`
    update public.feedback_items
       set title = ${title}, body = ${body}, severity = ${severity}::public.feedback_severity
     where org_id = ${input.orgId}
       and id = ${input.itemId}
       and author_id = ${input.authorId}
       and status = 'new'
    returning id
  `;
  if (!rows[0]) throw new FeedbackNotEditable();
  const item = await getFeedbackItem(handle, {
    orgId: input.orgId,
    itemId: input.itemId,
    viewerId: input.authorId,
  });
  if (!item) throw new FeedbackNotFound();
  return item;
}
