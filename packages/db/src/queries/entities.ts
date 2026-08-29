/**
 * Entity mirror writes.
 *
 * One generic upsert covers all seven mirror tables because they share a key
 * (`profile_id`, `amazon_id`) and a discipline: entities listed must equal
 * entities upserted, or the sync pass failed no matter what the API said.
 */
import { getTableColumns, getTableName, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { IndexColumn, PgTable, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { DbHandle } from '../client.js';
import { entityChanges } from '../schema/entities.js';
import type { NewEntityChange } from '../schema/entities.js';
import { chunkForInsert } from './chunk.js';

export interface MirrorCounts {
  /** Rows the sync pass listed from Amazon. */
  listed: number;
  /** Rows the database reports written. */
  upserted: number;
  /** Older or identical snapshots deliberately rejected by the promotion watermark. */
  superseded?: number;
}

export interface MirrorPromotionCounts extends MirrorCounts {
  /** Exact Amazon ids whose snapshots were promoted by this statement set. */
  promotedIds: string[];
}

export class MirrorCountMismatch extends Error {
  constructor(
    readonly table: string,
    readonly counts: MirrorCounts,
  ) {
    super(
      `${table}: listed ${counts.listed} entities, upserted ${counts.upserted}. ` +
        'An entity sync that loses rows is a sync that lies about the account.',
    );
    this.name = 'MirrorCountMismatch';
  }
}

export interface EntityChangeLinkCounts {
  offered: number;
  linked: number;
  ambiguous: number;
  unmatched: number;
}

async function linkEntityChangeIds(
  handle: DbHandle,
  ids: readonly number[],
): Promise<EntityChangeLinkCounts> {
  if (ids.length === 0) return { offered: 0, linked: 0, ambiguous: 0, unmatched: 0 };
  const [counts] = await handle.sql<EntityChangeLinkCounts[]>`
    select * from app.link_exact_apply_changes(${ids}::bigint[])
  `;
  const classified = counts === undefined
    ? 0
    : counts.linked + counts.ambiguous + counts.unmatched;
  if (counts === undefined || counts.offered !== ids.length || classified !== ids.length) {
    throw new Error(
      `entity_changes: offered ${ids.length} synchronization links, classified ${classified}`,
    );
  }
  return counts;
}

/**
 * Retry-safe reconciliation for sync evidence inserted before a linker error.
 * The worker calls this on every entity pass, including a retry that produces
 * no fresh diff because the current-state mirror was already promoted.
 */
export async function reconcileEntityChangeLinks(
  handle: DbHandle,
  input: { orgId: string; profileId: string },
): Promise<EntityChangeLinkCounts> {
  const rows = await handle.sql<{ id: number }[]>`
    select ec.id from public.entity_changes ec
     where ec.org_id = ${input.orgId}
       and ec.profile_id = ${input.profileId}
       and ec.source = 'sync'
       and ec.apply_batch_id is null
       and exists (
         select 1
           from public.apply_rows ar
           join public.apply_batches ab
             on ab.org_id = ar.org_id
            and ab.profile_id = ar.profile_id
            and ab.id = ar.batch_id
          where ar.org_id = ec.org_id
            and ar.profile_id = ec.profile_id
            and (case when ar.entity_type = 'placement' then 'campaign' else ar.entity_type::text end)
                = ec.entity_type::text
            and ar.entity_id = ec.amazon_id
            and app.canonical_apply_field(ar.entity_type::text, ar.field)
                = app.canonical_apply_field(ec.entity_type::text, ec.field)
            and ar.old_value = ec.old_value
            and ar.new_value = ec.new_value
            and ab.status in ('staged', 'applied')
            and ab.artifact_sha256 is not null
            and ab.exported_at <= ec.observed_at
       )
     order by ec.observed_at desc, ec.id desc
     limit 500
  `;
  return linkEntityChangeIds(handle, rows.map((row) => row.id));
}

/**
 * Upsert mirror rows, keyed `(profile_id, amazon_id)`.
 *
 * Every column present on the table except the key, `id` and `first_seen_at` is
 * overwritten from the incoming row: the mirror is a snapshot of what Amazon
 * currently says, and a half-updated snapshot is worse than a stale one.
 *
 * Written in bind-parameter-sized chunks rather than one statement. A profile
 * with more negative keywords than Postgres has parameters for is not an edge
 * case — it is what the first large live profile did, and the error it produced
 * was the truncated statement itself.
 *
 * The chunking gives up single-statement atomicity, deliberately: a failure
 * mid-batch leaves the earlier chunks committed. That is safe here for the same
 * reason the worker's partial entity sync is — every write is an upsert keyed
 * on `(profile_id, amazon_id)`, and the count assertion below still fails the
 * pass, so the retry redoes the whole listing and converges. A stale mirror
 * that reports success is the outcome worth avoiding; a mirror half-refreshed
 * by a job that failed loudly is not.
 *
 * The caller must hand over rows already deduplicated on the key: Postgres
 * refuses to let one `ON CONFLICT DO UPDATE` touch a row twice, and chunking
 * cannot make an intra-batch duplicate legal.
 */
export function upsertMirrorRows<T extends PgTable>(
  handle: DbHandle,
  table: T,
  rows: readonly T['$inferInsert'][],
): Promise<MirrorCounts>;
export function upsertMirrorRows<T extends PgTable>(
  handle: DbHandle,
  table: T,
  rows: readonly T['$inferInsert'][],
  options: { returnPromotedIds: true },
): Promise<MirrorPromotionCounts>;
export async function upsertMirrorRows<T extends PgTable>(
  handle: DbHandle,
  table: T,
  rows: readonly T['$inferInsert'][],
  options?: { returnPromotedIds: true },
): Promise<MirrorCounts | MirrorPromotionCounts> {
  if (rows.length === 0) {
    return options?.returnPromotedIds
      ? { listed: 0, upserted: 0, promotedIds: [] }
      : { listed: 0, upserted: 0 };
  }

  const columns = getTableColumns(table) as Record<string, { name: string }>;
  const keep = new Set(['id', 'profileId', 'amazonId', 'firstSeenAt']);
  const set: Record<string, SQL> = {};
  for (const [property, definition] of Object.entries(columns)) {
    if (keep.has(property)) continue;
    set[property] = sql`excluded.${sql.identifier(definition.name)}`;
  }

  const profileColumn = columns['profileId'] as IndexColumn | undefined;
  const amazonColumn = columns['amazonId'] as IndexColumn | undefined;
  const syncedAtColumn = columns['syncedAt'] as IndexColumn | undefined;
  if (!profileColumn || !amazonColumn || !syncedAtColumn) {
    throw new Error(`${getTableName(table)} is not a mirror table`);
  }
  const snapshotEqual = sql.join(
    Object.entries(columns)
      .filter(([property]) => !keep.has(property))
      .map(([_property, definition]) => {
        const column = definition as IndexColumn;
        return sql`${column} is not distinct from excluded.${sql.identifier(column.name)}`;
      }),
    sql` and `,
  );

  let upserted = 0;
  const promotedIds: string[] = [];
  for (const chunk of chunkForInsert(rows, Object.keys(columns).length)) {
    const written = await handle.db
      .insert(table)
      .values(chunk as T['$inferInsert'][])
      .onConflictDoUpdate({
        target: [profileColumn, amazonColumn],
        set: set as PgUpdateSetSource<T>,
        // A listing is stamped when its provider read begins. A slower, older
        // listing must never overwrite evidence returned by a newer targeted
        // read merely because its database write finishes later.
        setWhere: sql`${syncedAtColumn} < excluded.${sql.identifier(syncedAtColumn.name)}
          or (${syncedAtColumn} = excluded.${sql.identifier(syncedAtColumn.name)}
              and ${snapshotEqual})`,
      })
      .returning({ amazonId: sql<string>`${sql.identifier(amazonColumn.name)}` });
    upserted += written.length;
    promotedIds.push(...written.map((row) => row.amazonId));
  }

  const superseded = rows.length - upserted;
  const counts: MirrorCounts = {
    listed: rows.length,
    upserted,
    ...(superseded === 0 ? {} : { superseded }),
  };
  return options?.returnPromotedIds ? { ...counts, promotedIds } : counts;
}

/**
 * Record diffs. `source: 'sync'` means somebody changed this outside
 * wizard-ads, which is the question the table exists to answer.
 *
 * Chunked for the same reason as the mirror upsert, and with the same
 * tradeoff: a first sync of a large profile writes one change row per entity,
 * which is by far the biggest insert this system does.
 */
export async function recordEntityChanges(
  handle: DbHandle,
  changes: readonly NewEntityChange[],
): Promise<number> {
  if (changes.length === 0) return 0;
  const columnCount = Object.keys(getTableColumns(entityChanges)).length;
  let total = 0;
  const insertedIds: number[] = [];
  for (const chunk of chunkForInsert(changes, columnCount)) {
    const written = await handle.db
      .insert(entityChanges)
      .values(chunk)
      .returning({ id: entityChanges.id });
    total += written.length;
    insertedIds.push(...written.map((row) => row.id));
  }
  if (total !== changes.length) {
    throw new Error(
      `entity_changes: offered ${changes.length} rows, wrote ${total}`,
    );
  }

  await linkEntityChangeIds(handle, insertedIds);
  return total;
}
