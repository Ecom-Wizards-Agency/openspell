/**
 * CSV, with the cap enforced while writing rather than after.
 *
 * A size limit checked after building the whole string is a limit that has
 * already allocated the thing it was supposed to prevent. This writer stops at
 * the byte budget, keeps the rows it completed, and reports how many it left
 * behind: a truncated export that says so beats a complete one nobody can hold.
 */

export interface CsvResult {
  text: string;
  rowsWritten: number;
  rowsOffered: number;
  truncated: boolean;
  bytes: number;
}

function escape(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/["\n\r,]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function toCsv(
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
  maxBytes: number,
): CsvResult {
  const header = `${columns.map(escape).join(',')}\n`;
  const parts = [header];
  let bytes = Buffer.byteLength(header, 'utf8');
  let written = 0;

  for (const row of rows) {
    const line = `${columns.map((column) => escape(row[column])).join(',')}\n`;
    const size = Buffer.byteLength(line, 'utf8');
    if (bytes + size > maxBytes) break;
    parts.push(line);
    bytes += size;
    written += 1;
  }

  return {
    text: parts.join(''),
    rowsWritten: written,
    rowsOffered: rows.length,
    truncated: written < rows.length,
    bytes,
  };
}
