import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CANDIDATE_CHECK_ORDER, type CandidateCheckResult } from './candidate-artifacts';
import { releaseEvidence, serializeReleaseEvidence } from './release-evidence';

const CANDIDATE = new URL('https://wizard-private-synthetic-ecom-wizards.vercel.app');
const OTHER_CANDIDATE = new URL('https://wizard-other-synthetic-ecom-wizards.vercel.app');
const REVISION = '1234567890abcdef1234567890abcdef12345678';
const PASSED = CANDIDATE_CHECK_ORDER.map((id): CandidateCheckResult => ({
  id,
  verdict: 'pass',
}));

describe('public release evidence', () => {
  it('projects one deterministic non-authorizing document in fixed policy order', () => {
    const input = {
      candidate: CANDIDATE,
      expectedRevision: REVISION,
      observedRevision: { observed: REVISION, source: 'vercel' as const },
      checks: [...PASSED].reverse(),
    };
    const first = serializeReleaseEvidence(input);
    const second = serializeReleaseEvidence(input);
    const parsed = JSON.parse(first) as Record<string, unknown>;
    const expectedOriginDigest = createHash('sha256')
      .update('openspell.release-candidate-origin.v1\0')
      .update(CANDIDATE.origin)
      .digest('hex');

    expect(first).toBe(second);
    expect(parsed).toMatchObject({
      schema: 'openspell.release-evidence/v1',
      purpose: 'verification-only',
      authorization: 'none',
      verdict: 'pass',
      candidateOriginSha256: `sha256:${expectedOriginDigest}`,
      revision: { expected: REVISION, observed: REVISION, source: 'vercel' },
    });
    expect((parsed['checks'] as Array<{ id: string }>).map((check) => check.id))
      .toEqual(CANDIDATE_CHECK_ORDER);
    expect(first).not.toContain(CANDIDATE.hostname);
    expect(first).not.toContain(CANDIDATE.href);
  });

  it('emits fixed failures and fills unobserved checks as not-run', () => {
    const evidence = releaseEvidence({
      candidate: CANDIDATE,
      expectedRevision: REVISION,
      observedRevision: { observed: 'unknown', source: 'unknown' },
      checks: [{
        id: 'hosted-revision',
        verdict: 'fail',
        reason: 'artifact_missing',
        missingArtifacts: ['app-shell', 'app-shell'],
      }],
    });
    expect(evidence.verdict).toBe('fail');
    expect(evidence.checks.slice(0, 2)).toEqual([
      {
        id: 'hosted-revision',
        verdict: 'fail',
        reason: 'artifact_missing',
        missingArtifacts: ['app-shell'],
      },
      { id: 'official-brand-svg', verdict: 'not-run' },
    ]);
    expect(evidence.checks.slice(2).every((check) => check.verdict === 'not-run')).toBe(true);
  });

  it('binds the exact origin without exposing supplied private canaries', () => {
    const privateCanaries = [
      ['sb', 'private', 'auth'].join('-'),
      '10000000-0000-4000-8000-000000000001',
      ['private', 'account', 'label'].join('-'),
      'private-response-body',
      '987654 private rows',
      '54321ms',
    ];
    const first = serializeReleaseEvidence({
      candidate: CANDIDATE,
      expectedRevision: REVISION,
      observedRevision: { observed: REVISION, source: 'vercel' },
      checks: PASSED,
    });
    const second = serializeReleaseEvidence({
      candidate: OTHER_CANDIDATE,
      expectedRevision: REVISION,
      observedRevision: { observed: REVISION, source: 'vercel' },
      checks: PASSED,
    });

    for (const canary of privateCanaries) expect(first).not.toContain(canary);
    expect(JSON.parse(first).candidateOriginSha256)
      .not.toBe(JSON.parse(second).candidateOriginSha256);
  });

  it('rejects duplicate check construction', () => {
    expect(() => releaseEvidence({
      candidate: CANDIDATE,
      expectedRevision: REVISION,
      observedRevision: { observed: REVISION, source: 'vercel' },
      checks: [PASSED[0]!, PASSED[0]!],
    })).toThrow('duplicate_candidate_check');
  });

  it('rejects unknown failed checks instead of dropping them from a pass', () => {
    const unknown = {
      id: 'unknown-security-check',
      verdict: 'fail',
      reason: 'route_identity',
    };
    expect(() => releaseEvidence({
      candidate: CANDIDATE,
      expectedRevision: REVISION,
      observedRevision: { observed: REVISION, source: 'vercel' },
      checks: [...PASSED, unknown] as CandidateCheckResult[],
    })).toThrow('invalid_candidate_check');
  });

  it('rejects arbitrary public reason and artifact values', () => {
    const privateCanary = ['private', 'report', 'value'].join('-');
    for (const check of [
      { id: 'campaign-grid', verdict: 'fail', reason: privateCanary },
      {
        id: 'campaign-grid',
        verdict: 'fail',
        reason: 'artifact_missing',
        missingArtifacts: [privateCanary],
      },
    ]) {
      expect(() => releaseEvidence({
        candidate: CANDIDATE,
        expectedRevision: REVISION,
        observedRevision: { observed: REVISION, source: 'vercel' },
        checks: [check] as never,
      })).toThrow('invalid_candidate_check');
    }
  });

  it('cannot pass with a mismatched, malformed, or non-Vercel revision', () => {
    for (const observedRevision of [
      { observed: 'abcdef1234567890abcdef1234567890abcdef12', source: 'vercel' as const },
      { observed: REVISION, source: 'explicit' as const },
      { observed: 'unknown', source: 'unknown' as const },
    ]) {
      expect(releaseEvidence({
        candidate: CANDIDATE,
        expectedRevision: REVISION,
        observedRevision,
        checks: PASSED,
      }).verdict).toBe('fail');
    }
    expect(() => releaseEvidence({
      candidate: CANDIDATE,
      expectedRevision: 'malformed',
      observedRevision: { observed: REVISION, source: 'vercel' },
      checks: PASSED,
    })).toThrow('invalid_expected_revision');
    expect(() => releaseEvidence({
      candidate: CANDIDATE,
      expectedRevision: REVISION,
      observedRevision: { observed: 'malformed', source: 'vercel' },
      checks: PASSED,
    })).toThrow('invalid_observed_revision');
    expect(() => releaseEvidence({
      candidate: CANDIDATE,
      expectedRevision: REVISION,
      observedRevision: { observed: REVISION, source: 'other' as never },
      checks: PASSED,
    })).toThrow('invalid_revision_source');
  });
});
