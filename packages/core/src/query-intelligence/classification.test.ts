import type { QueryVocabularyEntry } from '@wizard-ads/shared';
import { describe, expect, it } from 'vitest';
import {
  QUERY_CATEGORY_LABELS,
  classifyQuery,
  classifySponsoredBrandsIntent,
} from './classification.js';
import { containsTokenSequence, normalizeQuery } from './normalize.js';
import { compareLikeForLikeIntent, rollupQueryCategories } from './rollup.js';

const ORG = '00000000-0000-4000-8000-000000000001';
const MARKET = 'ATVPDKIKX0DER';

function entry(
  kind: QueryVocabularyEntry['kind'],
  value: string,
  over: Partial<QueryVocabularyEntry> = {},
): QueryVocabularyEntry {
  return {
    orgId: ORG,
    marketplaceId: MARKET,
    kind,
    value,
    normalizedValue: normalizeQuery(value),
    source: 'operator',
    approved: true,
    reviewedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('query normalization and boundary matching', () => {
  it('folds Unicode, punctuation and spelled-out brand punctuation deterministically', () => {
    expect(normalizeQuery('  N.O.V.A. — Crème  ')).toBe('nova creme');
    expect(normalizeQuery('N-O-V-A creme')).toBe('nova creme');
  });

  it('does not match a short token inside an unrelated word', () => {
    expect(containsTokenSequence('mac makeup brush', 'mac')).toBe(true);
    expect(containsTokenSequence('macadamia hair mask', 'mac')).toBe(false);
    expect(containsTokenSequence('shelf organizer', 'elf')).toBe(false);
  });
});

describe('classifyQuery', () => {
  const vocabulary = [
    entry('own_brand_term', 'nova'),
    entry('own_brand_alias', 'novva'),
    entry('competitor_brand', 'orbit goods'),
    entry('competitor_asin', 'B012345678'),
    entry('core_term', 'travel mug'),
    entry('exclusion', 'replacement lid'),
  ];

  it('uses the complete presentation taxonomy', () => {
    expect(QUERY_CATEGORY_LABELS).toEqual({
      own_brand: 'Own Brand',
      competitor: 'Competitor',
      core: 'Core',
      head: 'Generic Head',
      excluded: 'Excluded',
      unreviewed: 'Needs Review',
    });
  });

  it.each([
    ['N.O.V.A travel mug', 'own_brand'],
    ['NOVVA travel mug', 'own_brand'],
    ['Orbit Goods mug', 'competitor'],
    ['B012345678', 'competitor'],
    ['insulated travel-mug', 'core'],
    ['kitchen gifts', 'head'],
  ] as const)('classifies %s as %s', (searchQuery, expected) => {
    expect(classifyQuery({ searchQuery, marketplaceId: MARKET, vocabulary }).category).toBe(
      expected,
    );
  });

  it('gives an explicit exclusion precedence over other matching categories', () => {
    const result = classifyQuery({
      searchQuery: 'nova replacement lid for travel mug',
      marketplaceId: MARKET,
      vocabulary,
    });
    expect(result.category).toBe('excluded');
    expect(result.matchedEntries.map((match) => match.kind)).toEqual(['exclusion']);
  });

  it('keeps an unapproved AI suggestion in Needs Review until a human approves it', () => {
    const suggestion = entry('core_term', 'commuter cup', {
      source: 'ai_suggestion',
      approved: false,
      reviewedAt: null,
    });
    const pending = classifyQuery({
      searchQuery: 'commuter cup',
      marketplaceId: MARKET,
      vocabulary: [...vocabulary, suggestion],
    });
    expect(pending).toMatchObject({ category: 'unreviewed', requiresHumanApproval: true });
    expect(pending.pendingSuggestions).toHaveLength(1);

    const approved = classifyQuery({
      searchQuery: 'commuter cup',
      marketplaceId: MARKET,
      vocabulary: [...vocabulary, { ...suggestion, approved: true }],
    });
    expect(approved).toMatchObject({ category: 'core', requiresHumanApproval: false });
  });

  it('does not leak vocabulary across marketplaces', () => {
    const result = classifyQuery({
      searchQuery: 'nova travel mug',
      marketplaceId: 'A1PA6795UKMFR9',
      vocabulary,
    });
    expect(result.category).toBe('head');
  });

  it('classifies Sponsored Brands from the customer search term, never its target', () => {
    const result = classifySponsoredBrandsIntent({
      searchQuery: 'insulated travel mug',
      targetingExpression: 'asin=B012345678',
      marketplaceId: MARKET,
      vocabulary,
    });
    expect(result.category).toBe('core');
  });

  it('classifies every input exactly once', () => {
    const inputs = ['nova mug', 'orbit goods mug', 'travel mug', 'large cup'];
    const outputs = inputs.map((searchQuery) =>
      classifyQuery({ searchQuery, marketplaceId: MARKET, vocabulary }),
    );
    expect(outputs).toHaveLength(inputs.length);
    expect(outputs.every((output) => output.normalizedQuery.length > 0)).toBe(true);
  });
});

describe('query rollups', () => {
  const rows = [
    { category: 'own_brand', value: 11 },
    { category: 'competitor', value: 7 },
    { category: 'core', value: 19 },
    { category: 'head', value: 101 },
    { category: 'excluded', value: 5 },
    { category: 'unreviewed', value: 3 },
  ] as const;

  it('retains raw and detailed totals while excluding Generic Head from opportunity', () => {
    const result = rollupQueryCategories(rows);
    expect(result.rawTotal).toBe(146);
    expect(result.detailed.head).toBe(101);
    expect(result.addressableOpportunity).toBe(19);
    expect(result.branded).toBe(11);
    expect(result.nonBranded).toBe(135);
    expect(Object.values(result.detailed).reduce((sum, value) => sum + value, 0)).toBe(
      result.rawTotal,
    );
  });

  it('includes competitor opportunity only when the caller explicitly opts in', () => {
    expect(rollupQueryCategories(rows, { includeCompetitorOpportunity: true }).addressableOpportunity).toBe(
      26,
    );
  });

  it('permits like-for-like comparisons and rejects branded-vs-generic comparisons', () => {
    expect(
      compareLikeForLikeIntent(
        { category: 'core', value: 20 },
        { category: 'core', value: 25 },
      ),
    ).toEqual({ category: 'core', previous: 20, current: 25, delta: 5 });
    expect(() =>
      compareLikeForLikeIntent(
        { category: 'own_brand', value: 20 },
        { category: 'core', value: 25 },
      ),
    ).toThrow('Intent mismatch');
  });
});
