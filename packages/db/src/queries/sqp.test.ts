import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ContextualNegativeProposal,
  QueryVocabularyEntry,
  SqpWeeklyFact,
} from '@wizard-ads/shared';
import type { DbHandle } from '../client.js';
import { createTestDatabase, databaseAvailable } from '../testing/harness.js';
import type { TestDatabase } from '../testing/harness.js';
import {
  approveQueryVocabularyEntry,
  listQueryVocabulary,
  persistContextualNegativeProposals,
  persistQueryVocabulary,
  promoteSqpWeeklyFacts,
  readSqpWeeklyFacts,
  readWeeklyPpcQueryFacts,
  SqpPersistenceError,
  StaleSqpPromotionError,
} from './sqp.js';

const available = await databaseAvailable();
const OWNER = '81818181-8181-4181-8181-818181818181';
const WEEK_START = '2026-08-16';
const WEEK_END = '2026-08-22';
const MARKETPLACE = 'marketplace-synthetic';

describe('WP-59 SQP validation without a database', () => {
  const unusable = {
    get db(): never {
      throw new Error('validation touched the database');
    },
  } as unknown as DbHandle;

  it('rejects unreconciled source counts before opening a transaction', async () => {
    await expect(promoteSqpWeeklyFacts(unusable, {
      orgId: '82828282-8282-4282-8282-828282828282',
      profileId: '83838383-8383-4383-8383-838383838383',
      marketplaceId: MARKETPLACE,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      requestedAsins: ['B000000001'],
      ...promotionSource('source-invalid-counts', ['B000000001'], '2026-08-23T00:00:00Z'),
      rows: [fact('83838383-8383-4383-8383-838383838383')],
      counts: {
        sourceAsins: 1,
        sourceRows: 2,
        parsedRows: 1,
        deduplicatedRows: 1,
        refusedRows: 0,
        upserts: 1,
      },
    })).rejects.toBeInstanceOf(SqpPersistenceError);
  });
});

describe.skipIf(!available)('WP-59 SQP database persistence', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;

  beforeAll(async () => {
    database = await createTestDatabase('wp59_sqp');
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('sqp-alpha', ${OWNER}, 'owner')
    `;
    orgId = org?.seed_tenant_fixture ?? '';
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId} limit 1
    `;
    profileId = profile?.id ?? '';
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('replaces one complete ASIN/week scope and proves canonical counts', async () => {
    const rows = [
      fact(profileId, { searchQuery: 'Synthetic Core Query', normalizedQuery: 'synthetic core query' }),
      fact(profileId, {
        searchQuery: 'Synthetic Second Query',
        normalizedQuery: 'synthetic second query',
        searchQueryVolume: 50,
      }),
    ];
    const first = await promoteSqpWeeklyFacts(database, {
      orgId,
      profileId,
      marketplaceId: MARKETPLACE,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      requestedAsins: ['B000000001'],
      ...promotionSource('source-first', ['B000000001'], '2026-08-23T00:00:00Z'),
      rows,
      counts: {
        sourceAsins: 1,
        sourceRows: 2,
        parsedRows: 2,
        deduplicatedRows: 2,
        refusedRows: 0,
        upserts: 2,
      },
    });
    expect(first).toMatchObject({
      status: 'promoted',
      promotionRunId: expect.any(String),
      sourceAsins: 1,
      sourceRows: 2,
      parsedRows: 2,
      deduplicatedRows: 2,
      refusedRows: 0,
      deletedRows: 0,
      promotedRows: 2,
      upserts: 2,
      canonicalRows: 2,
    });

    const revised = await promoteSqpWeeklyFacts(database, {
      orgId,
      profileId,
      marketplaceId: MARKETPLACE,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      requestedAsins: ['B000000001'],
      ...promotionSource('source-revised', ['B000000001'], '2026-08-24T00:00:00Z'),
      rows: [{ ...rows[0]!, asinClicks: 5, asinClickShare: 0.25 }],
      counts: {
        sourceAsins: 1,
        sourceRows: 1,
        parsedRows: 1,
        deduplicatedRows: 1,
        refusedRows: 0,
        upserts: 1,
      },
    });
    expect(revised).toMatchObject({ deletedRows: 2, promotedRows: 1, upserts: 1, canonicalRows: 1 });
    const readBack = await readSqpWeeklyFacts(database, {
      orgId,
      profileId,
      marketplaceId: MARKETPLACE,
      weekStart: WEEK_START,
    });
    expect(readBack).toHaveLength(1);
    expect(readBack[0]).toMatchObject({
      normalizedQuery: 'synthetic core query',
      category: 'unreviewed',
      asinClicks: 5,
    });

    const empty = await promoteSqpWeeklyFacts(database, {
      orgId,
      profileId,
      marketplaceId: MARKETPLACE,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      requestedAsins: ['B000000001'],
      ...promotionSource('source-empty', ['B000000001'], '2026-08-25T00:00:00Z'),
      rows: [],
      counts: {
        sourceAsins: 0,
        sourceRows: 0,
        parsedRows: 0,
        deduplicatedRows: 0,
        refusedRows: 0,
        upserts: 0,
      },
    });
    expect(empty).toMatchObject({ deletedRows: 1, promotedRows: 0, upserts: 0, canonicalRows: 0 });
  });

  it('makes an exact source-report retry idempotent and rechecks canonical counts', async () => {
    const marketplaceId = 'marketplace-idempotent';
    const input = promotionInput({
      orgId,
      profileId,
      marketplaceId,
      requestIdentity: 'source-idempotent',
      requestedAt: '2026-08-23T02:00:00Z',
      rows: [fact(profileId, {
        marketplaceId,
        searchQuery: 'Idempotent Synthetic Query',
        normalizedQuery: 'idempotent synthetic query',
      })],
    });

    const first = await promoteSqpWeeklyFacts(database, input);
    const retry = await promoteSqpWeeklyFacts(database, input);
    expect(first).toMatchObject({ status: 'promoted', promotedRows: 1, canonicalRows: 1 });
    expect(retry).toMatchObject({
      status: 'already_promoted',
      promotionRunId: first.promotionRunId,
      deletedRows: 0,
      promotedRows: 0,
      upserts: 0,
      canonicalRows: 1,
    });
    const [ledger] = await database.sql<{ n: string }[]>`
      select count(*) as n from public.sqp_promotion_runs
       where profile_id = ${profileId} and request_identity = 'source-idempotent'
    `;
    expect(Number(ledger?.n)).toBe(1);
  });

  it('rejects an older overlapping ASIN scope before any canonical replacement', async () => {
    const marketplaceId = 'marketplace-stale';
    const newer = promotionInput({
      orgId,
      profileId,
      marketplaceId,
      requestIdentity: 'source-newer',
      requestedAt: '2026-08-24T03:00:00Z',
      rows: [fact(profileId, {
        marketplaceId,
        searchQuery: 'Newer Synthetic Evidence',
        normalizedQuery: 'newer synthetic evidence',
        asinClicks: 9,
      })],
    });
    await promoteSqpWeeklyFacts(database, newer);

    const stale = promotionInput({
      orgId,
      profileId,
      marketplaceId,
      requestIdentity: 'source-stale',
      requestedAt: '2026-08-24T02:00:00Z',
      requestedAsins: ['B000000001', 'B000000002'],
      rows: [
        fact(profileId, {
          marketplaceId,
          searchQuery: 'Stale Synthetic Evidence',
          normalizedQuery: 'stale synthetic evidence',
          asinClicks: 1,
        }),
        fact(profileId, {
          marketplaceId,
          asin: 'B000000002',
          searchQuery: 'Stale Second ASIN',
          normalizedQuery: 'stale second asin',
        }),
      ],
    });
    await expect(promoteSqpWeeklyFacts(database, stale)).rejects.toBeInstanceOf(
      StaleSqpPromotionError,
    );
    const readBack = await readSqpWeeklyFacts(database, {
      orgId,
      profileId,
      marketplaceId,
      weekStart: WEEK_START,
    });
    expect(readBack).toHaveLength(1);
    expect(readBack[0]).toMatchObject({
      normalizedQuery: 'newer synthetic evidence',
      asinClicks: 9,
    });
    const [staleRuns] = await database.sql<{ n: string }[]>`
      select count(*) as n from public.sqp_promotion_runs
       where profile_id = ${profileId} and request_identity = 'source-stale'
    `;
    expect(Number(staleRuns?.n)).toBe(0);
  });

  it('serializes concurrent overlapping batches and leaves the newer evidence canonical', async () => {
    const marketplaceId = 'marketplace-concurrent';
    const requestedAsins = ['B000000001', 'B000000002'];
    const older = promotionInput({
      orgId,
      profileId,
      marketplaceId,
      requestIdentity: 'source-concurrent-older',
      requestedAt: '2026-08-25T01:00:00Z',
      requestedAsins,
      rows: requestedAsins.map((asin, index) => fact(profileId, {
        marketplaceId,
        asin,
        searchQuery: `Concurrent Older ${index}`,
        normalizedQuery: `concurrent older ${index}`,
        asinClicks: 1,
      })),
    });
    const newer = promotionInput({
      orgId,
      profileId,
      marketplaceId,
      requestIdentity: 'source-concurrent-newer',
      requestedAt: '2026-08-25T02:00:00Z',
      requestedAsins: [...requestedAsins].reverse(),
      rows: requestedAsins.map((asin, index) => fact(profileId, {
        marketplaceId,
        asin,
        searchQuery: `Concurrent Newer ${index}`,
        normalizedQuery: `concurrent newer ${index}`,
        asinClicks: 7 + index,
      })),
    });

    const [olderResult, newerResult] = await Promise.allSettled([
      promoteSqpWeeklyFacts(database, older),
      promoteSqpWeeklyFacts(database, newer),
    ]);
    expect(newerResult.status).toBe('fulfilled');
    if (olderResult.status === 'rejected') {
      expect(olderResult.reason).toBeInstanceOf(StaleSqpPromotionError);
    }
    const readBack = await readSqpWeeklyFacts(database, {
      orgId,
      profileId,
      marketplaceId,
      weekStart: WEEK_START,
    });
    expect(readBack.map((row) => [row.asin, row.normalizedQuery, row.asinClicks])).toEqual([
      ['B000000001', 'concurrent newer 0', 7],
      ['B000000002', 'concurrent newer 1', 8],
    ]);
  });

  it('keeps AI vocabulary pending until review and never undoes approval', async () => {
    const suggestion: QueryVocabularyEntry = {
      orgId,
      marketplaceId: MARKETPLACE,
      kind: 'core_term',
      value: 'Synthetic Core',
      normalizedValue: 'synthetic core',
      source: 'ai_suggestion',
      approved: false,
      reviewedAt: null,
    };
    expect(await persistQueryVocabulary(database, [suggestion])).toEqual({
      offered: 1,
      upserts: 1,
      readBack: 1,
      approvedReadBack: 0,
    });
    const pending = await listQueryVocabulary(database, {
      orgId,
      marketplaceId: MARKETPLACE,
      approved: false,
    });
    expect(pending).toHaveLength(1);
    const approved = await approveQueryVocabularyEntry(database, {
      orgId,
      id: pending[0]!.id!,
      reviewedBy: OWNER,
      reviewedAt: new Date('2026-08-29T00:00:00Z'),
    });
    expect(approved).toMatchObject({ approved: true, source: 'ai_suggestion' });

    expect(await persistQueryVocabulary(database, [{ ...suggestion, value: 'Synthetic Core Updated' }]))
      .toMatchObject({ approvedReadBack: 1 });
    expect(await listQueryVocabulary(database, { orgId, marketplaceId: MARKETPLACE }))
      .toEqual([{ ...approved, value: 'Synthetic Core Updated' }]);
    expect(await listQueryVocabulary(database, {
      orgId: '00000000-0000-4000-8000-000000000000',
      marketplaceId: MARKETPLACE,
    })).toEqual([]);
  });

  it('persists review-only contextual proposals without resetting a human decision', async () => {
    const proposal: ContextualNegativeProposal = {
      profileId,
      marketplaceId: MARKETPLACE,
      campaignId: 'campaign-synthetic',
      adGroupId: 'ad-group-synthetic',
      searchTerm: 'Synthetic Exclusion',
      normalizedQuery: 'synthetic exclusion',
      category: 'excluded',
      sourceGroupRole: 'profit',
      matchType: 'negative_exact',
      reason: 'Synthetic approved exclusion; review at this ad group.',
      status: 'proposed',
    };
    expect(await persistContextualNegativeProposals(database, {
      orgId,
      profileId,
      proposals: [proposal],
    })).toEqual({ offered: 1, upserts: 1, readBack: 1, preservedHumanDecisions: 0 });
    await database.sql`
      update public.contextual_negative_proposals
         set status = 'accepted', decided_at = now(), decided_by = ${OWNER}
       where org_id = ${orgId} and profile_id = ${profileId}
         and campaign_id = 'campaign-synthetic'
    `;
    expect(await persistContextualNegativeProposals(database, {
      orgId,
      profileId,
      proposals: [{
        ...proposal,
        searchTerm: 'Synthetic changed term',
        category: 'competitor',
        sourceGroupRole: 'discovery',
        reason: 'Synthetic refreshed reason.',
      }],
    })).toEqual({ offered: 1, upserts: 1, readBack: 1, preservedHumanDecisions: 1 });
    const [preserved] = await database.sql<{
      search_term: string;
      category: string;
      source_group_role: string;
      reason: string;
    }[]>`
      select search_term, category::text as category, source_group_role, reason
        from public.contextual_negative_proposals
       where org_id = ${orgId} and profile_id = ${profileId}
         and campaign_id = 'campaign-synthetic'
    `;
    expect(preserved).toEqual({
      search_term: 'Synthetic Exclusion',
      category: 'excluded',
      source_group_role: 'profit',
      reason: 'Synthetic approved exclusion; review at this ad group.',
    });
  });

  it('aggregates PPC before ASIN resolution so ambiguous ad groups do not multiply spend', async () => {
    await database.sql`
      insert into public.fact_search_term_daily (
        org_id, profile_id, date, ad_product, campaign_id, ad_group_id,
        search_term, impressions, clicks, cost, purchases_7d, sales_7d, units_sold_7d
      ) values
        (${orgId}, ${profileId}, '2026-08-18', 'SP', 'campaign-ppc', 'group-many',
         'Synthetic Shared Query', 100, 10, 7, 2, 20, 2),
        (${orgId}, ${profileId}, '2026-08-19', 'SP', 'campaign-ppc', 'group-many',
         'Synthetic Shared Query', 50, 5, 3, 1, 10, 1),
        (${orgId}, ${profileId}, '2026-08-18', 'SP', 'campaign-ppc', 'group-one',
         'Synthetic Exact Query', 40, 4, 2, 1, 8, 1)
    `;
    await database.sql`
      insert into public.product_ads (
        org_id, profile_id, amazon_id, ad_product, name, state,
        campaign_id, ad_group_id, asin
      ) values
        (${orgId}, ${profileId}, 'product-one', 'SP', 'Synthetic one', 'enabled',
         'campaign-ppc', 'group-many', 'B000000001'),
        (${orgId}, ${profileId}, 'product-two', 'SP', 'Synthetic two', 'enabled',
         'campaign-ppc', 'group-many', 'B000000002'),
        (${orgId}, ${profileId}, 'product-three', 'SP', 'Synthetic three', 'enabled',
         'campaign-ppc', 'group-one', 'B000000003')
    `;
    const rows = await readWeeklyPpcQueryFacts(database, {
      orgId,
      profileId,
      marketplaceId: MARKETPLACE,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
    });
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.adGroupId === 'group-many')).toMatchObject({
      asin: null,
      attributedAsins: ['B000000001', 'B000000002'],
      spend: 10,
      clicks: 15,
      orders: 3,
    });
    expect(rows.find((row) => row.adGroupId === 'group-one')).toMatchObject({
      asin: 'B000000003',
      attributedAsins: ['B000000003'],
      spend: 2,
    });
    expect(rows.reduce((sum, row) => sum + row.spend, 0)).toBe(12);
  });
});

function fact(profileId: string, overrides: Partial<SqpWeeklyFact> = {}): SqpWeeklyFact {
  return {
    profileId,
    marketplaceId: MARKETPLACE,
    asin: 'B000000001',
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
    searchQuery: 'Synthetic Query',
    normalizedQuery: 'synthetic query',
    category: 'unreviewed',
    searchQueryScore: 1,
    searchQueryVolume: 100,
    totalImpressions: 80,
    asinImpressions: 8,
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
    ...overrides,
  };
}

function promotionSource(
  requestIdentity: string,
  requestedAsins: readonly string[],
  requestedAtValue: string,
): Pick<
  Parameters<typeof promoteSqpWeeklyFacts>[1],
  'requestIdentity' | 'requestedAt' | 'completedAt' | 'sourceReports'
> {
  const requestedAt = new Date(requestedAtValue);
  const completedAt = new Date(requestedAt.valueOf() + 300_000);
  return {
    requestIdentity,
    requestedAt,
    completedAt,
    sourceReports: [{
      requestKey: `request-${requestIdentity}`,
      reportId: `report-${requestIdentity}`,
      reportDocumentId: `document-${requestIdentity}`,
      requestedAt,
      completedAt,
      providerCreatedAt: new Date(requestedAt.valueOf() + 1_000),
      requestedAsins,
    }],
  };
}

function promotionInput(input: {
  orgId: string;
  profileId: string;
  marketplaceId: string;
  requestIdentity: string;
  requestedAt: string;
  requestedAsins?: readonly string[];
  rows: readonly SqpWeeklyFact[];
}): Parameters<typeof promoteSqpWeeklyFacts>[1] {
  const requestedAsins = input.requestedAsins ?? ['B000000001'];
  return {
    orgId: input.orgId,
    profileId: input.profileId,
    marketplaceId: input.marketplaceId,
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
    requestedAsins,
    ...promotionSource(input.requestIdentity, requestedAsins, input.requestedAt),
    rows: input.rows,
    counts: {
      sourceAsins: new Set(input.rows.map((row) => row.asin)).size,
      sourceRows: input.rows.length,
      parsedRows: input.rows.length,
      deduplicatedRows: input.rows.length,
      refusedRows: 0,
      upserts: input.rows.length,
    },
  };
}
