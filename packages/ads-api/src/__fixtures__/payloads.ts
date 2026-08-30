/**
 * Recorded Amazon payloads, in the shapes the live API returns.
 *
 * Synthetic to the last field. Every id is an obvious placeholder, every
 * campaign name is invented, and no value here came from a real advertiser —
 * this repository is public, and a fixture built from a live account is a
 * client data leak with extra steps (AGENTS.md).
 *
 * What is *structurally* real is the part that matters: `targetingClauses`
 * rather than `targets`, `keywordId` on a product-target row, Sponsored
 * Display's bare array and lower-case states, `placementClassification`
 * spelled the way Amazon spells it. Those are the details a hand-written stub
 * gets wrong and a live integration then gets wrong too.
 *
 * Each fixture also carries at least one row the mapper must refuse, so the
 * "rows in equals rows out plus rows skipped" assertion has something to count.
 */

export const PROFILE_ID = '1111111111';

/** `GET /v2/profiles`. Profile ids arrive as JSON numbers, not strings. */
export const PROFILES_NA: unknown[] = [
  {
    profileId: 1111111111,
    countryCode: 'US',
    currencyCode: 'USD',
    dailyBudget: 0,
    timezone: 'America/Los_Angeles',
    accountInfo: {
      marketplaceStringId: 'MARKETPLACE1',
      id: 'SELLERID1',
      type: 'seller',
      name: 'Placeholder Seller One',
      validPaymentMethod: true,
    },
  },
  {
    profileId: 2222222222,
    countryCode: 'CA',
    currencyCode: 'CAD',
    timezone: 'America/Toronto',
    accountInfo: {
      marketplaceStringId: 'MARKETPLACE2',
      id: 'VENDORCODE1',
      type: 'vendor',
      name: 'Placeholder Vendor One',
    },
  },
  // Amazon has been known to return an entry with no profileId. Dropped.
  { countryCode: 'MX' },
];

export const PROFILES_EU: unknown[] = [
  {
    profileId: 3333333333,
    countryCode: 'DE',
    currencyCode: 'EUR',
    timezone: 'Europe/Berlin',
    accountInfo: { marketplaceStringId: 'MARKETPLACE3', id: 'SELLERID1', type: 'seller', name: 'Placeholder Seller One' },
  },
];

/** `POST /sp/campaigns/list`, page one of two. */
export const SP_CAMPAIGNS_PAGE_1 = {
  campaigns: [
    {
      campaignId: '100000000000001',
      name: 'Placeholder SP Exact',
      state: 'ENABLED',
      targetingType: 'MANUAL',
      portfolioId: '900000001',
      budget: { budget: 42.5, budgetType: 'DAILY' },
      dynamicBidding: {
        strategy: 'AUTO_FOR_SALES',
        placementBidding: [
          { placement: 'PLACEMENT_TOP', percentage: 50 },
          { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 0 },
        ],
      },
      startDate: '2026-01-01',
      endDate: null,
    },
    {
      campaignId: '100000000000002',
      name: 'Placeholder SP Auto',
      state: 'enabling',
      targetingType: 'AUTO',
      budget: { budget: 10, budgetType: 'DAILY' },
      startDate: '2026-02-01',
    },
  ],
  nextToken: 'page-two',
};

/** Page two, including a campaign with no budget: refused, never defaulted. */
export const SP_CAMPAIGNS_PAGE_2 = {
  campaigns: [
    {
      campaignId: '100000000000003',
      name: 'Placeholder SP Paused',
      state: 'PAUSED',
      budget: { budget: 5, budgetType: 'LIFETIME' },
    },
    { campaignId: '100000000000004', name: 'Placeholder SP Broken', state: 'ENABLED' },
  ],
  nextToken: null,
};

export const SP_AD_GROUPS = {
  adGroups: [
    { adGroupId: '200000000000001', campaignId: '100000000000001', name: 'Placeholder Ad Group', state: 'ENABLED', defaultBid: 0.75 },
    { adGroupId: '200000000000002', campaignId: '100000000000002', name: 'Auto Ad Group', state: 'PAUSED', defaultBid: 0.4 },
    { campaignId: '100000000000002', name: 'No id', state: 'ENABLED' },
  ],
  nextToken: null,
};

export const SP_KEYWORDS = {
  keywords: [
    {
      keywordId: '300000000000001',
      adGroupId: '200000000000001',
      campaignId: '100000000000001',
      keywordText: 'placeholder widget',
      matchType: 'EXACT',
      state: 'ENABLED',
      bid: 1.25,
    },
    {
      keywordId: '300000000000002',
      adGroupId: '200000000000001',
      campaignId: '100000000000001',
      keywordText: 'placeholder widget blue',
      matchType: 'PHRASE',
      state: 'PAUSED',
      bid: 0.9,
    },
    // Amazon adding a match type we do not know must not silently become "exact".
    {
      keywordId: '300000000000003',
      adGroupId: '200000000000001',
      campaignId: '100000000000001',
      keywordText: 'unknown match',
      matchType: 'SOMETHING_NEW',
      state: 'ENABLED',
    },
  ],
  nextToken: null,
};

/** Targets come back under `targetingClauses`. Reading `targets` yields nothing. */
export const SP_TARGETS = {
  targetingClauses: [
    {
      targetId: '400000000000001',
      adGroupId: '200000000000001',
      campaignId: '100000000000001',
      state: 'ENABLED',
      bid: 0.65,
      expression: [{ type: 'ASIN_SAME_AS', value: 'B000000001' }],
      resolvedExpression: [{ type: 'ASIN_SAME_AS', value: 'B000000001' }],
    },
    {
      targetId: '400000000000002',
      adGroupId: '200000000000002',
      campaignId: '100000000000002',
      state: 'ENABLED',
      bid: 0.5,
      expression: [{ type: 'QUERY_HIGH_REL_MATCHES' }],
      resolvedExpression: [{ type: 'QUERY_HIGH_REL_MATCHES' }],
    },
    {
      targetId: '400000000000003',
      adGroupId: '200000000000002',
      campaignId: '100000000000002',
      state: 'ENABLED',
      expression: [{ type: 'BRAND_NEW_CLAUSE', value: 'x' }],
    },
  ],
  nextToken: null,
};

export const SP_NEGATIVE_KEYWORDS = {
  negativeKeywords: [
    {
      keywordId: '500000000000001',
      adGroupId: '200000000000001',
      campaignId: '100000000000001',
      keywordText: 'free placeholder',
      matchType: 'NEGATIVE_EXACT',
      state: 'ENABLED',
    },
  ],
  nextToken: null,
};

export const SP_CAMPAIGN_NEGATIVE_KEYWORDS = {
  campaignNegativeKeywords: [
    {
      keywordId: '510000000000001',
      campaignId: '100000000000001',
      keywordText: 'cheap placeholder',
      matchType: 'CAMPAIGN_NEGATIVE_PHRASE',
      state: 'ENABLED',
    },
  ],
  nextToken: null,
};

export const SP_NEGATIVE_TARGETS = {
  negativeTargetingClauses: [
    {
      targetId: '520000000000001',
      adGroupId: '200000000000001',
      campaignId: '100000000000001',
      state: 'ENABLED',
      expression: [{ type: 'ASIN_SAME_AS', value: 'B000000002' }],
    },
  ],
  nextToken: null,
};

export const SP_PRODUCT_ADS = {
  productAds: [
    {
      adId: '600000000000001',
      adGroupId: '200000000000001',
      campaignId: '100000000000001',
      asin: 'B000000001',
      sku: 'PLACEHOLDER-SKU-1',
      state: 'ENABLED',
    },
    { adId: '600000000000002', adGroupId: '200000000000001', campaignId: '100000000000001', state: 'ARCHIVED' },
  ],
  nextToken: null,
};

/** Sponsored Brands v4. Budget arrives flat rather than nested. */
export const SB_CAMPAIGNS = {
  campaigns: [
    {
      campaignId: '700000000000001',
      name: 'Placeholder SB Video',
      state: 'ENABLED',
      budget: 75,
      budgetType: 'DAILY',
      startDate: '2026-03-01',
      endDate: null,
      portfolioId: '900000002',
    },
  ],
  nextToken: null,
};

export const SB_AD_GROUPS = {
  adGroups: [
    { adGroupId: '710000000000001', campaignId: '700000000000001', name: 'SB Ad Group', state: 'ENABLED' },
  ],
  nextToken: null,
};

/** Sponsored Display: a bare array, lower-case states, offset pagination. */
export const SD_CAMPAIGNS_PAGE_1: unknown[] = [
  {
    campaignId: '800000000000001',
    name: 'Placeholder SD Contextual',
    state: 'enabled',
    budget: 30,
    budgetType: 'daily',
    tactic: 'T00020',
    startDate: '20260401',
  },
  {
    campaignId: '800000000000002',
    name: 'Placeholder SD Audience',
    state: 'paused',
    budget: 20,
    budgetType: 'daily',
    tactic: 'T00030',
  },
];

export const SD_CAMPAIGNS_PAGE_2: unknown[] = [
  { campaignId: '800000000000003', name: 'Placeholder SD Third', state: 'archived', budget: 15, budgetType: 'daily' },
];

export const SD_AD_GROUPS: unknown[] = [
  { adGroupId: '810000000000001', campaignId: '800000000000001', name: 'SD Ad Group', state: 'enabled', defaultBid: 0.55 },
];

/** `spTargeting`, daily. Row three is a product target: no match type, same id field. */
export const REPORT_SP_TARGETING: unknown[] = [
  {
    date: '2026-08-10',
    campaignId: '100000000000001',
    campaignName: 'Placeholder SP Exact',
    adGroupId: '200000000000001',
    keywordId: '300000000000001',
    keyword: 'placeholder widget',
    keywordType: 'BROAD',
    matchType: 'EXACT',
    targeting: 'placeholder widget',
    impressions: 1200,
    clicks: 30,
    cost: 24.5,
    purchases1d: 1,
    purchases7d: 3,
    purchases14d: 4,
    purchases30d: 4,
    sales1d: 25.0,
    sales7d: 75.0,
    sales14d: 100.0,
    sales30d: 100.0,
    unitsSoldClicks7d: 3,
  },
  {
    date: '2026-08-10',
    campaignId: '100000000000001',
    campaignName: 'Placeholder SP Exact',
    adGroupId: '200000000000001',
    keywordId: '300000000000002',
    keyword: 'placeholder widget blue',
    matchType: 'PHRASE',
    impressions: 400,
    clicks: 8,
    cost: 6.4,
    purchases7d: 0,
    sales7d: 0,
    unitsSoldClicks7d: 0,
  },
  {
    date: '2026-08-10',
    campaignId: '100000000000002',
    adGroupId: '200000000000002',
    keywordId: '400000000000001',
    keywordType: 'TARGETING_EXPRESSION',
    targeting: 'asin="B000000001"',
    impressions: 90,
    clicks: 2,
    cost: 1.1,
    purchases7d: 1,
    sales7d: 30.0,
    unitsSoldClicks7d: 1,
  },
  // A summary-shaped row in a daily report: refused, never dated from startDate.
  {
    startDate: '2026-08-01',
    endDate: '2026-08-10',
    campaignId: '100000000000001',
    adGroupId: '200000000000001',
    keywordId: '300000000000009',
    impressions: 5,
  },
];

export const REPORT_SP_SEARCH_TERM: unknown[] = [
  {
    date: '2026-08-10',
    campaignId: '100000000000001',
    adGroupId: '200000000000001',
    keywordId: '300000000000001',
    keyword: 'placeholder widget',
    matchType: 'EXACT',
    searchTerm: 'placeholder widget',
    impressions: 800,
    clicks: 20,
    cost: 16.0,
    purchases7d: 2,
    sales7d: 50.0,
    unitsSoldClicks7d: 2,
  },
  {
    date: '2026-08-10',
    campaignId: '100000000000002',
    adGroupId: '200000000000002',
    searchTerm: 'unbranded placeholder thing',
    impressions: 60,
    clicks: 1,
    cost: 0.5,
    purchases7d: 0,
    sales7d: 0,
  },
  { date: '2026-08-10', campaignId: '100000000000002', adGroupId: '200000000000002', impressions: 3 },
];

export const REPORT_SP_PLACEMENT: unknown[] = [
  {
    date: '2026-08-10',
    campaignId: '100000000000001',
    placementClassification: 'Top of Search on-Amazon',
    impressions: 900,
    clicks: 22,
    cost: 20.0,
    purchases7d: 2,
    sales7d: 60.0,
  },
  {
    date: '2026-08-10',
    campaignId: '100000000000001',
    placementClassification: 'Detail Page on-Amazon',
    impressions: 300,
    clicks: 6,
    cost: 4.5,
    purchases7d: 1,
    sales7d: 15.0,
  },
  {
    date: '2026-08-10',
    campaignId: '100000000000001',
    placementClassification: 'Other on-Amazon',
    impressions: 120,
    clicks: 2,
    cost: 1.0,
  },
  {
    date: '2026-08-10',
    campaignId: '100000000000002',
    placementClassification: 'Off Amazon',
    impressions: 5000,
    clicks: 40,
    cost: 12.0,
    purchases7d: 0,
    sales7d: 0,
  },
  {
    date: '2026-08-10',
    campaignId: '100000000000002',
    placementClassification: 'Something Amazon Added',
    impressions: 10,
    clicks: 1,
    cost: 0.3,
  },
];

export const REPORT_SP_CAMPAIGNS: unknown[] = [
  {
    date: '2026-08-10',
    campaignId: '100000000000001',
    campaignName: 'Placeholder SP Exact',
    campaignStatus: 'ENABLED',
    campaignBudgetAmount: 42.5,
    campaignBudgetType: 'DAILY',
    campaignBudgetCurrencyCode: 'USD',
    impressions: 1600,
    clicks: 38,
    cost: 30.9,
    purchases1d: 1,
    purchases7d: 3,
    purchases14d: 4,
    purchases30d: 4,
    sales1d: 25.0,
    sales7d: 75.0,
    sales14d: 100.0,
    sales30d: 100.0,
    unitsSoldClicks7d: 3,
    // Reported as a percentage on this grain; the contract wants a fraction.
    topOfSearchImpressionShare: 28.4,
  },
  {
    date: '2026-08-10',
    campaignId: '100000000000002',
    campaignName: 'Placeholder SP Auto',
    campaignStatus: 'ENABLED',
    impressions: 90,
    clicks: 2,
    cost: 1.1,
    purchases7d: 1,
    sales7d: 30.0,
  },
];

export const REPORT_SB: unknown[] = [
  {
    date: '2026-08-10',
    campaignId: '700000000000001',
    campaignName: 'Placeholder SB Video',
    campaignStatus: 'ENABLED',
    impressions: 5000,
    clicks: 60,
    cost: 90.0,
    purchases: 4,
    sales: 220.0,
    unitsSold: 5,
    newToBrandPurchases: 3,
    newToBrandSales: 165.0,
    videoFirstQuartileViews: 2200,
    videoCompleteViews: 900,
    viewableImpressions: 4100,
  },
  { campaignId: '700000000000001', impressions: 1 },
];

export const REPORT_SD: unknown[] = [
  {
    date: '2026-08-10',
    campaignId: '800000000000001',
    campaignName: 'Placeholder SD Contextual',
    campaignStatus: 'ENABLED',
    impressions: 12000,
    clicks: 80,
    cost: 45.0,
    purchases: 6,
    sales: 180.0,
    unitsSold: 7,
    newToBrandPurchases: 2,
    newToBrandSales: 60.0,
    addToCart: 30,
    detailPageViews: 210,
  },
];

/** A campaigns export download: the name join Reporting v3 cannot do itself. */
export const EXPORT_CAMPAIGNS: unknown[] = [
  { campaignId: '100000000000001', name: 'Placeholder SP Exact', adProduct: 'SPONSORED_PRODUCTS', state: 'ENABLED' },
  { campaignId: '100000000000002', name: 'Placeholder SP Auto', adProduct: 'SPONSORED_PRODUCTS', state: 'ENABLED' },
  { campaignId: '700000000000001', name: 'Placeholder SB Video', adProduct: 'SPONSORED_BRANDS', state: 'ENABLED' },
  { adProduct: 'SPONSORED_DISPLAY' },
];

/** Product-specific budget-usage endpoints return per-campaign failures inside a 200. */
export const BUDGET_USAGE_RESPONSE = {
  success: [
    {
      index: 0,
      campaignId: '100000000000001',
      budget: 42.5,
      budgetUsagePercent: 87.3,
      usageUpdatedTimestamp: '2026-08-14T09:00:00Z',
    },
    {
      index: 1,
      campaignId: '100000000000002',
      budget: 10,
      budgetUsagePercent: 12.0,
      usageUpdatedTimestamp: '2026-08-14T09:00:00Z',
    },
  ],
  error: [{ index: 2, campaignId: '100000000000003', code: 'NOT_FOUND', details: 'campaign not found' }],
};
