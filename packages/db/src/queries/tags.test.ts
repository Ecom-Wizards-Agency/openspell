import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser } from '../testing/rls.js';
import { createTestDatabase, databaseAvailable } from '../testing/harness.js';
import type { TestDatabase } from '../testing/harness.js';
import { createRequestDatabase } from './request-client.js';
import {
  assignTagToEntities,
  bulkAssignTagByFilter,
  bulkUnassignTagByFilter,
  createTag,
  deleteTag,
  listCampaignsByTagFilter,
  listTags,
  resolveTagEntityFilter,
  updateTag,
} from './tags.js';

const available = await databaseAvailable();
const USER_A = '81818181-8181-4181-8181-818181818181';
const USER_B = '82828282-8282-4282-8282-828282828282';

describe.skipIf(!available)('WP-08 tag queries', () => {
  let database: TestDatabase;
  let orgA: string;
  let orgB: string;
  let profileA: string;
  let profileB: string;

  beforeAll(async () => {
    database = await createTestDatabase('wp08_tags');
    const [a] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('tag-alpha', ${USER_A}, 'owner')
    `;
    const [b] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('tag-bravo', ${USER_B}, 'owner')
    `;
    orgA = a?.seed_tenant_fixture ?? '';
    orgB = b?.seed_tenant_fixture ?? '';
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgA} limit 1
    `;
    profileA = profile?.id ?? '';
    const [otherProfile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgB} limit 1
    `;
    profileB = otherProfile?.id ?? '';
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('renames and moves a nested tag without changing its entity associations', async () => {
    const root = await createTag(database, { orgId: orgA, name: 'Markets' });
    const destination = await createTag(database, { orgId: orgA, name: 'Lifecycle' });
    const child = await createTag(database, {
      orgId: orgA,
      parentId: root.id,
      name: 'Northern region',
      color: '#2563eb',
    });
    const assignment = await assignTagToEntities(database, {
      orgId: orgA,
      tagId: child.id,
      references: [
        { profileId: profileA, entityType: 'campaign', entityId: 'c-1' },
        { profileId: profileA, entityType: 'campaign', entityId: 'missing' },
      ],
    });
    expect(assignment).toEqual({
      requested: 2,
      unique: 2,
      processed: 1,
      newlyAssigned: 1,
      skipped: 1,
    });

    const renamed = await updateTag(database, {
      orgId: orgA,
      tagId: child.id,
      name: 'North',
      parentId: destination.id,
    });
    expect(renamed).toMatchObject({ name: 'North', slug: 'north', parentId: destination.id });
    const associations = await database.sql<{ tag_id: string; entity_id: string }[]>`
      select tag_id, entity_id from public.entity_tags
       where org_id = ${orgA} and tag_id = ${child.id}
    `;
    expect(associations).toEqual([{ tag_id: child.id, entity_id: 'c-1' }]);

    await expect(
      updateTag(database, { orgId: orgA, tagId: destination.id, parentId: child.id }),
    ).rejects.toThrow(/descendant/i);
  });

  it('offers counted reassignment and preserves children when deleting a tag', async () => {
    const source = await createTag(database, { orgId: orgA, name: 'Retiring taxonomy' });
    const child = await createTag(database, {
      orgId: orgA,
      parentId: source.id,
      name: 'Still useful',
    });
    const target = await createTag(database, { orgId: orgA, name: 'Current taxonomy' });
    await assignTagToEntities(database, {
      orgId: orgA,
      tagId: source.id,
      references: [{ profileId: profileA, entityType: 'campaign', entityId: 'c-1' }],
    });

    const result = await deleteTag(database, {
      orgId: orgA,
      tagId: source.id,
      disposition: { mode: 'reassign', targetTagId: target.id },
    });
    expect(result).toEqual({
      tagId: source.id,
      associations: 1,
      reassigned: 1,
      detached: 0,
      childrenMoved: 1,
    });
    const [assignment] = await database.sql<{ tag_id: string }[]>`
      select tag_id from public.entity_tags
       where org_id = ${orgA} and entity_type = 'campaign' and entity_id = 'c-1'
         and tag_id = ${target.id}
    `;
    expect(assignment?.tag_id).toBe(target.id);
    const [movedChild] = await database.sql<{ parent_id: string | null }[]>`
      select parent_id from public.tags where id = ${child.id}
    `;
    expect(movedChild?.parent_id).toBeNull();

    const detachable = await createTag(database, { orgId: orgA, name: 'One-off taxonomy' });
    await assignTagToEntities(database, {
      orgId: orgA,
      tagId: detachable.id,
      references: [{ profileId: profileA, entityType: 'campaign', entityId: 'c-1' }],
    });
    expect(
      await deleteTag(database, {
        orgId: orgA,
        tagId: detachable.id,
        disposition: { mode: 'detach' },
      }),
    ).toMatchObject({ associations: 1, reassigned: 0, detached: 1 });
    const detachedRows = await database.sql`
      select * from public.entity_tags where tag_id = ${detachable.id}
    `;
    expect(detachedRows).toHaveLength(0);
  });

  it('bulk-tags the exact filter result idempotently and reports reconciled counts', async () => {
    const tag = await createTag(database, { orgId: orgA, name: 'Enabled campaign set' });
    const input = {
      orgId: orgA,
      tagId: tag.id,
      filter: { entityType: 'campaign' as const, entityIds: ['c-1', 'missing'] },
    };
    expect(await bulkAssignTagByFilter(database, input)).toEqual({
      matchedByFilter: 1,
      requested: 1,
      unique: 1,
      processed: 1,
      newlyAssigned: 1,
      skipped: 0,
    });
    expect((await bulkAssignTagByFilter(database, input)).newlyAssigned).toBe(0);

    // And the inverse: removing the assignment is counted the same way, and a
    // second removal is a no-op rather than an error.
    const untag = { orgId: orgA, tagId: tag.id, filter: input.filter };
    expect(await bulkUnassignTagByFilter(database, untag)).toEqual({
      matchedByFilter: 1,
      requested: 1,
      unique: 1,
      removed: 1,
    });
    expect((await bulkUnassignTagByFilter(database, untag)).removed).toBe(0);
    expect(
      await listCampaignsByTagFilter(database, orgA, { tagIds: [tag.id], mode: 'any' }),
    ).toHaveLength(0);
  });

  it('uses the same descendant-aware filter semantics for list and dashboard consumers', async () => {
    const parent = await createTag(database, { orgId: orgA, name: 'Portfolio group' });
    const child = await createTag(database, {
      orgId: orgA,
      parentId: parent.id,
      name: 'Launches',
    });
    await assignTagToEntities(database, {
      orgId: orgA,
      tagId: child.id,
      references: [{ profileId: profileA, entityType: 'campaign', entityId: 'c-1' }],
    });
    const withDescendants = await listCampaignsByTagFilter(database, orgA, {
      tagIds: [parent.id],
      mode: 'any',
      includeDescendants: true,
    });
    const exactParent = await listCampaignsByTagFilter(database, orgA, {
      tagIds: [parent.id],
      mode: 'any',
      includeDescendants: false,
    });
    expect(withDescendants.map((row) => row.entityId)).toContain('c-1');
    expect(exactParent.map((row) => row.entityId)).not.toContain('c-1');
  });

  /**
   * Every branch of the filter the grid hands over: each entity type against
   * its own table, the state enum array, the name search, and the profile
   * case, which addresses `ad_profiles` rather than the entity mirror. These
   * are separate SQL shapes, so exercising only `entityIds` proves only one.
   */
  it('resolves every branch of the grid filter against the real tables', async () => {
    const byType = await Promise.all(
      (['portfolio', 'campaign', 'ad_group', 'product_ad', 'keyword', 'target', 'negative'] as const)
        .map(async (entityType) => [
          entityType,
          await resolveTagEntityFilter(database, orgA, { entityType }),
        ] as const),
    );
    // The tenant fixture seeds exactly one row of each type for one profile.
    for (const [entityType, references] of byType) {
      expect(references, entityType).toHaveLength(1);
      expect(references[0]).toMatchObject({ profileId: profileA, entityType });
    }

    expect(
      await resolveTagEntityFilter(database, orgA, { entityType: 'campaign', states: ['enabled'] }),
    ).toHaveLength(1);
    expect(
      await resolveTagEntityFilter(database, orgA, {
        entityType: 'campaign',
        states: ['paused', 'archived'],
      }),
    ).toHaveLength(0);
    expect(
      await resolveTagEntityFilter(database, orgA, { entityType: 'campaign', search: 'CAMP' }),
    ).toHaveLength(1);
    expect(
      await resolveTagEntityFilter(database, orgA, { entityType: 'campaign', search: 'nothing' }),
    ).toHaveLength(0);
    expect(
      await resolveTagEntityFilter(database, orgA, {
        entityType: 'campaign',
        profileIds: [profileA],
      }),
    ).toHaveLength(1);

    const profiles = await resolveTagEntityFilter(database, orgA, { entityType: 'profile' });
    expect(profiles).toEqual([{ profileId: profileA, entityType: null, entityId: null }]);
    // A profile-scoped tag is the client grouping, so it has to assign too.
    const clientTag = await createTag(database, { orgId: orgA, name: 'Client grouping' });
    expect(
      await assignTagToEntities(database, {
        orgId: orgA,
        tagId: clientTag.id,
        references: profiles,
      }),
    ).toMatchObject({ processed: 1, newlyAssigned: 1, skipped: 0 });

    // The filter never reaches across tenants, whichever branch runs.
    expect(await resolveTagEntityFilter(database, orgB, { entityType: 'campaign' })).toHaveLength(1);
    expect(
      await resolveTagEntityFilter(database, orgA, {
        entityType: 'campaign',
        profileIds: [profileB],
      }),
    ).toHaveLength(0);
  });

  it('returns tag timestamps as Dates on a handle without Drizzle attached', async () => {
    const web = createRequestDatabase(database.connectionString);
    try {
      const created = await createTag(web, { orgId: orgA, name: 'Timestamp shape' });
      expect(created.createdAt).toBeInstanceOf(Date);
      expect(created.updatedAt).toBeInstanceOf(Date);
      const listed = (await listTags(web, orgA)).find((tag) => tag.id === created.id);
      expect(listed?.createdAt).toBeInstanceOf(Date);
      // And the same on the Drizzle-attached handle the worker uses.
      const viaDrizzle = (await listTags(database, orgA)).find((tag) => tag.id === created.id);
      expect(viaDrizzle?.createdAt).toBeInstanceOf(Date);
      expect(viaDrizzle?.createdAt.toISOString()).toBe(listed?.createdAt.toISOString());
    } finally {
      await web.close();
    }
  });

  it('RLS denies org A reads and writes for org B tags and entity_tags', async () => {
    const [foreignTag] = await database.sql<{ id: string }[]>`
      select id from public.tags where org_id = ${orgB} limit 1
    `;
    const foreignTagId = foreignTag?.id ?? '';
    await asUser(database, USER_A, async (sql) => {
      const tags = await sql`select * from public.tags where org_id = ${orgB}`;
      const assignments = await sql`select * from public.entity_tags where org_id = ${orgB}`;
      expect(tags).toHaveLength(0);
      expect(assignments).toHaveLength(0);
      await expect(
        sql`insert into public.tags (org_id, name, slug) values (${orgB}, 'foreign', 'foreign')`,
      ).rejects.toThrow(/row-level security/i);
      await expect(
        sql`
          insert into public.entity_tags (tag_id, org_id, profile_id, entity_type, entity_id)
          values (${foreignTagId}, ${orgB}, ${profileA}, 'campaign', 'c-1')
        `,
      ).rejects.toThrow(/row-level security|foreign key/i);
    });
  });
});
