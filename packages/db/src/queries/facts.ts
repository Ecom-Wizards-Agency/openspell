/**
 * Fact loading and reading.
 *
 * Every loader here returns a count of rows written against rows offered and
 * throws when they differ. That is program rule 4 made mechanical: a fact load
 * that silently drops rows is the failure mode this whole product is built to
 * notice, and "the insert did not throw" has never once been evidence that the
 * data arrived.
 *
 * The mappers at the bottom are the other half of the contract story: they turn
 * a database row into the exact shape `@wizard-ads/shared` defines, so a
 * mismatch between schema and contract is a compile error in this file rather
 * than a runtime surprise in the grid.
 */
import { and, eq, getTableColumns, getTableName, gte, lte, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PgTable, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { DailyFact, PlacementFact, ProfileFact, SearchTermFact } from '@wizard-ads/shared';
import type { DbHandle } from '../client.js';
import { chunkForInsert } from './chunk.js';
import {
  factPlacementDaily,
  factProfileDaily,
  factSearchTermDaily,
  factSpTargetDaily,
} from '../schema/facts.js';
import type {
  NewPlacementFact,
  NewProfileFact,
  NewSearchTermFact,
  NewSpTargetFact,
  PlacementFactRow,
  ProfileFactRow,
  SearchTermFactRow,
  SpTargetFactRow,
} from '../schema/facts.js';

export interface LoadCounts {
  /** Rows handed to the loader. */
  offered: number;
  /** Rows the database reports as inserted or updated. */
  written: number;
}

export class FactLoadCountMismatch extends Error {
  constructor(
    readonly table: string,
    readonly counts: LoadCounts,
  ) {
    super(
      `${table}: offered ${counts.offered} rows, wrote ${counts.written}. ` +
        'A load that loses rows must fail loudly, not report success.',
    );
    this.name = 'FactLoadCountMismatch';
  }
}

function assertCounts(table: string, counts: LoadCounts): LoadCounts {
  if (counts.offered !== counts.written) throw new FactLoadCountMismatch(table, counts);
  return counts;
}

/** How many offending keys an error names before it stops listing them. */
const MAX_REPORTED_DUPLICATES = 5;

/** One component of a conflict key: a value of a column the grain is keyed on. */
type KeyPart = string | number | boolean | null | undefined;

export class DuplicateFactGrain extends Error {
  constructor(
    readonly table: string,
    /** How many distinct conflict keys appeared more than once in the batch. */
    readonly duplicateKeys: number,
    /** Up to {@link MAX_REPORTED_DUPLICATES} of them, key columns only. */
    readonly samples: readonly string[],
  ) {
    super(
      `${table}: ${duplicateKeys} conflict ` +
        `${duplicateKeys === 1 ? 'key appears' : 'keys appear'} more than once in one batch ` +
        `(${samples.length === duplicateKeys ? 'all' : `first ${samples.length}`}: ` +
        `${samples.join('; ')}). ` +
        'The report grain is the conflict grain, so a repeated key means Amazon returned a ' +
        'malformed report or the parser broke. Checked across the whole batch before chunking, ' +
        'so a duplicate cannot hide by landing in a different statement.',
    );
    this.name = 'DuplicateFactGrain';
  }
}

/**
 * Refuse a batch that carries the same conflict key twice.
 *
 * `key` must return exactly the columns that loader's `ON CONFLICT` target
 * names, in order. Null and undefined compare equal, which is what the fact
 * tables do: `fact_search_term_daily`'s grain index is declared `nulls not
 * distinct`, and the other three key only on `not null` columns.
 *
 * Pure and exported so the rule can be tested without a database.
 */
export function assertUniqueFactGrain<T>(
  table: string,
  rows: readonly T[],
  key: (row: T) => readonly KeyPart[],
): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    const encoded = JSON.stringify(key(row).map((part) => part ?? null));
    if (seen.has(encoded)) duplicates.add(encoded);
    else seen.add(encoded);
  }
  if (duplicates.size === 0) return;
  throw new DuplicateFactGrain(table, duplicates.size, [...duplicates].slice(0, MAX_REPORTED_DUPLICATES));
}

/**
 * Bind parameters one row of a table spends. A report day on a large profile
 * runs to tens of thousands of target rows, and Postgres caps a statement at
 * 65535 parameters, so every loader below writes in chunks this sizes.
 *
 * A duplicate conflict key is still an error and stays one: these grains are
 * keyed by exactly the columns the report is grouped by, so two rows with the
 * same key mean the report is not what we asked for. Only the mirror, which
 * merges three Amazon endpoints into one table, deduplicates.
 *
 * Chunking made that check the loader's own job. Postgres refuses to let one
 * `ON CONFLICT DO UPDATE` statement touch a row twice, but two copies of a key
 * that land in different chunks run as different statements: each succeeds, the
 * summed written count still equals offered, and the later copy silently
 * overwrites the earlier one. So every loader below calls
 * {@link assertUniqueFactGrain} over the whole batch before it chunks anything.
 * That is strictly stronger than the old single-statement behaviour — the same
 * duplicate now fails the same way whatever the chunk boundaries happen to be,
 * and it fails before a single row is written.
 */
function columnCount(table: PgTable): number {
  return Object.keys(getTableColumns(table)).length;
}

/**
 * Upsert target-grain facts. The conflict target is the grain key, so a
 * re-pull of a restated day overwrites rather than duplicating: reports restate
 * for 14+ days and the trailing re-pull is a normal Tuesday, not an exception.
 */
export async function upsertSpTargetFacts(
  handle: DbHandle,
  rows: readonly NewSpTargetFact[],
): Promise<LoadCounts> {
  if (rows.length === 0) return { offered: 0, written: 0 };
  assertUniqueFactGrain('fact_sp_target_daily', rows, (row) => [
    row.profileId,
    row.date,
    row.adProduct,
    row.campaignId,
    row.adGroupId,
    row.targetId,
  ]);

  let written = 0;
  for (const chunk of chunkForInsert(rows, columnCount(factSpTargetDaily))) {
    const result = await handle.db
      .insert(factSpTargetDaily)
      .values(chunk)
      .onConflictDoUpdate({
        target: [
          factSpTargetDaily.profileId,
          factSpTargetDaily.date,
          factSpTargetDaily.adProduct,
          factSpTargetDaily.campaignId,
          factSpTargetDaily.adGroupId,
          factSpTargetDaily.targetId,
        ],
        set: conflictSet(factSpTargetDaily, [
          'impressions',
          'clicks',
          'cost',
          'purchases1d',
          'purchases7d',
          'purchases14d',
          'purchases30d',
          'sales1d',
          'sales7d',
          'sales14d',
          'sales30d',
          'unitsSold7d',
          'topOfSearchImpressionShare',
          'matchType',
          'reportRequestId',
          'loadedAt',
        ]),
      })
      .returning({ profileId: factSpTargetDaily.profileId });
    written += result.length;
  }

  return assertCounts('fact_sp_target_daily', { offered: rows.length, written });
}

export async function upsertSearchTermFacts(
  handle: DbHandle,
  rows: readonly NewSearchTermFact[],
): Promise<LoadCounts> {
  if (rows.length === 0) return { offered: 0, written: 0 };
  assertUniqueFactGrain('fact_search_term_daily', rows, (row) => [
    row.profileId,
    row.date,
    row.campaignId,
    row.adGroupId,
    row.targetId,
    row.searchTerm,
  ]);

  let written = 0;
  for (const chunk of chunkForInsert(rows, columnCount(factSearchTermDaily))) {
    const result = await handle.db
      .insert(factSearchTermDaily)
      .values(chunk)
      .onConflictDoUpdate({
        target: [
          factSearchTermDaily.profileId,
          factSearchTermDaily.date,
          factSearchTermDaily.campaignId,
          factSearchTermDaily.adGroupId,
          factSearchTermDaily.targetId,
          factSearchTermDaily.searchTerm,
        ],
        set: conflictSet(factSearchTermDaily, [
          'impressions',
          'clicks',
          'cost',
          'purchases7d',
          'sales7d',
          'unitsSold7d',
          'matchType',
          'reportRequestId',
          'loadedAt',
        ]),
      })
      .returning({ profileId: factSearchTermDaily.profileId });
    written += result.length;
  }

  return assertCounts('fact_search_term_daily', { offered: rows.length, written });
}

export async function upsertPlacementFacts(
  handle: DbHandle,
  rows: readonly NewPlacementFact[],
): Promise<LoadCounts> {
  if (rows.length === 0) return { offered: 0, written: 0 };
  assertUniqueFactGrain('fact_placement_daily', rows, (row) => [
    row.profileId,
    row.date,
    row.adProduct,
    row.campaignId,
    row.placement,
  ]);

  let written = 0;
  for (const chunk of chunkForInsert(rows, columnCount(factPlacementDaily))) {
    const result = await handle.db
      .insert(factPlacementDaily)
      .values(chunk)
      .onConflictDoUpdate({
        target: [
          factPlacementDaily.profileId,
          factPlacementDaily.date,
          factPlacementDaily.adProduct,
          factPlacementDaily.campaignId,
          factPlacementDaily.placement,
        ],
        set: conflictSet(factPlacementDaily, [
          'impressions',
          'clicks',
          'cost',
          'purchases7d',
          'sales7d',
          'reportRequestId',
          'loadedAt',
        ]),
      })
      .returning({ profileId: factPlacementDaily.profileId });
    written += result.length;
  }

  return assertCounts('fact_placement_daily', { offered: rows.length, written });
}

export async function upsertProfileFacts(
  handle: DbHandle,
  rows: readonly NewProfileFact[],
): Promise<LoadCounts> {
  if (rows.length === 0) return { offered: 0, written: 0 };
  assertUniqueFactGrain('fact_profile_daily', rows, (row) => [row.profileId, row.date]);

  let written = 0;
  for (const chunk of chunkForInsert(rows, columnCount(factProfileDaily))) {
    const result = await handle.db
      .insert(factProfileDaily)
      .values(chunk)
      .onConflictDoUpdate({
        target: [factProfileDaily.profileId, factProfileDaily.date],
        set: conflictSet(factProfileDaily, [
          'impressions',
          'clicks',
          'cost',
          'purchases7d',
          'sales7d',
          'unitsSold7d',
          'provisional',
          'currencyCode',
          'reportRequestId',
          'loadedAt',
        ]),
      })
      .returning({ profileId: factProfileDaily.profileId });
    written += result.length;
  }

  return assertCounts('fact_profile_daily', { offered: rows.length, written });
}

/**
 * `set` clause that takes the incoming value for each named column, built from
 * the table definition so a renamed column is a compile error rather than a
 * silently ignored update.
 */
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

/** Target-grain rows for one profile over a window, oldest first. */
export async function readSpTargetFacts(
  handle: DbHandle,
  profileId: string,
  from: string,
  to: string,
): Promise<SpTargetFactRow[]> {
  return handle.db
    .select()
    .from(factSpTargetDaily)
    .where(
      and(
        eq(factSpTargetDaily.profileId, profileId),
        gte(factSpTargetDaily.date, from),
        lte(factSpTargetDaily.date, to),
      ),
    )
    .orderBy(factSpTargetDaily.date);
}

// ---------------------------------------------------------------------------
// Contract mappers
// ---------------------------------------------------------------------------

export const toDailyFact = (row: SpTargetFactRow): DailyFact => ({
  profileId: row.profileId,
  date: row.date,
  adProduct: row.adProduct,
  campaignId: row.campaignId,
  adGroupId: row.adGroupId,
  targetId: row.targetId,
  targetKind: row.targetKind,
  matchType: row.matchType,
  impressions: row.impressions,
  clicks: row.clicks,
  cost: row.cost,
  purchases1d: row.purchases1d,
  purchases7d: row.purchases7d,
  purchases14d: row.purchases14d,
  purchases30d: row.purchases30d,
  sales1d: row.sales1d,
  sales7d: row.sales7d,
  sales14d: row.sales14d,
  sales30d: row.sales30d,
  unitsSold7d: row.unitsSold7d,
  topOfSearchImpressionShare: row.topOfSearchImpressionShare,
});

export const toSearchTermFact = (row: SearchTermFactRow): SearchTermFact => ({
  profileId: row.profileId,
  date: row.date,
  adProduct: row.adProduct,
  campaignId: row.campaignId,
  adGroupId: row.adGroupId,
  targetId: row.targetId,
  searchTerm: row.searchTerm,
  matchType: row.matchType,
  impressions: row.impressions,
  clicks: row.clicks,
  cost: row.cost,
  purchases7d: row.purchases7d,
  sales7d: row.sales7d,
  unitsSold7d: row.unitsSold7d,
});

export const toPlacementFact = (row: PlacementFactRow): PlacementFact => ({
  profileId: row.profileId,
  date: row.date,
  adProduct: row.adProduct,
  campaignId: row.campaignId,
  placement: row.placement,
  impressions: row.impressions,
  clicks: row.clicks,
  cost: row.cost,
  purchases7d: row.purchases7d,
  sales7d: row.sales7d,
});

export const toProfileFact = (row: ProfileFactRow): ProfileFact => ({
  profileId: row.profileId,
  date: row.date,
  currencyCode: row.currencyCode,
  impressions: row.impressions,
  clicks: row.clicks,
  cost: row.cost,
  purchases7d: row.purchases7d,
  sales7d: row.sales7d,
  unitsSold7d: row.unitsSold7d,
  provisional: row.provisional,
});
