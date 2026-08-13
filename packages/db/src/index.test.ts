import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@wizard-ads/db', () => {
  it('is wired into the workspace', () => {
    expect(PACKAGE_NAME).toBe('@wizard-ads/db');
  });
});
