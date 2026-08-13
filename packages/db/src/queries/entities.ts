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

export interface MirrorCounts {
  /** Rows the sync pass listed from Amazon. */
  listed: number;
  /** Rows the database reports written. */
  upserted: number;
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

/**
 * Upsert mirror rows, keyed `(profile_id, amazon_id)`.
 *
 * Every column present on the table except the key, `id` and `first_seen_at` is
 * overwritten from the incoming row: the mirror is a snapshot of what Amazon
 * currently says, and a half-updated snapshot is worse than a stale one.
 */
export async function upsertMirrorRows<T extends PgTable>(
  handle: DbHandle,
  table: T,
  rows: readonly T['$inferInsert'][],
): Promise<MirrorCounts> {
  if (rows.length === 0) return { listed: 0, upserted: 0 };

  const columns = getTableColumns(table) as Record<string, { name: string }>;
  const keep = new Set(['id', 'profileId', 'amazonId', 'firstSeenAt']);
  const set: Record<string, SQL> = {};
  for (const [property, definition] of Object.entries(columns)) {
    if (keep.has(property)) continue;
    set[property] = sql`excluded.${sql.identifier(definition.name)}`;
  }

  const profileColumn = columns['profileId'] as IndexColumn | undefined;
  const amazonColumn = columns['amazonId'] as IndexColumn | undefined;
  if (!profileColumn || !amazonColumn) {
    throw new Error(`${getTableName(table)} is not a mirror table`);
  }

  const written = await handle.db
    .insert(table)
    .values([...rows] as T['$inferInsert'][])
    .onConflictDoUpdate({
      target: [profileColumn, amazonColumn],
      set: set as PgUpdateSetSource<T>,
    })
    .returning({ amazonId: sql<string>`${sql.identifier(amazonColumn.name)}` });

  const counts: MirrorCounts = { listed: rows.length, upserted: written.length };
  if (counts.listed !== counts.upserted) {
    throw new MirrorCountMismatch(getTableName(table), counts);
  }
  return counts;
}

/**
 * Record diffs. `source: 'sync'` means somebody changed this outside
 * wizard-ads, which is the question the table exists to answer.
 */
export async function recordEntityChanges(
  handle: DbHandle,
  changes: readonly NewEntityChange[],
): Promise<number> {
  if (changes.length === 0) return 0;
  const written = await handle.db
    .insert(entityChanges)
    .values([...changes])
    .returning({ id: entityChanges.id });
  if (written.length !== changes.length) {
    throw new Error(
      `entity_changes: offered ${changes.length} rows, wrote ${written.length}`,
    );
  }
  return written.length;
}
