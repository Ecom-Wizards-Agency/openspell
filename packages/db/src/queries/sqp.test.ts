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
    expect(first).toEqual({
      sourceAsins: 1,
      sourceRows: 2,
      parsedRows: 2,
      deduplicatedRows: 2,
      refusedRows: 0,
      deletedRows: 0,
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
    expect(revised).toMatchObject({ deletedRows: 2, upserts: 1, canonicalRows: 1 });
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
    expect(empty).toMatchObject({ deletedRows: 1, upserts: 0, canonicalRows: 0 });
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
         set status = 'accepted'
       where org_id = ${orgId} and profile_id = ${profileId}
         and campaign_id = 'campaign-synthetic'
    `;
    expect(await persistContextualNegativeProposals(database, {
      orgId,
      profileId,
      proposals: [{ ...proposal, reason: 'Synthetic refreshed reason.' }],
    })).toEqual({ offered: 1, upserts: 1, readBack: 1, preservedHumanDecisions: 1 });
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
