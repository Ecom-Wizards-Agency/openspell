import { describe, expect, it, vi } from 'vitest';
import {
  inspectCandidateRevision,
  requiredExpectedRevision,
  runRevisionFirstGate,
  type CandidateRevisionCheck,
} from './candidate-revision';

const EXPECTED = 'd'.repeat(40);
const DIFFERENT = 'e'.repeat(40);

function health(revision: unknown): string {
  return JSON.stringify({ product: 'OpenSpell', status: 'ready', revision });
}

describe('release candidate revision verification', () => {
  it('requires an explicit full commit SHA and normalizes case', () => {
    expect(requiredExpectedRevision(EXPECTED.toUpperCase())).toBe(EXPECTED);
    expect(() => requiredExpectedRevision(undefined)).toThrow('expected full 40-character');
    expect(() => requiredExpectedRevision(EXPECTED.slice(0, 12))).toThrow('expected full 40-character');
  });

  it('accepts only the exact expected deployed revision', () => {
    expect(inspectCandidateRevision(0, 200, health(EXPECTED), EXPECTED)).toMatchObject({
      passed: true,
      reason: 'matched',
      observedRevision: EXPECTED,
    });
    expect(inspectCandidateRevision(0, 200, health(DIFFERENT), EXPECTED)).toMatchObject({
      passed: false,
      reason: 'mismatched_revision',
      observedRevision: DIFFERENT,
    });
  });

  it('distinguishes missing and malformed deployed revisions', () => {
    expect(inspectCandidateRevision(0, 200, health(null), EXPECTED)).toMatchObject({
      passed: false,
      reason: 'missing_revision',
    });
    expect(inspectCandidateRevision(0, 200, health('release-label'), EXPECTED)).toMatchObject({
      passed: false,
      reason: 'malformed_revision',
    });
    expect(inspectCandidateRevision(0, 200, health(123), EXPECTED)).toMatchObject({
      passed: false,
      reason: 'malformed_revision',
    });
  });

  it('refuses invalid product, status, response, request, or HTTP state', () => {
    expect(inspectCandidateRevision(0, 200, '{', EXPECTED).reason).toBe('invalid_response');
    expect(inspectCandidateRevision(0, 200, JSON.stringify({
      product: 'Another product', status: 'ready', revision: EXPECTED,
    }), EXPECTED).reason).toBe('invalid_response');
    expect(inspectCandidateRevision(1, 200, health(EXPECTED), EXPECTED).reason).toBe('request_failed');
    expect(inspectCandidateRevision(0, 404, health(EXPECTED), EXPECTED).reason).toBe('request_failed');
  });

  it.each(['missing_revision', 'malformed_revision', 'mismatched_revision'] as const)(
    'stops before route QA when revision verification reports %s',
    async (reason) => {
      const checkRoutes = vi.fn(async () => [{ passed: true }]);
      const revision: CandidateRevisionCheck = {
        passed: false,
        reason,
        status: 200,
        expectedRevision: EXPECTED,
        observedRevision: reason === 'mismatched_revision' ? DIFFERENT : null,
      };

      const result = await runRevisionFirstGate({
        checkRevision: async () => revision,
        checkRoutes,
        routePassed: (route) => route.passed,
      });

      expect(checkRoutes).not.toHaveBeenCalled();
      expect(result).toEqual({ passed: false, revision, routes: [] });
    },
  );

  it('runs route QA only after the exact revision passes', async () => {
    const checkRoutes = vi.fn(async () => [{ passed: true }, { passed: false }]);
    const revision = inspectCandidateRevision(0, 200, health(EXPECTED), EXPECTED);

    const result = await runRevisionFirstGate({
      checkRevision: async () => revision,
      checkRoutes,
      routePassed: (route) => route.passed,
    });

    expect(checkRoutes).toHaveBeenCalledOnce();
    expect(result.passed).toBe(false);
    expect(result.routes).toHaveLength(2);
  });
});
