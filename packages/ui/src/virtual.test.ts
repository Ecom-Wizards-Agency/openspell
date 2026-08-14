/**
 * The property behind "50k rows without jank": rows materialised does not grow
 * with rows loaded.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_OVERSCAN, DEFAULT_ROW_HEIGHT, virtualWindow } from './virtual.js';

const viewport = { rowHeight: DEFAULT_ROW_HEIGHT, viewportHeight: 620 };
const expectedVisible = Math.ceil(viewport.viewportHeight / viewport.rowHeight) + 1;
const ceiling = expectedVisible + DEFAULT_OVERSCAN * 2;

describe('virtualWindow', () => {
  it.each([100, 1_000, 10_000, 50_000, 250_000])(
    'materialises the same handful of rows whether the set holds %i',
    (rowCount) => {
      const window = virtualWindow({ ...viewport, rowCount, scrollTop: 0 });
      expect(window.count).toBeLessThanOrEqual(ceiling);
    },
  );

  it('stays bounded at every scroll position across a 50k set', () => {
    const rowCount = 50_000;
    const total = rowCount * viewport.rowHeight;
    let widest = 0;
    for (let scrollTop = 0; scrollTop <= total; scrollTop += 977) {
      const window = virtualWindow({ ...viewport, rowCount, scrollTop });
      widest = Math.max(widest, window.count);
      expect(window.startIndex).toBeGreaterThanOrEqual(0);
      expect(window.endIndex).toBeLessThanOrEqual(rowCount);
      expect(window.paddingTop + window.count * viewport.rowHeight + window.paddingBottom).toBe(
        window.totalHeight,
      );
    }
    expect(widest).toBeLessThanOrEqual(ceiling);
  });

  it('keeps the scrollbar honest: total height is the whole set, not the window', () => {
    const window = virtualWindow({ ...viewport, rowCount: 50_000, scrollTop: 0 });
    expect(window.totalHeight).toBe(50_000 * viewport.rowHeight);
  });

  it('overscans in both directions once scrolled off the top', () => {
    const window = virtualWindow({ ...viewport, rowCount: 50_000, scrollTop: 10_000 });
    const firstFullyVisible = Math.floor(10_000 / viewport.rowHeight);
    expect(window.startIndex).toBe(firstFullyVisible - DEFAULT_OVERSCAN);
    expect(window.endIndex).toBeGreaterThan(firstFullyVisible + expectedVisible - 1);
  });

  it('renders nothing, and no spacers, for an empty set', () => {
    expect(virtualWindow({ ...viewport, rowCount: 0, scrollTop: 0 })).toEqual({
      startIndex: 0,
      endIndex: 0,
      paddingTop: 0,
      paddingBottom: 0,
      totalHeight: 0,
      count: 0,
    });
  });

  it('clamps a scroll position past the end rather than producing a negative window', () => {
    const window = virtualWindow({ ...viewport, rowCount: 10, scrollTop: 999_999 });
    expect(window.endIndex).toBe(10);
    expect(window.paddingBottom).toBe(0);
    expect(window.count).toBeGreaterThanOrEqual(0);
  });
});
