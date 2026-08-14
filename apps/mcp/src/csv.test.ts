import { describe, expect, it } from 'vitest';
import { toCsv } from './csv.js';

describe('csv', () => {
  it('quotes what has to be quoted and leaves the rest alone', () => {
    const result = toCsv(
      ['name', 'spend'],
      [{ name: 'blue widget, large', spend: 1.5 }, { name: 'say "hi"', spend: 2 }],
      10_000,
    );
    expect(result.text.split('\n')[1]).toBe('"blue widget, large",1.5');
    expect(result.text.split('\n')[2]).toBe('"say ""hi""",2');
  });

  it('writes an empty cell for a missing value rather than the word null', () => {
    const result = toCsv(['a', 'b'], [{ a: null, b: undefined }], 10_000);
    expect(result.text.split('\n')[1]).toBe(',');
  });

  it('stops at the byte budget and counts what it left behind', () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ n: index, pad: 'x'.repeat(50) }));
    const result = toCsv(['n', 'pad'], rows, 500);

    expect(result.bytes).toBeLessThanOrEqual(500);
    expect(result.truncated).toBe(true);
    expect(result.rowsOffered).toBe(100);
    expect(result.rowsWritten).toBeLessThan(100);
    // Rule 4: rows written against rows offered, as data on the response.
    expect(result.text.trimEnd().split('\n').length - 1).toBe(result.rowsWritten);
  });
});
