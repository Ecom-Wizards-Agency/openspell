import { createHash } from 'node:crypto';
import type { WebRevisionSource } from '../revision';
import {
  CANDIDATE_ARTIFACT_IDS,
  CANDIDATE_CHECK_ORDER,
  CANDIDATE_FAILURE_REASONS,
  type CandidateArtifactId,
  type CandidateCheckId,
  type CandidateCheckResult,
  type CandidateFailureReason,
  type ObservedCandidateRevision,
} from './candidate-artifacts';

const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const CHECK_IDS = new Set<string>(CANDIDATE_CHECK_ORDER);
const FAILURE_REASONS = new Set<string>(CANDIDATE_FAILURE_REASONS);
const ARTIFACT_IDS = new Set<string>(CANDIDATE_ARTIFACT_IDS);
const CHECK_KEYS = new Set(['id', 'verdict', 'reason', 'missingArtifacts']);

export interface PublicCandidateCheck {
  readonly id: CandidateCheckId;
  readonly verdict: 'pass' | 'fail' | 'not-run';
  readonly reason?: CandidateFailureReason;
  readonly missingArtifacts?: readonly CandidateArtifactId[];
}

export interface PublicReleaseEvidenceV1 {
  readonly schema: 'openspell.release-evidence/v1';
  readonly purpose: 'verification-only';
  readonly authorization: 'none';
  readonly verdict: 'pass' | 'fail';
  readonly candidateOriginSha256: `sha256:${string}`;
  readonly revision: {
    readonly expected: string;
    readonly observed: string;
    readonly source: WebRevisionSource;
  };
  readonly checks: readonly PublicCandidateCheck[];
}

/** Build the only persistent projection of private candidate observations. */
export function releaseEvidence(input: {
  readonly candidate: URL;
  readonly expectedRevision: string;
  readonly observedRevision: ObservedCandidateRevision;
  readonly checks: readonly CandidateCheckResult[];
}): PublicReleaseEvidenceV1 {
  if (!FULL_GIT_SHA.test(input.expectedRevision)) {
    throw new Error('invalid_expected_revision');
  }
  if (
    input.observedRevision.observed !== 'unknown'
    && !FULL_GIT_SHA.test(input.observedRevision.observed)
  ) {
    throw new Error('invalid_observed_revision');
  }
  if (!['vercel', 'explicit', 'unknown'].includes(input.observedRevision.source)) {
    throw new Error('invalid_revision_source');
  }
  const supplied = new Map<CandidateCheckId, CandidateCheckResult>();
  for (const rawCheck of input.checks) {
    const check = validatedCandidateCheck(rawCheck);
    if (supplied.has(check.id)) throw new Error('duplicate_candidate_check');
    supplied.set(check.id, check);
  }
  const checks = CANDIDATE_CHECK_ORDER.map((id): PublicCandidateCheck => {
    const check = supplied.get(id);
    if (check === undefined) return { id, verdict: 'not-run' };
    if (check.verdict !== 'fail') return { id, verdict: check.verdict };
    if (check.reason === undefined) throw new Error('missing_candidate_failure_reason');
    return check.missingArtifacts === undefined || check.missingArtifacts.length === 0
      ? { id, verdict: 'fail', reason: check.reason }
      : {
          id,
          verdict: 'fail',
          reason: check.reason,
          missingArtifacts: Array.from(new Set(check.missingArtifacts)).sort(),
        };
  });
  const revisionMatches = input.observedRevision.source === 'vercel'
    && input.observedRevision.observed === input.expectedRevision;
  const allChecksPassed = checks.every((check) => check.verdict === 'pass');
  return {
    schema: 'openspell.release-evidence/v1',
    purpose: 'verification-only',
    authorization: 'none',
    verdict: revisionMatches && allChecksPassed ? 'pass' : 'fail',
    candidateOriginSha256: candidateOriginSha256(input.candidate),
    revision: {
      expected: input.expectedRevision,
      observed: input.observedRevision.observed,
      source: input.observedRevision.source,
    },
    checks,
  };
}

function validatedCandidateCheck(value: unknown): CandidateCheckResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid_candidate_check');
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !CHECK_KEYS.has(key))) {
    throw new Error('invalid_candidate_check');
  }
  if (typeof raw['id'] !== 'string' || !CHECK_IDS.has(raw['id'])) {
    throw new Error('invalid_candidate_check');
  }
  const id = raw['id'] as CandidateCheckId;
  if (raw['verdict'] === 'pass' || raw['verdict'] === 'not-run') {
    if (raw['reason'] !== undefined || raw['missingArtifacts'] !== undefined) {
      throw new Error('invalid_candidate_check');
    }
    return { id, verdict: raw['verdict'] };
  }
  if (
    raw['verdict'] !== 'fail'
    || typeof raw['reason'] !== 'string'
    || !FAILURE_REASONS.has(raw['reason'])
  ) {
    throw new Error('invalid_candidate_check');
  }
  const reason = raw['reason'] as CandidateFailureReason;
  if (raw['missingArtifacts'] === undefined) return { id, verdict: 'fail', reason };
  if (
    reason !== 'artifact_missing'
    || !Array.isArray(raw['missingArtifacts'])
    || raw['missingArtifacts'].some(
      (artifact) => typeof artifact !== 'string' || !ARTIFACT_IDS.has(artifact),
    )
  ) {
    throw new Error('invalid_candidate_check');
  }
  return {
    id,
    verdict: 'fail',
    reason,
    missingArtifacts: raw['missingArtifacts'] as CandidateArtifactId[],
  };
}

export function serializeReleaseEvidence(input: {
  readonly candidate: URL;
  readonly expectedRevision: string;
  readonly observedRevision: ObservedCandidateRevision;
  readonly checks: readonly CandidateCheckResult[];
}): string {
  return JSON.stringify(releaseEvidence(input), null, 2);
}

function candidateOriginSha256(candidate: URL): `sha256:${string}` {
  const digest = createHash('sha256')
    .update('openspell.release-candidate-origin.v1\0', 'utf8')
    .update(candidate.origin, 'utf8')
    .digest('hex');
  return `sha256:${digest}`;
}
