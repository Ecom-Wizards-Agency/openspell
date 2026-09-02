import { describe, expect, it, vi } from 'vitest';
import type { DbHandle } from '@wizard-ads/db';
import {
  enqueueRecommendationSchedulesIfReady,
  recommendationLaneIntentFromEnv,
  requireValidRecommendationLaneIntent,
  resolveOptimizerPreviewReadiness,
} from './readiness';

const REVISION = 'a'.repeat(40);

function handleWithRows(rows: readonly unknown[]): {
  handle: Pick<DbHandle, 'sql'>;
  sql: ReturnType<typeof vi.fn>;
} {
  const sql = vi.fn(async () => rows);
  return { handle: { sql: sql as unknown as DbHandle['sql'] }, sql };
}

const enabledEnv = {
  OPENSPELL_RECOMMENDATION_LANE_READY: '1',
  OPENSPELL_RECOMMENDATION_LANE_REVISION: REVISION,
};

describe('recommendation lane deployment intent', () => {
  it('is inert for an absent or exact zero gate and ignores a stale revision', () => {
    expect(recommendationLaneIntentFromEnv({})).toEqual({ state: 'disabled' });
    expect(recommendationLaneIntentFromEnv({
      OPENSPELL_RECOMMENDATION_LANE_READY: '0',
      OPENSPELL_RECOMMENDATION_LANE_REVISION: 'malformed-but-inert',
    })).toEqual({ state: 'disabled' });
  });

  it('accepts only exact one with an exact lowercase full object id', () => {
    expect(recommendationLaneIntentFromEnv(enabledEnv)).toEqual({
      state: 'enabled', revision: REVISION,
    });
    for (const env of [
      { OPENSPELL_RECOMMENDATION_LANE_READY: 'true', OPENSPELL_RECOMMENDATION_LANE_REVISION: REVISION },
      { OPENSPELL_RECOMMENDATION_LANE_READY: '1' },
      { OPENSPELL_RECOMMENDATION_LANE_READY: '1', OPENSPELL_RECOMMENDATION_LANE_REVISION: 'a'.repeat(39) },
      { OPENSPELL_RECOMMENDATION_LANE_READY: '1', OPENSPELL_RECOMMENDATION_LANE_REVISION: 'A'.repeat(40) },
      { OPENSPELL_RECOMMENDATION_LANE_READY: ' 1', OPENSPELL_RECOMMENDATION_LANE_REVISION: REVISION },
    ]) {
      expect(recommendationLaneIntentFromEnv(env)).toEqual({ state: 'invalid' });
      expect(() => requireValidRecommendationLaneIntent(env)).toThrow(/not configured safely/);
    }
  });
});

describe('optimizer preview readiness', () => {
  it('does no database work while source intent is disabled or malformed', async () => {
    const { handle, sql } = handleWithRows([]);
    await expect(resolveOptimizerPreviewReadiness(handle, {})).resolves.toEqual({
      ready: false, reason: 'disabled',
    });
    await expect(resolveOptimizerPreviewReadiness(handle, {
      OPENSPELL_RECOMMENDATION_LANE_READY: '1',
    })).resolves.toEqual({ ready: false, reason: 'misconfigured' });
    expect(sql).not.toHaveBeenCalled();
  });

  it('requires fenced, scoped authority at the exact expected revision', async () => {
    const cases = [
      [{ protocol: 'legacy', admission: 'legacy', epoch: '0', authorized_revision: null }, 'authority_not_fenced'],
      [{ protocol: 'fenced', admission: 'blocked', epoch: '2', authorized_revision: REVISION }, 'admission_not_scoped'],
      [{ protocol: 'fenced', admission: 'scoped', epoch: '3', authorized_revision: 'b'.repeat(40) }, 'revision_mismatch'],
    ] as const;
    for (const [row, reason] of cases) {
      const { handle } = handleWithRows([row]);
      await expect(resolveOptimizerPreviewReadiness(handle, enabledEnv)).resolves.toEqual({
        ready: false, reason,
      });
    }

    const { handle } = handleWithRows([{
      protocol: 'fenced', admission: 'scoped', epoch: '4', authorized_revision: REVISION,
    }]);
    await expect(resolveOptimizerPreviewReadiness(handle, enabledEnv)).resolves.toEqual({ ready: true });
  });

  it('fails closed and sanitizes duplicate, malformed, and unavailable evidence', async () => {
    const invalidRows: readonly (readonly unknown[])[] = [
      [],
      [
        { protocol: 'fenced', admission: 'scoped', epoch: 1, authorized_revision: REVISION },
        { protocol: 'fenced', admission: 'scoped', epoch: 1, authorized_revision: REVISION },
      ],
      [{ protocol: 'fenced', admission: 'scoped', epoch: 'NaN', authorized_revision: REVISION }],
      [{ protocol: 'future', admission: 'scoped', epoch: 1, authorized_revision: REVISION }],
      [{ protocol: 'fenced', admission: 'future', epoch: 1, authorized_revision: REVISION }],
      [{ protocol: 'fenced', admission: 'scoped', epoch: 1, authorized_revision: 'not-a-revision' }],
    ];
    for (const rows of invalidRows) {
      const { handle } = handleWithRows(rows);
      await expect(resolveOptimizerPreviewReadiness(handle, enabledEnv)).resolves.toEqual({
        ready: false, reason: 'authority_unavailable',
      });
    }

    const sql = vi.fn(async () => { throw new Error(`database leaked ${REVISION}`); });
    const handle = { sql: sql as unknown as DbHandle['sql'] };
    await expect(resolveOptimizerPreviewReadiness(handle, enabledEnv)).resolves.toEqual({
      ready: false, reason: 'authority_unavailable',
    });
  });

  it('reads fresh evidence on every enabled resolution', async () => {
    const rows = [{
      protocol: 'fenced', admission: 'scoped', epoch: 1, authorized_revision: REVISION,
    }];
    const { handle, sql } = handleWithRows(rows);
    await resolveOptimizerPreviewReadiness(handle, enabledEnv);
    await resolveOptimizerPreviewReadiness(handle, enabledEnv);
    expect(sql).toHaveBeenCalledTimes(2);
  });

  it('calls the scheduled producer only after fresh exact evidence', async () => {
    const enqueue = vi.fn(async () => 2);
    const blocked = handleWithRows([{
      protocol: 'fenced', admission: 'blocked', epoch: 2, authorized_revision: REVISION,
    }]);
    await expect(enqueueRecommendationSchedulesIfReady(
      blocked.handle, enqueue, enabledEnv,
    )).resolves.toBe(0);
    expect(enqueue).not.toHaveBeenCalled();

    const ready = handleWithRows([{
      protocol: 'fenced', admission: 'scoped', epoch: 3, authorized_revision: REVISION,
    }]);
    await expect(enqueueRecommendationSchedulesIfReady(
      ready.handle, enqueue, enabledEnv,
    )).resolves.toBe(2);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
