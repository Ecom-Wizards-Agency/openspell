/**
 * WP-28 bid-corridor chart geometry.
 *
 * The two marks the corridor adds over `TrendChart` are a filled band between
 * the suggested-bid edges and step lines for the bid and max-potential CPC.
 * Both are pure over an x/y projection, so they are tested without a DOM: the
 * band breaks where an edge is missing, and a step holds a value until the next
 * day rather than sloping between them.
 */
import { describe, expect, it } from 'vitest';
import { corridorBandSegments, stepPath, type BidCorridorPoint } from './viz';

// Identity-ish projections keep the assertions about shape, not scale.
const x = (index: number): number => index;
const y = (value: number): number => value;

function point(over: Partial<BidCorridorPoint> & { date: string }): BidCorridorPoint {
  return {
    low: null,
    median: null,
    high: null,
    bid: null,
    cpc: null,
    maxCpc: null,
    components: [],
    ...over,
  };
}

describe('corridorBandSegments', () => {
  it('draws one closed segment across a contiguous run of edges', () => {
    const points = [
      point({ date: '2026-08-01', low: 1, high: 3 }),
      point({ date: '2026-08-02', low: 1.5, high: 3.5 }),
    ];
    const segments = corridorBandSegments(points, x, y);
    expect(segments).toHaveLength(1);
    // Top edge left→right, bottom edge right→left, closed.
    expect(segments[0]).toMatch(/^M/);
    expect(segments[0]?.endsWith('Z')).toBe(true);
  });

  it('breaks the band where an edge is missing', () => {
    const points = [
      point({ date: '2026-08-01', low: 1, high: 3 }),
      point({ date: '2026-08-02' }), // no edges — a gap
      point({ date: '2026-08-03', low: 2, high: 4 }),
    ];
    // Two runs of one day each: two (widened) segments, not one bridge.
    expect(corridorBandSegments(points, x, y)).toHaveLength(2);
  });

  it('has no segment when nothing carries a corridor', () => {
    expect(corridorBandSegments([point({ date: '2026-08-01' })], x, y)).toEqual([]);
  });
});

describe('stepPath', () => {
  it('holds each value until the next day, then steps', () => {
    const path = stepPath(
      [
        { date: '2026-08-01', value: 1 },
        { date: '2026-08-02', value: 2 },
      ],
      x,
      y,
    );
    // Move to (0,1), hold to (1,1), then step to (1,2): a horizontal then a vertical.
    expect(path).toBe('M0.00 1.00 L1.00 1.00 L1.00 2.00');
  });

  it('breaks the line across a gap rather than sloping through it', () => {
    const path = stepPath(
      [
        { date: '2026-08-01', value: 1 },
        { date: '2026-08-02', value: null },
        { date: '2026-08-03', value: 3 },
      ],
      x,
      y,
    );
    // Two separate move commands — one per side of the gap.
    expect(path.match(/M/g)).toHaveLength(2);
  });
});
