import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@wizard-ads/mcp', () => {
  it('is wired into the workspace', () => {
    expect(PACKAGE_NAME).toBe('@wizard-ads/mcp');
  });
});
