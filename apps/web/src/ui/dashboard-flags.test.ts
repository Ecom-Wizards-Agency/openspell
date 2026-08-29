import { describe, expect, it } from 'vitest';
import type { FlagView } from './dashboard';
import { groupFlags } from './dashboard';

const flag = (severity: FlagView['severity'], metric: string, scope: string): FlagView => ({
  severity,
  metric,
  threshold: 'tenant rule',
  message: `${metric} moved`,
  likelyCause: 'Synthetic cause',
  scope,
  category: 'Rank',
  suppressed: false,
  suppressedReason: null,
});

describe('dashboard alert grouping', () => {
  it('bundles repeated campaign signals and ranks severity before volume', () => {
    const groups = groupFlags([
      flag('alert', 'impressions', 'Campaign A'),
      flag('alert', 'impressions', 'Campaign B'),
      flag('critical', 'spend', 'Account'),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ severity: 'critical', metric: 'spend' });
    expect(groups[1]?.flags).toHaveLength(2);
  });
});
