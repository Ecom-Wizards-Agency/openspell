/**
 * The database side of the backfill.
 *
 * Raw SQL rather than the query builder, for the reason the crosscheck gives
 * for the same choice: numerics come back from the driver as strings, every one
 * of them is converted explicitly, and `"10.80" + "9.20"` is a data-quality
 * incident with a plausible-looking output. Rows go in through `unnest` of
 * per-column arrays, which keeps every value a bound parameter — a backfill
 * that string-built its inserts would be an injection surface fed by somebody
 * else's CSV.
 *
 * Every one of those arrays is bound as `text[]` and cast to its real type
 * inside the `select`, which looks redundant and is not: postgres.js serialises
 * an array parameter with the array serializer for the type the server
 * describes, and with `prepare: false` — mandatory, because Supabase's
 * transaction-mode pooler refuses prepared statements — it has no serializer
 * for `numeric[]` and hands the raw JavaScript array to the socket writer. The
 * failure is a `TypeError` from four frames inside the driver, at load time,
 * with nothing in the type system to warn you. `text[]` in, cast in SQL, works
 * on both sides.
 *
 * ## The two rules that make a backfill safe to run twice
 *
 * **API wins.** A day that already has a fact row from our own Reporting v3
 * pull is never touched. The backfill fills the gap in front of the API's 60-to
 * -95-day window; it does not restate what we measured ourselves. Only rows the
 * backfill itself wrote are overwritten, which is what makes a rerun idempotent
 * instead of destructive.
 *
 * **Every fact row gets a ledger row.** `fact_profile_daily` has no `source`
 * column — it has `report_request_id` — so provenance is a join, and the join
 * only works if the pointer is always set. The crosscheck's exclusion is
 * written as "a request that names a non-Amazon source", so a backfilled fact
 * with a null pointer would read as ours and poison exactly the check this
 * whole package exists to protect. The insert therefore creates the ledger row
 * first and refuses to write facts without one.
 */
import { ensureFactPartitions } from '@wizard-ads/db';
import type { DbHandle } from '@wizard-ads/db';
import type { ProfileDayRow } from './timeline.js';
import { profileLocalToday } from './timeline.js';
import { BACKFILL_SOURCE, sumRows } from './rollup.js';
import type { ParsedRollup, RollupTotals } from './rollup.js';

/** `report_requests.source` for everything this tool writes. */
export const LEDGER_SOURCE = 'adlabs_backfill';

/**
 * The `report_type` a Phase 0 ledger row carries.
 *
 * `report_type` is an enum of Amazon's Reporting v3 ids and `spCampaigns` is
 * the report our own pipeline aggregates into `fact_profile_daily`. Reusing it
 * keeps the ledger's vocabulary honest — this row describes the same grain the
 * API row would have — and avoids widening an enum that `packages/shared` and
 * the Drizzle mirror both restate. `source` is the discriminator, not the type.
 */
export const PROFILE_REPORT_TYPE = 'spCampaigns';

export interface ProfileTarget {
  profileId: string;
  orgId: string;
  amazonProfileId: string;
  currencyCode: string;
  timezone: string;
}

export class ProfileNotOnboarded extends Error {
  constructor(amazonProfileId: string) {
    super(
      `no ad_profiles row for Amazon profile ${amazonProfileId}. ` +
        'The backfill loads history for profiles the product already knows about; onboard it first.',
    );
    this.name = 'ProfileNotOnboarded';
  }
}

/** Every onboarded profile, keyed by Amazon's profile id. */
export async function readProfileTargets(handle: DbHandle): Promise<Map<string, ProfileTarget>> {
  const rows = await handle.sql<
    {
      id: string;
      org_id: string;
      amazon_profile_id: string;
      currency_code: string;
      timezone: string;
    }[]
  >`
    select id, org_id, amazon_profile_id, currency_code, timezone
    from public.ad_profiles
    order by amazon_profile_id
  `;
  return new Map(
    rows.map((row) => [
      row.amazon_profile_id,
      {
        profileId: row.id,
        orgId: row.org_id,
        amazonProfileId: row.amazon_profile_id,
        currencyCode: row.currency_code,
        timezone: row.timezone,
      },
    ]),
  );
}

export interface Phase0Options {
  /** The currency from the AdLabs roster, checked against ours rather than trusted. */
  adlabsCurrency?: string;
  /** Overridable so a test can pin "today". */
  now?: Date;
  /** Parse, count and report, but write nothing. */
  dryRun?: boolean;
}

export interface Phase0Result {
  amazonProfileId: string;
  profileId: string;
  /** Nonzero days the export offered for this profile. */
  rowsOffered: number;
  /** Dropped: the profile's current local day and anything after it. */
  rowsInProgress: number;
  /** Dropped: a day we already hold from a non-backfill source. API wins. */
  rowsApiCovered: number;
  /** What was actually handed to the insert. `rows_parsed` on the ledger row. */
  rowsEligible: number;
  /** What the insert reported back. `rows_loaded` on the ledger row. */
  rowsLoaded: number;
  firstDate: string | null;
  lastDate: string | null;
  /** Null on a dry run. */
  reportRequestId: string | null;
  /** AdLabs' currency for this profile, when it disagreed with ours. */
  currencyMismatch: string | null;
}

/**
 * Load one profile's daily history into `fact_profile_daily`.
 *
 * The order is: decide what is eligible, open the partitions, write the ledger
 * row, insert, then write the loaded count back. If anything fails after the
 * ledger row exists it stays behind with `rows_loaded` null and `counts_match`
 * null, which is the state an operator can find with one query — a load that
 * left no trace is a load nobody can audit.
 */
export async function loadProfileDays(
  handle: DbHandle,
  target: ProfileTarget,
  days: readonly ProfileDayRow[],
  options: Phase0Options = {},
): Promise<Phase0Result> {
  const localToday = profileLocalToday(target.timezone, options.now ?? new Date());
  const complete = days.filter((day) => day.date < localToday);
  const rowsInProgress = days.length - complete.length;

  const covered =
    complete.length === 0
      ? new Set<string>()
      : await readNonBackfilledDates(
          handle,
          target.profileId,
          complete[0]?.date as string,
          complete[complete.length - 1]?.date as string,
        );
  const eligible = complete.filter((day) => !covered.has(day.date));

  const result: Phase0Result = {
    amazonProfileId: target.amazonProfileId,
    profileId: target.profileId,
    rowsOffered: days.length,
    rowsInProgress,
    rowsApiCovered: complete.length - eligible.length,
    rowsEligible: eligible.length,
    rowsLoaded: 0,
    firstDate: eligible[0]?.date ?? null,
    lastDate: eligible[eligible.length - 1]?.date ?? null,
    reportRequestId: null,
    currencyMismatch:
      options.adlabsCurrency !== undefined && options.adlabsCurrency !== target.currencyCode
        ? options.adlabsCurrency
        : null,
  };

  if (eligible.length === 0 || options.dryRun === true) return result;

  await ensureMonths(handle, result.firstDate as string, result.lastDate as string);

  const requests = await handle.sql<{ id: string }[]>`
    insert into public.report_requests
      (org_id, profile_id, report_type, start_date, end_date, status, source,
       requested_at, completed_at, rows_parsed)
    values (${target.orgId}, ${target.profileId}, ${PROFILE_REPORT_TYPE},
            ${result.firstDate}, ${result.lastDate}, 'completed', ${LEDGER_SOURCE},
            now(), now(), ${eligible.length})
    returning id
  `;
  const reportRequestId = requests[0]?.id;
  if (reportRequestId === undefined) {
    throw new Error('the ledger row was not created; refusing to write facts with no provenance');
  }
  result.reportRequestId = reportRequestId;

  let loaded = 0;
  for (const chunk of chunks(eligible, 2000)) {
    loaded += await insertProfileDays(handle, target, reportRequestId, chunk);
  }
  result.rowsLoaded = loaded;

  await handle.sql`
    update public.report_requests set rows_loaded = ${loaded} where id = ${reportRequestId}
  `;

  return result;
}

export interface Phase1Options {
  /** Inclusive window the export was pulled for. Written to `days`. */
  startDate: string;
  endDate: string;
  dryRun?: boolean;
}

export interface Phase1Result {
  amazonProfileId: string;
  profileId: string;
  month: string;
  grain: string;
  rowsSeen: number;
  rowsIdle: number;
  rowsMerged: number;
  rowsEligible: number;
  rowsLoaded: number;
  days: number;
  /** Summed from the file. */
  fileTotals: RollupTotals;
  /** Read back out of the database after the insert, for the same rows. */
  storedTotals: RollupTotals | null;
}

/**
 * Load one profile-month of one grain into `fact_monthly_rollup`.
 *
 * No ledger row: `fact_monthly_rollup` carries its own `source` column, and a
 * report request describing a table the crosscheck never reads would be
 * ceremony. The reconciliation is done by reading the rows back and summing
 * them, which is a stronger check than trusting the row count — it catches a
 * numeric that lost precision on the way in, which a count cannot.
 */
export async function loadRollupMonth(
  handle: DbHandle,
  target: ProfileTarget,
  parsed: ParsedRollup,
  options: Phase1Options,
): Promise<Phase1Result> {
  const month = `${options.startDate.slice(0, 7)}-01`;
  const days = dayCount(options.startDate, options.endDate);

  const result: Phase1Result = {
    amazonProfileId: target.amazonProfileId,
    profileId: target.profileId,
    month,
    grain: parsed.grain,
    rowsSeen: parsed.rowsSeen,
    rowsIdle: parsed.rowsIdle,
    rowsMerged: parsed.rowsMerged,
    rowsEligible: parsed.rows.length,
    rowsLoaded: 0,
    days,
    fileTotals: parsed.totals,
    storedTotals: null,
  };

  if (parsed.rows.length === 0 || options.dryRun === true) return result;

  let loaded = 0;
  for (const chunk of chunks(parsed.rows, 1000)) {
    loaded += await insertRollupRows(handle, target, month, days, chunk);
  }
  result.rowsLoaded = loaded;
  result.storedTotals = await readRollupTotals(handle, target.profileId, month, parsed.grain);
  return result;
}

/** The stored figures for one profile-month-grain of backfilled rollup. */
export async function readRollupTotals(
  handle: DbHandle,
  profileId: string,
  month: string,
  grain: string,
): Promise<RollupTotals> {
  const rows = await handle.sql<
    {
      impressions: string | null;
      clicks: string | null;
      cost: string | null;
      purchases_7d: string | null;
      sales_7d: string | null;
      units_sold_7d: string | null;
    }[]
  >`
    select
      coalesce(sum(impressions), 0)::text as impressions,
      coalesce(sum(clicks), 0)::text as clicks,
      coalesce(sum(cost), 0)::text as cost,
      coalesce(sum(purchases_7d), 0)::text as purchases_7d,
      coalesce(sum(sales_7d), 0)::text as sales_7d,
      coalesce(sum(units_sold_7d), 0)::text as units_sold_7d
    from public.fact_monthly_rollup
    where profile_id = ${profileId}
      and month = ${month}
      and source = ${BACKFILL_SOURCE}
      and dimensions ->> 'grain' = ${grain}
  `;
  const row = rows[0];
  return {
    impressions: Number(row?.impressions ?? 0),
    clicks: Number(row?.clicks ?? 0),
    cost: Number(row?.cost ?? 0),
    purchases7d: Number(row?.purchases_7d ?? 0),
    sales7d: Number(row?.sales_7d ?? 0),
    unitsSold7d: Number(row?.units_sold_7d ?? 0),
  };
}

export interface BackfilledDepth {
  amazonProfileId: string;
  firstDate: string | null;
  lastDate: string | null;
  days: number;
}

/** What the backfill actually put in `fact_profile_daily`, per profile. */
export async function readBackfilledDepth(handle: DbHandle): Promise<BackfilledDepth[]> {
  const rows = await handle.sql<
    { amazon_profile_id: string; first_date: string | null; last_date: string | null; days: string }[]
  >`
    select p.amazon_profile_id,
           min(f.date)::text as first_date,
           max(f.date)::text as last_date,
           count(*)::text as days
    from public.fact_profile_daily f
    join public.ad_profiles p on p.id = f.profile_id
    join public.report_requests r on r.id = f.report_request_id
    where r.source = ${LEDGER_SOURCE}
    group by p.amazon_profile_id
    order by p.amazon_profile_id
  `;
  return rows.map((row) => ({
    amazonProfileId: row.amazon_profile_id,
    firstDate: row.first_date,
    lastDate: row.last_date,
    days: Number(row.days),
  }));
}

/**
 * The dates in the window we already hold from something other than this
 * backfill. Those days are not overwritten: API wins.
 */
async function readNonBackfilledDates(
  handle: DbHandle,
  profileId: string,
  startDate: string,
  endDate: string,
): Promise<Set<string>> {
  const rows = await handle.sql<{ date: string }[]>`
    select f.date::text as date
    from public.fact_profile_daily f
    where f.profile_id = ${profileId}
      and f.date between ${startDate} and ${endDate}
      and not exists (
        select 1 from public.report_requests r
        where r.id = f.report_request_id and r.source = ${LEDGER_SOURCE}
      )
  `;
  return new Set(rows.map((row) => row.date));
}

async function insertProfileDays(
  handle: DbHandle,
  target: ProfileTarget,
  reportRequestId: string,
  rows: readonly ProfileDayRow[],
): Promise<number> {
  const written = await handle.sql<{ ok: number }[]>`
    insert into public.fact_profile_daily
      (org_id, profile_id, date, currency_code, impressions, clicks, cost, purchases_7d,
       sales_7d, units_sold_7d, provisional, report_request_id)
    select ${target.orgId}::uuid, ${target.profileId}::uuid, d.date::date, ${target.currencyCode},
           d.impressions::bigint, d.clicks::bigint, d.cost::numeric, d.purchases_7d::bigint,
           d.sales_7d::numeric, d.units_sold_7d::bigint, false, ${reportRequestId}::uuid
    from unnest(
      ${rows.map((row) => row.date)}::text[],
      ${rows.map((row) => String(Math.round(row.impressions)))}::text[],
      ${rows.map((row) => String(Math.round(row.clicks)))}::text[],
      ${rows.map((row) => row.cost.toFixed(4))}::text[],
      ${rows.map((row) => String(Math.round(row.purchases7d)))}::text[],
      ${rows.map((row) => row.sales7d.toFixed(4))}::text[],
      ${rows.map((row) => String(Math.round(row.unitsSold7d)))}::text[]
    ) as d(date, impressions, clicks, cost, purchases_7d, sales_7d, units_sold_7d)
    on conflict (profile_id, date) do update set
      currency_code = excluded.currency_code,
      impressions = excluded.impressions,
      clicks = excluded.clicks,
      cost = excluded.cost,
      purchases_7d = excluded.purchases_7d,
      sales_7d = excluded.sales_7d,
      units_sold_7d = excluded.units_sold_7d,
      provisional = excluded.provisional,
      report_request_id = excluded.report_request_id,
      loaded_at = now()
    returning 1 as ok
  `;
  return written.length;
}

async function insertRollupRows(
  handle: DbHandle,
  target: ProfileTarget,
  month: string,
  days: number,
  rows: readonly { dimensions: Record<string, string>; impressions: number; clicks: number; cost: number; purchases7d: number; sales7d: number; unitsSold7d: number }[],
): Promise<number> {
  const written = await handle.sql<{ ok: number }[]>`
    insert into public.fact_monthly_rollup
      (org_id, profile_id, month, source, dimensions, days, impressions, clicks, cost,
       purchases_7d, purchases_14d, sales_7d, sales_14d, units_sold_7d)
    select ${target.orgId}::uuid, ${target.profileId}::uuid, ${month}::date, ${BACKFILL_SOURCE},
           r.dimensions::jsonb, ${days}::integer, r.impressions::bigint, r.clicks::bigint,
           r.cost::numeric, r.purchases_7d::bigint, null::bigint, r.sales_7d::numeric,
           null::numeric, r.units_sold_7d::bigint
    from unnest(
      ${rows.map((row) => JSON.stringify(row.dimensions))}::text[],
      ${rows.map((row) => String(Math.round(row.impressions)))}::text[],
      ${rows.map((row) => String(Math.round(row.clicks)))}::text[],
      ${rows.map((row) => row.cost.toFixed(4))}::text[],
      ${rows.map((row) => String(Math.round(row.purchases7d)))}::text[],
      ${rows.map((row) => row.sales7d.toFixed(4))}::text[],
      ${rows.map((row) => String(Math.round(row.unitsSold7d)))}::text[]
    ) as r(dimensions, impressions, clicks, cost, purchases_7d, sales_7d, units_sold_7d)
    on conflict (profile_id, month, source, dimensions) do update set
      org_id = excluded.org_id,
      days = excluded.days,
      impressions = excluded.impressions,
      clicks = excluded.clicks,
      cost = excluded.cost,
      purchases_7d = excluded.purchases_7d,
      purchases_14d = excluded.purchases_14d,
      sales_7d = excluded.sales_7d,
      sales_14d = excluded.sales_14d,
      units_sold_7d = excluded.units_sold_7d,
      rolled_up_at = now()
    returning 1 as ok
  `;
  return written.length;
}

/**
 * Open every monthly partition the load will write into.
 *
 * `app.ensure_fact_partitions` is idempotent and, per its own comment, is how a
 * backfill opens historical months. There is deliberately no default partition
 * on the fact tables, so an unopened month is an error rather than a row that
 * quietly lands in the wrong place.
 */
async function ensureMonths(handle: DbHandle, firstDate: string, lastDate: string): Promise<void> {
  const from = `${firstDate.slice(0, 7)}-01`;
  const months = monthSpan(firstDate, lastDate);
  await ensureFactPartitions(handle, from, months);
}

function monthSpan(firstDate: string, lastDate: string): number {
  const [fy, fm] = firstDate.split('-').map(Number) as [number, number];
  const [ly, lm] = lastDate.split('-').map(Number) as [number, number];
  return (ly - fy) * 12 + (lm - fm);
}

function dayCount(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  return Math.floor((end - start) / 86_400_000) + 1;
}

function* chunks<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let at = 0; at < items.length; at += size) yield items.slice(at, at + size);
}

/** Re-exported so a caller can total a parsed file without importing two modules. */
export { sumRows };
