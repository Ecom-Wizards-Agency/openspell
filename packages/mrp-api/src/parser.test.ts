import { describe, expect, it } from 'vitest';
import { MrpParseError, MrpToolNotFoundError } from './errors.js';
import { parseProductEconomics, selectEconomicsTool } from './parser.js';

describe('MRP product parser', () => {
  it('accepts an ASIN-keyed object and numeric strings', () => {
    const rows = parseProductEconomics({
      B0TEST4403: { selling_price: '10.50', product_cost: '3.25', unexplained: true },
    });
    expect(rows).toEqual([
      expect.objectContaining({
        asin: 'B0TEST4403',
        salePrice: 10.5,
        cogs: 3.25,
        details: { unexplained: true },
      }),
    ]);
  });

  it('refuses nonnumeric metrics and rows with no economics', () => {
    expect(() => parseProductEconomics([{ asin: 'B0TEST4404', margin: 'many' }]))
      .toThrow(MrpParseError);
    expect(() => parseProductEconomics([{ asin: 'B0TEST4404', label: 'only metadata' }]))
      .toThrow(/no economics fields/);
  });
});

describe('runtime tool discovery', () => {
  it('selects by name score and breaks ties deterministically', () => {
    const selected = selectEconomicsTool([
      { name: 'list_products', description: null, inputSchema: {} },
      { name: 'z_profit_ltv', description: null, inputSchema: {} },
      { name: 'a_product_economics', description: null, inputSchema: {} },
    ]);
    expect(selected.name).toBe('a_product_economics');
  });

  it('fails loudly when discovery exposes no relevant tool', () => {
    expect(() => selectEconomicsTool([
      { name: 'server_health', description: 'Health', inputSchema: {} },
    ])).toThrow(MrpToolNotFoundError);
  });
});
