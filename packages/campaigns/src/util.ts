/**
 * The small conversions a bulksheet needs, and the one that is not small.
 */
import type { ProductList } from './types.js';

/**
 * Round a money amount to cents the way the reference does.
 *
 * The reference is Python, and Python's `round` breaks an exact tie to the
 * even cent while JavaScript's `toFixed` breaks it away from zero. That
 * disagreement is invisible almost everywhere, because almost no decimal is an
 * exact tie in binary: 8.475 is really 8.47499…, so both runtimes round it
 * down. It becomes visible for the dyadic fractions — .125, .375, .625, .875 —
 * which ARE exact, and where Python answers 0.12 for 0.125 and `toFixed` would
 * answer 0.13.
 *
 * So: detect the exact tie (a value that is a whole number of eighths but not
 * of quarters is exactly a half-cent), round it to even, and let `toFixed`
 * handle everything else, since `toFixed` reads the double's true value and a
 * multiply-by-100 would not.
 */
export function money(value: number): number {
  const scaled = value * 100;
  if (Number.isInteger(value * 8) && !Number.isInteger(value * 4)) {
    const floor = Math.floor(scaled);
    return (floor % 2 === 0 ? floor : floor + 1) / 100;
  }
  return Number(value.toFixed(2));
}

/** A SKU/ASIN field: a list, or one string split on newlines and commas. */
export function parseProductList(value: ProductList | undefined | null): string[] {
  if (value === undefined || value === null) return [];
  const parts = Array.isArray(value)
    ? (value as readonly string[]).map((v) => String(v))
    : String(value).split(/[\n,]/);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** `YYYY-MM-DD` to the reference's `MM/DD/YYYY` intermediate. Anything else is dropped. */
export function formatStartDate(isoDate: string): string {
  if (!isoDate) return '';
  const parts = isoDate.split('-');
  if (parts.length !== 3 || parts.some((part) => part === '')) return '';
  const [yyyy, mm, dd] = parts as [string, string, string];
  return `${mm}/${dd}/${yyyy}`;
}

/**
 * Any of the accepted date spellings to the `YYYYMMDD` a bulksheet cell holds.
 *
 * An empty or unparseable value falls back to `today`, which is passed in
 * rather than read, so that a plan generated twice for the same day is the
 * same plan.
 */
export function parseDateToExport(value: string, today: string): string {
  const fallback = today.replaceAll('-', '');
  if (!value) return fallback;
  const parts = value.replaceAll('/', '-').split('-');
  if (parts.length !== 3) return fallback;
  const [first, second, third] = parts as [string, string, string];
  const [yyyy, mm, dd] = first.length === 4 ? [first, second, third] : [third, first, second];
  return `${yyyy}${mm.padStart(2, '0')}${dd.padStart(2, '0')}`;
}

/**
 * A number the way Python's `str()` renders a float: with a `.0` when it is
 * whole.
 *
 * This exists only for the gate messages. They are pinned against the
 * reference toolkit's own wording in the parity suite, and the reference is
 * Python, where `MIN_BUDGET` is `1.0` and prints as `1.0`. JavaScript prints
 * `1`. The values are identical; only the rendering differs, and the message
 * is the contract an operator reads.
 */
export function pyFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

/** Split a list into chunks of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Non-empty, trimmed lines. The reference stores keyword lists as text. */
export function splitLines(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}
