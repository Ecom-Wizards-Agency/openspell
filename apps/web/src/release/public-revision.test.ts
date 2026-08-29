import { describe, expect, it } from 'vitest';
import {
  normalizePublicGitRevision,
  publicWebHealth,
  resolvePublicGitRevision,
} from './public-revision';

const REVISION = 'a'.repeat(40);

describe('public web revision', () => {
  it('normalizes a full public Git revision', () => {
    expect(normalizePublicGitRevision(` ${REVISION.toUpperCase()} `)).toBe(REVISION);
  });

  it.each([
    undefined,
    null,
    '',
    'a'.repeat(39),
    'a'.repeat(41),
    `${'a'.repeat(39)}z`,
    'release-2026-08-30',
  ])('refuses a missing or malformed revision: %s', (value) => {
    expect(normalizePublicGitRevision(value)).toBeNull();
  });

  it('prefers the Vercel build revision and supports an explicit non-secret fallback', () => {
    const fallback = 'b'.repeat(40);
    expect(resolvePublicGitRevision({
      vercelGitCommitSha: REVISION,
      openspellAppVersion: fallback,
    })).toBe(REVISION);
    expect(resolvePublicGitRevision({ openspellAppVersion: fallback })).toBe(fallback);
    expect(resolvePublicGitRevision({ legacyAppVersion: REVISION })).toBe(REVISION);
  });

  it('fails closed on a malformed higher-priority source instead of hiding it with a fallback', () => {
    expect(resolvePublicGitRevision({
      vercelGitCommitSha: 'not-a-git-revision',
      openspellAppVersion: REVISION,
    })).toBeNull();
  });

  it('exposes only product, readiness, and the normalized revision', () => {
    expect(publicWebHealth({ vercelGitCommitSha: REVISION })).toEqual({
      product: 'OpenSpell',
      status: 'ready',
      revision: REVISION,
    });
  });
});
