import { describe, expect, it } from 'vitest';
import {
  proposeContextualNegative,
  type ContextualNegativeInput,
} from './negatives.js';

const BASE = {
  profileId: '00000000-0000-4000-8000-000000000021',
  marketplaceId: 'ATVPDKIKX0DER',
  campaignId: '100000000001',
  adGroupId: '200000000001',
  searchTerm: 'synthetic query',
  sourceGroupRole: 'profit',
  policy: {
    isolatesOwnBrandTraffic: false,
    competitorConquest: false,
    matchType: 'negative_exact',
  },
} as const;

function proposal(
  over: Partial<ContextualNegativeInput> & Pick<ContextualNegativeInput, 'category'>,
) {
  return proposeContextualNegative({ ...BASE, ...over });
}

describe('contextual negative policy', () => {
  it('proposes approved exclusions in every group at ad-group level', () => {
    for (const sourceGroupRole of ['rank', 'discovery', 'profit', 'shield'] as const) {
      expect(proposal({ category: 'excluded', sourceGroupRole })).toMatchObject({
        adGroupId: BASE.adGroupId,
        category: 'excluded',
        sourceGroupRole,
        status: 'proposed',
      });
    }
  });

  it('keeps own brand valid in Shield and isolates it elsewhere only when policy says so', () => {
    expect(proposal({ category: 'own_brand', sourceGroupRole: 'shield' })).toBeNull();
    expect(proposal({ category: 'own_brand', sourceGroupRole: 'profit' })).toBeNull();
    expect(
      proposal({
        category: 'own_brand',
        sourceGroupRole: 'profit',
        policy: { ...BASE.policy, isolatesOwnBrandTraffic: true },
      }),
    ).toMatchObject({ category: 'own_brand', status: 'proposed' });
  });

  it('keeps competitor queries in conquest and proposes isolation elsewhere', () => {
    expect(
      proposal({
        category: 'competitor',
        policy: { ...BASE.policy, competitorConquest: true },
      }),
    ).toBeNull();
    expect(proposal({ category: 'competitor' })).toMatchObject({
      category: 'competitor',
      status: 'proposed',
    });
  });

  it.each(['core', 'head', 'unreviewed'] as const)(
    'does not negate %s solely because of its analytics category',
    (category) => {
      expect(proposal({ category })).toBeNull();
    },
  );

  it('can only return a review/export proposal, never an Amazon mutation', () => {
    const result = proposal({ category: 'excluded' });
    expect(result?.status).toBe('proposed');
    expect(Object.keys(result ?? {})).not.toContain('apply');
  });
});
