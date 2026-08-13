/**
 * Formatting parity.
 *
 * Every expectation below is the literal output of Python's `format()` for the
 * same value and spec. They are pinned separately from the golden replay
 * because the failure they guard against is subtle: `toFixed` rounds ties away
 * from zero and Python rounds them to even, so `12.5` renders as "13" in
 * JavaScript and "12" in Python. Flag messages carry those strings, so the
 * difference would surface as a dozen unrelated parity failures with no obvious
 * cause.
 */
import { describe, expect, it } from 'vitest';
import { formatCount, formatFixed, formatMoney, safeDiv, safeDivRow } from './num.js';

describe('formatFixed matches Python format()', () => {
  const cases: Array<[number, number, boolean, string]> = [
    [12.5, 0, false, '12'], // tie rounds to even, not up
    [13.5, 0, false, '14'],
    [-0.4, 0, false, '-0'], // the sign survives a round to zero
    [2.675, 2, false, '2.67'], // binary value is just below the tie
    [1.005, 2, false, '1.00'],
    [1234567.891, 2, true, '1,234,567.89'],
    [1234567.891, 2, false, '1234567.89'],
    [-0.001, 2, false, '-0.00'],
    [0.0, 0, false, '0'],
    [35.0, 0, false, '35'],
    [-1234.5, 0, true, '-1,234'],
    [-1234.5, 0, false, '-1234'],
  ];
  for (const [value, digits, thousands, expected] of cases) {
    it(`${value} @ ${digits}dp${thousands ? ' grouped' : ''} -> ${expected}`, () => {
      expect(formatFixed(value, digits, thousands)).toBe(expected);
    });
  }
});

describe('money and count helpers', () => {
  it('renders currency the way the reference messages do', () => {
    expect(formatMoney(30)).toBe('$30.00');
    expect(formatMoney(1234.5)).toBe('$1,234.50');
    expect(formatMoney(-12.345)).toBe('$-12.35');
  });

  it('renders counts with group separators and no decimals', () => {
    expect(formatCount(5)).toBe('5');
    expect(formatCount(12345)).toBe('12,345');
  });
});

describe('safe division', () => {
  it('treats a zero or missing denominator as no answer, never as zero', () => {
    expect(safeDiv(10, 0)).toBeNull();
    expect(safeDiv(10, null)).toBeNull();
    expect(safeDiv(null, 10)).toBeNull();
    expect(safeDiv(0, 10)).toBe(0);
  });

  it('reproduces the row-level variant, where a missing numerator is also no answer', () => {
    expect(safeDivRow(null, 10)).toBeNull();
    expect(safeDivRow(0, 10)).toBe(0);
    expect(safeDivRow(10, 0)).toBeNull();
  });
});
