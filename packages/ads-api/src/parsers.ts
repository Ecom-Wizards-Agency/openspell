/**
 * One typed parser per report shape. Never a generic one.
 *
 * The five Sponsored Products / Brands / Display report schemas overlap enough
 * to tempt a single "flexible" parser and differ enough that one would have to
 * guess: `spTargeting` names its identifier `keywordId` whether the row is a
 * keyword or a product target, `spSearchTerm` carries both a keyword and the
 * customer's query, placement rows have no ad group at all, and Sponsored
 * Brands reports a single `purchases` column where Sponsored Products reports
 * four attribution windows. A generic parser resolves those by falling back,
 * and a fallback in a fact pipeline is a silent wrong number.
 *
 * Every parser returns what it produced *and* what it refused, with the input
 * count alongside, so the caller can assert `rows + skipped === input`
 * (Rule 4). A row is refused only when a dimension the grain is keyed by is
 * missing — never for a missing metric, which is legitimately zero.
 *
 * Rows are emitted without `profileId`: the report knows Amazon's profile, the
 * contract's `profileId` is our database uuid, and only the worker holds both.
 */
import type { DailyFact, MatchType, Placement, PlacementFact, SearchTermFact } from '@wizard-ads/shared';
import { mapMatchType } from './mappers.js';
import { isRecord, normalizeEnum, readCount, readId, readMoney, readNumber, readString } from './read.js';

/** A fact row as this package can produce it: everything but the tenant join. */
export type ReportFact<T> = Omit<T, 'profileId'>;

export interface SkippedReportRow {
  index: number;
  reason: string;
}

export interface ParseResult<T> {
  rows: T[];
  skipped: SkippedReportRow[];
  /** Rows in the downloaded payload. `rows.length + skipped.length` equals it. */
  input: number;
}

function finish<T>(rows: T[], skipped: SkippedReportRow[], input: number): ParseResult<T> {
  return { rows, skipped, input };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The report's own day.
 *
 * `DAILY` reports carry `date`; a `SUMMARY` report carries `startDate` and
 * `endDate` instead, and using `startDate` as if it were a day would smear a
 * whole window onto one date. Only the daily form is accepted.
 */
function readReportDate(row: Record<string, unknown>): string | null {
  const value = readString(row, 'date');
  if (value === null) return null;
  return ISO_DATE.test(value) ? value : null;
}

/**
 * Top-of-search impression share, as a fraction.
 *
 * Amazon reports it as a percentage on some grains and a fraction on others,
 * and the contract bounds it to 0..1. Values above 1 are treated as percent;
 * anything still out of range is dropped rather than clamped, because a clamped
 * 4 000% would look like a legitimate 100%.
 */
function readImpressionShare(row: Record<string, unknown>): number | null {
  const raw = readNumber(row, 'topOfSearchImpressionShare');
  if (raw === null) return null;
  const fraction = raw > 1 ? raw / 100 : raw;
  return fraction >= 0 && fraction <= 1 ? fraction : null;
}

/** Sponsored Products units column, across the spellings the report types use. */
function readUnitsSold7d(row: Record<string, unknown>): number {
  if (row['unitsSoldClicks7d'] !== undefined) return readCount(row, 'unitsSoldClicks7d');
  if (row['unitsSoldSameSku7d'] !== undefined) return readCount(row, 'unitsSoldSameSku7d');
  return readCount(row, 'unitsSold7d');
}

/**
 * Target grain (`spTargeting`) to the fact that is the spine of the product.
 *
 * `keywordId` is the identifier for keywords *and* product targets; the two are
 * told apart by whether the row's match type is one of the keyword match types.
 * `matchType` stays null for product targets rather than being invented from
 * the `targeting` expression string, which is display text, not a contract.
 */
export function parseSpTargetingReport(
  raw: readonly unknown[],
): ParseResult<ReportFact<DailyFact>> {
  const rows: ReportFact<DailyFact>[] = [];
  const skipped: SkippedReportRow[] = [];

  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      skipped.push({ index, reason: 'not an object' });
      return;
    }
    const date = readReportDate(entry);
    const campaignId = readId(entry, 'campaignId');
    const adGroupId = readId(entry, 'adGroupId');
    const targetId = readId(entry, 'keywordId') ?? readId(entry, 'targetId');
    if (date === null || campaignId === null || adGroupId === null || targetId === null) {
      skipped.push({
        index,
        reason:
          date === null
            ? 'no daily date column'
            : campaignId === null
              ? 'no campaignId'
              : adGroupId === null
                ? 'no adGroupId'
                : 'no keywordId or targetId',
      });
      return;
    }
    const matchType: MatchType | null =
      mapMatchType(readString(entry, 'matchType')) ?? mapMatchType(readString(entry, 'keywordType'));

    rows.push({
      date,
      adProduct: 'SP',
      campaignId,
      adGroupId,
      targetId,
      targetKind: matchType === null ? 'target' : 'keyword',
      matchType,
      impressions: readCount(entry, 'impressions'),
      clicks: readCount(entry, 'clicks'),
      cost: readMoney(entry, 'cost'),
      purchases1d: readCount(entry, 'purchases1d'),
      purchases7d: readCount(entry, 'purchases7d'),
      purchases14d: readCount(entry, 'purchases14d'),
      purchases30d: readCount(entry, 'purchases30d'),
      sales1d: readMoney(entry, 'sales1d'),
      sales7d: readMoney(entry, 'sales7d'),
      sales14d: readMoney(entry, 'sales14d'),
      sales30d: readMoney(entry, 'sales30d'),
      unitsSold7d: readUnitsSold7d(entry),
      topOfSearchImpressionShare: readImpressionShare(entry),
    });
  });

  return finish(rows, skipped, raw.length);
}

/**
 * Search-term grain.
 *
 * `targetId` is nullable here and that nullability is real: an auto campaign
 * attributes a term to a target it does not always name, and forcing a value
 * would invent a join key.
 */
export function parseSpSearchTermReport(
  raw: readonly unknown[],
): ParseResult<ReportFact<SearchTermFact>> {
  const rows: ReportFact<SearchTermFact>[] = [];
  const skipped: SkippedReportRow[] = [];

  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      skipped.push({ index, reason: 'not an object' });
      return;
    }
    const date = readReportDate(entry);
    const campaignId = readId(entry, 'campaignId');
    const adGroupId = readId(entry, 'adGroupId');
    const searchTerm = readString(entry, 'searchTerm');
    if (date === null || campaignId === null || adGroupId === null || searchTerm === null) {
      skipped.push({
        index,
        reason:
          date === null
            ? 'no daily date column'
            : campaignId === null
              ? 'no campaignId'
              : adGroupId === null
                ? 'no adGroupId'
                : 'no searchTerm',
      });
      return;
    }
    rows.push({
      date,
      adProduct: 'SP',
      campaignId,
      adGroupId,
      targetId: readId(entry, 'keywordId') ?? readId(entry, 'targetId'),
      searchTerm,
      matchType:
        mapMatchType(readString(entry, 'matchType')) ?? mapMatchType(readString(entry, 'keywordType')),
      impressions: readCount(entry, 'impressions'),
      clicks: readCount(entry, 'clicks'),
      cost: readMoney(entry, 'cost'),
      purchases7d: readCount(entry, 'purchases7d'),
      sales7d: readMoney(entry, 'sales7d'),
      unitsSold7d: readUnitsSold7d(entry),
    });
  });

  return finish(rows, skipped, raw.length);
}

/**
 * Amazon's placement vocabulary to ours.
 *
 * `Other on-Amazon` is Amazon's name for rest-of-search, which is what the
 * console shows and what a placement modifier acts on. `Off Amazon` is a real
 * placement in the report, and it is the seam the off-Amazon leakage report is
 * built on, so it must never be folded into `other`. Genuinely unknown
 * classifications land in `other` rather than being dropped: the spend is real.
 */
export function mapPlacement(value: string | null): Placement | null {
  if (value === null) return null;
  switch (normalizeEnum(value)) {
    case 'topofsearchonamazon':
    case 'topofsearch':
    case 'placementtop':
      return 'top_of_search';
    case 'detailpageonamazon':
    case 'productpages':
    case 'placementproductpage':
      return 'product_pages';
    case 'otheronamazon':
    case 'restofsearch':
    case 'placementrestofsearch':
      return 'rest_of_search';
    case 'offamazon':
    case 'offamazononamazon':
      return 'off_amazon';
    default:
      return 'other';
  }
}

/** Placement-grouped `spCampaigns`. Campaign grain plus a placement dimension. */
export function parseSpPlacementReport(
  raw: readonly unknown[],
): ParseResult<ReportFact<PlacementFact>> {
  const rows: ReportFact<PlacementFact>[] = [];
  const skipped: SkippedReportRow[] = [];

  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      skipped.push({ index, reason: 'not an object' });
      return;
    }
    const date = readReportDate(entry);
    const campaignId = readId(entry, 'campaignId');
    const placement = mapPlacement(
      readString(entry, 'placementClassification') ?? readString(entry, 'placement'),
    );
    if (date === null || campaignId === null || placement === null) {
      skipped.push({
        index,
        reason:
          date === null
            ? 'no daily date column'
            : campaignId === null
              ? 'no campaignId'
              : 'no placement classification',
      });
      return;
    }
    rows.push({
      date,
      adProduct: 'SP',
      campaignId,
      placement,
      impressions: readCount(entry, 'impressions'),
      clicks: readCount(entry, 'clicks'),
      cost: readMoney(entry, 'cost'),
      purchases7d: readCount(entry, 'purchases7d'),
      sales7d: readMoney(entry, 'sales7d'),
    });
  });

  return finish(rows, skipped, raw.length);
}

/**
 * Campaign grain (`spCampaigns`).
 *
 * There is no campaign-grain fact in the contract — the mirror keeps campaign
 * attributes and the facts are target, search-term and placement grain — so
 * this parser returns the report's own shape. The worker sums it into
 * `ProfileFact` (the reference does the same in `get_account_daily`) and uses
 * the budget columns for pacing context.
 */
export interface SpCampaignReportRow {
  date: string;
  campaignId: string;
  campaignName: string | null;
  campaignStatus: string | null;
  budgetAmount: number | null;
  budgetType: string | null;
  currencyCode: string | null;
  impressions: number;
  clicks: number;
  cost: number;
  purchases1d: number;
  purchases7d: number;
  purchases14d: number;
  purchases30d: number;
  sales1d: number;
  sales7d: number;
  sales14d: number;
  sales30d: number;
  unitsSold7d: number;
  topOfSearchImpressionShare: number | null;
}

export function parseSpCampaignReport(
  raw: readonly unknown[],
): ParseResult<SpCampaignReportRow> {
  const rows: SpCampaignReportRow[] = [];
  const skipped: SkippedReportRow[] = [];

  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      skipped.push({ index, reason: 'not an object' });
      return;
    }
    const date = readReportDate(entry);
    const campaignId = readId(entry, 'campaignId');
    if (date === null || campaignId === null) {
      skipped.push({ index, reason: date === null ? 'no daily date column' : 'no campaignId' });
      return;
    }
    rows.push({
      date,
      campaignId,
      campaignName: readString(entry, 'campaignName'),
      campaignStatus: readString(entry, 'campaignStatus'),
      budgetAmount: readNumber(entry, 'campaignBudgetAmount'),
      budgetType: readString(entry, 'campaignBudgetType'),
      currencyCode: readString(entry, 'campaignBudgetCurrencyCode'),
      impressions: readCount(entry, 'impressions'),
      clicks: readCount(entry, 'clicks'),
      cost: readMoney(entry, 'cost'),
      purchases1d: readCount(entry, 'purchases1d'),
      purchases7d: readCount(entry, 'purchases7d'),
      purchases14d: readCount(entry, 'purchases14d'),
      purchases30d: readCount(entry, 'purchases30d'),
      sales1d: readMoney(entry, 'sales1d'),
      sales7d: readMoney(entry, 'sales7d'),
      sales14d: readMoney(entry, 'sales14d'),
      sales30d: readMoney(entry, 'sales30d'),
      unitsSold7d: readUnitsSold7d(entry),
      topOfSearchImpressionShare: readImpressionShare(entry),
    });
  });

  return finish(rows, skipped, raw.length);
}

/**
 * Sponsored Brands campaign grain.
 *
 * Sponsored Brands reports a *single* attribution window under bare
 * `purchases`, `sales` and `unitsSold` columns — 14-day — where Sponsored
 * Products reports four. The window is deliberately not renamed to `7d` on the
 * way out: `fact_sb_daily.purchases_7d` exists, and writing a 14-day number
 * into a column named 7d is exactly the quiet mislabelling this codebase
 * refuses. `attributionWindowDays` says what the number is; where it lands is
 * the worker's decision.
 *
 * Everything numeric that is not a dimension is carried in `metrics`. Sponsored
 * Brands is the only product with video quartile and viewability columns, which
 * is why the database keeps that grain's extras as jsonb.
 */
export interface SbCampaignReportRow {
  date: string;
  campaignId: string;
  campaignName: string | null;
  campaignStatus: string | null;
  adGroupId: string | null;
  impressions: number;
  clicks: number;
  cost: number;
  purchases: number;
  sales: number;
  unitsSold: number;
  attributionWindowDays: 14;
  newToBrandPurchases: number | null;
  newToBrandSales: number | null;
  /** Video, viewability and anything else Amazon added since. Verbatim. */
  metrics: Record<string, number>;
}

/** Sponsored Display campaign grain. Same single 14-day window, other extras. */
export interface SdCampaignReportRow {
  date: string;
  campaignId: string;
  campaignName: string | null;
  campaignStatus: string | null;
  adGroupId: string | null;
  impressions: number;
  clicks: number;
  cost: number;
  purchases: number;
  sales: number;
  unitsSold: number;
  attributionWindowDays: 14;
  newToBrandPurchases: number | null;
  newToBrandSales: number | null;
  /** View-through, add-to-cart and detail-page columns Sponsored Display alone has. */
  metrics: Record<string, number>;
}

const SB_DIMENSIONS = new Set([
  'date',
  'campaignId',
  'campaignName',
  'campaignStatus',
  'adGroupId',
  'adGroupName',
  'impressions',
  'clicks',
  'cost',
  'purchases',
  'sales',
  'unitsSold',
  'newToBrandPurchases',
  'newToBrandSales',
]);

const SD_DIMENSIONS = new Set([
  'date',
  'campaignId',
  'campaignName',
  'campaignStatus',
  'adGroupId',
  'adGroupName',
  'impressions',
  'clicks',
  'cost',
  'purchases',
  'sales',
  'unitsSold',
  'newToBrandPurchases',
  'newToBrandSales',
]);

/** Numeric leftovers, kept as sent. Non-numeric columns are not metrics. */
function collectMetrics(
  entry: Record<string, unknown>,
  dimensions: ReadonlySet<string>,
): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (dimensions.has(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) metrics[key] = value;
  }
  return metrics;
}

export function parseSbCampaignReport(raw: readonly unknown[]): ParseResult<SbCampaignReportRow> {
  const rows: SbCampaignReportRow[] = [];
  const skipped: SkippedReportRow[] = [];

  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      skipped.push({ index, reason: 'not an object' });
      return;
    }
    const date = readReportDate(entry);
    const campaignId = readId(entry, 'campaignId');
    if (date === null || campaignId === null) {
      skipped.push({ index, reason: date === null ? 'no daily date column' : 'no campaignId' });
      return;
    }
    rows.push({
      date,
      campaignId,
      campaignName: readString(entry, 'campaignName'),
      campaignStatus: readString(entry, 'campaignStatus'),
      adGroupId: readId(entry, 'adGroupId'),
      impressions: readCount(entry, 'impressions'),
      clicks: readCount(entry, 'clicks'),
      cost: readMoney(entry, 'cost'),
      purchases: readCount(entry, 'purchases'),
      sales: readMoney(entry, 'sales'),
      unitsSold: readCount(entry, 'unitsSold'),
      attributionWindowDays: 14,
      newToBrandPurchases: readNumber(entry, 'newToBrandPurchases'),
      newToBrandSales: readNumber(entry, 'newToBrandSales'),
      metrics: collectMetrics(entry, SB_DIMENSIONS),
    });
  });

  return finish(rows, skipped, raw.length);
}

export function parseSdCampaignReport(raw: readonly unknown[]): ParseResult<SdCampaignReportRow> {
  const rows: SdCampaignReportRow[] = [];
  const skipped: SkippedReportRow[] = [];

  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      skipped.push({ index, reason: 'not an object' });
      return;
    }
    const date = readReportDate(entry);
    const campaignId = readId(entry, 'campaignId');
    if (date === null || campaignId === null) {
      skipped.push({ index, reason: date === null ? 'no daily date column' : 'no campaignId' });
      return;
    }
    rows.push({
      date,
      campaignId,
      campaignName: readString(entry, 'campaignName'),
      campaignStatus: readString(entry, 'campaignStatus'),
      adGroupId: readId(entry, 'adGroupId'),
      impressions: readCount(entry, 'impressions'),
      clicks: readCount(entry, 'clicks'),
      cost: readMoney(entry, 'cost'),
      purchases: readCount(entry, 'purchases'),
      sales: readMoney(entry, 'sales'),
      unitsSold: readCount(entry, 'unitsSold'),
      attributionWindowDays: 14,
      newToBrandPurchases: readNumber(entry, 'newToBrandPurchases'),
      newToBrandSales: readNumber(entry, 'newToBrandSales'),
      metrics: collectMetrics(entry, SD_DIMENSIONS),
    });
  });

  return finish(rows, skipped, raw.length);
}
