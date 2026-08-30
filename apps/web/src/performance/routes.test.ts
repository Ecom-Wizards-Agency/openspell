import { describe, expect, it } from 'vitest';
import { EXPENSIVE_ROUTE_PATHNAMES, shouldPrefetchRoute } from './routes';

describe('route prefetch budget', () => {
  it('disables automatic prefetch for every declared server-heavy route', () => {
    expect(EXPENSIVE_ROUTE_PATHNAMES.size).toBeGreaterThan(0);
    for (const pathname of EXPENSIVE_ROUTE_PATHNAMES) {
      expect(shouldPrefetchRoute(pathname), pathname).toBe(false);
    }
  });

  it('does not silently classify ordinary utility navigation as expensive', () => {
    expect(shouldPrefetchRoute('/settings')).toBe(true);
  });
});
