/**
 * Row accessors: the derived metrics `DailyRow` computes on demand, and the
 * metric-name lookup the analyzer drives itself with.
 *
 * The reference computes CTR/CVR/CPC/ACOS/ROAS/TACOS as properties rather than
 * storing them, so a row can never carry a stale ratio. Same discipline here:
 * nothing derived is ever written onto a row.
 */
import { safeDivRow } from './num.js';
import type { DailyRow } from './types.js';

/** Calendar-day arithmetic on `YYYY-MM-DD`, done in UTC so no zone can shift it. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const ms = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

export function firstOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function dayOfMonth(date: string): number {
  return Number(date.slice(8, 10));
}

export function daysInMonth(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function ctr(row: DailyRow): number | null {
  return safeDivRow(row.clicks, row.impressions);
}

export function cvr(row: DailyRow): number | null {
  return safeDivRow(row.orders, row.clicks);
}

export function cpc(row: DailyRow): number | null {
  return safeDivRow(row.spend, row.clicks);
}

export function acos(row: DailyRow): number | null {
  return safeDivRow(row.spend, row.sales);
}

export function roas(row: DailyRow): number | null {
  return safeDivRow(row.sales, row.spend);
}

export function tacos(row: DailyRow): number | null {
  if (!row.totalSales) return null;
  return safeDivRow(row.spend, row.totalSales);
}

/** Metric name (the reference's snake_case) to the raw field that holds it. */
const RAW_FIELDS: Record<string, keyof DailyRow> = {
  impressions: 'impressions',
  clicks: 'clicks',
  spend: 'spend',
  sales: 'sales',
  orders: 'orders',
  total_sales: 'totalSales',
  ad_sales_sp: 'adSalesSp',
  ad_sales_sd: 'adSalesSd',
  real_acos: 'realAcos',
  units_organic: 'unitsOrganic',
  units_ppc: 'unitsPpc',
  refunds: 'refunds',
  gross_profit: 'grossProfit',
  net_profit: 'netProfit',
  margin: 'margin',
  sessions: 'sessions',
  unit_session_pct: 'unitSessionPct',
  budget: 'budget',
};

const DERIVED: Record<string, (row: DailyRow) => number | null> = {
  ctr,
  cvr,
  cpc,
  acos,
  roas,
  tacos,
};

/**
 * Port of `datasource.metric_value`. A missing row is `null`, and so is a
 * metric this row does not carry: absence is never zero.
 */
export function metricValue(row: DailyRow | null | undefined, metric: string): number | null {
  if (!row) return null;
  const derived = DERIVED[metric];
  if (derived) return derived(row);
  const field = RAW_FIELDS[metric];
  if (!field) return null;
  const value = row[field];
  return typeof value === 'number' ? value : null;
}
