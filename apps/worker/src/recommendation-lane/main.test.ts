import { describe, expect, it } from 'vitest';
import { RecommendationClaimantCustodyError } from './claimant.js';
import { RecommendationLaneUnsafeExitError, recommendationLaneExitCode } from './main.js';

describe('recommendation lane process exit policy', () => {
  it('prevents automatic restart for custody and authority states needing attendance', () => {
    expect(recommendationLaneExitCode(
      new RecommendationClaimantCustodyError('settlement_ambiguous'),
    )).toBe(78);
    expect(recommendationLaneExitCode(
      new RecommendationLaneUnsafeExitError('authority_mismatch'),
    )).toBe(78);
    expect(recommendationLaneExitCode(
      new RecommendationLaneUnsafeExitError('unresolved_custody'),
    )).toBe(78);
  });

  it('allows systemd to restart ordinary transient failures', () => {
    expect(recommendationLaneExitCode(new Error('synthetic transient failure'))).toBe(1);
    expect(recommendationLaneExitCode(null)).toBe(1);
  });
});
