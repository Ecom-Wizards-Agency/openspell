import { describe, expect, it } from 'vitest';
import type { CreativeSyncSnapshot } from '@wizard-ads/shared';
import { creativeLifecycle } from './lifecycle';

const snapshot: CreativeSyncSnapshot = {
  id: '61616161-6161-4161-8161-616161616161',
  profileId: '62626262-6262-4262-8262-626262626262',
  startDate: '2026-08-29',
  endDate: '2026-08-29',
  observedAt: '2026-08-29T12:00:00.000Z',
  mappingProvenance: 'current_sb_ad_snapshot',
  historicalValidity: 'unproven_current_snapshot',
  status: 'completed',
  paginationComplete: true,
  factPromotionAllowed: true,
  sourceAssets: 4,
  parsedAssets: 4,
  sourceAds: 7,
  parsedAds: 7,
  mapped: 5,
  legacy: 1,
  unsupported: 0,
  ambiguous: 1,
  unmapped: 0,
  reportSourceRows: 6,
  reportParsedRows: 6,
  reportRefusedRows: 0,
  mappedFactRows: 5,
  unpromotedReportRows: 1,
};

describe('creative lifecycle', () => {
  it('keeps an absent sync distinct from a complete zero-row report', () => {
    expect(creativeLifecycle(null)).toMatchObject({ state: 'not_started', counts: [] });
    expect(creativeLifecycle({ ...snapshot, mappedFactRows: 0, unpromotedReportRows: 6 }))
      .toMatchObject({ state: 'completed_empty', eyebrow: 'Sync complete' });
  });

  it('does not describe mapping-only evidence as performance', () => {
    const view = creativeLifecycle({
      ...snapshot,
      status: 'mapping_only',
      factPromotionAllowed: false,
      reportSourceRows: null,
      reportParsedRows: null,
      reportRefusedRows: null,
      mappedFactRows: 0,
      unpromotedReportRows: 0,
    });
    expect(view).toMatchObject({ state: 'mapping_ready', title: expect.stringContaining('not') });
    expect(view.counts).toContainEqual({ label: 'Needs review', value: 2 });
  });

  it('surfaces pending, blocked and promoted fact states without losing counts', () => {
    expect(creativeLifecycle({
      ...snapshot,
      status: 'report_pending',
      factPromotionAllowed: false,
      reportSourceRows: null,
      reportParsedRows: null,
      reportRefusedRows: null,
      mappedFactRows: 0,
      unpromotedReportRows: 0,
    }).state).toBe('report_pending');
    expect(creativeLifecycle({ ...snapshot, status: 'blocked', factPromotionAllowed: false }).state)
      .toBe('blocked');
    expect(creativeLifecycle(snapshot)).toMatchObject({
      state: 'performance_ready',
      title: '5 ad-level fact rows promoted',
    });
  });
});
