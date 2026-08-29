import type {
  QueryCategory,
  QueryVocabularyEntry,
  QueryVocabularyKind,
} from '@wizard-ads/shared';
import { containsTokenSequence, normalizeQuery } from './normalize.js';

export const QUERY_CATEGORY_LABELS = {
  own_brand: 'Own Brand',
  competitor: 'Competitor',
  core: 'Core',
  head: 'Generic Head',
  excluded: 'Excluded',
  unreviewed: 'Needs Review',
} as const satisfies Record<QueryCategory, string>;

const CATEGORY_PRECEDENCE = [
  'excluded',
  'own_brand',
  'competitor',
  'core',
] as const satisfies readonly QueryCategory[];

const CATEGORY_BY_KIND = {
  own_brand_term: 'own_brand',
  own_brand_alias: 'own_brand',
  competitor_brand: 'competitor',
  competitor_asin: 'competitor',
  core_term: 'core',
  exclusion: 'excluded',
} as const satisfies Record<QueryVocabularyKind, QueryCategory>;

export interface QueryClassification {
  searchQuery: string;
  normalizedQuery: string;
  category: QueryCategory;
  label: (typeof QUERY_CATEGORY_LABELS)[QueryCategory];
  matchedEntries: QueryVocabularyEntry[];
  pendingSuggestions: QueryVocabularyEntry[];
  requiresHumanApproval: boolean;
}

export interface ClassifyQueryInput {
  searchQuery: string;
  marketplaceId: string;
  vocabulary: readonly QueryVocabularyEntry[];
}

function entryMatches(normalizedQuery: string, entry: QueryVocabularyEntry): boolean {
  const candidate = normalizeQuery(entry.normalizedValue || entry.value);
  if (!candidate) return false;
  return containsTokenSequence(normalizedQuery, candidate);
}

/**
 * Apply the approved marketplace vocabulary to one customer search query.
 *
 * Explicit exclusions take precedence, then own-brand, competitor and core.
 * The generic remainder is Head. A matching unapproved entry remains Needs
 * Review; suggestions never become truth until a human approves them.
 */
export function classifyQuery(input: ClassifyQueryInput): QueryClassification {
  const normalizedQuery = normalizeQuery(input.searchQuery);
  const applicable = input.vocabulary.filter(
    (entry) =>
      entry.marketplaceId === input.marketplaceId &&
      entryMatches(normalizedQuery, entry),
  );
  const approved = applicable.filter((entry) => entry.approved);
  const pendingSuggestions = applicable.filter((entry) => !entry.approved);

  let category: QueryCategory | undefined;
  let matchedEntries: QueryVocabularyEntry[] = [];
  for (const candidate of CATEGORY_PRECEDENCE) {
    const matches = approved.filter((entry) => CATEGORY_BY_KIND[entry.kind] === candidate);
    if (matches.length > 0) {
      category = candidate;
      matchedEntries = matches;
      break;
    }
  }

  if (!category) category = pendingSuggestions.length > 0 ? 'unreviewed' : 'head';

  return {
    searchQuery: input.searchQuery,
    normalizedQuery,
    category,
    label: QUERY_CATEGORY_LABELS[category],
    matchedEntries,
    pendingSuggestions,
    requiresHumanApproval: category === 'unreviewed',
  };
}

export interface SponsoredBrandsIntentInput extends ClassifyQueryInput {
  /** Retained only to make accidental target-based classification testable. */
  targetingExpression?: string | null;
}

/** Sponsored Brands intent is always classified from the customer query. */
export function classifySponsoredBrandsIntent(
  input: SponsoredBrandsIntentInput,
): QueryClassification {
  return classifyQuery({
    searchQuery: input.searchQuery,
    marketplaceId: input.marketplaceId,
    vocabulary: input.vocabulary,
  });
}

export function isBrandedCategory(category: QueryCategory): boolean {
  return category === 'own_brand';
}

export function isAddressableOpportunityCategory(
  category: QueryCategory,
  options: { includeCompetitor?: boolean } = {},
): boolean {
  return category === 'core' || (options.includeCompetitor === true && category === 'competitor');
}
