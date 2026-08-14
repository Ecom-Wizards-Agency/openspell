/**
 * Phase 1: one profile-month of one grain, normalised to `fact_monthly_rollup`.
 *
 * Phase 1 exists because the daily walk does not have to. A month at campaign,
 * target, placement and search-term grain is one fetch each — about 1,800 calls
 * for the whole team against the ~55,000 a daily walk needs — and it lands in a
 * table that already carries a `source` column, so it cannot touch the
 * crosscheck at all. Long-run trend charts, almost free, before anyone commits
 * to the expensive phase.
 *
 * ## The three things this file is careful about
 *
 * **Attribution.** Every AdLabs entity exposes a single `sales` and a single
 * `orders` and does not say which attribution window they are. Our tables carry
 * 1/7/14/30-day columns precisely because Amazon restates. Guessing would be a
 * silent, permanent error, so the figures land in the 7-day columns — the
 * product's default window everywhere else — and the 14-day columns are left
 * **null**, not zero. Null is a question mark; zero is a claim. When the
 * overlap window resolves which window AdLabs actually means, the fix is an
 * update over `source = 'adlabs_backfill'` rows, and until then no chart can
 * accidentally add a real 14-day figure to a fabricated one.
 *
 * **Roster drift.** Entity rosters are current-state: a fetch for a month two
 * years ago returns the entities that exist *today*, and archived campaigns and
 * deleted targets are invisible. So a backfilled month can under-report what
 * actually happened, and nothing in this source recovers it. What the loader
 * can do is notice: the campaign-grain total is the reconciliation baseline,
 * and a target-grain month that does not sum to it is recorded with a
 * shortfall, never silently.
 *
 * **`days`.** The rollup's `days` column means "days with data" when the
 * partition automation writes it, because it counts distinct dates in the daily
 * table. A monthly window pull has no date column at all — the day is a
 * property of the request — so this loader writes the length of the window it
 * asked for. Same column, weaker claim, stated here rather than discovered
 * later by someone dividing by it.
 */
import { metric, parseProjected } from './csv.js';
import type { CsvDelimiter } from './csv.js';

/** The grains Phase 1 rolls up. Ad-group grain is Phase 2's carrier, not this one's. */
export const ROLLUP_GRAINS = ['campaign', 'target', 'placement', 'search_term'] as const;
export type RollupGrain = (typeof ROLLUP_GRAINS)[number];

/** `fact_monthly_rollup.source` for everything this tool writes. */
export const BACKFILL_SOURCE = 'adlabs_backfill';

/** The metric columns, identical across every AdLabs entity export. */
const METRIC_COLUMNS = ['impressions', 'clicks', 'spend', 'orders', 'sales', 'units'] as const;

/**
 * The dimension columns per grain, chosen to mirror the dimensions the
 * partition automation already rolls up (`app.fact_partitions.rollup_dimensions`)
 * so a backfilled month and an aged-out month describe the same thing.
 */
const DIMENSION_COLUMNS: Record<RollupGrain, readonly string[]> = {
  campaign: ['campaign_id', 'campaign_ad_type'],
  target: ['campaign_id', 'ad_group_id', 'target_id', 'campaign_ad_type'],
  placement: ['campaign_id', 'placement_type_raw', 'campaign_ad_type'],
  search_term: ['campaign_id', 'ad_group_id', 'search_term', 'campaign_ad_type'],
};

export interface RollupRow {
  /** Written to `fact_monthly_rollup.dimensions`. Every value is text, as jsonb. */
  dimensions: Record<string, string>;
  impressions: number;
  clicks: number;
  cost: number;
  purchases7d: number;
  sales7d: number;
  unitsSold7d: number;
}

export interface RollupTotals {
  impressions: number;
  clicks: number;
  cost: number;
  purchases7d: number;
  sales7d: number;
  unitsSold7d: number;
}

export interface ParsedRollup {
  grain: RollupGrain;
  /** Data rows in the file. */
  rowsSeen: number;
  /**
   * Rows dropped because the entity did nothing that month. The server-side
   * `impressions > 0 OR spend > 0 OR clicks > 0` filter should already have
   * removed these; this is the belt to that braces, and a nonzero count here
   * means the filter was forgotten.
   */
  rowsIdle: number;
  /** Rows folded into an earlier row with identical dimensions. */
  rowsMerged: number;
  rows: RollupRow[];
  /** Summed over `rows`. What the AdLabs aggregate reference must agree with. */
  totals: RollupTotals;
}

export class RollupParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RollupParseError';
  }
}

/**
 * Parse one grain's export for one profile-month.
 *
 * Rows that share a dimension tuple are summed rather than fighting over the
 * primary key: `(profile_id, month, source, dimensions)` is unique, and an
 * insert that let the last row win would silently discard the others.
 */
export function parseEntityExport(grain: RollupGrain, text: string): ParsedRollup {
  const dimensionColumns = DIMENSION_COLUMNS[grain];
  const table = parseProjected(text, [...dimensionColumns, ...METRIC_COLUMNS]);

  const merged = new Map<string, RollupRow>();
  let rowsIdle = 0;
  let rowsMerged = 0;

  for (const row of table.rows) {
    const figures = readMetrics(row, table.delimiter);
    if (figures.impressions === 0 && figures.clicks === 0 && figures.cost === 0) {
      rowsIdle += 1;
      continue;
    }

    const dimensions = buildDimensions(grain, dimensionColumns, row);
    const key = JSON.stringify(dimensions);
    const existing = merged.get(key);
    if (existing) {
      rowsMerged += 1;
      existing.impressions += figures.impressions;
      existing.clicks += figures.clicks;
      existing.cost = round4(existing.cost + figures.cost);
      existing.purchases7d += figures.purchases7d;
      existing.sales7d = round4(existing.sales7d + figures.sales7d);
      existing.unitsSold7d += figures.unitsSold7d;
      continue;
    }
    merged.set(key, { dimensions, ...figures });
  }

  const rows = [...merged.values()];
  return {
    grain,
    rowsSeen: table.rows.length,
    rowsIdle,
    rowsMerged,
    rows,
    totals: sumRows(rows),
  };
}

export function sumRows(rows: readonly RollupRow[]): RollupTotals {
  const totals: RollupTotals = {
    impressions: 0,
    clicks: 0,
    cost: 0,
    purchases7d: 0,
    sales7d: 0,
    unitsSold7d: 0,
  };
  for (const row of rows) {
    totals.impressions += row.impressions;
    totals.clicks += row.clicks;
    totals.cost = round4(totals.cost + row.cost);
    totals.purchases7d += row.purchases7d;
    totals.sales7d = round4(totals.sales7d + row.sales7d);
    totals.unitsSold7d += row.unitsSold7d;
  }
  return totals;
}

/** `Sponsored Products` → `SP`. The raw column is the provider's, not ours. */
export function adProduct(label: string | undefined): string {
  const text = (label ?? '').trim().toLowerCase();
  if (text.includes('brand')) return 'SB';
  if (text.includes('display')) return 'SD';
  if (text.includes('product')) return 'SP';
  return 'unknown';
}

function buildDimensions(
  grain: RollupGrain,
  columns: readonly string[],
  row: Record<string, string>,
): Record<string, string> {
  const dimensions: Record<string, string> = { grain };
  for (const column of columns) {
    const value = (row[column] ?? '').trim();
    if (column === 'campaign_ad_type') {
      dimensions['ad_product'] = adProduct(value);
      continue;
    }
    if (column === 'placement_type_raw') {
      // The provider's own label, kept raw: SITE_AMAZON_BUSINESS is a known
      // quirk that is in the rows and out of the aggregate, and renaming it
      // would hide that.
      dimensions['placement'] = value;
      continue;
    }
    dimensions[column] = value;
  }

  const identifier = dimensions['campaign_id'];
  if (identifier === undefined || identifier === '') {
    throw new RollupParseError(`a ${grain} row has no campaign id; refusing to key a rollup on it`);
  }
  return dimensions;
}

function readMetrics(row: Record<string, string>, delimiter: CsvDelimiter) {
  return {
    impressions: Math.round(metric(row['impressions'], delimiter)),
    clicks: Math.round(metric(row['clicks'], delimiter)),
    cost: round4(metric(row['spend'], delimiter)),
    purchases7d: Math.round(metric(row['orders'], delimiter)),
    sales7d: round4(metric(row['sales'], delimiter)),
    unitsSold7d: Math.round(metric(row['units'], delimiter)),
  };
}

/** `numeric(16,4)` is the column; four decimals is the most it can hold. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
