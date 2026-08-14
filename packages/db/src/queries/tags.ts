/**
 * Nested tag queries and the grid-independent bulk/filter contract.
 *
 * Tags are addressed by UUID throughout. Names are presentation only: this
 * avoids the ambiguous exact-name behavior documented in the AdLabs recon.
 */
import type { EntityState, EntityType } from '@wizard-ads/shared';
import type { DbHandle, Sql } from '../client.js';

export type TagQueryHandle = Pick<DbHandle, 'sql'>;

export interface TagRecord {
  id: string;
  orgId: string;
  parentId: string | null;
  name: string;
  slug: string;
  color: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface TagRow {
  id: string;
  org_id: string;
  parent_id: string | null;
  name: string;
  slug: string;
  color: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface TagTreeNode extends TagRecord {
  children: TagTreeNode[];
}

export interface CreateTagInput {
  orgId: string;
  parentId?: string | null;
  name: string;
  color?: string | null;
  createdBy?: string | null;
}

export interface UpdateTagInput {
  orgId: string;
  tagId: string;
  name?: string;
  parentId?: string | null;
  color?: string | null;
}

export type TaggableEntityType = EntityType | 'profile';

/**
 * The hand-off point for WP-06. A grid can pass its resolved entity type and
 * current filters without importing tag UI code.
 */
export interface TagEntityFilter {
  entityType: TaggableEntityType;
  profileIds?: readonly string[];
  entityIds?: readonly string[];
  states?: readonly EntityState[];
  search?: string;
}

export interface TagEntityReference {
  profileId: string;
  entityType: EntityType | null;
  entityId: string | null;
}

export interface BulkTagResult {
  matchedByFilter: number;
  requested: number;
  unique: number;
  processed: number;
  newlyAssigned: number;
  skipped: number;
}

export interface EntityTagFilter {
  tagIds: readonly string[];
  mode: 'any' | 'all' | 'none' | 'untagged';
  includeDescendants?: boolean;
}

export interface CampaignTagListRow {
  profileId: string;
  entityId: string;
  name: string | null;
  state: EntityState;
  tagIds: string[];
}

export interface DeleteTagResult {
  tagId: string;
  associations: number;
  reassigned: number;
  detached: number;
  childrenMoved: number;
}

export type DeleteTagMode =
  | { mode: 'detach' }
  | { mode: 'reassign'; targetTagId: string };

const ENTITY_TABLES: Record<EntityType, string> = {
  portfolio: 'portfolios',
  campaign: 'campaigns',
  ad_group: 'ad_groups',
  product_ad: 'product_ads',
  keyword: 'keywords',
  target: 'targets',
  negative: 'negatives',
};

const toTag = (row: TagRow): TagRecord => ({
  id: row.id,
  orgId: row.org_id,
  parentId: row.parent_id,
  name: row.name,
  slug: row.slug,
  color: row.color,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function slugifyTagName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('A tag name must contain at least one letter or number');
  return slug;
}

function normalizeName(name: string): string {
  const normalized = name.trim();
  if (!normalized) throw new Error('A tag name cannot be empty');
  if (normalized.length > 120) throw new Error('A tag name cannot exceed 120 characters');
  return normalized;
}

async function requireTag(sql: Sql, orgId: string, tagId: string): Promise<TagRecord> {
  const rows = await sql<TagRow[]>`
    select id, org_id, parent_id, name, slug, color, created_by, created_at, updated_at
      from public.tags
     where org_id = ${orgId} and id = ${tagId}
  `;
  const row = rows[0];
  if (!row) throw new Error('Tag not found');
  return toTag(row);
}

export async function listTags(handle: TagQueryHandle, orgId: string): Promise<TagRecord[]> {
  const rows = await handle.sql<TagRow[]>`
    select id, org_id, parent_id, name, slug, color, created_by, created_at, updated_at
      from public.tags
     where org_id = ${orgId}
     order by lower(name), id
  `;
  return rows.map(toTag);
}

export async function listTagTree(
  handle: TagQueryHandle,
  orgId: string,
): Promise<TagTreeNode[]> {
  const nodes = new Map<string, TagTreeNode>(
    (await listTags(handle, orgId)).map((tag) => [tag.id, { ...tag, children: [] }]),
  );
  const roots: TagTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export async function createTag(
  handle: TagQueryHandle,
  input: CreateTagInput,
): Promise<TagRecord> {
  const name = normalizeName(input.name);
  if (input.parentId) await requireTag(handle.sql, input.orgId, input.parentId);
  const rows = await handle.sql<TagRow[]>`
    insert into public.tags (org_id, parent_id, name, slug, color, created_by)
    values (
      ${input.orgId}, ${input.parentId ?? null}, ${name}, ${slugifyTagName(name)},
      ${input.color ?? null}, ${input.createdBy ?? null}
    )
    returning id, org_id, parent_id, name, slug, color, created_by, created_at, updated_at
  `;
  const row = rows[0];
  if (!row) throw new Error('Creating a tag returned no row');
  return toTag(row);
}

export async function updateTag(
  handle: TagQueryHandle,
  input: UpdateTagInput,
): Promise<TagRecord> {
  if (input.name === undefined && input.parentId === undefined && input.color === undefined) {
    throw new Error('A tag update must change name, parent, or color');
  }
  const existing = await requireTag(handle.sql, input.orgId, input.tagId);
  const name = input.name === undefined ? existing.name : normalizeName(input.name);
  const parentId = input.parentId === undefined ? existing.parentId : input.parentId;

  if (parentId) {
    if (parentId === input.tagId) throw new Error('A tag cannot be its own parent');
    await requireTag(handle.sql, input.orgId, parentId);
    const cycle = await handle.sql<{ exists: boolean }[]>`
      select exists(
        select 1 from public.tag_subtree(${input.tagId}) where id = ${parentId}
      ) as exists
    `;
    if (cycle[0]?.exists) throw new Error('A tag cannot be moved below one of its descendants');
  }

  const rows = await handle.sql<TagRow[]>`
    update public.tags
       set name = ${name},
           slug = ${slugifyTagName(name)},
           parent_id = ${parentId},
           color = ${input.color === undefined ? existing.color : input.color}
     where org_id = ${input.orgId} and id = ${input.tagId}
    returning id, org_id, parent_id, name, slug, color, created_by, created_at, updated_at
  `;
  const row = rows[0];
  if (!row) throw new Error('Tag not found');
  return toTag(row);
}

/** Resolve a grid/dashboard selection to the exact rows that bulk tagging will address. */
export async function resolveTagEntityFilter(
  handle: TagQueryHandle,
  orgId: string,
  filter: TagEntityFilter,
): Promise<TagEntityReference[]> {
  const profileIds = filter.profileIds?.length ? [...new Set(filter.profileIds)] : null;
  const entityIds = filter.entityIds?.length ? [...new Set(filter.entityIds)] : null;
  const search = filter.search?.trim() || null;

  if (filter.entityType === 'profile') {
    const rows = await handle.sql<{ profile_id: string }[]>`
      select id as profile_id
        from public.ad_profiles
       where org_id = ${orgId}
         and (${profileIds}::uuid[] is null or id = any(${profileIds}::uuid[]))
         and (${entityIds}::uuid[] is null or id = any(${entityIds}::uuid[]))
         and (${search}::text is null or coalesce(account_name, '') ilike '%' || ${search} || '%')
       order by id
    `;
    return rows.map((row) => ({ profileId: row.profile_id, entityType: null, entityId: null }));
  }

  const entityType = filter.entityType;
  const table = ENTITY_TABLES[entityType];
  const states = filter.states?.length ? [...new Set(filter.states)] : null;
  const rows = await handle.sql<{ profile_id: string; amazon_id: string }[]>`
    select profile_id, amazon_id
      from public.${handle.sql(table)}
     where org_id = ${orgId}
       and (${profileIds}::uuid[] is null or profile_id = any(${profileIds}::uuid[]))
       and (${entityIds}::text[] is null or amazon_id = any(${entityIds}::text[]))
       and (${states}::public.entity_state[] is null or state = any(${states}::public.entity_state[]))
       and (${search}::text is null or coalesce(name, '') ilike '%' || ${search} || '%')
     order by profile_id, amazon_id
  `;
  return rows.map((row) => ({
    profileId: row.profile_id,
    entityType,
    entityId: row.amazon_id,
  }));
}

const referenceKey = (reference: TagEntityReference) =>
  `${reference.profileId}\u0000${reference.entityType ?? ''}\u0000${reference.entityId ?? ''}`;

export async function assignTagToEntities(
  handle: TagQueryHandle,
  input: {
    orgId: string;
    tagId: string;
    references: readonly TagEntityReference[];
    createdBy?: string | null;
  },
): Promise<Omit<BulkTagResult, 'matchedByFilter'>> {
  await requireTag(handle.sql, input.orgId, input.tagId);
  const unique = [...new Map(input.references.map((row) => [referenceKey(row), row])).values()];
  let processed = 0;
  let newlyAssigned = 0;

  for (const reference of unique) {
    const validShape =
      (reference.entityType === null && reference.entityId === null) ||
      (reference.entityType !== null && reference.entityId !== null);
    if (!validShape) continue;

    const exists =
      reference.entityType === null
        ? await handle.sql<{ exists: boolean }[]>`
            select exists(
              select 1 from public.ad_profiles
               where org_id = ${input.orgId} and id = ${reference.profileId}
            ) as exists
          `
        : await handle.sql<{ exists: boolean }[]>`
            select exists(
              select 1 from public.${handle.sql(ENTITY_TABLES[reference.entityType])}
               where org_id = ${input.orgId}
                 and profile_id = ${reference.profileId}
                 and amazon_id = ${reference.entityId}
            ) as exists
          `;
    if (!exists[0]?.exists) continue;
    processed += 1;

    const inserted = await handle.sql<{ tag_id: string }[]>`
      insert into public.entity_tags
        (tag_id, org_id, profile_id, entity_type, entity_id, created_by)
      values (
        ${input.tagId}, ${input.orgId}, ${reference.profileId},
        ${reference.entityType}::public.entity_type, ${reference.entityId}, ${input.createdBy ?? null}
      )
      on conflict do nothing
      returning tag_id
    `;
    newlyAssigned += inserted.length;
  }

  return {
    requested: input.references.length,
    unique: unique.length,
    processed,
    newlyAssigned,
    skipped: unique.length - processed,
  };
}

export async function bulkAssignTagByFilter(
  handle: TagQueryHandle,
  input: {
    orgId: string;
    tagId: string;
    filter: TagEntityFilter;
    createdBy?: string | null;
  },
): Promise<BulkTagResult> {
  const references = await resolveTagEntityFilter(handle, input.orgId, input.filter);
  const result = await assignTagToEntities(handle, { ...input, references });
  if (result.processed + result.skipped !== result.unique) {
    throw new Error('Bulk tag counts do not reconcile');
  }
  return { matchedByFilter: references.length, ...result };
}

export async function deleteTag(
  handle: TagQueryHandle,
  input: { orgId: string; tagId: string; disposition: DeleteTagMode },
): Promise<DeleteTagResult> {
  return handle.sql.begin(async (transaction) => {
    const sql = transaction as unknown as Sql;
    const source = await requireTag(sql, input.orgId, input.tagId);
    let target: TagRecord | null = null;
    if (input.disposition.mode === 'reassign') {
      if (input.disposition.targetTagId === input.tagId) {
        throw new Error('A deleted tag cannot be its own reassignment target');
      }
      target = await requireTag(sql, input.orgId, input.disposition.targetTagId);
      const descendant = await sql<{ exists: boolean }[]>`
        select exists(
          select 1 from public.tag_subtree(${input.tagId}) where id = ${target.id}
        ) as exists
      `;
      if (descendant[0]?.exists) throw new Error('Cannot reassign to a tag that will be deleted');
    }

    const associations = await sql<{ count: string }[]>`
      select count(*) as count
        from public.entity_tags
       where org_id = ${input.orgId} and tag_id = ${input.tagId}
    `;
    const associationCount = Number(associations[0]?.count ?? 0);
    let reassigned = 0;
    let detached = associationCount;

    if (target) {
      await sql`
        insert into public.entity_tags
          (tag_id, org_id, profile_id, entity_type, entity_id, created_by)
        select ${target.id}, org_id, profile_id, entity_type, entity_id, created_by
          from public.entity_tags
         where org_id = ${input.orgId} and tag_id = ${input.tagId}
        on conflict do nothing
      `;
      const verified = await sql<{ count: string }[]>`
        select count(*) as count
          from public.entity_tags source
         where source.org_id = ${input.orgId}
           and source.tag_id = ${input.tagId}
           and exists (
             select 1
               from public.entity_tags destination
              where destination.org_id = source.org_id
                and destination.tag_id = ${target.id}
                and destination.profile_id is not distinct from source.profile_id
                and destination.entity_type is not distinct from source.entity_type
                and destination.entity_id is not distinct from source.entity_id
           )
      `;
      reassigned = Number(verified[0]?.count ?? 0);
      detached = 0;
      if (reassigned !== associationCount) {
        throw new Error(
          `Tag reassignment lost rows: expected ${associationCount}, verified ${reassigned}`,
        );
      }
    }

    const moved = await sql<{ id: string }[]>`
      update public.tags
         set parent_id = ${source.parentId}
       where org_id = ${input.orgId} and parent_id = ${input.tagId}
      returning id
    `;
    const deleted = await sql<{ id: string }[]>`
      delete from public.tags
       where org_id = ${input.orgId} and id = ${input.tagId}
      returning id
    `;
    if (deleted.length !== 1) throw new Error('Deleting a tag did not delete exactly one row');

    return {
      tagId: input.tagId,
      associations: associationCount,
      reassigned,
      detached,
      childrenMoved: moved.length,
    };
  });
}

export async function listCampaignsByTagFilter(
  handle: TagQueryHandle,
  orgId: string,
  filter?: EntityTagFilter,
): Promise<CampaignTagListRow[]> {
  const rows = await handle.sql<
    {
      profile_id: string;
      entity_id: string;
      name: string | null;
      state: EntityState;
      tag_ids: string[];
    }[]
  >`
    select c.profile_id, c.amazon_id as entity_id, c.name, c.state,
           coalesce(
             array_agg(et.tag_id::text order by et.tag_id) filter (where et.tag_id is not null),
             array[]::text[]
           ) as tag_ids
      from public.campaigns c
      left join public.entity_tags et
        on et.org_id = c.org_id
       and et.profile_id = c.profile_id
       and et.entity_type = 'campaign'
       and et.entity_id = c.amazon_id
     where c.org_id = ${orgId}
     group by c.profile_id, c.amazon_id, c.name, c.state
     order by lower(coalesce(c.name, '')), c.amazon_id
  `;
  const mapped = rows.map((row) => ({
    profileId: row.profile_id,
    entityId: row.entity_id,
    name: row.name,
    state: row.state,
    tagIds: row.tag_ids,
  }));
  if (!filter) return mapped;
  if (filter.mode === 'untagged') return mapped.filter((row) => row.tagIds.length === 0);
  if (filter.tagIds.length === 0) return mapped;

  const groups = await Promise.all(
    filter.tagIds.map(async (tagId) => {
      await requireTag(handle.sql, orgId, tagId);
      if (filter.includeDescendants === false) return new Set([tagId]);
      const descendants = await handle.sql<{ id: string }[]>`
        select id from public.tag_subtree(${tagId})
      `;
      return new Set(descendants.map((row) => row.id));
    }),
  );

  return mapped.filter((row) => {
    const matches = groups.map((group) => row.tagIds.some((tagId) => group.has(tagId)));
    if (filter.mode === 'all') return matches.every(Boolean);
    if (filter.mode === 'none') return matches.every((value) => !value);
    return matches.some(Boolean);
  });
}
