import { describe, expect, it } from 'vitest';
import { RecommendationPopulation } from './recommendations.js';

describe('recommendation population', () => {
  it('distinguishes empty, complete and capped populations', () => {
    for (const value of [
      { loaded: 0, total: 0, limit: 2, truncated: false },
      { loaded: 2, total: 2, limit: 2, truncated: false },
      { loaded: 2, total: 3, limit: 2, truncated: true },
    ]) expect(RecommendationPopulation.parse(value)).toEqual(value);
  });

  it('refuses silent loss, contradictory completeness and invalid count precision', () => {
    const valid = { loaded: 2, total: 3, limit: 2, truncated: true };
    for (const patch of [
      { loaded: 1 }, { total: 1 }, { truncated: false }, { loaded: 3 },
      { total: Number.MAX_SAFE_INTEGER + 1 }, { total: Infinity }, { loaded: 1.5 },
      { limit: 0 }, { limit: 20_001 },
    ]) expect(RecommendationPopulation.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});
