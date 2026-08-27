/** Synthetic-only MRP fixtures. No live account payload belongs in this repository. */
export const SYNTHETIC_PRODUCTS = {
  products: [
    {
      ASIN: 'B0TEST4401',
      salePrice: '39.9900',
      cost_of_goods: 11.25,
      fba_fee: '4.75',
      referral_fees: 6,
      other_fees: '1.25',
      profit_margin: '0.4185',
      lifetime_value: '71.20',
      lifetime_orders: '1.8',
      repeat_purchase_rate: '0.24',
      currency_code: 'usd',
      snapshot_date: '2026-08-26T23:30:00Z',
      contribution_profit: 16.74,
    },
    {
      asin: 'B0TEST4402',
      sale_price: 24.5,
      cogs: '7.5',
      currency: 'EUR',
      captured_on: '2026-08-27',
      cohort: 'repeat-buyers',
    },
  ],
};

export const INITIALIZED = {
  protocolVersion: '2025-06-18',
  capabilities: { tools: {} },
  serverInfo: { name: 'synthetic-mrp', version: '0.1.0' },
};

export const TOOLS = {
  tools: [
    { name: 'list_products', description: 'Catalog', inputSchema: { type: 'object' } },
    {
      name: 'get_product_economics',
      description: 'Per-product profit and LTV',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
};
