import { describe, expect, it } from 'vitest';
import { RegionTokenBuckets } from './region-token-buckets.js';

describe('RegionTokenBuckets', () => {
  it('caps each region independently at two concurrent calls', async () => {
    const buckets = new RegionTokenBuckets(2);
    const active = { NA: 0, EU: 0 };
    const maximum = { NA: 0, EU: 0 };
    const run = async (region: 'NA' | 'EU'): Promise<void> => buckets.run(region, async () => {
      active[region] += 1;
      maximum[region] = Math.max(maximum[region], active[region]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active[region] -= 1;
    });

    await Promise.all([...Array.from({ length: 8 }, () => run('NA')), ...Array.from({ length: 8 }, () => run('EU'))]);
    expect(maximum).toEqual({ NA: 2, EU: 2 });
  });
});
