import { describe, expect, it } from 'vitest';
import { Region } from '@wizard-ads/shared';

describe('@wizard-ads/web', () => {
  it('can import the contract package', () => {
    expect(Region.options).toContain('EU');
  });
});
