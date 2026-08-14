/**
 * A CSV reader with no dependencies, sized for one job: reading an export
 * somebody else's tool produced.
 *
 * Two behaviours here are not general-purpose politeness, they are the two
 * things that have actually broken this class of parser in production:
 *
 *  - **The delimiter is sniffed, not assumed.** The same tool exports comma in
 *    one locale and semicolon in another, and a semicolon file read as comma
 *    parses cleanly into one column per row: no error, no data.
 *  - **The decimal separator follows the delimiter.** In a semicolon file
 *    `1.234,56` is one number, not two columns and not `1.234`. Reading it as
 *    a comma-decimal number is the difference between a verified day and a
 *    100% mismatch nobody can explain.
 *
 * Everything the reader cannot turn into a number becomes `null`, which the
 * verdict model already has a name for: `no_data`. A silent zero would be a
 * lie with the same shape as a real figure.
 */

export interface CsvTable {
  /** Header names, lowercased and trimmed. */
  columns: string[];
  /** One record per data row, keyed by column name. */
  rows: Record<string, string>[];
  delimiter: ',' | ';' | '\t';
}

const DELIMITERS = [',', ';', '\t'] as const;
export type CsvDelimiter = (typeof DELIMITERS)[number];

export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvParseError';
  }
}

/** The delimiter that yields the most columns on the header line. */
export function sniffDelimiter(text: string): CsvDelimiter {
  const header = firstLine(stripBom(text));
  let best: CsvDelimiter = ',';
  let bestCount = 0;
  for (const candidate of DELIMITERS) {
    const count = splitLine(header, candidate).length;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

export function parseCsv(text: string, delimiter?: CsvDelimiter): CsvTable {
  const source = stripBom(text);
  const sep = delimiter ?? sniffDelimiter(source);
  const records = splitRecords(source, sep);
  const headerRecord = records.shift();
  if (!headerRecord) throw new CsvParseError('the export is empty: no header row');

  const columns = headerRecord.map((name) => name.trim().toLowerCase());
  const rows: Record<string, string>[] = [];

  for (const [index, record] of records.entries()) {
    // A trailing newline is normal; a genuinely short row is not.
    if (record.length === 1 && record[0]?.trim() === '') continue;
    if (record.length !== columns.length) {
      throw new CsvParseError(
        `row ${index + 2} has ${record.length} fields, the header has ${columns.length}`,
      );
    }
    const row: Record<string, string> = {};
    for (const [column, name] of columns.entries()) row[name] = (record[column] ?? '').trim();
    rows.push(row);
  }

  return { columns, rows, delimiter: sep };
}

/**
 * A figure, or `null` when the cell carries no figure.
 *
 * Handles what exports actually contain: a currency symbol, thousands
 * separators in either convention, a parenthesised negative, a percent sign, a
 * dash for "nothing here".
 */
export function parseNumber(value: string | undefined, delimiter: CsvDelimiter = ','): number | null {
  if (value === undefined) return null;
  let text = value.trim();
  if (text === '' || text === '-' || text === '--' || text === 'n/a' || text === 'N/A') return null;

  let negative = false;
  if (text.startsWith('(') && text.endsWith(')')) {
    negative = true;
    text = text.slice(1, -1);
  }

  text = text.replace(/[^0-9,.\-+]/g, '');
  if (text === '') return null;

  const decimalSeparator = decimalSeparatorFor(text, delimiter);
  text =
    decimalSeparator === ','
      ? text.replace(/\./g, '').replace(',', '.')
      : text.replace(/,/g, '');

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

/**
 * Which of `.` and `,` is the decimal point in this cell.
 *
 * When both appear the last one wins, which is true in every locale. When only
 * one appears the delimiter decides: a semicolon file is a comma-decimal file.
 */
function decimalSeparatorFor(text: string, delimiter: CsvDelimiter): '.' | ',' {
  const lastDot = text.lastIndexOf('.');
  const lastComma = text.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) return lastComma > lastDot ? ',' : '.';
  if (lastComma >= 0) return delimiter === ';' ? ',' : '.';
  return '.';
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function firstLine(text: string): string {
  const end = text.indexOf('\n');
  const line = end === -1 ? text : text.slice(0, end);
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** Split one already-unquoted line. Used only for sniffing. */
function splitLine(line: string, delimiter: CsvDelimiter): string[] {
  return splitRecords(line, delimiter)[0] ?? [];
}

/**
 * The state machine. Quotes may contain the delimiter and newlines; a doubled
 * quote inside a quoted field is one quote.
 */
function splitRecords(text: string, delimiter: CsvDelimiter): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === '') {
      quoted = true;
    } else if (char === delimiter) {
      record.push(field);
      field = '';
    } else if (char === '\n') {
      record.push(field.endsWith('\r') ? field.slice(0, -1) : field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (quoted) throw new CsvParseError('the export ends inside a quoted field');
  if (field !== '' || record.length > 0) {
    record.push(field.endsWith('\r') ? field.slice(0, -1) : field);
    records.push(record);
  }
  return records;
}
