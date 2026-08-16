/**
 * The arithmetic that keeps a multi-row insert inside Postgres' bind-parameter
 * cap. Pure, so it is tested here rather than against a database — the loaders
 * that use it are covered by the integration suites.
 */
import { describe, expect, it } from 'vitest';
import { MAX_BIND_PARAMS, chunkForInsert } from './chunk.js';

/** A sixteen-column table, the width that first overflowed in production. */
const NEGATIVES_COLUMNS = 16;
const negativesCap = Math.floor(MAX_BIND_PARAMS / NEGATIVES_COLUMNS);

function rows(count: number): number[] {
  return Array.from({ length: count }, (_unused, index) => index);
}

describe('chunkForInsert', () => {
  it('returns no chunks for no rows, so a caller never issues an empty insert', () => {
    expect(chunkForInsert([], NEGATIVES_COLUMNS)).toEqual([]);
  });

  it('leaves a batch that fits as a single chunk', () => {
    expect(chunkForInsert(rows(3), NEGATIVES_COLUMNS)).toEqual([[0, 1, 2]]);
  });

  it('keeps a batch of exactly the cap in one chunk', () => {
    const chunks = chunkForInsert(rows(negativesCap), NEGATIVES_COLUMNS);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(negativesCap);
  });

  it('splits one row past the cap into two chunks, losing nothing', () => {
    const chunks = chunkForInsert(rows(negativesCap + 1), NEGATIVES_COLUMNS);
    expect(chunks.map((chunk) => chunk.length)).toEqual([negativesCap, 1]);
    expect(chunks.flat()).toHaveLength(negativesCap + 1);
  });

  it('never lets a chunk exceed the parameter cap', () => {
    for (const columnCount of [1, 8, 16, 24, 40]) {
      const chunks = chunkForInsert(rows(200_000), columnCount);
      expect(chunks.flat()).toHaveLength(200_000);
      for (const chunk of chunks) {
        expect(chunk.length * columnCount).toBeLessThanOrEqual(MAX_BIND_PARAMS);
      }
    }
  });

  it('preserves order and identity across chunk boundaries', () => {
    const chunks = chunkForInsert(rows(negativesCap * 2 + 7), NEGATIVES_COLUMNS);
    expect(chunks.flat()).toEqual(rows(negativesCap * 2 + 7));
  });

  it('falls back to one row per chunk rather than looping forever on a silly width', () => {
    for (const columnCount of [0, -4, MAX_BIND_PARAMS * 2]) {
      expect(chunkForInsert(rows(3), columnCount).map((chunk) => chunk.length))
        .toEqual(columnCount === 0 || columnCount === -4 ? [3] : [1, 1, 1]);
    }
  });

  it('does not hand back the caller\'s array, so a later mutation cannot reach a chunk', () => {
    const source = rows(3);
    const [chunk] = chunkForInsert(source, NEGATIVES_COLUMNS);
    source[0] = 99;
    expect(chunk).toEqual([0, 1, 2]);
  });
});
