import { describe, expect, it } from 'vitest';
import { passwordChangeError } from './password-policy';

describe('account password policy', () => {
  it('enforces the ten-character server boundary', () => {
    expect(passwordChangeError('a'.repeat(9), 'a'.repeat(9))).toBe(
      'Use at least 10 characters.',
    );
    expect(passwordChangeError('a'.repeat(10), 'a'.repeat(10))).toBeNull();
  });

  it('requires the confirmation to match', () => {
    expect(passwordChangeError('a'.repeat(10), 'b'.repeat(10))).toBe(
      'The two passwords do not match.',
    );
  });
});
