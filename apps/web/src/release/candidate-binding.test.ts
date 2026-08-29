import { describe, expect, it } from 'vitest';
import { inspectCandidateBinding } from './candidate-binding';

const BASE = {
  exitCode: 0,
  status: 200,
  candidateHostname: 'wizard-ads-preview-123.vercel.app',
  projectId: 'project-synthetic',
  orgId: 'org-synthetic',
};

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    url: BASE.candidateHostname,
    projectId: BASE.projectId,
    ownerId: BASE.orgId,
    target: 'production',
    readyState: 'READY',
    ...overrides,
  });
}

describe('immutable candidate metadata binding', () => {
  it('accepts only the configured ready deployment', () => {
    expect(inspectCandidateBinding({ ...BASE, responseBody: body() })).toEqual({
      passed: true, reason: 'matched',
    });
  });

  it.each([
    [{ url: 'wizard-ads-other.vercel.app' }, 'candidate_mismatch'],
    [{ projectId: 'different-project' }, 'project_mismatch'],
    [{ ownerId: 'different-owner' }, 'owner_mismatch'],
    [{ target: 'preview' }, 'target_mismatch'],
    [{ readyState: 'BUILDING' }, 'not_ready'],
  ] as const)('rejects metadata mismatch %#', (override, reason) => {
    expect(inspectCandidateBinding({ ...BASE, responseBody: body(override) })).toEqual({
      passed: false, reason,
    });
  });

  it('rejects redirects and malformed metadata', () => {
    expect(inspectCandidateBinding({ ...BASE, status: 307, responseBody: body() }).reason)
      .toBe('request_failed');
    expect(inspectCandidateBinding({ ...BASE, responseBody: '{' }).reason)
      .toBe('invalid_response');
  });
});
