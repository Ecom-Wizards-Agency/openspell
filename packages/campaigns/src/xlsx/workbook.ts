/**
 * A one-sheet .xlsx, written and read back.
 *
 * Only what a bulksheet needs: one worksheet, a header row, and cells that are
 * either a number or a string. No styles beyond the minimum the format
 * requires, no shared string table (inline strings cost a few bytes and remove
 * a whole class of index bug), no formulas.
 *
 * The one subtlety worth stating: a cell whose value is the empty string is
 * written as **no cell at all**, and read back as the empty string. That is
 * what openpyxl does on both sides, and matching it is what lets a workbook
 * this package wrote be diffed against one the Python reference wrote.
 */
import type { SheetModel } from '../types.js';
import { readZip, writeZip, type ZipEntry } from './zip.js';

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function unescapeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

/** 0-based column index to its spreadsheet letters: 0 → A, 26 → AA. */
export function columnName(index: number): string {
  let name = '';
  let n = index;
  while (n >= 0) {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  }
  return name;
}

function cellXml(value: string | number, column: number, row: number): string {
  const reference = `${columnName(column)}${row}`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`cell ${reference} is ${value}: a spreadsheet cannot hold a non-finite number`);
    }
    return `<c r="${reference}"><v>${value}</v></c>`;
  }
  if (value === '') return '';
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function sheetXml(sheet: SheetModel): string {
  const lines = [XML_DECLARATION, `<worksheet xmlns="${MAIN_NS}"><sheetData>`];
  const allRows = [sheet.header, ...sheet.rows];
  allRows.forEach((row, index) => {
    const rowNumber = index + 1;
    const cells = row.map((value, column) => cellXml(value, column, rowNumber)).join('');
    lines.push(`<row r="${rowNumber}">${cells}</row>`);
  });
  lines.push('</sheetData></worksheet>');
  return lines.join('');
}

function parts(sheet: SheetModel): ZipEntry[] {
  const encoder = new TextEncoder();
  const entry = (name: string, xml: string): ZipEntry => ({ name, data: encoder.encode(xml) });

  return [
    entry('[Content_Types].xml', `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '</Types>'),
    entry('_rels/.rels', `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/>`
      + '</Relationships>'),
    entry('xl/workbook.xml', `${XML_DECLARATION}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets>`
      + `<sheet name="${escapeXml(sheet.sheetName)}" sheetId="1" r:id="rId1"/>`
      + '</sheets></workbook>'),
    entry('xl/_rels/workbook.xml.rels', `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>`
      + `<Relationship Id="rId2" Type="${REL_NS}/styles" Target="styles.xml"/>`
      + '</Relationships>'),
    // The minimum styles part: one font, one fill, one border, one cell
    // format, and the named `Normal` style. The named style is not optional in
    // practice — openpyxl warns and substitutes its own defaults without it,
    // which is a warning printed at every operator who opens the file.
    entry('xl/styles.xml', `${XML_DECLARATION}<styleSheet xmlns="${MAIN_NS}">`
      + '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
      + '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>'
      + '<borders count="1"><border/></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
      + '</styleSheet>'),
    entry('xl/worksheets/sheet1.xml', sheetXml(sheet)),
  ];
}

/** A sheet model to .xlsx bytes. Nothing is written to disk; that is a caller's job. */
export function writeWorkbook(sheet: SheetModel): Uint8Array {
  return writeZip(parts(sheet));
}

const ROW_RE = /<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
const CELL_RE = /<c\s+r="([A-Z]+)(\d+)"([^>]*)>([\s\S]*?)<\/c>/g;
const INLINE_RE = /<t[^>]*>([\s\S]*?)<\/t>/;
const VALUE_RE = /<v>([\s\S]*?)<\/v>/;

/** Spreadsheet letters back to a 0-based index. */
export function columnIndex(name: string): number {
  let index = 0;
  for (const char of name) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

/**
 * Read a workbook this package wrote.
 *
 * Deliberately narrow: it understands inline strings and numbers, which is
 * everything `writeWorkbook` emits. Its job is to prove the file on disk holds
 * the rows the plan said it would, not to be a general reader.
 */
export function readWorkbook(bytes: Uint8Array): SheetModel {
  const files = readZip(bytes);
  const decoder = new TextDecoder();

  const workbookXml = files.get('xl/workbook.xml');
  if (workbookXml === undefined) throw new Error('not an xlsx: xl/workbook.xml is missing');
  const sheetName = unescapeXml(/<sheet[^>]*\bname="([^"]*)"/.exec(decoder.decode(workbookXml))?.[1] ?? '');

  const sheetXmlBytes = files.get('xl/worksheets/sheet1.xml');
  if (sheetXmlBytes === undefined) throw new Error('not an xlsx: xl/worksheets/sheet1.xml is missing');
  const xml = decoder.decode(sheetXmlBytes);

  const grid: Array<Array<string | number>> = [];
  let width = 0;
  for (const rowMatch of xml.matchAll(ROW_RE)) {
    const rowNumber = Number(rowMatch[1]);
    const cells: Array<string | number> = [];
    for (const cellMatch of (rowMatch[2] ?? '').matchAll(CELL_RE)) {
      const column = columnIndex(cellMatch[1] as string);
      const attributes = cellMatch[3] ?? '';
      const body = cellMatch[4] ?? '';
      const value = attributes.includes('t="inlineStr"')
        ? unescapeXml(INLINE_RE.exec(body)?.[1] ?? '')
        : Number(VALUE_RE.exec(body)?.[1] ?? '0');
      while (cells.length < column) cells.push('');
      cells[column] = value;
    }
    width = Math.max(width, cells.length);
    grid[rowNumber - 1] = cells;
  }

  // Missing cells at the end of a row are empty ones; pad so every row is the
  // same width and a diff against another reader's grid lines up.
  const padded = grid.map((row) => {
    const copy = [...(row ?? [])];
    while (copy.length < width) copy.push('');
    return copy;
  });

  return {
    sheetName,
    header: (padded[0] ?? []).map((value) => String(value)),
    rows: padded.slice(1),
  };
}
