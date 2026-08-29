import { describe, expect, it } from 'vitest';
import { reversionBatchTag } from './reversion.js';

describe('reversionBatchTag', () => {
  it('creates a stable, filesystem-safe audit tag', () => {
    expect(
      reversionBatchTag({
        sourceTag: 'Synthetic Rank / push',
        sourceBatchId: '11111111-2222-4333-8444-555555555555',
        exportedAt: new Date('2026-08-29T02:03:04.000Z'),
      }),
    ).toBe('Synthetic-Rank-push-revert-20260829T020304Z-11111111');
  });
});
