import { describe, expect, it } from 'vitest';
import { operatorFailureLabel } from './operator-failure';

describe('operator failure labels', () => {
  it('never returns database statements or bind parameters', () => {
    const raw = [
      'Failed query: insert into fact_profile_daily (profile_id) values ($1)',
      'params: 00000000-0000-0000-0000-000000000001,private-value',
    ].join('\n');

    const label = operatorFailureLabel(raw);

    expect(label).toBe('The data load failed before promotion. Review the private worker log.');
    expect(label).not.toContain('insert into');
    expect(label).not.toContain('private-value');
  });

  it('uses only allowlisted actionable provider categories', () => {
    expect(operatorFailureLabel('HTTP 429: Too Many Requests')).toBe(
      'The provider rate limit was reached. The worker will retry within its retry policy.',
    );
    expect(operatorFailureLabel('invalid_grant while refreshing token')).toBe(
      'Authorization failed. Reconnect the integration before retrying.',
    );
    expect(operatorFailureLabel('source row-count mismatch')).toBe(
      'Row-count reconciliation failed. The affected report was not promoted.',
    );
    expect(operatorFailureLabel('opaque provider failure request-id=private')).toBe(
      'The operation failed. Review the private worker log for the underlying cause.',
    );
    expect(operatorFailureLabel(null)).toBeNull();
  });

  it('preserves only known-safe OAuth guidance', () => {
    expect(operatorFailureLabel('the authorization link expired; start again')).toBe(
      'The authorization link expired. Start the connection again.',
    );
    expect(operatorFailureLabel('the authorization state was altered and was rejected')).toBe(
      'The altered authorization response was rejected. Nothing was stored.',
    );
    expect(operatorFailureLabel('this authorization was started by a different session')).toBe(
      'The authorization was opened in a different session. Start again here.',
    );
  });
});
