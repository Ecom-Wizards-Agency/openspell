/**
 * Convert an untrusted operational error into an operator-safe category.
 *
 * Database drivers routinely include SQL statements, bind parameters and
 * identifiers in Error.message. Provider responses can contain request IDs or
 * echoed inputs. None of that belongs in HTML or a redirect URL, so this
 * function is intentionally allowlist-based and never interpolates the source.
 */
export function operatorFailureLabel(error: string | null | undefined): string | null {
  if (!error) return null;

  const normalized = error.toLowerCase();
  if (/authorization link expired/.test(normalized)) {
    return 'The authorization link expired. Start the connection again.';
  }
  if (/authorization could not be verified/.test(normalized)) {
    return 'The authorization could not be verified. Start the connection again.';
  }
  if (/different browser session/.test(normalized)) {
    return 'The authorization was opened in a different browser session. Start again here.';
  }
  if (/authorization state was altered/.test(normalized)) {
    return 'The authorization response was rejected. Nothing was stored.';
  }
  if (/row[- ]count|reconcil|counts? (?:do not|don't) match|count mismatch/.test(normalized)) {
    return 'Row-count reconciliation failed. The affected report was not promoted.';
  }
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid_grant|refresh token/.test(normalized)) {
    return 'Authorization failed. Reconnect the integration before retrying.';
  }
  if (/\b429\b|throttl|rate limit|too many requests/.test(normalized)) {
    return 'The provider rate limit was reached. The worker will retry within its retry policy.';
  }
  if (/timed? out|timeout|econnreset|enotfound|network|socket hang up/.test(normalized)) {
    return 'The upstream request did not complete. Retry after connectivity recovers.';
  }
  if (/failed query|database|postgres|constraint|duplicate key|syntax error/.test(normalized)) {
    return 'The data load failed before promotion. Review the private worker log.';
  }

  return 'The operation failed. Review the private worker log for the underlying cause.';
}
