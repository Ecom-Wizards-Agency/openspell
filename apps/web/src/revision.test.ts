import { describe, expect, it } from 'vitest';
import { webRevision } from './revision.js';

describe('webRevision', () => {
  it('publishes one normalized full Git object id', () => {
    expect(webRevision({ OPENSPELL_WEB_REVISION: 'ABCDEF1234567890ABCDEF1234567890ABCDEF12' }))
      .toBe('abcdef1234567890abcdef1234567890abcdef12');
  });

  it('falls back to Vercel Git metadata and refuses labels or abbreviated ids', () => {
    expect(webRevision({ VERCEL_GIT_COMMIT_SHA: '1234567890abcdef1234567890abcdef12345678' }))
      .toBe('1234567890abcdef1234567890abcdef12345678');
    expect(webRevision({ OPENSPELL_WEB_REVISION: 'main' })).toBe('unknown');
    expect(webRevision({ OPENSPELL_WEB_REVISION: 'abcdef1' })).toBe('unknown');
    expect(webRevision({})).toBe('unknown');
  });
});
