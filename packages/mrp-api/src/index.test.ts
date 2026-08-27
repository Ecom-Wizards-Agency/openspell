import { describe, expect, it } from 'vitest';
import * as api from './index.js';

describe('@wizard-ads/mrp-api public surface', () => {
  it('exports the MCP client operations and domain parser', () => {
    expect(api.PACKAGE_NAME).toBe('@wizard-ads/mrp-api');
    for (const method of ['initialize', 'listTools', 'callTool', 'fetchSellers', 'fetchProductMetrics']) {
      expect(typeof (api.MrpClient.prototype as unknown as Record<string, unknown>)[method]).toBe('function');
    }
    expect(api.parseSellers).toBeTypeOf('function');
    expect(api.parseSellerLine).toBeTypeOf('function');
    expect(api.parseProductMetrics).toBeTypeOf('function');
  });
});
