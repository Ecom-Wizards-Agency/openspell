// @vitest-environment jsdom
/**
 * The cockpit's data and interaction honesty rules, pinned.
 *
 * - Calendar gaps are completed only inside observed coverage.
 * - Ratios are derived from bucket sums, never averaged daily ratios.
 * - A fifth series is rejected rather than silently replacing another.
 * - Every series owns its display and axis configuration.
 * - Each period can be focused and announces exact values.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bucketKey,
  Cockpit,
  completeDailyFacts,
  MAX_CHART_SERIES,
  partitionKpiTiles,
  periodAriaLabel,
  presentationAfterChange,
  selectionAfterToggle,
  seriesFor,
} from './cockpit';
import type { CockpitDay } from './cockpit';
import type { KpiTileModel } from '../optimizer/view';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Root[] = [];

const day = (date: string, over: Partial<CockpitDay> = {}): CockpitDay => ({
  date,
  impressions: 1000,
  clicks: 10,
  spend: 10,
  sales: 40,
  orders: 2,
  ...over,
});

const tile = (
  metric: string,
  label: string,
  scale: KpiTileModel['scale'] = 'money',
): KpiTileModel => ({
  metric,
  label,
  scale,
  better: null,
  value: 10,
  prev: 8,
  deltaPct: 0.25,
});

const tiles: KpiTileModel[] = [
  tile('spend', 'Spend'),
  tile('sales', 'Ad Sales'),
  tile('orders', 'Orders', 'integer'),
  tile('acos', 'ACOS', 'percent'),
  tile('clicks', 'Clicks', 'integer'),
  tile('roas', 'ROAS', 'ratio'),
];

function mountCockpit(days: readonly CockpitDay[] = [day('2026-08-24'), day('2026-08-26')]): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push(root);
  act(() => {
    root.render(
      createElement(Cockpit, {
        days,
        tiles,
        currencyCode: 'USD',
        settlingStart: '2026-08-26',
        coverageStart: '2026-08-24',
      }),
    );
  });
  return host;
}

function metricButton(host: HTMLElement, label: string): HTMLButtonElement {
  const match = [...host.querySelectorAll<HTMLButtonElement>('button[role="option"]')].find(
    (button) => button.querySelector('.wa-kpi__label')?.textContent === label,
  );
  if (match === undefined) throw new Error(`Missing metric button: ${label}`);
  return match;
}

afterEach(() => {
  act(() => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

describe('bucketKey', () => {
  it('uses the date, Monday, and calendar month as stable bucket keys', () => {
    expect(bucketKey('2026-08-27', 'D')).toBe('2026-08-27');
    expect(bucketKey('2026-08-27', 'W')).toBe('2026-08-24');
    expect(bucketKey('2026-08-23', 'W')).toBe('2026-08-17');
    expect(bucketKey('2026-08-31', 'M')).toBe('2026-08');
  });
});

describe('completeDailyFacts and seriesFor', () => {
  it('fills internal daily gaps with zero base facts and does not extend the coverage span', () => {
    const input = [day('2026-08-24', { spend: 10 }), day('2026-08-26', { spend: 30 })];
    const completed = completeDailyFacts(input);

    expect(completed.observedDates.size).toBe(input.length);
    expect(completed.days).toHaveLength(3);
    expect(completed.days.map((fact) => [fact.date, fact.spend])).toEqual([
      ['2026-08-24', 10],
      ['2026-08-25', 0],
      ['2026-08-26', 30],
    ]);

    const points = seriesFor(input, 'spend', 'D');
    expect(points.map((point) => [point.date, point.value, point.observedDays])).toEqual([
      ['2026-08-24', 10, 1],
      ['2026-08-25', 0, 0],
      ['2026-08-26', 30, 1],
    ]);
  });

  it('emits complete weekly buckets including a fully empty week', () => {
    const points = seriesFor(
      [day('2026-08-03', { spend: 10 }), day('2026-08-17', { spend: 30 })],
      'spend',
      'W',
    );
    expect(points.map((point) => [point.date, point.value, point.observedDays])).toEqual([
      ['2026-08-03', 10, 1],
      ['2026-08-10', 0, 0],
      ['2026-08-17', 30, 1],
    ]);
  });

  it('emits a calendar-month bucket when an entire month has no activity row', () => {
    const points = seriesFor(
      [day('2026-01-31', { spend: 10 }), day('2026-03-01', { spend: 30 })],
      'spend',
      'M',
    );
    expect(points.map((point) => [point.date, point.value, point.observedDays, point.calendarDays])).toEqual([
      ['2026-01', 10, 1, 1],
      ['2026-02', 0, 0, 28],
      ['2026-03', 30, 1, 1],
    ]);
  });

  it('derives ratios from summed base facts, not averaged daily ratios', () => {
    const points = seriesFor(
      [
        day('2026-08-24', { spend: 100, sales: 1000 }),
        day('2026-08-25', { spend: 10, sales: 20 }),
      ],
      'acos',
      'W',
    );
    expect(points).toHaveLength(1);
    expect(points[0]?.value).toBeCloseTo(110 / 1020, 10);
  });
});

describe('series selection and presentation', () => {
  it('allows one to four metrics and rejects a fifth without replacement', () => {
    let selected = ['spend'];
    for (const metric of ['sales', 'orders', 'acos']) {
      selected = selectionAfterToggle(selected, metric);
    }
    expect(selected).toHaveLength(MAX_CHART_SERIES);
    expect(selectionAfterToggle(selected, 'clicks')).toEqual(selected);
    expect(selectionAfterToggle(['spend'], 'spend')).toEqual(['spend']);
  });

  it('changes one series display and axis without resetting its other choice', () => {
    const initial = { spend: { mark: 'bar' as const, axis: 'left' as const } };
    const line = presentationAfterChange(initial, 'spend', { mark: 'line' });
    const right = presentationAfterChange(line, 'spend', { axis: 'right' });
    expect(right.spend).toEqual({ mark: 'line', axis: 'right' });
  });

  it('enforces the cap in the rendered metric controls', () => {
    const host = mountCockpit();
    act(() => metricButton(host, 'Orders').click());
    act(() => metricButton(host, 'ACOS').click());

    const clicks = metricButton(host, 'Clicks');
    expect(clicks.getAttribute('aria-disabled')).toBe('true');
    act(() => clicks.click());
    expect(clicks.getAttribute('aria-selected')).toBe('false');
    expect(host.querySelector('.wa-cockpit__selection-count')?.textContent).toContain('4 of 4');
  });

  it('renders each series display and axis configuration independently', () => {
    const host = mountCockpit();
    const spendDisplay = host.querySelector<HTMLSelectElement>('select[aria-label="Spend display"]');
    const spendAxis = host.querySelector<HTMLSelectElement>('select[aria-label="Spend axis"]');
    expect(spendDisplay?.value).toBe('bar');
    expect(spendAxis?.value).toBe('left');

    act(() => {
      if (spendDisplay === null) throw new Error('Spend display control missing');
      spendDisplay.value = 'line';
      spendDisplay.dispatchEvent(new Event('change', { bubbles: true }));
    });
    act(() => {
      if (spendAxis === null) throw new Error('Spend axis control missing');
      spendAxis.value = 'right';
      spendAxis.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(host.querySelector('[data-series-mark="line"][aria-label="Spend line"]')).not.toBeNull();
    expect(host.querySelector('g[aria-label="left axis"]')).toBeNull();
    expect(host.querySelector('g[aria-label="right axis"]')).not.toBeNull();
  });
});

describe('accessible period detail', () => {
  it('announces the exact period and exact values, including a completed gap', () => {
    const facts = [day('2026-08-24', { spend: 10 }), day('2026-08-26', { spend: 30 })];
    const points = seriesFor(facts, 'spend', 'D');
    const series = [{ label: 'Spend', scale: 'money' as const, points }];

    expect(periodAriaLabel(points[0] as NonNullable<(typeof points)[number]>, series, 0, 'USD')).toContain(
      'Aug 24, 2026. Spend: $10.00',
    );
    expect(periodAriaLabel(points[1] as NonNullable<(typeof points)[number]>, series, 1, 'USD')).toContain(
      'Spend: $0.00. No source row; chart shows zero for continuity.',
    );
  });

  it('makes every completed period keyboard-focusable with a useful label', () => {
    const host = mountCockpit();
    const periods = [...host.querySelectorAll<SVGRectElement>('.wa-cockpit__period-hit')];
    expect(periods).toHaveLength(3);
    expect(periods.every((period) => period.getAttribute('tabindex') === '0')).toBe(true);
    expect(periods[1]?.getAttribute('aria-label')).toContain('No source row; chart shows zero for continuity.');
    expect(host.querySelector('[role="radiogroup"][aria-label="Chart aggregation"]')).not.toBeNull();
    expect(host.querySelector('[role="radio"][aria-label="Daily"]')).not.toBeNull();
  });
});

describe('partitionKpiTiles', () => {
  it('keeps exactly four operator KPIs primary and preserves every supporting metric', () => {
    const groups = partitionKpiTiles(tiles);
    expect(groups.primary.map((candidate) => candidate.metric)).toEqual([
      'spend',
      'sales',
      'orders',
      'acos',
    ]);
    expect(groups.supporting.map((candidate) => candidate.metric)).toEqual(['clicks', 'roas']);
    expect([...groups.primary, ...groups.supporting]).toHaveLength(tiles.length);
  });
});
