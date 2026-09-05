/** Sanitized application failures contain no SQL text, provider response or tenant data. */
export class SpWriteApplicationError extends Error {
  constructor(readonly code:
    | 'not_found' | 'invalid_request' | 'unsupported_source' | 'source_changed'
    | 'identity_conflict' | 'authorization_refused' | 'outcome_unknown') {
    super(`SP write application refused: ${code}`);
    this.name = 'SpWriteApplicationError';
  }
}
