import {
  ContextualNegativeArtifactIntegrityError,
  ContextualNegativeReviewConflictError,
  ContextualNegativeReviewLockTimeoutError,
  ContextualNegativeReviewStateError,
} from '@wizard-ads/db';

export function contextualNegativeReviewErrorResponse(error: unknown): Response | null {
  if (error instanceof ContextualNegativeArtifactIntegrityError) {
    return Response.json({
      error: 'Stored contextual-negative evidence failed integrity verification',
      amazonUpdated: false,
    }, { status: 500 });
  }
  if (
    error instanceof ContextualNegativeReviewConflictError
    || error instanceof ContextualNegativeReviewStateError
    || error instanceof ContextualNegativeReviewLockTimeoutError
  ) {
    return Response.json({
      error: error.message,
      reloadRequired: true,
      ...('proposalIds' in error ? { staleProposalIds: error.proposalIds } : {}),
      amazonUpdated: false,
    }, { status: 409 });
  }
  return null;
}
