import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { QueryIntelligenceModel } from '../../src/query-intelligence/model';
import { QueryIntelligenceWorkspace } from './workspace';

const model: QueryIntelligenceModel = {
  categorySummaries: [
    'own_brand',
    'competitor',
    'core',
    'head',
    'excluded',
    'unreviewed',
  ].map((category, index) => ({
    category: category as QueryIntelligenceModel['categorySummaries'][number]['category'],
    label: ['Own Brand', 'Competitor', 'Core', 'Generic Head', 'Excluded', 'Needs Review'][index] as string,
    queryCount: 1,
    asinCount: 1,
    searchVolume: 10,
    clickShare: 0.2,
    purchaseShare: 0.3,
    impressionShare: 0.1,
  })),
  queryRows: [],
  rawDemand: 60,
  addressableDemand: 10,
  uniqueQueries: 6,
  uniqueAsins: 2,
  needsReview: 1,
  ppcRows: [],
  ppcSummaries: [
    { attribution: 'asin_exact', label: 'ASIN exact', rows: 0, spend: 0 },
    { attribution: 'profile_only', label: 'Profile-only', rows: 0, spend: 0 },
    { attribution: 'ambiguous', label: 'Ambiguous', rows: 0, spend: 0 },
    { attribution: 'unmatched', label: 'No SQP match', rows: 0, spend: 0 },
  ],
  vocabulary: [],
  approvedVocabulary: 0,
  pendingVocabulary: 1,
  proposals: [],
  negativeExports: [],
  promotionRuns: [],
  promotionReconciled: null,
  assertions: {
    sourceFacts: 0,
    displayedFactRows: 0,
    ppcInputRows: 0,
    ppcOutputRows: 0,
    ppcSpendConserved: true,
  },
};

describe('/query-intelligence workspace', () => {
  it('renders the full taxonomy and puts purchase/click share ahead of impression share', () => {
    const markup = renderToStaticMarkup(
      createElement(QueryIntelligenceWorkspace, {
        model,
        currencyCode: 'USD',
        selectedCategory: null,
        search: '',
        profileId: '00000000-0000-4000-8000-000000000079',
        marketplaceId: 'SYNTHETIC_MARKET',
        role: 'owner',
      }),
    );

    for (const label of ['Own Brand', 'Competitor', 'Core', 'Generic Head', 'Excluded', 'Needs Review']) {
      expect(markup).toContain(label);
    }
    expect(markup.indexOf('Weighted purchase share')).toBeLessThan(markup.indexOf('Impression share'));
    expect(markup.indexOf('Weighted click share')).toBeLessThan(markup.indexOf('Impression share'));
    expect(markup).toContain('Generic Head excluded');
    expect(markup).toContain('not share of voice');
  });

  it('names conservative PPC states and keeps negatives review/export-only', () => {
    const markup = renderToStaticMarkup(
      createElement(QueryIntelligenceWorkspace, {
        model,
        currencyCode: 'USD',
        selectedCategory: null,
        search: '',
        profileId: '00000000-0000-4000-8000-000000000079',
        marketplaceId: 'SYNTHETIC_MARKET',
        role: 'owner',
      }),
    );

    expect(markup).toContain('Profile-only');
    expect(markup).toContain('Ambiguous');
    expect(markup).toContain('never duplicates that spend');
    expect(markup).toContain('Decide a compact queue, then export');
    expect(markup).toContain('Yes, export negatives');
    expect(markup).toContain('exported means a file was created—not that Amazon changed');
    expect(markup).toContain('No Amazon writes');
    expect(markup).not.toContain('Apply to Amazon');
  });
});
