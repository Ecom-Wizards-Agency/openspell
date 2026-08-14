/**
 * The workbook writer, verified through the file rather than around it.
 *
 * Every test here writes real bytes and reads them back. A test that inspected
 * the sheet model on the way in would prove the model equals itself; the
 * question worth answering is whether the archive on disk holds the grid the
 * plan described.
 */
import { describe, expect, it } from 'vitest';

import { SP_COLUMNS } from './constants.js';
import type { SheetModel } from './types.js';
import { columnIndex, columnName, crc32, readWorkbook, readZip, writeWorkbook, writeZip } from './xlsx/index.js';

const REQUIRED_PARTS = [
  '[Content_Types].xml',
  '_rels/.rels',
  'xl/workbook.xml',
  'xl/_rels/workbook.xml.rels',
  'xl/styles.xml',
  'xl/worksheets/sheet1.xml',
];

function roundTrip(sheet: SheetModel): SheetModel {
  return readWorkbook(writeWorkbook(sheet));
}

describe('column names', () => {
  it('counts up through the two-letter range', () => {
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    expect(columnName(26)).toBe('AA');
    expect(columnName(51)).toBe('AZ');
    expect(columnName(52)).toBe('BA');
    expect(columnName(701)).toBe('ZZ');
    expect(columnName(702)).toBe('AAA');
  });

  it('round-trips every index a bulksheet can reach', () => {
    for (let i = 0; i < 1000; i += 1) expect(columnIndex(columnName(i))).toBe(i);
  });
});

describe('the ZIP container', () => {
  it('writes something that starts with a local file header', () => {
    const bytes = writeZip([{ name: 'a.txt', data: new TextEncoder().encode('hello') }]);
    expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('round-trips entries byte for byte', () => {
    const encoder = new TextEncoder();
    const entries = [
      { name: 'one.txt', data: encoder.encode('first') },
      { name: 'nested/two.xml', data: encoder.encode('<x/>') },
      { name: 'empty.bin', data: new Uint8Array(0) },
    ];
    const files = readZip(writeZip(entries));
    expect([...files.keys()]).toEqual(['one.txt', 'nested/two.xml', 'empty.bin']);
    for (const entry of entries) {
      expect([...(files.get(entry.name) as Uint8Array)]).toEqual([...entry.data]);
    }
  });

  it('computes the CRC-32 the format specifies', () => {
    // The canonical check value for "123456789".
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('is byte-identical for the same input, so two exports can be diffed', () => {
    const entry = [{ name: 'a.txt', data: new TextEncoder().encode('hello') }];
    expect([...writeZip(entry)]).toEqual([...writeZip(entry)]);
  });
});

describe('the workbook', () => {
  const sheet: SheetModel = {
    sheetName: 'Sponsored Products Campaigns',
    header: [...SP_COLUMNS],
    rows: [
      SP_COLUMNS.map((column) => (column === 'Daily Budget' ? 10 : column === 'Bid' ? 0.55 : '')),
      SP_COLUMNS.map((column) => (column === 'Campaign Name' ? 'Rank | SP | Exact | Widget' : '')),
    ],
  };

  it('contains exactly the parts the format requires', () => {
    const files = readZip(writeWorkbook(sheet));
    expect([...files.keys()].sort()).toEqual([...REQUIRED_PARTS].sort());
  });

  it('round-trips the grid, the sheet name and the header', () => {
    const read = roundTrip(sheet);
    expect(read.sheetName).toBe(sheet.sheetName);
    expect(read.header).toEqual(sheet.header);
    expect(read.rows).toEqual(sheet.rows);
  });

  it('keeps a number a number and a digit string a string', () => {
    // `Start Date` is `20260814`, and a bulksheet that turned it into the
    // number 20,260,814 would upload as a different date entirely.
    const read = roundTrip({
      sheetName: 'S',
      header: ['a', 'b'],
      rows: [['20260814', 20260814]],
    });
    expect(read.rows[0]?.[0]).toBe('20260814');
    expect(typeof read.rows[0]?.[0]).toBe('string');
    expect(read.rows[0]?.[1]).toBe(20260814);
    expect(typeof read.rows[0]?.[1]).toBe('number');
  });

  it('survives the characters XML cares about', () => {
    const nasty = 'widget & <holder> "quoted" \'apostrophe\' 50% off';
    const read = roundTrip({ sheetName: 'S & <T>', header: ['a'], rows: [[nasty]] });
    expect(read.sheetName).toBe('S & <T>');
    expect(read.rows[0]?.[0]).toBe(nasty);
  });

  it('keeps leading and trailing whitespace in a cell', () => {
    const read = roundTrip({ sheetName: 'S', header: ['a'], rows: [['  padded  ']] });
    expect(read.rows[0]?.[0]).toBe('  padded  ');
  });

  it('treats an empty string and a missing cell as the same thing', () => {
    // openpyxl reads a blank cell as `None`, and the golden records that as an
    // empty string. Matching it is what lets the two workbooks be diffed.
    const read = roundTrip({ sheetName: 'S', header: ['a', 'b', 'c'], rows: [['x', '', 'z']] });
    expect(read.rows[0]).toEqual(['x', '', 'z']);
  });

  it('refuses a cell a spreadsheet cannot hold', () => {
    expect(() => writeWorkbook({ sheetName: 'S', header: ['a'], rows: [[Number.NaN]] }))
      .toThrow(/non-finite/);
    expect(() => writeWorkbook({ sheetName: 'S', header: ['a'], rows: [[Number.POSITIVE_INFINITY]] }))
      .toThrow(/non-finite/);
  });

  it('rejects an archive it did not write', () => {
    expect(() => readZip(new TextEncoder().encode('not a zip at all'))).toThrow(/not a ZIP/);
    expect(() => readWorkbook(writeZip([{ name: 'a.txt', data: new Uint8Array(1) }])))
      .toThrow(/not an xlsx/);
  });
});
