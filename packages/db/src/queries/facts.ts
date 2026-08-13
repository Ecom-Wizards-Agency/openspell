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

  const written = await handle.db
    .insert(factSpTargetDaily)
    .values([...rows])
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

  return assertCounts('fact_sp_target_daily', {
    offered: rows.length,
    written: written.length,
  });
}

export async function upsertSearchTermFacts(
  handle: DbHandle,
  rows: readonly NewSearchTermFact[],
): Promise<LoadCounts> {
  if (rows.length === 0) return { offered: 0, written: 0 };

  const written = await handle.db
    .insert(factSearchTermDaily)
    .values([...rows])
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

  return assertCounts('fact_search_term_daily', {
    offered: rows.length,
    written: written.length,
  });
}

export async function upsertPlacementFacts(
  handle: DbHandle,
  rows: readonly NewPlacementFact[],
): Promise<LoadCounts> {
  if (rows.length === 0) return { offered: 0, written: 0 };

  const written = await handle.db
    .insert(factPlacementDaily)
    .values([...rows])
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

  return assertCounts('fact_placement_daily', { offered: rows.length, written: written.length });
}

export async function upsertProfileFacts(
  handle: DbHandle,
  rows: readonly NewProfileFact[],
): Promise<LoadCounts> {
  if (rows.length === 0) return { offered: 0, written: 0 };

  const written = await handle.db
    .insert(factProfileDaily)
    .values([...rows])
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

  return assertCounts('fact_profile_daily', { offered: rows.length, written: written.length });
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
