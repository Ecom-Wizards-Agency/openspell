import { describe, expect, it } from 'vitest';
import type { WeeklyPpcQueryRecord } from '@wizard-ads/db';
import type {
  QueryCategory,
  QueryVocabularyEntry,
  SqpWeeklyFact,
} from '@wizard-ads/shared';
import { buildQueryIntelligenceModel } from './model';

const PROFILE = '00000000-0000-4000-8000-000000000071';
const ORG = '00000000-0000-4000-8000-000000000072';
const MARKET = 'SYNTHETIC_MARKET';
const WEEK = '2026-08-16';

function fact(
  query: string,
  category: QueryCategory,
  searchQueryVolume: number,
  asin: string,
  over: Partial<SqpWeeklyFact> = {},
): SqpWeeklyFact {
  return {
    profileId: PROFILE,
    marketplaceId: MARKET,
    asin,
    weekStart: WEEK,
    weekEnd: '2026-08-22',
    searchQuery: query,
    normalizedQuery: query.toLowerCase(),
    category,
    searchQueryScore: null,
    searchQueryVolume,
    totalImpressions: 100,
    asinImpressions: 10,
    asinImpressionShare: 0.1,
    totalClicks: 20,
    asinClicks: 4,
    asinClickShare: 0.2,
    totalCartAdds: 10,
    asinCartAdds: 2,
    asinCartAddShare: 0.2,
    totalPurchases: 5,
    asinPurchases: 2,
    asinPurchaseShare: 0.4,
    ...over,
  };
}

function ppc(
  id: string,
  searchTerm: string,
  spend: number,
  over: Partial<WeeklyPpcQueryRecord> = {},
): WeeklyPpcQueryRecord {
  return {
    id,
    profileId: PROFILE,
    marketplaceId: MARKET,
    weekStart: WEEK,
    campaignId: `campaign-${id}`,
    adGroupId: `ad-group-${id}`,
    searchTerm,
    asin: null,
    attributedAsins: [],
    spend,
    sales: spend * 2,
    clicks: 3,
    orders: 1,
    groupRole: 'profit',
    ...over,
  };
}

const facts = [
  fact('Brand Query', 'own_brand', 10, 'B000000001'),
  fact('Competitor Query', 'competitor', 20, 'B000000002'),
  fact('Core Query', 'core', 30, 'B000000003'),
  // The same market demand appears once per ASIN. The model must count the
  // query's demand once while retaining both detailed rows.
  fact('Core Query', 'core', 30, 'B000000004'),
  fact('Generic Query', 'head', 100, 'B000000005'),
  fact('Excluded Query', 'excluded', 5, 'B000000006'),
  fact('Pending Query', 'unreviewed', 7, 'B000000007'),
];

const vocabulary: QueryVocabularyEntry[] = [
  {
    id: '00000000-0000-4000-8000-000000000073',
    orgId: ORG,
    marketplaceId: MARKET,
    kind: 'core_term',
    value: 'Core Query',
    normalizedValue: 'core query',
    source: 'operator',
    approved: true,
    reviewedAt: '2026-08-20T00:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000074',
    orgId: ORG,
    marketplaceId: MARKET,
    kind: 'competitor_brand',
    value: 'Pending Query',
    normalizedValue: 'pending query',
    source: 'ai_suggestion',
    approved: false,
    reviewedAt: null,
  },
];

describe('Query Intelligence view model', () => {
  it('retains the full taxonomy and excludes Generic Head from addressable demand only', () => {
    const model = buildQueryIntelligenceModel({
      facts,
      ppc: [],
      vocabulary,
      promotionRuns: [],
    });

    expect(model.categorySummaries.map(({ category, label }) => ({ category, label }))).toEqual([
      { category: 'own_brand', label: 'Own Brand' },
      { category: 'competitor', label: 'Competitor' },
      { category: 'core', label: 'Core' },
      { category: 'head', label: 'Generic Head' },
      { category: 'excluded', label: 'Excluded' },
      { category: 'unreviewed', label: 'Needs Review' },
    ]);
    expect(model.rawDemand).toBe(172);
    expect(model.addressableDemand).toBe(30);
    expect(model.categorySummaries.find((row) => row.category === 'head')?.searchVolume).toBe(100);
    expect(model.queryRows).toHaveLength(facts.length);
    expect(model.assertions).toMatchObject({ sourceFacts: 7, displayedFactRows: 7 });
  });

  it('keeps ambiguous and profile-only PPC spend explicit and conserves every row', () => {
    const ppcRows = [
      ppc('exact', 'Brand Query', 5, {
        asin: 'B000000001',
        attributedAsins: ['B000000001'],
        groupRole: 'shield',
      }),
      ppc('profile', 'Competitor Query', 7),
      ppc('ambiguous', 'Core Query', 11),
      ppc('unmatched', 'Absent Query', 13),
    ];
    const model = buildQueryIntelligenceModel({
      facts,
      ppc: ppcRows,
      vocabulary,
      promotionRuns: [],
    });

    expect(model.ppcRows.map((row) => row.attribution).sort()).toEqual([
      'ambiguous',
      'asin_exact',
      'profile_only',
      'unmatched',
    ]);
    expect(model.ppcRows.find((row) => row.id === 'ambiguous')).toMatchObject({
      asin: null,
      candidateAsins: ['B000000003', 'B000000004'],
      category: 'core',
    });
    expect(model.ppcRows.find((row) => row.id === 'profile')).toMatchObject({
      asin: null,
      attributionLabel: 'Profile-only',
      category: 'competitor',
    });
    expect(model.ppcSummaries.reduce((sum, row) => sum + row.spend, 0)).toBe(36);
    expect(model.assertions).toEqual({
      sourceFacts: 7,
      displayedFactRows: 7,
      ppcInputRows: 4,
      ppcOutputRows: 4,
      ppcSpendConserved: true,
    });
  });

  it('shows human vocabulary state and promotion reconciliation', () => {
    const model = buildQueryIntelligenceModel({
      facts,
      ppc: [],
      vocabulary,
      promotionRuns: [
        {
          id: '00000000-0000-4000-8000-000000000076',
          sourceSystem: 'amazon_sp_api_brand_analytics',
          promotedAt: '2026-08-24T00:00:00.000Z',
          requestedAsins: ['B000000001'],
          sourceRows: 8,
          parsedRows: 7,
          refusedRows: 1,
          deduplicatedRows: 7,
          promotedRows: 7,
          canonicalRows: 7,
        },
      ],
    });

    expect(model.approvedVocabulary).toBe(1);
    expect(model.pendingVocabulary).toBe(1);
    expect(model.vocabulary.find((entry) => !entry.approved)?.source).toBe('ai_suggestion');
    expect(model.promotionReconciled).toBe(true);
  });
});
