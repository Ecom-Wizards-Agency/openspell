/** Counted, idempotent product-economics loading and latest-per-ASIN reads. */
import { and, desc, eq, getTableColumns, getTableName, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PgTable, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { DbHandle } from '../client.js';
import { productEconomics } from '../schema/economics.js';
import type { NewProductEconomics, ProductEconomicsRow } from '../schema/economics.js';
import { chunkForInsert } from './chunk.js';
import { assertUniqueFactGrain } from './facts.js';

export interface ProductEconomicsLoadCounts {
  offered: number;
  written: number;
}

export class ProductEconomicsLoadCountMismatch extends Error {
  constructor(readonly counts: ProductEconomicsLoadCounts) {
    super(
      `product_economics: offered ${counts.offered} rows, wrote ${counts.written}. ` +
        'A load that loses product economics must fail loudly, not report success.',
    );
    this.name = 'ProductEconomicsLoadCountMismatch';
  }
}

function assertCounts(counts: ProductEconomicsLoadCounts): ProductEconomicsLoadCounts {
  if (counts.offered !== counts.written) throw new ProductEconomicsLoadCountMismatch(counts);
  return counts;
}

/**
 * Upsert one or more captured MRP days.
 *
 * Five steps mirror the fact loaders: empty return, whole-batch grain check,
 * bind-safe chunking, idempotent conflict update, and an offered/written count
 * assertion across every chunk.
 */
export async function upsertProductEconomics(
  handle: DbHandle,
  rows: readonly NewProductEconomics[],
): Promise<ProductEconomicsLoadCounts> {
  if (rows.length === 0) return { offered: 0, written: 0 };
  assertUniqueFactGrain('product_economics', rows, (row) => [
    row.profileId,
    row.asin,
    row.capturedOn,
  ]);

  let written = 0;
  const width = Object.keys(getTableColumns(productEconomics)).length;
  for (const chunk of chunkForInsert(rows, width)) {
    const result = await handle.db
      .insert(productEconomics)
      .values(chunk)
      .onConflictDoUpdate({
        target: [productEconomics.profileId, productEconomics.asin, productEconomics.capturedOn],
        set: conflictSet(productEconomics, [
          'orgId',
          'salePrice',
          'cogs',
          'fbaFees',
          'referralFees',
          'otherFees',
          'margin',
          'ltvRevenue',
          'ltvOrders',
          'repeatRate',
          'currency',
          'source',
          'details',
          'loadedAt',
        ]),
      })
      .returning({ id: productEconomics.id });
    written += result.length;
  }
  return assertCounts({ offered: rows.length, written });
}

/** Newest captured row for every ASIN in one tenant/profile, ordered by ASIN. */
export async function latestProductEconomics(
  handle: DbHandle,
  args: { orgId: string; profileId: string },
): Promise<ProductEconomicsRow[]> {
  return handle.db
    .selectDistinctOn([productEconomics.asin])
    .from(productEconomics)
    .where(
      and(
        eq(productEconomics.orgId, args.orgId),
        eq(productEconomics.profileId, args.profileId),
      ),
    )
    .orderBy(
      productEconomics.asin,
      desc(productEconomics.capturedOn),
      desc(productEconomics.loadedAt),
      desc(productEconomics.id),
    );
}

function conflictSet<T extends PgTable>(
  table: T,
  columns: readonly (keyof T['$inferInsert'] & string)[],
): PgUpdateSetSource<T> {
  const definitions = getTableColumns(table) as Record<string, { name: string }>;
  const set: Record<string, SQL> = {};
  for (const column of columns) {
    const definition = definitions[column];
    if (!definition) throw new Error(`no such column on ${getTableName(table)}: ${column}`);
    set[column] = sql`excluded.${sql.identifier(definition.name)}`;
  }
  return set as PgUpdateSetSource<T>;
}
