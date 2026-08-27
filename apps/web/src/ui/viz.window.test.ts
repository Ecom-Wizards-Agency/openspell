/**
 * Where an experiment window lands on a bucketed x-axis.
 *
 * The case that mattered: at weekly or monthly granularity the axis carries one
 * label per bucket, so a short test can begin and end between two labels. The
 * band used to be dropped entirely — the operator switched from D to W and the
 * shading for the very test they were reading vanished. It is now clamped to
 * the bucket the window sits in, which is the smallest honest answer.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { niceTicks, TrendChart, windowBand } from './viz';

// The chart's own projection: PAD.left is 62 and the plot is 620 wide.
const PLOT_WIDTH = 620;
const PAD_LEFT = 62;
const projection = (dates: readonly string[]) => (index: number) =>
  PAD_LEFT + (dates.length > 1 ? (PLOT_WIDTH / (dates.length - 1)) * index : 0);

const band = (window: { start: string; end: string | null }, dates: readonly string[]) =>
  windowBand(
    { id: 'x', label: 'A test', ...window },
    dates,
    projection(dates),
    PLOT_WIDTH,
  );

const WEEKS = ['2026-07-27', '2026-08-03', '2026-08-10', '2026-08-17'];
const MONTHS = ['2026-06', '2026-07', '2026-08'];
const DAYS = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13'];

describe('windowBand', () => {
  it('spans the days a daily window covers', () => {
    const drawn = band({ start: '2026-08-11', end: '2026-08-12' }, DAYS);
    expect(drawn).not.toBeNull();
    // Two of four points, padded half a step each side.
    expect(drawn?.width).toBeCloseTo(PLOT_WIDTH / 3 + PLOT_WIDTH / 3, 5);
  });

  it('keeps a window that opens and closes between two weekly labels', () => {
    // 5–7 August: after the 3 August bucket starts, before the 10 August one.
    const drawn = band({ start: '2026-08-05', end: '2026-08-07' }, WEEKS);
    expect(drawn).not.toBeNull();
    // One bucket wide, on the week the test actually ran in.
    const step = PLOT_WIDTH / (WEEKS.length - 1);
    expect(drawn?.width).toBeCloseTo(step, 5);
    expect(drawn?.x).toBeCloseTo(projection(WEEKS)(1) - step / 2, 5);
  });

  it('keeps a window that falls inside one monthly bucket', () => {
    // Labels are 'YYYY-MM' here, which a plain string compare reads as later
    // than any day inside them.
    const drawn = band({ start: '2026-08-04', end: '2026-08-09' }, MONTHS);
    expect(drawn).not.toBeNull();
    const step = PLOT_WIDTH / (MONTHS.length - 1);
    // The last bucket: clamped to the plot's right edge, so half a step wide.
    expect(drawn?.width).toBeCloseTo(step / 2, 5);
  });

  it('still spans several buckets when the window really is long', () => {
    const drawn = band({ start: '2026-07-28', end: '2026-08-11' }, WEEKS);
    const step = PLOT_WIDTH / (WEEKS.length - 1);
    // Buckets 0 through 2, padded half a step on the right (the left is the
    // plot edge).
    expect(drawn?.width).toBeCloseTo(2 * step + step / 2, 5);
  });

  it('runs a still-open window to the right edge', () => {
    const drawn = band({ start: '2026-08-05', end: null }, WEEKS);
    expect(drawn?.x).toBeLessThan(PAD_LEFT + PLOT_WIDTH);
    expect((drawn?.x ?? 0) + (drawn?.width ?? 0)).toBeCloseTo(PAD_LEFT + PLOT_WIDTH, 5);
  });

  it('is null only when the window misses the plotted range entirely', () => {
    expect(band({ start: '2026-05-01', end: '2026-05-30' }, WEEKS)).toBeNull();
    expect(band({ start: '2026-09-01', end: '2026-09-30' }, WEEKS)).toBeNull();
    expect(band({ start: '2026-09-01', end: '2026-09-30' }, MONTHS)).toBeNull();
    expect(band({ start: '2026-08-01', end: '2026-08-02' }, [])).toBeNull();
  });
});

describe('brand chart rendering', () => {
  it('keeps every y-axis to three through five gridlines', () => {
    for (const [min, max] of [
      [0, 1],
      [0, 9],
      [13, 98],
      [-7, 21],
      [12_345, 98_765],
    ] as const) {
      expect(niceTicks(min, max).length).toBeGreaterThanOrEqual(3);
      expect(niceTicks(min, max).length).toBeLessThanOrEqual(5);
    }
  });

  it('renders fixed brand roles, comparison dashes, tabular 12px ticks, and endpoint labels', () => {
    const points = (offset: number) => [
      { date: '2026-08-01', value: 10 + offset },
      { date: '2026-08-02', value: 20 + offset },
      { date: '2026-08-03', value: 30 + offset },
    ];
    const markup = renderToStaticMarkup(
      createElement(TrendChart, {
        title: 'Brand roles',
        ariaLabel: 'Brand chart',
        currencyCode: 'USD',
        scale: 'integer',
        series: [
          { label: 'Primary', points: points(0) },
          { label: 'Highlight', points: points(5) },
          { label: 'Comparison', points: points(10) },
        ],
      }),
    );

    expect(markup).toContain('stroke="var(--wa-viz-1)"');
    expect(markup).toContain('stroke="var(--wa-viz-2)"');
    expect(markup).toContain('stroke="var(--wa-viz-3)"');
    expect(markup).toContain('stroke-dasharray="5 4"');
    expect(markup).toContain('stroke="var(--wa-viz-1-outline)"');
    expect(markup).toContain('font-size="12"');
    expect(markup).toContain('font-variant-numeric:tabular-nums');
    expect(markup).toContain('>30</text>');
  });
});
