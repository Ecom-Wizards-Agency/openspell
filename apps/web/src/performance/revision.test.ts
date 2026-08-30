import { describe, expect, it } from 'vitest';
import { parseRevisionMetadata, publicRevision } from './revision';

describe('public performance revision metadata', () => {
  it('exposes only a full provider revision', () => {
    const revision = 'b'.repeat(40);
    expect(publicRevision({ VERCEL_GIT_COMMIT_SHA: revision, PRIVATE_VALUE: 'do not expose' }))
      .toEqual({ revision });
    expect(JSON.stringify(publicRevision({ VERCEL_GIT_COMMIT_SHA: revision })))
      .not.toContain('PRIVATE_VALUE');
  });

  it('fails closed for shortened or decorated revisions', () => {
    expect(publicRevision({ VERCEL_GIT_COMMIT_SHA: 'abc1234' })).toEqual({ revision: null });
    expect(publicRevision({ VERCEL_GIT_COMMIT_SHA: `${'c'.repeat(40)}-dirty` }))
      .toEqual({ revision: null });
  });

  it('rejects metadata with extra fields', () => {
    expect(parseRevisionMetadata({ revision: 'd'.repeat(40), deployment: 'synthetic' })).toBeNull();
  });
});
