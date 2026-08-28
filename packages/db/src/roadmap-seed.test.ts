/**
 * The roadmap seed.
 *
 * Two properties are worth a test: it is idempotent (an operator re-runs it
 * after editing the list, and re-running must not double the board), and the
 * items it writes are ordinary feedback items — planned features that the same
 * roadmap query returns, ordered by the same votes as anything a teammate
 * files. A seed that produced special rows would be a second data model.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROADMAP_ITEMS, seedRoadmap } from '../../../supabase/seed/seed-roadmap.js';
import { listRoadmap, toggleFeedbackVote } from './queries/feedback.js';
import { createTestDatabase, databaseAvailable } from './testing/harness.js';
import type { TestDatabase } from './testing/harness.js';

const available = await databaseAvailable();
const OWNER = '15656565-6565-4656-8656-565656565656';

describe.skipIf(!available)('the roadmap seed', () => {
  let database: TestDatabase;
  let orgId: string;

  beforeAll(async () => {
    database = await createTestDatabase('wp15_roadmap_seed');
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('roadmap-seed', ${OWNER}, 'owner')
    `;
    orgId = org?.seed_tenant_fixture ?? '';
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('writes every item once, attributed to the org owner, and says so', async () => {
    const first = await seedRoadmap(database, { orgId });
    expect(first.offered).toBe(ROADMAP_ITEMS.length);
    expect(first.created).toBe(ROADMAP_ITEMS.length);
    expect(first.updated).toBe(0);
    expect(first.alreadyPresent).toBe(0);
    expect(first.authorId).toBe(OWNER);

    const [count] = await database.sql<{ count: string }[]>`
      select count(*) as count from public.feedback_items
       where org_id = ${orgId} and status = 'planned'
    `;
    expect(Number(count?.count)).toBe(ROADMAP_ITEMS.length);
  });

  it('is idempotent: a second run creates nothing', async () => {
    const again = await seedRoadmap(database, { orgId });
    expect(again.created).toBe(0);
    expect(again.updated).toBe(0);
    expect(again.alreadyPresent).toBe(ROADMAP_ITEMS.length);

    const [count] = await database.sql<{ count: string }[]>`
      select count(*) as count from public.feedback_items where org_id = ${orgId}
    `;
    // The tenant fixture's own bug report is the one extra row.
    expect(Number(count?.count)).toBe(ROADMAP_ITEMS.length + 1);
  });

  it('previews and applies planned-card content updates without duplicating aliases', async () => {
    const item = ROADMAP_ITEMS.find((candidate) => (candidate.aliases?.length ?? 0) > 0);
    expect(item).toBeDefined();
    if (!item) return;
    const alias = item.aliases?.[0];
    expect(alias).toBeDefined();
    if (!alias) return;

    await database.sql`
      update public.feedback_items
         set title = ${alias}, body = 'Older roadmap copy'
       where org_id = ${orgId} and title = ${item.title}
    `;

    const preview = await seedRoadmap(database, { orgId, dryRun: true });
    expect(preview.created).toBe(0);
    expect(preview.updated).toBe(1);
    expect(preview.alreadyPresent).toBe(ROADMAP_ITEMS.length - 1);
    const [unchanged] = await database.sql<{ title: string; body: string }[]>`
      select title, body from public.feedback_items
       where org_id = ${orgId} and title = ${alias}
    `;
    expect(unchanged).toEqual({ title: alias, body: 'Older roadmap copy' });

    const applied = await seedRoadmap(database, { orgId });
    expect(applied).toMatchObject({ created: 0, updated: 1, alreadyPresent: ROADMAP_ITEMS.length - 1 });
    const [canonical] = await database.sql<{ title: string; body: string }[]>`
      select title, body from public.feedback_items
       where org_id = ${orgId} and title = ${item.title}
    `;
    expect(canonical).toEqual({ title: item.title, body: item.body });
    const [count] = await database.sql<{ count: string }[]>`
      select count(*) as count from public.feedback_items
       where org_id = ${orgId} and title in (${item.title}, ${alias})
    `;
    expect(Number(count?.count)).toBe(1);
  });

  it('lands the items on the board, in vote order', async () => {
    const before = await listRoadmap(database, { orgId, viewerId: OWNER });
    expect(before.planned.map((item) => item.title)).toEqual(
      expect.arrayContaining(ROADMAP_ITEMS.map((item) => item.title)),
    );
    expect(before.planned.every((item) => item.votes === 0)).toBe(true);

    // A vote reorders the board, which is what makes the seed a starting point
    // rather than a ranking.
    const last = before.planned[before.planned.length - 1];
    expect(last).toBeDefined();
    if (!last) return;
    await toggleFeedbackVote(database, { orgId, itemId: last.id, userId: OWNER });

    const after = await listRoadmap(database, { orgId, viewerId: OWNER });
    expect(after.planned[0]?.id).toBe(last.id);
    expect(after.planned[0]?.votes).toBe(1);
    expect(after.planned[0]?.viewerHasVoted).toBe(true);
  });

  it('refuses an org that does not exist rather than seeding nothing quietly', async () => {
    await expect(seedRoadmap(database, { orgSlug: 'no-such-org' })).rejects.toThrow(/no org/i);
  });
});
