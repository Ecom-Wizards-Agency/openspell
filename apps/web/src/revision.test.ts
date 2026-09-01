import { describe, expect, it } from 'vitest';
import { resolveWebRevisionIdentity, webRevision } from './revision.js';

const REVISION = '1234567890abcdef1234567890abcdef12345678';
const OTHER_REVISION = 'abcdef1234567890abcdef1234567890abcdef12';

describe('webRevision', () => {
  it('uses one normalized Vercel Git object id as hosted authority', () => {
    expect(resolveWebRevisionIdentity({ VERCEL_GIT_COMMIT_SHA: REVISION.toUpperCase() }))
      .toEqual({ revision: REVISION, source: 'vercel' });
    expect(resolveWebRevisionIdentity({
      VERCEL_GIT_COMMIT_SHA: REVISION,
      OPENSPELL_WEB_REVISION: REVISION.toUpperCase(),
    })).toEqual({ revision: REVISION, source: 'vercel' });
  });

  it('fails closed on hosted conflicts and malformed present values', () => {
    expect(resolveWebRevisionIdentity({
      VERCEL_GIT_COMMIT_SHA: REVISION,
      OPENSPELL_WEB_REVISION: OTHER_REVISION,
    })).toEqual({ revision: 'unknown', source: 'unknown' });
    expect(resolveWebRevisionIdentity({
      VERCEL_GIT_COMMIT_SHA: 'main',
      OPENSPELL_WEB_REVISION: REVISION,
    })).toEqual({ revision: 'unknown', source: 'unknown' });
    expect(resolveWebRevisionIdentity({
      VERCEL_GIT_COMMIT_SHA: '',
      OPENSPELL_WEB_REVISION: REVISION,
    })).toEqual({ revision: 'unknown', source: 'unknown' });
    expect(resolveWebRevisionIdentity({
      VERCEL_GIT_COMMIT_SHA: REVISION,
      OPENSPELL_WEB_REVISION: 'main',
    })).toEqual({ revision: 'unknown', source: 'unknown' });
  });

  it('retains an explicit local fallback without treating it as hosted evidence', () => {
    expect(resolveWebRevisionIdentity({ OPENSPELL_WEB_REVISION: OTHER_REVISION.toUpperCase() }))
      .toEqual({ revision: OTHER_REVISION, source: 'explicit' });
    expect(webRevision({ OPENSPELL_WEB_REVISION: OTHER_REVISION })).toBe(OTHER_REVISION);
    expect(webRevision({ OPENSPELL_WEB_REVISION: 'main' })).toBe('unknown');
    expect(webRevision({ OPENSPELL_WEB_REVISION: 'abcdef1' })).toBe('unknown');
    expect(webRevision({})).toBe('unknown');
  });
});
