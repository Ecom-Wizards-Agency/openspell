import { describe, expect, it } from 'vitest';
import type { MarketingStreamHourlyFact } from '@wizard-ads/shared';
import {
  buildDaypartingHeatmap,
  formatDaypartingMetric,
  summarizeDaypartingFacts,
} from './view';

const fact = (
  overrides: Partial<MarketingStreamHourlyFact> = {},
): MarketingStreamHourlyFact => ({
  profileId: '11111111-1111-4111-8111-111111111111',
  adProduct: 'SP',
  campaignId: 'campaign-a',
  utcHour: '2026-08-10T03:00:00.000Z',
  profileTimeZone: 'Asia/Singapore',
  localDate: '2026-08-10',
  localHour: 11,
  localDayOfWeek: 1,
  currencyCode: 'USD',
  impressions: 100,
  clicks: 10,
  cost: 20,
  purchases: 2,
  sales: 80,
  budgetUsagePercent: 91,
  budgetCapped: true,
  settlingState: 'settled',
  sourceEvents: 3,
  ...overrides,
});

describe('dayparting view model', () => {
  it('aggregates local cells, revision state, budget caps, and source counts without losing rows', () => {
    const cells = buildDaypartingHeatmap([
      fact(),
      fact({ utcHour: '2026-08-17T03:00:00.000Z', impressions: 50, clicks: 5, cost: 10, purchases: 1, sales: 20, settlingState: 'revised', sourceEvents: 2 }),
    ], 'roas');
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({
      dayOfWeek: 1,
      hour: 11,
      impressions: 150,
      clicks: 15,
      spend: 30,
      orders: 3,
      sales: 100,
      settledFacts: 1,
      revisedFacts: 1,
      cappedFacts: 2,
      sourceEvents: 5,
    });
    expect(cells[0]?.value).toBeCloseTo(100 / 30);
  });

  it('separates settled, settling, revised, and capped UTC hours in the summary', () => {
    const summary = summarizeDaypartingFacts([
      fact(),
      fact({ utcHour: '2026-08-10T04:00:00.000Z', localHour: 12, settlingState: 'settling', budgetCapped: false }),
      fact({ utcHour: '2026-08-10T05:00:00.000Z', localHour: 13, settlingState: 'revised' }),
    ]);
    expect(summary).toMatchObject({ settledHours: 1, settlingHours: 1, revisedHours: 1, cappedHours: 2 });
  });

  it('formats rate, ratio, money, and missing denominator states honestly', () => {
    expect(formatDaypartingMetric(4, 'roas', 'USD')).toBe('4.00×');
    expect(formatDaypartingMetric(0.2, 'conversion_rate', 'USD')).toBe('20.0%');
    expect(formatDaypartingMetric(null, 'acos', 'USD')).toBe('—');
    expect(formatDaypartingMetric(12, 'orders', 'USD')).toBe('12');
  });
});
