/**
 * Readers for untrusted JSON.
 *
 * Amazon's responses are typed here by assertion, not by faith: every field is
 * pulled out with an explicit reader that returns null when the field is
 * missing or the wrong type. Casting a response to an interface and indexing it
 * would compile just as happily and would turn a renamed field into
 * `undefined` flowing all the way into a fact table.
 *
 * Numbers arrive as numbers, as numeric strings, and (for ids) as JSON numbers
 * that must not go through `Number` at all — a campaign id can exceed 2^53, so
 * ids are read as strings and never as numbers.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value === 'string') return value === '' ? null : value;
  return null;
}

/**
 * An Amazon id, whatever JSON type it arrived as.
 *
 * Ids are read through `String(...)` rather than parsed: some are numeric and
 * larger than a JS safe integer, and `12345678901234567890` round-tripped
 * through `Number` silently becomes a different id.
 */
export function readId(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return String(value);
  return null;
}

export function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function readBoolean(source: Record<string, unknown>, key: string): boolean | null {
  const value = source[key];
  return typeof value === 'boolean' ? value : null;
}

export function readRecord(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = source[key];
  return isRecord(value) ? value : null;
}

export function readArray(source: Record<string, unknown>, key: string): unknown[] | null {
  const value = source[key];
  return Array.isArray(value) ? value : null;
}

/** Array of objects, with non-objects dropped. Used for expressions and pages. */
export function readRecordArray(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown>[] {
  const value = readArray(source, key);
  if (value === null) return [];
  return value.filter(isRecord);
}

/** A count that must never be negative or fractional in a fact row. */
export function readCount(source: Record<string, unknown>, key: string): number {
  const value = readNumber(source, key);
  if (value === null) return 0;
  return Math.max(0, Math.round(value));
}

/** Money, clamped at zero: a negative cost is a report bug, not a refund. */
export function readMoney(source: Record<string, unknown>, key: string): number {
  const value = readNumber(source, key);
  if (value === null) return 0;
  return Math.max(0, value);
}

/**
 * Normalise an Amazon enum spelling for comparison.
 *
 * The same concept is spelled `ASIN_SAME_AS` on one endpoint and `asinSameAs`
 * on another, and both appear in live payloads. Folding case and separators
 * makes one lookup table serve every endpoint.
 */
export function normalizeEnum(value: string): string {
  return value.replace(/[\s_-]+/g, '').toLowerCase();
}
