import { describe, expect, it } from 'vitest';
import { safeNextPath } from './next-path';

describe('safeNextPath', () => {
  it('keeps local invite paths and their query', () => {
    expect(safeNextPath('/invite/abc_123?from=login', '/dashboard')).toBe(
      '/invite/abc_123?from=login',
    );
  });

  it.each(['https://example.test', '//example.test', '/\\example.test'])(
    'refuses external redirect shape %s',
    (candidate) => {
      expect(safeNextPath(candidate, '/dashboard')).toBe('/dashboard');
    },
  );
});
