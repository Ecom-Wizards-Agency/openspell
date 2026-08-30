/**
 * CSV export.
 *
 * Export is a terminal operation on the same pipeline the grid rendered, not a
 * separate "download this table" action bolted onto the side (recon
 * `02-data-grid.md` §7). So it takes a `GridModel` -- the thing already
 * filtered, grouped and sorted -- and cannot disagree with what is on screen.
 *
 * Values are exported **raw**, not formatted: `0.243`, not `24.3%`, and
 * `1234.5`, not `$1,234.50`. A CSV is going into a spreadsheet where somebody
 * will sum a column, and a currency-formatted string sums to zero. The currency
 * is stated once, in the header comment row, where it cannot be lost.
 */
import type { GridColumn } from './columns.js';
import type { GridModel } from './pipeline.js';
import { resolveField } from './rows.js';

export interface CsvResult {
  csv: string;
  /** Data rows written. */
  exported: number;
  /** Source rows the grid held before filtering. */
  total: number;
  filename: string;
}

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

export interface CsvOptions {
  /** Visible columns, in display order. */
  columns: readonly GridColumn[];
  /** Goes into the filename and the provenance row. */
  label: string;
  currencyCode: string;
  /** The window the figures cover, so the file is readable a month later. */
  period?: { start: string; end: string };
  comparisonPeriod?: { start: string; end: string } | null;
}

/**
 * Build the file.
 *
 * The first line is a provenance comment, not a header: which entity level,
 * which period, which comparison period, which currency, and how many rows of
 * how many. Every one of those is a question somebody asks about a spreadsheet
 * three weeks after it was sent, and none of them can be answered from the
 * numbers alone.
 */
export function toCsv(model: GridModel, options: CsvOptions): CsvResult {
  const lines: string[] = [];
  const provenance = [
    `# OpenSpell ${options.label}`,
    options.period ? `period ${options.period.start}..${options.period.end}` : null,
    options.comparisonPeriod
      ? `comparison ${options.comparisonPeriod.start}..${options.comparisonPeriod.end}`
      : null,
    `currency ${options.currencyCode}`,
    model.grouped
      ? `${model.exported} deepest groups from ${model.matched} matched source rows (${model.total} before filtering)`
      : `${model.exported} of ${model.total} source rows`,
    model.grouped
      ? `grouped by ${model.groupBy.join(' > ')}: parent summaries omitted; ratio metrics recomputed from summed bases`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
  lines.push(provenance);

  lines.push(options.columns.map((column) => escapeCell(column.header)).join(','));

  for (const row of model.exportRows) {
    lines.push(
      options.columns.map((column) => escapeCell(resolveField(row, column.id))).join(','),
    );
  }

  return {
    csv: `${lines.join('\n')}\n`,
    exported: model.exportRows.length,
    total: model.total,
    filename: csvFilename(options.label),
  };
}

function csvFilename(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const stamp = new Date().toISOString().slice(0, 10);
  return `openspell-${slug || 'export'}-${stamp}.csv`;
}
