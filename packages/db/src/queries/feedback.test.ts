/**
 * WP-15's database half: the tracker's reads, the vote's uniqueness, and the
 * two authorization rules that cannot be expressed as a policy alone.
 *
 * The query helpers run on the admin handle, which is what the web request
 * layer uses, so they prove the org predicates. The rules that a browser client
 * would meet run through `asUser`, which switches role and JWT claims exactly
 * as PostgREST does, so a policy that passes here passes there.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '../testing/harness.js';
import { asUser } from '../testing/rls.js';
import type { TestDatabase } from '../testing/harness.js';
import {
  FeedbackNotEditable,
  FeedbackNotFound,
  OPEN_FEEDBACK_STATUSES,
  countFeedback,
  createFeedbackItem,
  findSimilarOpenBugs,
  getFeedbackItem,
  listBugBoard,
  listFeedbackItems,
  listRoadmap,
  markFeedbackDuplicate,
  setFeedbackStatus,
  toggleFeedbackVote,
  updateFeedbackContent,
} from './feedback.js';

const available = await databaseAvailable();

const OWNER_A = '15151515-1515-4151-8151-151515151515';
const VIEWER_A = '15252525-2525-4252-8252-252525252525';
const OWNER_B = '15353535-3535-4353-8353-353535353535';

describe.skipIf(!available)('WP-15 feedback queries', () => {
  let database: TestDatabase;
  let orgA: string;
  let orgB: string;
  /** The item the tenant fixture seeds for org B, used for the negatives. */
  let foreignItem: string;

  beforeAll(async () => {
    database = await createTestDatabase('wp15_feedback');
    const [a] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('feedback-alpha', ${OWNER_A}, 'owner')
    `;
    const [b] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('feedback-bravo', ${OWNER_B}, 'owner')
    `;
    orgA = a?.seed_tenant_fixture ?? '';
    orgB = b?.seed_tenant_fixture ?? '';

    await database.sql`select public.auth_user_stub(${VIEWER_A})`;
    await database.sql`
      insert into public.org_members (org_id, user_id, role) values (${orgA}, ${VIEWER_A}, 'viewer')
    `;

    const [foreign] = await database.sql<{ id: string }[]>`
      select id from public.feedback_items where org_id = ${orgB} limit 1
    `;
    foreignItem = foreign?.id ?? '';
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('files a bug with its page context and counts it as open', async () => {
    const before = await countFeedback(database, orgA);
    const item = await createFeedbackItem(database, {
      orgId: orgA,
      authorId: OWNER_A,
      type: 'bug',
      title: '  The grid  loses the sort  ',
      body: 'Sorting by spend resets on reload.',
      severity: 'high',
      pageContext: { route: '/grid?state=1', profileId: 'p-1', appVersion: '0.1.0' },
    });

    expect(item.title).toBe('The grid loses the sort');
    expect(item.status).toBe('new');
    expect(item.severity).toBe('high');
    expect(item.votes).toBe(0);
    expect(item.viewerHasVoted).toBe(false);
    // The context survives as an object, not as a JSON string.
    expect(item.pageContext).toEqual({
      route: '/grid?state=1',
      profileId: 'p-1',
      appVersion: '0.1.0',
    });

    const after = await countFeedback(database, orgA);
    expect(after.openBugs).toBe(before.openBugs + 1);
    expect(after.openFeatures).toBe(before.openFeatures);
    expect(after.total).toBe(before.total + 1);

    // The counts and the list agree on what "open" means: the SQL spells the
    // statuses out, and this is what keeps that literal tied to the constant.
    const open = await listFeedbackItems(database, {
      orgId: orgA,
      statuses: OPEN_FEEDBACK_STATUSES,
    });
    expect(open.length).toBe(after.openBugs + after.openFeatures);

    const bugs = await listFeedbackItems(database, { orgId: orgA, type: 'bug' });
    const features = await listFeedbackItems(database, { orgId: orgA, type: 'feature' });
    const all = await listFeedbackItems(database, { orgId: orgA });
    expect(bugs.map((row) => row.id)).toContain(item.id);
    expect(features.map((row) => row.id)).not.toContain(item.id);
    // The filtered views partition the list rather than overlapping it.
    expect(bugs.length + features.length).toBe(all.length);
  });

  it('refuses a severity on a feature request', async () => {
    await expect(
      createFeedbackItem(database, {
        orgId: orgA,
        authorId: OWNER_A,
        type: 'feature',
        title: 'Severity does not belong here',
        severity: 'critical',
      }),
    ).rejects.toThrow(/only a bug report carries a severity/i);
  });

  it('toggles a vote on and off, and counts it once per person', async () => {
    const item = await createFeedbackItem(database, {
      orgId: orgA,
      authorId: OWNER_A,
      type: 'feature',
      title: 'Saved views',
    });

    const on = await toggleFeedbackVote(database, {
      orgId: orgA,
      itemId: item.id,
      userId: OWNER_A,
    });
    expect(on).toEqual({ itemId: item.id, voted: true, votes: 1 });

    const second = await toggleFeedbackVote(database, {
      orgId: orgA,
      itemId: item.id,
      userId: VIEWER_A,
    });
    expect(second).toEqual({ itemId: item.id, voted: true, votes: 2 });

    const off = await toggleFeedbackVote(database, {
      orgId: orgA,
      itemId: item.id,
      userId: OWNER_A,
    });
    expect(off).toEqual({ itemId: item.id, voted: false, votes: 1 });

    // The viewer's vote is still visible to them and only to them.
    const seenByViewer = await getFeedbackItem(database, {
      orgId: orgA,
      itemId: item.id,
      viewerId: VIEWER_A,
    });
    const seenByOwner = await getFeedbackItem(database, {
      orgId: orgA,
      itemId: item.id,
      viewerId: OWNER_A,
    });
    expect(seenByViewer?.viewerHasVoted).toBe(true);
    expect(seenByOwner?.viewerHasVoted).toBe(false);
    expect(seenByOwner?.votes).toBe(1);

    // And the constraint, not the helper, is what makes a double vote impossible.
    await expect(
      database.sql`
        insert into public.feedback_votes (item_id, org_id, user_id)
        values (${item.id}, ${orgA}, ${VIEWER_A})
      `,
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('refuses a vote on an item that is not this org’s', async () => {
    await expect(
      toggleFeedbackVote(database, { orgId: orgA, itemId: foreignItem, userId: OWNER_A }),
    ).rejects.toBeInstanceOf(FeedbackNotFound);
  });

  it('orders the roadmap by votes and files declined items under their note', async () => {
    const popular = await createFeedbackItem(database, {
      orgId: orgA,
      authorId: OWNER_A,
      type: 'feature',
      title: 'Bulk apply',
    });
    const quiet = await createFeedbackItem(database, {
      orgId: orgA,
      authorId: OWNER_A,
      type: 'feature',
      title: 'Dark mode',
    });
    const rejected = await createFeedbackItem(database, {
      orgId: orgA,
      authorId: OWNER_A,
      type: 'feature',
      title: 'Public portal',
    });

    for (const user of [OWNER_A, VIEWER_A]) {
      await toggleFeedbackVote(database, { orgId: orgA, itemId: popular.id, userId: user });
    }
    await toggleFeedbackVote(database, { orgId: orgA, itemId: quiet.id, userId: OWNER_A });

    await setFeedbackStatus(database, { orgId: orgA, itemId: popular.id, status: 'planned' });
    await setFeedbackStatus(database, { orgId: orgA, itemId: quiet.id, status: 'planned' });
    const declined = await setFeedbackStatus(database, {
      orgId: orgA,
      itemId: rejected.id,
      status: 'declined',
      adminNote: 'Not in v1: no public surface until org scoping is proven.',
    });
    expect(declined.adminNote).toContain('Not in v1');
    // The status clock follows the status, not the row.
    expect(declined.statusChangedAt.getTime()).toBeGreaterThanOrEqual(
      declined.createdAt.getTime(),
    );

    const board = await listRoadmap(database, { orgId: orgA, viewerId: VIEWER_A });
    const plannedIds = board.planned.map((row) => row.id);
    expect(plannedIds.indexOf(popular.id)).toBeLessThan(plannedIds.indexOf(quiet.id));
    expect(board.planned.find((row) => row.id === popular.id)?.votes).toBe(2);
    expect(board.declined.map((row) => row.id)).toContain(rejected.id);
    expect(board.declined.find((row) => row.id === rejected.id)?.adminNote).toContain('Not in v1');
    // A card moves between columns on a status change, and lands in exactly one.
    await setFeedbackStatus(database, { orgId: orgA, itemId: popular.id, status: 'in_progress' });
    const moved = await listRoadmap(database, { orgId: orgA, viewerId: VIEWER_A });
    expect(moved.planned.map((row) => row.id)).not.toContain(popular.id);
    expect(moved.inProgress.map((row) => row.id)).toContain(popular.id);
  });

  it('sorts the tracker by votes or by recency, on request', async () => {
    const byVotes = await listFeedbackItems(database, { orgId: orgA, sort: 'votes' });
    const byNewest = await listFeedbackItems(database, { orgId: orgA, sort: 'newest' });
    expect(byVotes.length).toBe(byNewest.length);
    for (let index = 1; index < byVotes.length; index += 1) {
      expect(byVotes[index - 1]?.votes ?? 0).toBeGreaterThanOrEqual(byVotes[index]?.votes ?? 0);
    }
    for (let index = 1; index < byNewest.length; index += 1) {
      expect((byNewest[index - 1]?.createdAt.getTime() ?? 0)).toBeGreaterThanOrEqual(
        byNewest[index]?.createdAt.getTime() ?? 0,
      );
    }
  });

  it('finds only matching open bugs in the named organisation', async () => {
    const match = await createFeedbackItem(database, {
      orgId: orgA,
      authorId: OWNER_A,
      type: 'bug',
      title: 'Export loses the selected sort',
    });
    const closed = await createFeedbackItem(database, {
      orgId: orgA,
      authorId: OWNER_A,
      type: 'bug',
      title: 'Export loses the selected sort after closing',
    });
    await setFeedbackStatus(database, {
      orgId: orgA,
      itemId: closed.id,
      status: 'declined',
    });
    const foreign = await createFeedbackItem(database, {
      orgId: orgB,
      authorId: OWNER_B,
      type: 'bug',
      title: 'Export loses the selected sort in another org',
    });

    const similar = await findSimilarOpenBugs(database, {
      orgId: orgA,
      viewerId: OWNER_A,
      query: 'loses the selected sort',
    });
    expect(similar.map((item) => item.id)).toEqual([match.id]);
    expect(similar.map((item) => item.id)).not.toContain(foreign.id);
    expect(await findSimilarOpenBugs(database, { orgId: orgA, query: 'lo' })).toEqual([]);
  });

  it('marks a same-org item as a duplicate and nests it in the bug read model', async () => {
    const target = await createFeedbackItem(database, {
      orgId: orgA,
      authorId: OWNER_A,
      type: 'bug',
      title: 'Canonical export failure',
    });
    const duplicate = await createFeedbackItem(database, {
      orgId: orgA,
      authorId: VIEWER_A,
      type: 'bug',
      title: 'Export fails in the same way',
    });

    const marked = await markFeedbackDuplicate(database, {
      orgId: orgA,
      itemId: duplicate.id,
      duplicateOf: target.id,
      viewerId: OWNER_A,
    });
    expect(marked.status).toBe('declined');
    expect(marked.adminNote).toBe(`duplicate of #${target.id}`);
    expect(marked.duplicateOf).toBe(target.id);
    expect(marked.dedupCheckedAt).toBeNull();

    const board = await listBugBoard(database, { orgId: orgA, viewerId: OWNER_A });
    expect(board.open.map((item) => item.id)).toContain(target.id);
    expect(board.duplicates.map((item) => item.id)).toContain(duplicate.id);
    expect(board.declined.map((item) => item.id)).not.toContain(duplicate.id);

    await expect(
      markFeedbackDuplicate(database, {
        orgId: orgA,
        itemId: duplicate.id,
        duplicateOf: foreignItem,
      }),
    ).rejects.toBeInstanceOf(FeedbackNotFound);

    const reopened = await setFeedbackStatus(database, {
      orgId: orgA,
      itemId: duplicate.id,
      status: 'triaged',
    });
    expect(reopened.duplicateOf).toBeNull();
  });

  it('lets an author correct their own item only while it is new', async () => {
    const item = await createFeedbackItem(database, {
      orgId: orgA,
      authorId: VIEWER_A,
      type: 'bug',
      title: 'Typo in the title',
      body: 'first draft',
      severity: 'low',
    });

    const edited = await updateFeedbackContent(database, {
      orgId: orgA,
      itemId: item.id,
      authorId: VIEWER_A,
      title: 'Sort resets after export',
      body: 'second draft',
      severity: 'medium',
    });
    expect(edited.title).toBe('Sort resets after export');
    expect(edited.body).toBe('second draft');
    expect(edited.severity).toBe('medium');

    // Somebody else's item is not editable, whatever their role.
    await expect(
      updateFeedbackContent(database, {
        orgId: orgA,
        itemId: item.id,
        authorId: OWNER_A,
        title: 'Not mine to edit',
      }),
    ).rejects.toBeInstanceOf(FeedbackNotEditable);

    await setFeedbackStatus(database, { orgId: orgA, itemId: item.id, status: 'triaged' });
    await expect(
      updateFeedbackContent(database, {
        orgId: orgA,
        itemId: item.id,
        authorId: VIEWER_A,
        title: 'Too late',
      }),
    ).rejects.toBeInstanceOf(FeedbackNotEditable);
  });

  // -------------------------------------------------------------------------
  // The policy layer, exercised as a browser client would meet it
  // -------------------------------------------------------------------------

  it('shows a member of org A nothing of org B, and refuses a vote on it', async () => {
    await asUser(database, OWNER_A, async (sql) => {
      const items = await sql<{ id: string }[]>`
        select id from public.feedback_items where org_id = ${orgB}
      `;
      expect(items).toEqual([]);

      const votes = await sql<{ item_id: string }[]>`
        select item_id from public.feedback_votes where org_id = ${orgB}
      `;
      expect(votes).toEqual([]);

      await expect(
        sql`
          insert into public.feedback_votes (item_id, org_id, user_id)
          values (${foreignItem}, ${orgB}, ${OWNER_A})
        `,
      ).rejects.toThrow(/row-level security/i);

      // Naming their own org while pointing at a foreign item fails on the
      // composite foreign key instead, which is the point of carrying one.
      await expect(
        sql`
          insert into public.feedback_votes (item_id, org_id, user_id)
          values (${foreignItem}, ${orgA}, ${OWNER_A})
        `,
      ).rejects.toThrow(/foreign key|violates/i);
    });

    // And org A's items are visible to org A.
    await asUser(database, OWNER_A, async (sql) => {
      const rows = await sql<{ id: string }[]>`
        select id from public.feedback_items where org_id = ${orgA}
      `;
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  it('lets any member submit and vote, and only an admin triage', async () => {
    const item = await createFeedbackItem(database, {
      orgId: orgA,
      authorId: OWNER_A,
      type: 'bug',
      title: 'Role matrix subject',
      severity: 'low',
    });

    await asUser(database, VIEWER_A, async (sql) => {
      // Submitting is everyone's right.
      const filed = await sql<{ id: string }[]>`
        insert into public.feedback_items (org_id, author_id, type, title)
        values (${orgA}, ${VIEWER_A}, 'feature', 'Filed by a viewer')
        returning id
      `;
      expect(filed.length).toBe(1);

      // So is voting.
      const voted = await sql<{ item_id: string }[]>`
        insert into public.feedback_votes (item_id, org_id, user_id)
        values (${item.id}, ${orgA}, ${VIEWER_A})
        returning item_id
      `;
      expect(voted.length).toBe(1);

      // Triage is not: no policy admits the row, so the update matches nothing.
      const triaged = await sql<{ id: string }[]>`
        update public.feedback_items set status = 'planned'
         where org_id = ${orgA} and id = ${item.id}
        returning id
      `;
      expect(triaged).toEqual([]);

      // Not even on their own item, where a policy does admit the row: the
      // guard trigger is what draws the line between editing and triaging.
      await expect(
        sql`
          update public.feedback_items
             set status = 'shipped'
           where org_id = ${orgA} and author_id = ${VIEWER_A} and status = 'new'
        `,
      ).rejects.toThrow(/only an owner or admin/i);

      await expect(
        sql`
          update public.feedback_items
             set admin_note = 'self-served'
           where org_id = ${orgA} and author_id = ${VIEWER_A} and status = 'new'
        `,
      ).rejects.toThrow(/only an owner or admin/i);
    });

    await asUser(database, OWNER_A, async (sql) => {
      const triaged = await sql<{ id: string; status: string }[]>`
        update public.feedback_items set status = 'planned', admin_note = 'queued for v1.1'
         where org_id = ${orgA} and id = ${item.id}
        returning id, status::text as status
      `;
      expect(triaged[0]?.status).toBe('planned');
    });
  });
});
