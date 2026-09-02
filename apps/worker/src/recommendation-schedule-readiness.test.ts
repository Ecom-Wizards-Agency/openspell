import { describe, expect, it, vi } from 'vitest';
import type { DbHandle } from '@wizard-ads/db';
import { createReadinessGatedRecommendationSchedules } from './recommendation-schedule-readiness.js';

const REVISION = 'a'.repeat(40);

describe('mixed-worker recommendation producer readiness', () => {
  it('creates zero scheduled artifacts until exact intent and fresh authority agree', async () => {
    const enqueueDueRecommendationRuns = vi.fn(async () => 2);
    const sql = vi.fn(async () => [{
      protocol: 'fenced', admission: 'scoped', epoch: 3, authorized_revision: REVISION,
    }]);
    const handle = { sql: sql as unknown as DbHandle['sql'] };
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
});
