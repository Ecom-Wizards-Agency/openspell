import { describe, expect, it } from 'vitest';
import { CsvParseError, parseCsv, parseNumber, sniffDelimiter } from './csv.js';

describe('parseCsv', () => {
  it('reads a comma export, lowercasing the header', () => {
    const table = parseCsv('Date,Spend\n2026-08-01,100.00\n');
    expect(table.columns).toEqual(['date', 'spend']);
    expect(table.rows).toEqual([{ date: '2026-08-01', spend: '100.00' }]);
  });

  it('sniffs the delimiter rather than assuming a comma', () => {
    expect(sniffDelimiter('date;spend;sales\n')).toBe(';');
    expect(sniffDelimiter('date,spend,sales\n')).toBe(',');
    expect(sniffDelimiter('date\tspend\tsales\n')).toBe('\t');
  });

  it('keeps a delimiter inside quotes, and unescapes doubled quotes', () => {
    const table = parseCsv('id,name\ncmp-1,"Exact, ""Core"""\n');
    expect(table.rows[0]?.name).toBe('Exact, "Core"');
  });

  it('strips a byte-order mark instead of hiding it in the first column name', () => {
    const table = parseCsv('﻿date,spend\n2026-08-01,1\n');
    expect(table.columns[0]).toBe('date');
  });

  it('refuses a short row rather than filling it with undefined', () => {
    expect(() => parseCsv('a,b,c\n1,2\n')).toThrow(CsvParseError);
  });

  it('tolerates a trailing newline and CRLF line endings', () => {
    const table = parseCsv('date,spend\r\n2026-08-01,1\r\n\r\n');
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.spend).toBe('1');
  });
});

describe('parseNumber', () => {
  it('reads plain and decorated figures', () => {
    expect(parseNumber('1234.56')).toBe(1234.56);
    expect(parseNumber('$1,234.56')).toBe(1234.56);
    expect(parseNumber('(12.50)')).toBe(-12.5);
    expect(parseNumber('-4.25')).toBe(-4.25);
  });

  it('reads comma decimals when the file is semicolon-delimited', () => {
    expect(parseNumber('1.234,56', ';')).toBe(1234.56);
    expect(parseNumber('102,00', ';')).toBe(102);
  });

  it('lets the last separator win when both appear', () => {
    expect(parseNumber('1,234.56', ',')).toBe(1234.56);
    expect(parseNumber('1.234,56', ',')).toBe(1234.56);
  });

  it('returns null for an absent figure instead of a silent zero', () => {
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('-')).toBeNull();
    expect(parseNumber('n/a')).toBeNull();
    expect(parseNumber(undefined)).toBeNull();
    expect(parseNumber('0')).toBe(0);
  });
});
