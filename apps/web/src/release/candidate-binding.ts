export type CandidateBindingReason =
  | 'matched'
  | 'request_failed'
  | 'invalid_response'
  | 'candidate_mismatch'
  | 'project_mismatch'
  | 'owner_mismatch'
  | 'not_ready';

export interface CandidateBindingCheck {
  passed: boolean;
  reason: CandidateBindingReason;
}

export function inspectCandidateBinding(input: {
  exitCode: number | null;
  status: number | null;
  responseBody: string;
  candidateHostname: string;
  projectId: string;
  orgId: string;
}): CandidateBindingCheck {
  if (input.exitCode !== 0 || input.status !== 200) {
    return { passed: false, reason: 'request_failed' };
  }
  let value: unknown;
  try {
    value = JSON.parse(input.responseBody);
  } catch {
    return { passed: false, reason: 'invalid_response' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { passed: false, reason: 'invalid_response' };
  }
  const deployment = value as Record<string, unknown>;
  if (deployment['url'] !== input.candidateHostname) {
    return { passed: false, reason: 'candidate_mismatch' };
  }
  if (deployment['projectId'] !== input.projectId) {
    return { passed: false, reason: 'project_mismatch' };
  }
  if (deployment['ownerId'] !== input.orgId) {
    return { passed: false, reason: 'owner_mismatch' };
  }
  if (deployment['readyState'] !== 'READY') {
    return { passed: false, reason: 'not_ready' };
  }
  return { passed: true, reason: 'matched' };
}
