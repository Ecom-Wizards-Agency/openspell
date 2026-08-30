import { afterEach, describe, expect, it } from 'vitest';
import { beginRouteNavigation, routeReadyEvent } from './navigation';

afterEach(() => {
  performance.clearMarks('openspell.route-start');
  performance.clearMarks('openspell.route-ready');
});

describe('route-ready marks', () => {
  it('marks allowlisted routes locally without emitting an unattributed event', () => {
    beginRouteNavigation();
    expect(routeReadyEvent('/grid', null)).toBeNull();
    expect(performance.getEntriesByName('openspell.route-ready')).toHaveLength(1);
  });

  it('does not mark or emit arbitrary pathnames', () => {
    expect(routeReadyEvent('/profiles/synthetic-identifier', 'a'.repeat(40))).toBeNull();
    expect(performance.getEntriesByName('openspell.route-ready')).toHaveLength(0);
  });
});
