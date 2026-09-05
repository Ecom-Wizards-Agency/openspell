/**
 * The general worker's scheduled recommendation producer. Its gate is the
 * scheduled (fenced-only) readiness decision: the manual "Run preview" legacy
 * fallback must never turn this scheduler on.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DbHandle } from '@wizard-ads/db';
import { createReadinessGatedRecommendationSchedules } from './recommendation-schedule-readiness.js';

const REVISION = 'a'.repeat(40);
const LEGACY_AUTHORITY = {
  protocol: 'legacy', admission: 'legacy', epoch: 0, authorized_revision: null,
};
const FENCED_AUTHORITY = {
  protocol: 'fenced', admission: 'scoped', epoch: 3, authorized_revision: REVISION,
};

function fixture(rows: readonly unknown[]) {
  const enqueueDueRecommendationRuns = vi.fn(async () => 2);
  const sql = vi.fn(async () => rows);
  const handle = { sql: sql as unknown as DbHandle['sql'] };
  return { enqueueDueRecommendationRuns, sql, handle };
}

describe('mixed-worker recommendation producer readiness', () => {
  it('creates zero scheduled artifacts until exact intent and fresh authority agree', async () => {
    const { enqueueDueRecommendationRuns, sql, handle } = fixture([FENCED_AUTHORITY]);
    const disabled = createReadinessGatedRecommendationSchedules(
      handle,
      { enqueueDueRecommendationRuns },
      {},
    );
    await expect(disabled.enqueueDueRecommendationRuns()).resolves.toBe(0);
    expect(sql).not.toHaveBeenCalled();
    expect(enqueueDueRecommendationRuns).not.toHaveBeenCalled();

    const enabled = createReadinessGatedRecommendationSchedules(
      handle,
      { enqueueDueRecommendationRuns },
      {
        OPENSPELL_RECOMMENDATION_LANE_READY: '1',
        OPENSPELL_RECOMMENDATION_LANE_REVISION: REVISION,
      },
    );
    await expect(enabled.enqueueDueRecommendationRuns()).resolves.toBe(2);
    expect(sql).toHaveBeenCalledTimes(1);
    expect(enqueueDueRecommendationRuns).toHaveBeenCalledTimes(1);
  });

  it('gains no admission from legacy authority while the manual preview fallback is active', async () => {
    // The same authority state that admits a manual legacy preview.
    for (const env of [{}, { OPENSPELL_RECOMMENDATION_LANE_READY: '0' }]) {
      const { enqueueDueRecommendationRuns, sql, handle } = fixture([LEGACY_AUTHORITY]);
      const gated = createReadinessGatedRecommendationSchedules(
        handle,
        { enqueueDueRecommendationRuns },
        env,
      );
      await expect(gated.enqueueDueRecommendationRuns(new Date('2026-09-07T09:00:00Z'))).resolves.toBe(0);
      expect(sql).not.toHaveBeenCalled();
      expect(enqueueDueRecommendationRuns).not.toHaveBeenCalled();
    }
  });

  it('keeps every fenced refusal when intent is enabled but authority disagrees', async () => {
    const refusals = [
      LEGACY_AUTHORITY,
      { ...FENCED_AUTHORITY, admission: 'blocked' },
      { ...FENCED_AUTHORITY, authorized_revision: 'b'.repeat(40) },
    ];
    for (const row of refusals) {
      const { enqueueDueRecommendationRuns, sql, handle } = fixture([row]);
      const gated = createReadinessGatedRecommendationSchedules(
        handle,
        { enqueueDueRecommendationRuns },
        {
          OPENSPELL_RECOMMENDATION_LANE_READY: '1',
          OPENSPELL_RECOMMENDATION_LANE_REVISION: REVISION,
        },
      );
      await expect(gated.enqueueDueRecommendationRuns()).resolves.toBe(0);
      expect(sql).toHaveBeenCalledTimes(1);
      expect(enqueueDueRecommendationRuns).not.toHaveBeenCalled();
    }
  });

  it('fails closed without database work on a malformed environment', async () => {
    const { enqueueDueRecommendationRuns, sql, handle } = fixture([FENCED_AUTHORITY]);
    const gated = createReadinessGatedRecommendationSchedules(
      handle,
      { enqueueDueRecommendationRuns },
      { OPENSPELL_RECOMMENDATION_LANE_READY: '1' },
    );
    await expect(gated.enqueueDueRecommendationRuns()).resolves.toBe(0);
    expect(sql).not.toHaveBeenCalled();
    expect(enqueueDueRecommendationRuns).not.toHaveBeenCalled();
  });
});
