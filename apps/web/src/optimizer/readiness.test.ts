/**
 * The web re-export of the recommendation readiness decisions. The exhaustive
 * authority-state matrix lives in `packages/db`; this file pins what the web
 * routes and cron door see through this module.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DbHandle } from '@wizard-ads/db';
import {
  OPTIMIZER_PREVIEW_UNAVAILABLE_MESSAGE,
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

const legacyRow = { protocol: 'legacy', admission: 'legacy', epoch: '0', authorized_revision: null };
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

describe('optimizer preview readiness through the web module', () => {
  it('keeps the operator-facing refusal copy stable', () => {
    expect(OPTIMIZER_PREVIEW_UNAVAILABLE_MESSAGE).toBe(
      'Recommendation previews are temporarily unavailable.',
    );
  });

  it('falls back to legacy mode from fresh legacy authority while intent is unset or 0', async () => {
    for (const env of [{}, { OPENSPELL_RECOMMENDATION_LANE_READY: '0' }]) {
      const { handle, sql } = handleWithRows([legacyRow]);
      await expect(resolveOptimizerPreviewReadiness(handle, env)).resolves.toEqual({
        ready: true, mode: 'legacy',
      });
      expect(sql).toHaveBeenCalledTimes(1);
    }
  });

  it('fails closed with a reason when the flag is unset but the database has already cut over', async () => {
    const { handle } = handleWithRows([{
      protocol: 'fenced', admission: 'scoped', epoch: '4', authorized_revision: REVISION,
    }]);
    await expect(resolveOptimizerPreviewReadiness(handle, {})).resolves.toEqual({
      ready: false, reason: 'authority_not_legacy',
    });
    const blocked = handleWithRows([{ ...legacyRow, admission: 'blocked' }]);
    await expect(resolveOptimizerPreviewReadiness(blocked.handle, {})).resolves.toEqual({
      ready: false, reason: 'admission_not_legacy',
    });
  });

  it('is misconfigured without database work for a malformed environment', async () => {
    const { handle, sql } = handleWithRows([legacyRow]);
    await expect(resolveOptimizerPreviewReadiness(handle, {
      OPENSPELL_RECOMMENDATION_LANE_READY: '1',
    })).resolves.toEqual({ ready: false, reason: 'misconfigured' });
    expect(sql).not.toHaveBeenCalled();
  });

  it('requires fenced, scoped authority at the exact expected revision when intent is 1', async () => {
    const cases = [
      [legacyRow, 'authority_not_fenced'],
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
    await expect(resolveOptimizerPreviewReadiness(handle, enabledEnv)).resolves.toEqual({
      ready: true, mode: 'fenced',
    });
  });

  it('fails closed and sanitizes duplicate, malformed, and unavailable evidence in both modes', async () => {
    const invalidRows: readonly (readonly unknown[])[] = [
      [],
      [legacyRow, legacyRow],
      [{ ...legacyRow, epoch: 'NaN' }],
      [{ ...legacyRow, protocol: 'future' }],
      [{ ...legacyRow, admission: 'future' }],
      [{ ...legacyRow, authorized_revision: 'not-a-revision' }],
    ];
    for (const env of [{}, enabledEnv]) {
      for (const rows of invalidRows) {
        const { handle } = handleWithRows(rows);
        await expect(resolveOptimizerPreviewReadiness(handle, env)).resolves.toEqual({
          ready: false, reason: 'authority_unavailable',
        });
      }
      const sql = vi.fn(async () => { throw new Error(`database leaked ${REVISION}`); });
      const handle = { sql: sql as unknown as DbHandle['sql'] };
      await expect(resolveOptimizerPreviewReadiness(handle, env)).resolves.toEqual({
        ready: false, reason: 'authority_unavailable',
      });
    }
  });

  it('gives the cron scheduler no admission from legacy authority', async () => {
    const enqueue = vi.fn(async () => 2);
    const legacy = handleWithRows([legacyRow]);
    await expect(enqueueRecommendationSchedulesIfReady(legacy.handle, enqueue, {})).resolves.toBe(0);
    expect(legacy.sql).not.toHaveBeenCalled();
    await expect(enqueueRecommendationSchedulesIfReady(legacy.handle, enqueue, enabledEnv)).resolves.toBe(0);
    expect(enqueue).not.toHaveBeenCalled();

    const ready = handleWithRows([{
      protocol: 'fenced', admission: 'scoped', epoch: 3, authorized_revision: REVISION,
    }]);
    await expect(enqueueRecommendationSchedulesIfReady(ready.handle, enqueue, enabledEnv)).resolves.toBe(2);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
