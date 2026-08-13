/**
 * The doctrine engine's own working shapes.
 *
 * These are NOT contracts. `packages/shared` owns everything that crosses a
 * package boundary; what lives here is the in-memory vocabulary the ported
 * Python modules speak (`DailyRow`, `MetricDelta`, `Flag`, ...), kept
 * field-for-field compatible with `amazon-ads-monitor` so the parity goldens
 * can be replayed without a translation layer. A caller that wants to feed the
 * engine from the fact tables maps `DailyFact` onto `DailyRow` at the edge.
 */

/** Strategy categories, as the reference calls them. Plain strings, open set. */
export const CATEGORY_RANK = 'Rank';
export const CATEGORY_DISCOVERY = 'Discovery';
export const CATEGORY_PROFIT = 'Profit';
export const CATEGORY_SHIELD = 'Shield';
export const CATEGORY_UNKNOWN = 'Unknown';

export const STRATEGY_CATEGORIES = [
  CATEGORY_RANK,
  CATEGORY_DISCOVERY,
  CATEGORY_PROFIT,
  CATEGORY_SHIELD,
] as const;

export type CampaignCategory = string;

/**
 * One account-level or campaign-level daily row.
 *
 * `date` is a calendar day string (`YYYY-MM-DD`) rather than a `Date`, for the
 * same reason `IsoDate` is a string in the contracts: a profile's day is a
 * label in its own timezone, and a `Date` would invite a UTC shift.
 */
export interface DailyRow {
  account: string;
  date: string;
  level: 'account' | 'campaign';
  impressions: number;
  clicks: number;
  spend: number;
  sales: number;
  orders: number;
  campaignId?: string | null;
  campaignName?: string | null;
  category?: CampaignCategory;
  budget?: number | null;
  budgetCapped?: boolean;
  /** Brand total (organic + ad) sales that day, the denominator of TACOS. */
  totalSales?: number | null;

  // Account-total fields a Sellerboard-style feed carries and ad reporting does not.
  adSalesSp?: number | null;
  adSalesSd?: number | null;
  realAcos?: number | null;
  unitsOrganic?: number | null;
  unitsPpc?: number | null;
  refunds?: number | null;
  grossProfit?: number | null;
  netProfit?: number | null;
  margin?: number | null;
  sessions?: number | null;
  unitSessionPct?: number | null;
}

/** Metric names the analyzer understands, raw and derived. */
export type MetricName = string;

/** The ad-reporting metric set. Order is display order. */
export const METRICS = [
  'impressions',
  'clicks',
  'spend',
  'sales',
  'orders',
  'ctr',
  'cvr',
  'cpc',
  'acos',
  'roas',
  'tacos',
] as const;

/** The account-totals metric set: no click-level metrics, plus the P&L fields. */
export const SELLERBOARD_METRICS = [
  'total_sales',
  'sales',
  'spend',
  'acos',
  'tacos',
  'real_acos',
  'orders',
  'units_organic',
  'units_ppc',
  'refunds',
  'gross_profit',
  'net_profit',
  'margin',
  'sessions',
  'unit_session_pct',
  'ad_sales_sp',
  'ad_sales_sd',
] as const;

export interface MetricDelta {
  metric: MetricName;
  value: number | null;
  priorValue: number | null;
  priorAbsChange: number | null;
  priorPctChange: number | null;
  trailing7Avg: number | null;
  trailing7AbsChange: number | null;
  trailing7PctChange: number | null;
  trend: Trend;
}

export type Trend = 'up' | 'down' | 'flat';

export interface SeriesAnalysis {
  label: string;
  campaignId: string | null;
  category: CampaignCategory;
  reportRow: DailyRow | null;
  deltas: Record<string, MetricDelta>;
}

export interface AnalysisResult {
  account: string;
  reportDate: string;
  accountSeries: SeriesAnalysis;
  campaignSeries: SeriesAnalysis[];
}

export type Severity = 'critical' | 'alert' | 'warn' | 'info';

export interface Flag {
  severity: Severity;
  metric: string;
  threshold: string;
  message: string;
  likelyCause: string;
  /** `"account"` or a campaign label. */
  scope: string;
  category: CampaignCategory;
  suppressed: boolean;
  suppressedReason: string | null;
}
