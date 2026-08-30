import { describe, expect, it } from 'vitest';
import { parseRevisionMetadata, publicRevision } from './revision';

describe('public performance revision metadata', () => {
  it('exposes only a full provider revision', () => {
    const revision = 'b'.repeat(40);
    expect(publicRevision({ VERCEL_GIT_COMMIT_SHA: revision, PRIVATE_VALUE: 'do not expose' }))
      .toEqual({ revision, rum_evidence: 'diagnostic_only' });
    expect(JSON.stringify(publicRevision({ VERCEL_GIT_COMMIT_SHA: revision })))
      .not.toContain('PRIVATE_VALUE');
  });

  it('fails closed for shortened or decorated revisions', () => {
    expect(publicRevision({ VERCEL_GIT_COMMIT_SHA: 'abc1234' })).toEqual({
      revision: null,
      rum_evidence: 'diagnostic_only',
    });
    expect(publicRevision({ VERCEL_GIT_COMMIT_SHA: `${'c'.repeat(40)}-dirty` }))
      .toEqual({ revision: null, rum_evidence: 'diagnostic_only' });
  });

  it('rejects metadata with extra fields', () => {
    expect(parseRevisionMetadata({
      revision: 'd'.repeat(40),
      rum_evidence: 'diagnostic_only',
      deployment: 'synthetic',
    })).toBeNull();
    expect(parseRevisionMetadata({ revision: 'd'.repeat(40), rum_evidence: 'acceptance' })).toBeNull();
  });
});
