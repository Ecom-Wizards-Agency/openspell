import type {
  ContextualNegativeProposal,
  QueryCategory,
} from '@wizard-ads/shared';
import { normalizeQuery } from './normalize.js';

export interface ContextualNegativePolicy {
  isolatesOwnBrandTraffic: boolean;
  competitorConquest: boolean;
  matchType: ContextualNegativeProposal['matchType'];
}

export interface ContextualNegativeInput {
  profileId: string;
  marketplaceId: string;
  campaignId: string;
  adGroupId: string;
  searchTerm: string;
  category: QueryCategory;
  sourceGroupRole: ContextualNegativeProposal['sourceGroupRole'];
  policy: ContextualNegativePolicy;
}

/**
 * Propose an ad-group negative without altering analytical categorization.
 * This function cannot apply anything: its only output state is `proposed`.
 */
export function proposeContextualNegative(
  input: ContextualNegativeInput,
): ContextualNegativeProposal | null {
  let reason: string | null = null;

  if (input.category === 'excluded') {
    reason = 'Approved exclusion; review for an ad-group negative in every strategy role.';
  } else if (input.category === 'own_brand') {
    if (input.sourceGroupRole !== 'shield' && input.policy.isolatesOwnBrandTraffic) {
      reason = 'Own-brand traffic is routed to Shield; review isolation at this ad group.';
    }
  } else if (input.category === 'competitor' && !input.policy.competitorConquest) {
    reason = 'Competitor traffic is outside this ad group’s conquest route; review isolation.';
  }

  if (!reason) return null;

  return {
    profileId: input.profileId,
    marketplaceId: input.marketplaceId,
    campaignId: input.campaignId,
    adGroupId: input.adGroupId,
    searchTerm: input.searchTerm,
    normalizedQuery: normalizeQuery(input.searchTerm),
    category: input.category,
    sourceGroupRole: input.sourceGroupRole,
    matchType: input.policy.matchType,
    reason,
    status: 'proposed',
  };
}
