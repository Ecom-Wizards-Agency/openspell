/** Synthetic-only MRP fixtures. No live account payload belongs in this repository. */
export const SYNTHETIC_SELLERS_PROSE = [
  'Connected sellers:',
  '1. Example Labs | Seller id: 123450001 | Selling partner id: PARTNER-ONE | Region: North America | Type: CPG | Access: owned',
  '2. Sample Island | Seller id: 123450002 | Selling partner id: PARTNER-TWO | Region: Europe | Access: shared',
].join('\n');

export const SYNTHETIC_PRODUCT_METRICS = {
  account: {
    name: 'Example Labs',
    seller_ids: [123450001],
  },
  product: {
    asin: 'B0TEST4401',
    child_asins: [],
    scope: 'single',
  },
  period: {
    from: '2026-08-26',
    to: '2026-08-26',
    days: '1',
    complete: true,
    data_available_through: {
      orders: '2026-08-26',
      advertising: '2026-08-26',
      traffic: '2026-08-26',
    },
    incomplete_sources: [],
    note: null,
  },
  comparison_period: {
    from: '2026-08-25',
    to: '2026-08-25',
    margin: 0.99,
  },
  pricing: {
    sale_price: '39.99',
    currency: 'usd',
  },
  costs: {
    cogs: 11.25,
  },
  fees: {
    fba_fees: '4.75',
    referral_fee: 6,
    other_fees: '1.25',
    total_fees: 12,
  },
  profitability: {
    profit: 16.74,
    profit_margin: '0.4185',
  },
  sales: {
    revenue: 399.9,
    units: 10,
  },
  advertising: {
    ppc_spend: 42.5,
  },
};

export const INITIALIZED = {
  protocolVersion: '2025-06-18',
  capabilities: { tools: {} },
  serverInfo: { name: 'synthetic-mrp', version: '0.1.0' },
};

export const TOOLS = {
  tools: [
    { name: 'get_sellers', description: 'Connected sellers', inputSchema: { type: 'object' } },
    {
      name: 'get_product_metrics',
      description: 'Single-ASIN product metrics',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['asin', 'seller_ids', 'marketplace_ids', 'date_from', 'date_to'],
        properties: {
          asin: { type: 'string' },
          seller_ids: { type: 'array', items: { type: 'integer' } },
          marketplace_ids: { type: 'array', items: { type: 'string' } },
          date_from: { type: 'string' },
          date_to: { type: 'string' },
        },
      },
    },
  ],
};

export const SINGLE_ASIN_SCHEMA_ERROR = {
  code: -32602,
  message: "Invalid arguments for get_product_metrics: 'asin' is required",
};
