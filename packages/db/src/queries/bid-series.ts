/**
 * The bid corridor: loading and reading the per-target daily bid series (WP-28).
 *
 * `upsertBidSeries` follows the fact loaders' contract to the letter (program
 * rule 4): it counts rows written against rows offered and throws when they
 * differ, because a series load that silently drops a day is exactly the
 * failure this product exists to notice, and "the insert did not throw" has
 * never been evidence the data arrived. The conflict target is the grain key, so
 * re-syncing today's corridor overwrites rather than duplicating.
 *
 * The reads are the drill-down's data source: one target's whole history for the
 * modal chart, and the set of targets that have a corridor at all so the surface
 * can offer a chooser instead of a blank.
 */
import { and, eq, getTableColumns, getTableName, gte, lte, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PgTable, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { DbHandle } from '../client.js';
import { bidSeriesDaily } from '../schema/bid-series.js';
import type { BidSeriesRow, NewBidSeriesRow } from '../schema/bid-series.js';

export interface BidSeriesLoadCounts {
  /** Rows handed to the loader. */
  offered: number;
  /** Rows the database reports as inserted or updated. */
  written: number;
}

export class BidSeriesLoadCountMismatch extends Error {
  constructor(readonly counts: BidSeriesLoadCounts) {
    super(
      `bid_series_daily: offered ${counts.offered} rows, wrote ${counts.written}. ` +
        'A load that loses rows must fail loudly, not report success.',
    );
    this.name = 'BidSeriesLoadCountMismatch';
  }
}

/**
 * Upsert one profile's bid-series rows for a day. Idempotent on the grain key
 * `(profile, date, campaign, ad group, target)`, so a re-sync of today's
 * corridor overwrites the row rather than duplicating it.
 */
export async function upsertBidSeries(
  handle: DbHandle,
  rows: readonly NewBidSeriesRow[],
): Promise<BidSeriesLoadCounts> {
  if (rows.length === 0) return { offered: 0, written: 0 };

  const written = await handle.db
    .insert(bidSeriesDaily)
    .values([...rows])
    .onConflictDoUpdate({
      target: [
        bidSeriesDaily.profileId,
        bidSeriesDaily.date,
        bidSeriesDaily.campaignId,
        bidSeriesDaily.adGroupId,
        bidSeriesDaily.targetId,
      ],
      set: conflictSet(bidSeriesDaily, [
        'isKeyword',
        'suggestedBidLow',
        'suggestedBidMedian',
        'suggestedBidHigh',
        'bid',
        'cpc',
        'maxPotentialCpc',
        'modifierComponents',
        'loadedAt',
      ]),
    })
    .returning({ profileId: bidSeriesDaily.profileId });

  const counts = { offered: rows.length, written: written.length };
  if (counts.offered !== counts.written) throw new BidSeriesLoadCountMismatch(counts);
  return counts;
}

/** One target's corridor over a window, oldest first: the drill-down's series. */
export async function readBidSeries(
  handle: DbHandle,
  args: { orgId: string; profileId: string; targetId: string; from: string; to: string },
): Promise<BidSeriesRow[]> {
  return handle.db
    .select()
    .from(bidSeriesDaily)
    .where(
      and(
        eq(bidSeriesDaily.orgId, args.orgId),
        eq(bidSeriesDaily.profileId, args.profileId),
        eq(bidSeriesDaily.targetId, args.targetId),
        gte(bidSeriesDaily.date, args.from),
        lte(bidSeriesDaily.date, args.to),
      ),
    )
    .orderBy(bidSeriesDaily.date);
}

export interface BidSeriesTarget {
  targetId: string;
  isKeyword: boolean;
  campaignId: string;
  adGroupId: string;
  /** The most recent day this target carried a corridor. */
  lastDate: string;
  /** How many days of corridor exist for it in the window. */
  days: number;
}

/**
 * The targets that have a corridor in the window, most-recent first. The
 * surface offers these as the drill-down chooser rather than a blank field.
 */
export async function listBidSeriesTargets(
  handle: DbHandle,
  args: { orgId: string; profileId: string; from: string; to: string; limit?: number },
): Promise<BidSeriesTarget[]> {
  const rows = await handle.sql<
    {
      target_id: string;
      is_keyword: boolean;
      campaign_id: string;
      ad_group_id: string;
      last_date: string;
      days: string | number;
    }[]
  >`
    select target_id,
           bool_or(is_keyword) as is_keyword,
           max(campaign_id) as campaign_id,
           max(ad_group_id) as ad_group_id,
           max(date)::text as last_date,
           count(*) as days
      from public.bid_series_daily
     where org_id = ${args.orgId}
       and profile_id = ${args.profileId}
       and date between ${args.from} and ${args.to}
     group by target_id
     order by last_date desc, days desc
     limit ${args.limit ?? 50}
  `;
  return rows.map((row) => ({
    targetId: row.target_id,
    isKeyword: row.is_keyword,
    campaignId: row.campaign_id,
    adGroupId: row.ad_group_id,
    lastDate: row.last_date,
    days: Number(row.days),
  }));
}

/**
 * `set` clause that takes the incoming value for each named column, built from
 * the table definition so a renamed column is a compile error rather than a
 * silently ignored update. Mirrors the fact loaders' helper.
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
