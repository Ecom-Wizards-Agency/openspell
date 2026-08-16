/**
 * Batch-size arithmetic for multi-row inserts.
 *
 * Postgres binds at most 65535 parameters per statement, and a multi-row
 * `INSERT ... VALUES` spends one per column per row. A sixteen-column mirror
 * table therefore tops out a little over four thousand rows — which a real
 * profile's negative keywords exceed — and the failure is a protocol error
 * carrying the whole truncated statement, not a useful message.
 *
 * The cap is 65000 rather than 65535: the margin absorbs the parameters a
 * statement spends outside its `VALUES` list (an `ON CONFLICT ... SET` clause,
 * a `WHERE`), so a caller never has to reason about them.
 */
export const MAX_BIND_PARAMS = 65_000;

/**
 * Slice rows into batches no statement can overflow.
 *
 * `columnCount` is how many bind parameters one row spends. A zero or negative
 * count, and any batch size that rounds to zero, still yields one row per
 * batch: a slow insert is recoverable, an infinite loop is not.
 */
export function chunkForInsert<T>(rows: readonly T[], columnCount: number): T[][] {
  if (rows.length === 0) return [];
  const size = Math.max(1, Math.floor(MAX_BIND_PARAMS / Math.max(1, columnCount)));
  if (rows.length <= size) return [[...rows]];
  const chunks: T[][] = [];
  for (let start = 0; start < rows.length; start += size) {
    chunks.push(rows.slice(start, start + size));
  }
  return chunks;
}
