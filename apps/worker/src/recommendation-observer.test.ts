import type { DbHandle } from '@wizard-ads/db';
import { describe, expect, it, vi } from 'vitest';
import {
  RecommendationObservationPass,
  type RecommendationObservationReconcileCounts,
} from './recommendation-observer.js';

const emptyCounts: RecommendationObservationReconcileCounts = {
  scanned: 0,
  evaluated: 0,
  inserted: 0,
  unchanged: 0,
  refused: 0,
  refusalReasons: {},
};

describe('RecommendationObservationPass', () => {
  it('contains a reconciliation failure so the always-on worker remains available', async () => {
    const error = vi.fn();
    const pass = new RecommendationObservationPass(
      {} as DbHandle,
      { info: vi.fn(), error },
      60_000,
      async () => { throw new Error('synthetic database failure'); },
    );

    await expect(pass.runOnce()).resolves.toBeNull();
    expect(error).toHaveBeenCalledWith(
      'Recommendation observation reconciliation failed',
      { error: 'synthetic database failure' },
    );
  });

  it('refuses overlapping passes instead of evaluating the same bounded page concurrently', async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const reconcile = vi.fn(async () => {
      await blocked;
      return emptyCounts;
    });
    const pass = new RecommendationObservationPass(
      {} as DbHandle,
      { info: vi.fn(), error: vi.fn() },
      60_000,
      reconcile,
    );

    const first = pass.runOnce();
    await expect(pass.runOnce()).resolves.toBeNull();
    release?.();
    await expect(first).resolves.toEqual(emptyCounts);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});
