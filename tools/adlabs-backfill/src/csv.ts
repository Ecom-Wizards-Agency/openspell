/**
 * A projecting CSV reader.
 *
 * AdLabs exports are wide — 104 to 123 columns, most of them comparison and
 * delta columns nothing here wants — and the profile timeline is 47,000 rows of
 * them. A general reader that materialises `Record<string, string>` per row
 * builds five million strings to use eight of them per row. So this one takes
 * the column names it needs up front and keeps only those.
 *
 * The quoting rules are RFC 4180's, which is what AdLabs emits: a field may be
 * quoted, a quote inside a quoted field is doubled, and a quoted field may span
 * newlines (campaign names contain them often enough to matter).
 *
 * Two behaviours are deliberate and copied from the crosscheck's reader, for
 * the same reasons it gives:
 *
 *  - **The delimiter is sniffed, not assumed.** A semicolon file read as comma
 *    parses cleanly into one column per row: no error, no data.
 *  - **What cannot be read as a number is `null`, never `0`.** A silent zero is
 *    a lie with the same shape as a real figure, and at this grain it would be
 *    a lie loaded into a fact table.
 */

const DELIMITERS = [',', ';', '\t'] as const;
export type CsvDelimiter = (typeof DELIMITERS)[number];

export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvError';
  }
}

export interface ProjectedCsv {
  /** Every header name in the file, lowercased and trimmed. */
  columns: string[];
  /** One record per data row, carrying only the requested columns. */
  rows: Record<string, string>[];
  delimiter: CsvDelimiter;
}

/** The delimiter that yields the most fields on the header line. */
export function sniffDelimiter(text: string): CsvDelimiter {
  const header = stripBom(text).split(/\r?\n/, 1)[0] ?? '';
  let best: CsvDelimiter = ',';
  let bestCount = 0;
  for (const candidate of DELIMITERS) {
    const count = header.split(candidate).length;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Read `text`, keeping only `wanted`.
 *
 * A name in `wanted` that the file does not have is an error, not a null
 * column: every caller here is mapping to a fact-table column, and a silently
 * absent `spend` would load a month of zeroes.
 */
export function parseProjected(
  text: string,
  wanted: readonly string[],
  delimiter?: CsvDelimiter,
): ProjectedCsv {
  const source = stripBom(text);
  const sep = delimiter ?? sniffDelimiter(source);
  const scanner = new Scanner(source, sep);

  const header = scanner.next();
  if (header === null) throw new CsvError('the export is empty: no header row');
  const columns = header.map((name) => name.trim().toLowerCase());

  const index = new Map<string, number>();
  for (const name of wanted) {
    const at = columns.indexOf(name);
    if (at === -1) {
      throw new CsvError(
        `the export has no "${name}" column. Found ${columns.length} column(s), starting: ${columns
          .slice(0, 8)
          .join(', ')}`,
      );
    }
    index.set(name, at);
  }

  const rows: Record<string, string>[] = [];
  let record = scanner.next();
  let lineNumber = 1;
  while (record !== null) {
    lineNumber += 1;
    // A trailing newline is normal; a genuinely short row is not.
    if (!(record.length === 1 && record[0] === '')) {
      if (record.length !== columns.length) {
        throw new CsvError(
          `row ${lineNumber} has ${record.length} field(s), the header has ${columns.length}`,
        );
      }
      const row: Record<string, string> = {};
      for (const [name, at] of index) row[name] = (record[at] ?? '').trim();
      rows.push(row);
    }
    record = scanner.next();
  }

  return { columns, rows, delimiter: sep };
}

/**
 * A figure, or `null` when the cell holds nothing readable.
 *
 * In a semicolon-delimited file `1.234,56` is one number: the decimal
 * separator follows the delimiter, or a European export reads 1000× low.
 */
export function parseNumber(value: string | undefined, delimiter: CsvDelimiter): number | null {
  const text = (value ?? '').trim();
  if (text === '') return null;
  const normalised =
    delimiter === ';' ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  const cleaned = normalised.replace(/[^0-9.eE+-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A metric cell that must be a number. Missing is zero only where zero is the fact. */
export function metric(value: string | undefined, delimiter: CsvDelimiter): number {
  return parseNumber(value, delimiter) ?? 0;
}

/** An ISO date, or an error naming the row: a mis-parsed date lands in the wrong month. */
export function isoDate(value: string | undefined, where: string): string {
  const text = (value ?? '').trim();
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  if (iso?.[1]) return iso[1];
  const slashed = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (slashed) return `${slashed[3]}-${slashed[1]}-${slashed[2]}`;
  throw new CsvError(`${where}: unreadable date "${text}"`);
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** One pass over the text, yielding one array of fields per record. */
class Scanner {
  private at = 0;

  constructor(
    private readonly text: string,
    private readonly delimiter: string,
  ) {}

  next(): string[] | null {
    if (this.at >= this.text.length) return null;

    const fields: string[] = [];
    let field = '';
    let quoted = false;

    while (this.at < this.text.length) {
      const char = this.text[this.at] as string;

      if (quoted) {
        if (char === '"') {
          if (this.text[this.at + 1] === '"') {
            field += '"';
            this.at += 2;
            continue;
          }
          quoted = false;
          this.at += 1;
          continue;
        }
        field += char;
        this.at += 1;
        continue;
      }

      if (char === '"' && field === '') {
        quoted = true;
        this.at += 1;
        continue;
      }
      if (char === this.delimiter) {
        fields.push(field);
        field = '';
        this.at += 1;
        continue;
      }
      if (char === '\n') {
        this.at += 1;
        fields.push(field);
        return fields;
      }
      if (char === '\r') {
        this.at += 1;
        if (this.text[this.at] === '\n') this.at += 1;
        fields.push(field);
        return fields;
      }

      field += char;
      this.at += 1;
    }

    fields.push(field);
    return fields;
  }
}
