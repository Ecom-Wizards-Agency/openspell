import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { stackEndLabelYs, TrendChart } from './viz.js';

describe('trend endpoint labels', () => {
  it('stacks colliding labels and keeps them inside the plot', () => {
    const positions = stackEndLabelYs([100, 102, 104], 20, 120);
    const sorted = [...positions].sort((a, b) => a - b);
    expect((sorted[1] ?? 0) - (sorted[0] ?? 0)).toBeGreaterThanOrEqual(13);
    expect((sorted[2] ?? 0) - (sorted[1] ?? 0)).toBeGreaterThanOrEqual(13);
    expect(Math.min(...positions)).toBeGreaterThanOrEqual(20);
    expect(Math.max(...positions)).toBeLessThanOrEqual(120);
  });

  it('shades and explains a settling tail that overlaps the chart', () => {
    const markup = renderToStaticMarkup(
      <TrendChart
        title="Spend"
        ariaLabel="Daily spend"
        scale="money"
        currencyCode="USD"
        settlingWindow={{ label: 'Settling', start: '2026-08-13', end: '2026-08-26' }}
        series={[{
          label: 'Spend',
          points: [
            { date: '2026-08-12', value: 10 },
            { date: '2026-08-13', value: 11 },
            { date: '2026-08-14', value: 12 },
          ],
        }]}
      />,
    );
    expect(markup).toContain('data-testid="settling-window"');
    expect(markup).toContain('data-testid="settling-note"');
    expect(markup).toContain('14-day attribution window');
  });
});
