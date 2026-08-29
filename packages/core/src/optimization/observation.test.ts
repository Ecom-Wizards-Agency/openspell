import {
  OptimizationGroup,
  OptimizationRunContext,
  RecommendationObservation,
} from '@wizard-ads/shared';
import { describe, expect, it } from 'vitest';
import {
  evaluateRecommendationEvidence,
  type EvaluateRecommendationEvidenceRequest,
} from './observation.js';

const ORG_ID = '00000000-0000-4000-8000-000000000101';
const PROFILE_ID = '00000000-0000-4000-8000-000000000102';
const GROUP_ID = '00000000-0000-4000-8000-000000000103';
const RUN_ID = '00000000-0000-4000-8000-000000000104';
const RECOMMENDATION_ID = '00000000-0000-4000-8000-000000000105';
const PRIOR_RECOMMENDATION_ID = '00000000-0000-4000-8000-000000000106';

const group = OptimizationGroup.parse({
  id: GROUP_ID,
  orgId: ORG_ID,
  profileId: PROFILE_ID,
  name: 'Synthetic evidence group',
  role: 'profit',
  targetAcos: 0.2,
  bidFloor: 0.1,
  bidCeiling: 4,
  bidIncreaseCap: 0.5,
  bidDecreaseCap: 0.5,
  placementIncreaseCap: 0.5,
  placementDecreaseCap: 0.5,
  exclusions: [],
  cadence: 'synthetic cadence',
  prioritization: 'balanced',
  enabled: true,
});

const context = OptimizationRunContext.parse({
  runId: RUN_ID,
  profileId: PROFILE_ID,
  groupId: GROUP_ID,
  groupRole: 'profit',
  groupSnapshot: group,
  dueAt: '2026-08-20T00:00:00Z',
  windowStart: '2026-07-20',
  windowEnd: '2026-08-19',
});

function request(
  overrides: Partial<EvaluateRecommendationEvidenceRequest> = {},
): EvaluateRecommendationEvidenceRequest {
  return {
    context,
    seed: {
      recommendationId: RECOMMENDATION_ID,
      priorRecommendationId: PRIOR_RECOMMENDATION_ID,
      groupId: GROUP_ID,
      expectedValue: 1.01,
      synchronizedValue: 1.01,
      synchronizedAt: '2026-08-21T00:00:00Z',
      observationWindowStart: '2026-08-21',
      observationWindowEnd: '2026-08-27',
    },
    preChangeValue: 0.97,
    settledThrough: '2026-08-27',
    matchedPairs: [
      { matchKey: 'synthetic-a', preIncrementalVolume: 4, postIncrementalVolume: 6 },
      { matchKey: 'synthetic-b', preIncrementalVolume: 6, postIncrementalVolume: 7 },
    ],
    policy: {
      synchronizationTolerance: 0.001,
      minimumMatchedPairs: 2,
      minimumCombinedIncrementalVolume: 5,
      minimumAbsoluteLift: 1,
      minimumRelativeLift: 0.1,
    },
    ...overrides,
  };
}

describe('stateful recommendation evidence', () => {
  it('holds without synchronization and never compounds', () => {
    const input = request({
      seed: {
        ...request().seed,
        synchronizedValue: null,
        synchronizedAt: null,
      },
    });
    const result = evaluateRecommendationEvidence(input);

    expect(result.classification).toBe('not_synchronized');
    expect(result.observation.evidenceState).toBe('awaiting_sync');
    expect(result.observation.decision).toBe('hold');
    expect(result.mayCompound).toBe(false);
    expect(result.revertToValue).toBeNull();
    expect(result.observation.preIncrementalVolume).toBeNull();
  });

  it('holds when synchronized history conflicts with the exported value', () => {
    const result = evaluateRecommendationEvidence(
      request({
        seed: {
          ...request().seed,
          synchronizedValue: 1.03,
        },
      }),
    );

    expect(result.classification).toBe('synchronization_conflict');
    expect(result.observation).toMatchObject({ evidenceState: 'conflict', decision: 'hold' });
    expect(result.mayCompound).toBe(false);
  });

  it('holds while the post-change evidence window is not settled', () => {
    const result = evaluateRecommendationEvidence(
      request({ settledThrough: '2026-08-26' }),
    );

    expect(result.classification).toBe('observation_incomplete');
    expect(result.observation).toMatchObject({ evidenceState: 'observing', decision: 'hold' });
    expect(result.provenance).toMatchObject({
      suppliedPairCount: 2,
      evaluatedPairCount: 0,
      matchedPairCount: 0,
    });
    expect(result.mayCompound).toBe(false);
  });

  it('holds when a complete window does not pass the tenant evidence gates', () => {
    const result = evaluateRecommendationEvidence(
      request({
        matchedPairs: [
          { matchKey: 'synthetic-a', preIncrementalVolume: 0.2, postIncrementalVolume: 0.4 },
        ],
      }),
    );

    expect(result.classification).toBe('evidence_insufficient');
    expect(result.observation).toMatchObject({ evidenceState: 'insufficient', decision: 'hold' });
    expect(result.provenance).toMatchObject({
      suppliedPairCount: 1,
      evaluatedPairCount: 1,
      matchedPairCount: 1,
      preIncrementalVolume: 0.2,
      postIncrementalVolume: 0.4,
    });
    expect(result.mayCompound).toBe(false);
  });

  it('continues only when complete matched evidence supports lift', () => {
    const result = evaluateRecommendationEvidence(request());

    expect(result.classification).toBe('supported_lift');
    expect(result.observation).toMatchObject({
      evidenceState: 'complete',
      decision: 'continue',
      preIncrementalVolume: 10,
      postIncrementalVolume: 13,
    });
    expect(result.provenance).toMatchObject({
      absoluteLift: 3,
      relativeLift: 0.3,
    });
    expect(result.context).toBe(context);
    expect(result.mayCompound).toBe(true);
    expect(result.revertToValue).toBeNull();
    expect(() => RecommendationObservation.parse(result.observation)).not.toThrow();
  });

  it('proposes the exact pre-change value after a complete no-lift window', () => {
    const result = evaluateRecommendationEvidence(
      request({
        matchedPairs: [
          { matchKey: 'synthetic-a', preIncrementalVolume: 4, postIncrementalVolume: 3 },
          { matchKey: 'synthetic-b', preIncrementalVolume: 6, postIncrementalVolume: 6 },
        ],
      }),
    );

    expect(result.classification).toBe('complete_no_lift');
    expect(result.observation).toMatchObject({
      evidenceState: 'complete',
      decision: 'revert',
      preIncrementalVolume: 10,
      postIncrementalVolume: 9,
    });
    expect(result.mayCompound).toBe(false);
    expect(result.revertToValue).toBe(0.97);
    expect(result.observation.evidenceNote).toContain('propose reverting to the pre-change value');
  });

  it('can support lift from a zero baseline only when positive absolute lift clears policy', () => {
    const result = evaluateRecommendationEvidence(
      request({
        matchedPairs: [
          { matchKey: 'synthetic-a', preIncrementalVolume: 0, postIncrementalVolume: 2 },
          { matchKey: 'synthetic-b', preIncrementalVolume: 0, postIncrementalVolume: 4 },
        ],
      }),
    );

    expect(result.classification).toBe('supported_lift');
    expect(result.provenance.relativeLift).toBeNull();
  });

  it('rejects mismatched group context rather than losing provenance', () => {
    expect(() =>
      evaluateRecommendationEvidence(
        request({
          seed: {
            ...request().seed,
            groupId: '00000000-0000-4000-8000-000000000199',
          },
        }),
      ),
    ).toThrow('does not match the run context');
  });

  it('rejects duplicate matched keys rather than double-counting volume', () => {
    expect(() =>
      evaluateRecommendationEvidence(
        request({
          matchedPairs: [
            { matchKey: 'same', preIncrementalVolume: 1, postIncrementalVolume: 2 },
            { matchKey: 'same', preIncrementalVolume: 1, postIncrementalVolume: 2 },
          ],
        }),
      ),
    ).toThrow('duplicate matched pair key');
  });

  it('has no apply or Amazon-write capability in its result', () => {
    const result = evaluateRecommendationEvidence(request());
    expect(Object.keys(result).sort()).toEqual([
      'classification',
      'context',
      'mayCompound',
      'observation',
      'provenance',
      'revertToValue',
    ]);
    expect('apply' in result).toBe(false);
    expect('amazonWrite' in result).toBe(false);
  });
});
