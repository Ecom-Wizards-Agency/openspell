import { describe, expect, it } from 'vitest';
import type { CreativeSyncJobState } from '@wizard-ads/db';
import type { CreativeSyncSnapshot } from '@wizard-ads/shared';
import {
  creativeLifecycle,
  type CreativeLifecycleEvidence,
} from './lifecycle';

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
  it('distinguishes an inactive producer from an eligible profile awaiting its first schedule', () => {
    const inactive = creativeLifecycle(evidence({ producerEligible: false }));
    const awaiting = creativeLifecycle(evidence({ producerEligible: true }));

    expect(inactive).toMatchObject({ state: 'inactive', counts: [] });
    expect(awaiting).toMatchObject({ state: 'awaiting_schedule', counts: [] });
    expect(inactive.body + awaiting.body).not.toContain('Run a Creative sync');
    expect(awaiting.body).toContain('automatically');
  });

  it('surfaces queued and running work before the first snapshot exists', () => {
    expect(creativeLifecycle(evidence({ latestJob: job('queued') }))).toMatchObject({
      state: 'queued',
      eyebrow: 'Sync queued',
    });
    expect(creativeLifecycle(evidence({ latestJob: job('running') }))).toMatchObject({
      state: 'mapping_pending',
      eyebrow: 'Mapping in progress',
    });
  });

  it('does not describe mapping-only or pending report evidence as performance', () => {
    const mapping = creativeLifecycle(evidence({
      snapshot: {
        ...snapshot,
        status: 'mapping_only',
        factPromotionAllowed: false,
        reportSourceRows: null,
        reportParsedRows: null,
        reportRefusedRows: null,
        mappedFactRows: 0,
        unpromotedReportRows: 0,
      },
    }));
    const pending = creativeLifecycle(evidence({
      snapshot: {
        ...snapshot,
        status: 'report_pending',
        factPromotionAllowed: true,
        reportSourceRows: null,
        reportParsedRows: null,
        reportRefusedRows: null,
        mappedFactRows: 0,
        unpromotedReportRows: 0,
      },
    }));

    expect(mapping).toMatchObject({ state: 'mapping_ready', title: expect.stringContaining('not') });
    expect(mapping.counts).toContainEqual({ label: 'Needs review', value: 2 });
    expect(pending.state).toBe('report_pending');
  });

  it('calls an all-unsupported snapshot unsupported without hiding mixed review rows', () => {
    const unsupported = creativeLifecycle(evidence({
      snapshot: {
        ...snapshot,
        mapped: 0,
        legacy: 0,
        unsupported: 7,
        ambiguous: 0,
        reportSourceRows: 0,
        reportParsedRows: 0,
        mappedFactRows: 0,
        unpromotedReportRows: 0,
      },
    }));
    const mixed = creativeLifecycle(evidence({ snapshot: { ...snapshot, mappedFactRows: 0 } }));

    expect(unsupported).toMatchObject({ state: 'unsupported', eyebrow: 'Unsupported evidence' });
    expect(unsupported.counts).toContainEqual({ label: 'Needs review', value: 7 });
    expect(mixed.state).toBe('completed_empty');
  });

  it('keeps blocked, completed-empty, and promoted fact states separate', () => {
    expect(creativeLifecycle(evidence({
      snapshot: { ...snapshot, status: 'blocked', factPromotionAllowed: false },
    })).state).toBe('blocked');
    expect(creativeLifecycle(evidence({
      snapshot: { ...snapshot, mappedFactRows: 0, unpromotedReportRows: 6 },
    }))).toMatchObject({ state: 'completed_empty', eyebrow: 'Sync complete' });
    expect(creativeLifecycle(evidence({ snapshot }))).toMatchObject({
      state: 'performance_ready',
      title: '5 ad-level fact rows promoted',
    });
  });

  it('keeps previous counted evidence visible while a newer refresh runs', () => {
    const queued = creativeLifecycle(evidence({
      snapshot,
      latestJob: job('queued', '63636363-6363-4363-8363-636363636363'),
    }));
    const running = creativeLifecycle(evidence({
      snapshot,
      latestJob: job('running', '64646464-6464-4464-8464-646464646464'),
    }));

    expect(queued).toMatchObject({
      state: 'queued',
      eyebrow: 'Refresh queued',
      observedAt: snapshot.observedAt,
      coverage: snapshot.startDate,
    });
    expect(queued.counts).toHaveLength(4);
    expect(running).toMatchObject({ state: 'mapping_pending', observedAt: snapshot.observedAt });
  });

  it('fails closed when a terminal job has no matching reconciled snapshot', () => {
    expect(creativeLifecycle(evidence({ latestJob: job('succeeded') }))).toMatchObject({
      state: 'blocked',
      title: expect.stringContaining('did not produce'),
    });
    expect(creativeLifecycle(evidence({ snapshot, latestJob: job('dead', snapshot.id) })))
      .toMatchObject({ state: 'blocked', observedAt: snapshot.observedAt });
  });
});

function evidence(
  overrides: Partial<CreativeLifecycleEvidence> = {},
): CreativeLifecycleEvidence {
  return {
    producerEligible: true,
    latestJob: null,
    snapshot: null,
    ...overrides,
  };
}

function job(
  status: CreativeSyncJobState['status'],
  id = '65656565-6565-4565-8565-656565656565',
): CreativeSyncJobState {
  return { id, status, createdAt: '2026-08-30T12:00:00.000Z' };
}
