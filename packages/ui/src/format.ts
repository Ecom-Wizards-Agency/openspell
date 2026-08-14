/**
 * Value formatting.
 *
 * Scale comes from the column, never from the value or the name -- the recon's
 * `is_percent_scale` lesson (`03-dashboards.md` §3): "carrying scale as data
 * rather than inferring it from a suffix is how you stop a dashboard from
 * showing 2430%".
 *
 * Currency comes from the profile, never from a locale default. A single-profile
 * view renders that profile's currency; there is no cross-currency aggregation
 * anywhere in v1 (`aggregate.ts` enforces it), so there is never a figure here
 * whose currency is ambiguous.
 *
 * Locale defaults to `en-US` **explicitly**, and every number in this package
 * goes through these functions rather than through a bare `toLocaleString()`.
 * That is not tidiness: a bare call takes the *runtime's* locale, which on the
 * server is Node's and in the browser is the operator's. A German browser
 * hydrating a server-rendered "50,000" against a client-rendered "50.000" is a
 * React hydration failure that throws away and re-renders the whole subtree —
 * found exactly that way, in a real browser, before this comment existed.
 */
import type { MetricScale } from './metrics.js';

export const EMPTY_CELL = '—';

export interface FormatContext {
  currencyCode: string;
  locale?: string;
}

const numberCache = new Map<string, Intl.NumberFormat>();

function formatter(key: string, build: () => Intl.NumberFormat): Intl.NumberFormat {
  let cached = numberCache.get(key);
  if (cached === undefined) {
    cached = build();
    numberCache.set(key, cached);
  }
  return cached;
}

export function formatMoney(value: number, context: FormatContext): string {
  const locale = context.locale ?? 'en-US';
  return formatter(`money:${locale}:${context.currencyCode}`, () =>
    new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: context.currencyCode,
      maximumFractionDigits: 2,
    }),
  ).format(value);
}

export function formatInteger(value: number, locale = 'en-US'): string {
  return formatter(`int:${locale}`, () =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
  ).format(value);
}

export function formatPercent(value: number, locale = 'en-US'): string {
  return formatter(`pct:${locale}`, () =>
    new Intl.NumberFormat(locale, {
      style: 'percent',
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }),
  ).format(value);
}

export function formatRatio(value: number, locale = 'en-US'): string {
  return formatter(`ratio:${locale}`, () =>
    new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  ).format(value);
}

/**
 * Render one cell.
 *
 * `null` is `—`, always. Absent is a state an operator has to be able to see:
 * Amazon omits zero-impression rows, so a blank cell and a zero cell mean
 * genuinely different things and rendering both as `0` erases the difference.
 */
export function formatValue(
  value: unknown,
  scale: MetricScale | 'text',
  context: FormatContext,
): string {
  if (value === null || value === undefined || value === '') return EMPTY_CELL;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value !== 'number') return String(value);
  if (!Number.isFinite(value)) return EMPTY_CELL;

  switch (scale) {
    case 'money':
      return formatMoney(value, context);
    case 'percent':
      return formatPercent(value, context.locale);
    case 'integer':
      return formatInteger(value, context.locale);
    case 'ratio':
      return formatRatio(value, context.locale);
    case 'decimal':
      return formatRatio(value, context.locale);
    default:
      return String(value);
  }
}

/** Signed rendering for delta columns, so +3% and -3% never look alike. */
export function formatDelta(
  value: number | null,
  scale: MetricScale | 'text',
  context: FormatContext,
): string {
  if (value === null) return EMPTY_CELL;
  const body = formatValue(Math.abs(value), scale, context);
  if (value === 0) return body;
  return `${value > 0 ? '+' : '−'}${body}`;
}
