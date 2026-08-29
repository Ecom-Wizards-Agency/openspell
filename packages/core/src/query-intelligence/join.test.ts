import type { SqpWeeklyFact } from '@wizard-ads/shared';
import { describe, expect, it } from 'vitest';
import {
  joinSqpAndPpc,
  verifySpendConservation,
  type PpcQueryFact,
} from './join.js';

const PROFILE = '00000000-0000-4000-8000-000000000011';
const OTHER_PROFILE = '00000000-0000-4000-8000-000000000012';
const MARKET = 'ATVPDKIKX0DER';
const WEEK = '2026-01-04';

function sqp(asin: string, query: string, profileId = PROFILE): SqpWeeklyFact {
  return {
    profileId,
    marketplaceId: MARKET,
    asin,
    weekStart: WEEK,
    weekEnd: '2026-01-10',
    searchQuery: query,
    normalizedQuery: query.toLowerCase(),
    category: 'core',
    searchQueryScore: null,
    searchQueryVolume: 100,
    totalImpressions: 1000,
    asinImpressions: 100,
    asinImpressionShare: 0.1,
    totalClicks: 100,
    asinClicks: 10,
    asinClickShare: 0.1,
    totalCartAdds: 20,
    asinCartAdds: 2,
    asinCartAddShare: 0.1,
    totalPurchases: 10,
    asinPurchases: 1,
    asinPurchaseShare: 0.1,
  };
}

function ppc(
  id: string,
  searchTerm: string,
  spend: number,
  over: Partial<PpcQueryFact> = {},
): PpcQueryFact {
  return {
    id,
    profileId: PROFILE,
    marketplaceId: MARKET,
    weekStart: WEEK,
    searchTerm,
    spend,
    sales: spend * 2,
    clicks: 5,
    orders: 1,
    ...over,
  };
}

describe('joinSqpAndPpc', () => {
  const sqpFacts = [
    sqp('B000000001', 'Travel Mug'),
    sqp('B000000001', 'Shared Query'),
    sqp('B000000002', 'Shared Query'),
    sqp('B000000003', 'Unique Query'),
    sqp('B000000004', 'Other Profile', OTHER_PROFILE),
  ];
  const ppcFacts = [
    ppc('exact', 'travel-mug', 7, { asin: 'b000000001' }),
    ppc('profile-only', 'unique query', 11),
    ppc('ambiguous', 'shared query', 13),
    ppc('unmatched', 'absent query', 17),
    ppc('declared-ambiguous', 'shared query', 19, {
      attributedAsins: ['B000000001', 'B000000002'],
    }),
    ppc('wrong-profile', 'other profile', 23),
  ];

  it('uses exact ASIN attribution where supported and leaves profile-only spend unassigned', () => {
    const rows = joinSqpAndPpc(sqpFacts, ppcFacts);
    const byId = new Map(rows.map((row) => [row.ppc.id, row]));
    expect(byId.get('exact')).toMatchObject({
      asin: 'B000000001',
      attribution: 'asin_exact',
      candidateAsins: ['B000000001'],
    });
    expect(byId.get('profile-only')).toMatchObject({
      asin: null,
      attribution: 'profile_only',
      candidateAsins: ['B000000003'],
      sqp: null,
    });
    expect(byId.get('ambiguous')).toMatchObject({
      asin: null,
      attribution: 'ambiguous',
      candidateAsins: ['B000000001', 'B000000002'],
    });
    expect(byId.get('declared-ambiguous')?.attribution).toBe('ambiguous');
    expect(byId.get('unmatched')?.attribution).toBe('unmatched');
    expect(byId.get('wrong-profile')?.attribution).toBe('unmatched');
  });

  it('normalizes punctuation on the exact join and conserves every PPC row and spend unit', () => {
    const rows = joinSqpAndPpc(sqpFacts, ppcFacts);
    expect(rows.find((row) => row.ppc.id === 'exact')?.normalizedQuery).toBe('travel mug');
    expect(rows).toHaveLength(ppcFacts.length);
    expect(verifySpendConservation(ppcFacts, rows)).toEqual({
      inputSpend: 90,
      outputSpend: 90,
      inputRows: 6,
      outputRows: 6,
      conserved: true,
    });
    expect(rows.filter((row) => row.ppc.id === 'ambiguous')).toHaveLength(1);
  });

  it('marks duplicate exact SQP keys ambiguous instead of selecting one arbitrarily', () => {
    const duplicate = sqp('B000000001', 'Travel Mug');
    const [row] = joinSqpAndPpc([...sqpFacts, duplicate], [ppcFacts[0] as PpcQueryFact]);
    expect(row).toMatchObject({ attribution: 'ambiguous', asin: null, sqp: null });
  });
});
