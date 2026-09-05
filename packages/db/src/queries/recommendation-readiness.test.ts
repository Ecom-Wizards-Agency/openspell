/**
 * Readiness decisions for the recommendation producers.
 *
 * Two decisions live here on purpose. A manual "Run preview" may fall back to
 * the legacy producer while the database authority is still legacy; a scheduled
 * producer never may. These tests pin both, with every authority state the
 * `20260901060000` singleton can hold, so that changing the manual route can
 * never activate a second scheduler by accident.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DbHandle } from '../client.js';
import {
  enqueueRecommendationSchedulesIfReady,
  recommendationLaneIntentFromEnv,
  requireValidRecommendationLaneIntent,
  resolveOptimizerPreviewReadiness,
  resolveScheduledRecommendationReadiness,
} from './recommendation-readiness.js';

const REVISION = 'a'.repeat(40);
const OTHER_REVISION = 'b'.repeat(40);

const LEGACY = { protocol: 'legacy', admission: 'legacy', epoch: 0, authorized_revision: null };
const LEGACY_BLOCKED = { protocol: 'legacy', admission: 'blocked', epoch: 1, authorized_revision: null };
const LEGACY_SCOPED = { protocol: 'legacy', admission: 'scoped', epoch: 1, authorized_revision: null };
const FENCED_BLOCKED = { protocol: 'fenced', admission: 'blocked', epoch: 2, authorized_revision: REVISION };
const FENCED_SCOPED = { protocol: 'fenced', admission: 'scoped', epoch: 3, authorized_revision: REVISION };
const FENCED_OTHER = { protocol: 'fenced', admission: 'scoped', epoch: 3, authorized_revision: OTHER_REVISION };

const MALFORMED_ROWS: readonly (readonly unknown[])[] = [
  [],
  [LEGACY, LEGACY],
  [{ ...LEGACY, epoch: 'NaN' }],
  [{ ...LEGACY, epoch: -1 }],
  [{ ...LEGACY, protocol: 'future' }],
  [{ ...LEGACY, admission: 'future' }],
  [{ ...LEGACY, authorized_revision: 'not-a-revision' }],
  [{ ...FENCED_SCOPED, authorized_revision: REVISION.toUpperCase() }],
];

const disabledEnvs: readonly Readonly<Record<string, string | undefined>>[] = [
  {},
  { OPENSPELL_RECOMMENDATION_LANE_READY: '0' },
  { OPENSPELL_RECOMMENDATION_LANE_READY: '0', OPENSPELL_RECOMMENDATION_LANE_REVISION: REVISION },
  { OPENSPELL_RECOMMENDATION_LANE_READY: '0', OPENSPELL_RECOMMENDATION_LANE_REVISION: 'stale' },
];

const enabledEnv = {
  OPENSPELL_RECOMMENDATION_LANE_READY: '1',
  OPENSPELL_RECOMMENDATION_LANE_REVISION: REVISION,
};

const invalidEnvs: readonly Readonly<Record<string, string | undefined>>[] = [
  { OPENSPELL_RECOMMENDATION_LANE_READY: 'true', OPENSPELL_RECOMMENDATION_LANE_REVISION: REVISION },
  { OPENSPELL_RECOMMENDATION_LANE_READY: '1' },
  { OPENSPELL_RECOMMENDATION_LANE_READY: '1', OPENSPELL_RECOMMENDATION_LANE_REVISION: 'a'.repeat(39) },
  { OPENSPELL_RECOMMENDATION_LANE_READY: '1', OPENSPELL_RECOMMENDATION_LANE_REVISION: 'A'.repeat(40) },
  { OPENSPELL_RECOMMENDATION_LANE_READY: ' 1', OPENSPELL_RECOMMENDATION_LANE_REVISION: REVISION },
  { OPENSPELL_RECOMMENDATION_LANE_READY: '', OPENSPELL_RECOMMENDATION_LANE_REVISION: REVISION },
  { OPENSPELL_RECOMMENDATION_LANE_READY: '00' },
];

function handleWithRows(rows: readonly unknown[]): {
  handle: Pick<DbHandle, 'sql'>;
  sql: ReturnType<typeof vi.fn>;
} {
  const sql = vi.fn(async () => rows);
  return { handle: { sql: sql as unknown as DbHandle['sql'] }, sql };
}

function failingHandle(): { handle: Pick<DbHandle, 'sql'>; sql: ReturnType<typeof vi.fn> } {
  const sql = vi.fn(async () => { throw new Error(`database leaked ${REVISION}`); });
  return { handle: { sql: sql as unknown as DbHandle['sql'] }, sql };
}

describe('recommendation lane deployment intent', () => {
  it('is disabled for an absent or exact zero gate regardless of the revision value', () => {
    for (const env of disabledEnvs) {
      expect(recommendationLaneIntentFromEnv(env)).toEqual({ state: 'disabled' });
      expect(requireValidRecommendationLaneIntent(env)).toEqual({ state: 'disabled' });
    }
  });

  it('accepts only exact one with an exact lowercase full object id', () => {
    expect(recommendationLaneIntentFromEnv(enabledEnv)).toEqual({
      state: 'enabled', revision: REVISION,
    });
    for (const env of invalidEnvs) {
      expect(recommendationLaneIntentFromEnv(env)).toEqual({ state: 'invalid' });
      expect(() => requireValidRecommendationLaneIntent(env)).toThrow(/not configured safely/);
    }
  });
});

describe('manual optimizer preview readiness', () => {
  it('admits legacy mode for exactly one legacy/legacy authority row when intent is unset or 0', async () => {
    for (const env of disabledEnvs) {
      const { handle, sql } = handleWithRows([LEGACY]);
      await expect(resolveOptimizerPreviewReadiness(handle, env)).resolves.toEqual({
        ready: true, mode: 'legacy',
      });
      expect(sql).toHaveBeenCalledTimes(1);
    }
    // A string epoch from the driver is the same evidence.
    const { handle } = handleWithRows([{ ...LEGACY, epoch: '0' }]);
    await expect(resolveOptimizerPreviewReadiness(handle, {})).resolves.toEqual({
      ready: true, mode: 'legacy',
    });
  });

  it('fails closed in legacy mode for blocked, scoped and post-cutover authority', async () => {
    const cases = [
      [LEGACY_BLOCKED, 'admission_not_legacy'],
      [LEGACY_SCOPED, 'admission_not_legacy'],
      // Unsetting the flag after activation must never re-open the old lane.
      [FENCED_BLOCKED, 'authority_not_legacy'],
      [FENCED_SCOPED, 'authority_not_legacy'],
      [FENCED_OTHER, 'authority_not_legacy'],
    ] as const;
    for (const env of disabledEnvs) {
      for (const [row, reason] of cases) {
        const { handle } = handleWithRows([row]);
        await expect(resolveOptimizerPreviewReadiness(handle, env)).resolves.toEqual({
          ready: false, reason,
        });
      }
    }
  });

  it('fails closed in legacy mode on unavailable, duplicate or malformed authority', async () => {
    for (const env of disabledEnvs) {
      for (const rows of MALFORMED_ROWS) {
        const { handle } = handleWithRows(rows);
        await expect(resolveOptimizerPreviewReadiness(handle, env)).resolves.toEqual({
          ready: false, reason: 'authority_unavailable',
        });
      }
      const { handle } = failingHandle();
      await expect(resolveOptimizerPreviewReadiness(handle, env)).resolves.toEqual({
        ready: false, reason: 'authority_unavailable',
      });
    }
  });

  it('keeps every fenced refusal and admits fenced mode at the exact revision when intent is 1', async () => {
    const cases = [
      [LEGACY, 'authority_not_fenced'],
      [LEGACY_BLOCKED, 'authority_not_fenced'],
      [LEGACY_SCOPED, 'authority_not_fenced'],
      [FENCED_BLOCKED, 'admission_not_scoped'],
      [FENCED_OTHER, 'revision_mismatch'],
    ] as const;
    for (const [row, reason] of cases) {
      const { handle } = handleWithRows([row]);
      await expect(resolveOptimizerPreviewReadiness(handle, enabledEnv)).resolves.toEqual({
        ready: false, reason,
      });
    }
    for (const rows of MALFORMED_ROWS) {
      const { handle } = handleWithRows(rows);
      await expect(resolveOptimizerPreviewReadiness(handle, enabledEnv)).resolves.toEqual({
        ready: false, reason: 'authority_unavailable',
      });
    }
    await expect(resolveOptimizerPreviewReadiness(failingHandle().handle, enabledEnv)).resolves.toEqual({
      ready: false, reason: 'authority_unavailable',
    });

    const { handle, sql } = handleWithRows([FENCED_SCOPED]);
    await expect(resolveOptimizerPreviewReadiness(handle, enabledEnv)).resolves.toEqual({
      ready: true, mode: 'fenced',
    });
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it('is misconfigured without database work for every invalid environment value', async () => {
    for (const env of invalidEnvs) {
      const { handle, sql } = handleWithRows([LEGACY]);
      await expect(resolveOptimizerPreviewReadiness(handle, env)).resolves.toEqual({
        ready: false, reason: 'misconfigured',
      });
      expect(sql).not.toHaveBeenCalled();
    }
  });

  it('reads fresh evidence on every resolution in both modes', async () => {
    const legacy = handleWithRows([LEGACY]);
    await resolveOptimizerPreviewReadiness(legacy.handle, {});
    await resolveOptimizerPreviewReadiness(legacy.handle, {});
    expect(legacy.sql).toHaveBeenCalledTimes(2);

    const fenced = handleWithRows([FENCED_SCOPED]);
    await resolveOptimizerPreviewReadiness(fenced.handle, enabledEnv);
    await resolveOptimizerPreviewReadiness(fenced.handle, enabledEnv);
    expect(fenced.sql).toHaveBeenCalledTimes(2);
  });
});

describe('scheduled recommendation readiness', () => {
  it('never inherits legacy admission: unset or 0 intent is disabled with no database work', async () => {
    for (const env of disabledEnvs) {
      const { handle, sql } = handleWithRows([LEGACY]);
      await expect(resolveScheduledRecommendationReadiness(handle, env)).resolves.toEqual({
        ready: false, reason: 'disabled',
      });
      expect(sql).not.toHaveBeenCalled();
    }
  });

  it('is misconfigured without database work for every invalid environment value', async () => {
    for (const env of invalidEnvs) {
      const { handle, sql } = handleWithRows([FENCED_SCOPED]);
      await expect(resolveScheduledRecommendationReadiness(handle, env)).resolves.toEqual({
        ready: false, reason: 'misconfigured',
      });
      expect(sql).not.toHaveBeenCalled();
    }
  });

  it('retains the fenced gates when intent is enabled', async () => {
    const cases = [
      [LEGACY, 'authority_not_fenced'],
      [FENCED_BLOCKED, 'admission_not_scoped'],
      [FENCED_OTHER, 'revision_mismatch'],
    ] as const;
    for (const [row, reason] of cases) {
      const { handle } = handleWithRows([row]);
      await expect(resolveScheduledRecommendationReadiness(handle, enabledEnv)).resolves.toEqual({
        ready: false, reason,
      });
    }
    for (const rows of MALFORMED_ROWS) {
      const { handle } = handleWithRows(rows);
      await expect(resolveScheduledRecommendationReadiness(handle, enabledEnv)).resolves.toEqual({
        ready: false, reason: 'authority_unavailable',
      });
    }
    await expect(resolveScheduledRecommendationReadiness(failingHandle().handle, enabledEnv))
      .resolves.toEqual({ ready: false, reason: 'authority_unavailable' });
    await expect(resolveScheduledRecommendationReadiness(handleWithRows([FENCED_SCOPED]).handle, enabledEnv))
      .resolves.toEqual({ ready: true, mode: 'fenced' });
  });

  it('calls the scheduled producer only after fresh exact fenced evidence, never on legacy authority', async () => {
    const enqueue = vi.fn(async () => 2);

    // Legacy authority with disabled intent: the manual route is admitted here,
    // the scheduler must not be, and it must not even consult the database.
    for (const env of disabledEnvs) {
      const legacy = handleWithRows([LEGACY]);
      await expect(enqueueRecommendationSchedulesIfReady(legacy.handle, enqueue, env)).resolves.toBe(0);
      expect(legacy.sql).not.toHaveBeenCalled();
    }
    // Legacy authority with enabled intent is still not fenced.
    const legacyEnabled = handleWithRows([LEGACY]);
    await expect(enqueueRecommendationSchedulesIfReady(legacyEnabled.handle, enqueue, enabledEnv))
      .resolves.toBe(0);
    expect(legacyEnabled.sql).toHaveBeenCalledTimes(1);
    // Fenced but blocked or foreign revision.
    for (const row of [FENCED_BLOCKED, FENCED_OTHER]) {
      await expect(enqueueRecommendationSchedulesIfReady(handleWithRows([row]).handle, enqueue, enabledEnv))
        .resolves.toBe(0);
    }
    expect(enqueue).not.toHaveBeenCalled();

    const ready = handleWithRows([FENCED_SCOPED]);
    await expect(enqueueRecommendationSchedulesIfReady(ready.handle, enqueue, enabledEnv)).resolves.toBe(2);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
