import { describe, expect, it } from 'vitest';
import * as api from './index.js';

describe('@wizard-ads/mrp-api public surface', () => {
  it('exports the MCP client operations and domain parser', () => {
    expect(api.PACKAGE_NAME).toBe('@wizard-ads/mrp-api');
    for (const method of ['initialize', 'listTools', 'callTool', 'fetchProductEconomics']) {
      expect(typeof (api.MrpClient.prototype as unknown as Record<string, unknown>)[method]).toBe('function');
    }
    expect(api.parseProductEconomics).toBeTypeOf('function');
    expect(api.selectEconomicsTool).toBeTypeOf('function');
  });
});
