/**
 * N-gram aggregation and negative candidates.
 *
 * The assertions worth reading are the two that stop the module lying: a gram
 * repeated inside one search term is counted once, and gram totals are allowed
 * to exceed account spend because a term contributes to every gram it contains.
 */
import { describe, expect, it } from 'vitest';
import { aggregateNgrams, gramsOf, negativeCandidates, tokenize, type SearchTermRow } from './ngram.js';

function row(searchTerm: string, over: Partial<SearchTermRow> = {}): SearchTermRow {
  return {
    searchTerm,
    impressions: 100,
    clicks: 10,
    cost: 10,
    purchases7d: 1,
    sales7d: 40,
    ...over,
  };
}

describe('tokenization', () => {
  it('lowercases, splits on punctuation and keeps digits', () => {
    expect(tokenize('Blue Widget, 2-Pack!')).toEqual(['blue', 'widget', '2', 'pack']);
  });

  it('builds contiguous windows and de-duplicates within a term', () => {
    expect(gramsOf(['blue', 'widget', 'blue'], 1)).toEqual(['blue', 'widget']);
    expect(gramsOf(['blue', 'widget', 'case'], 2)).toEqual(['blue widget', 'widget case']);
    expect(gramsOf(['blue', 'widget'], 3)).toEqual([]);
  });
});

describe('aggregateNgrams', () => {
  const rows = [
    row('blue widget case', { clicks: 10, cost: 20, purchases7d: 2, sales7d: 100, impressions: 200 }),
    row('blue widget', { clicks: 5, cost: 5, purchases7d: 0, sales7d: 0, impressions: 50 }),
    row('red widget', { clicks: 4, cost: 8, purchases7d: 1, sales7d: 30, impressions: 60 }),
  ];

  it('pools spend and sales across the terms a gram appears in', () => {
    const grams = aggregateNgrams(rows);
    const widget = grams.find((g) => g.gram === 'widget' && g.n === 1);
    expect(widget).toBeDefined();
    expect(widget?.searchTerms).toBe(3);
    expect(widget?.clicks).toBe(19);
    expect(widget?.cost).toBe(33);
    expect(widget?.sales).toBe(130);
    expect(widget?.rpc).toBeCloseTo(130 / 19, 10);
    expect(widget?.cvr).toBeCloseTo(3 / 19, 10);
    expect(widget?.acos).toBeCloseTo(33 / 130, 10);
  });

  it('counts a repeated gram once per search term', () => {
    const grams = aggregateNgrams([row('widget widget widget', { clicks: 6, cost: 6 })]);
    const widget = grams.find((g) => g.gram === 'widget');
    expect(widget?.searchTerms).toBe(1);
    expect(widget?.clicks).toBe(6);
  });

  it('builds bi- and tri-grams and can be restricted to one size', () => {
    const grams = aggregateNgrams(rows);
    expect(grams.some((g) => g.gram === 'blue widget' && g.n === 2)).toBe(true);
    expect(grams.some((g) => g.gram === 'blue widget case' && g.n === 3)).toBe(true);
    const unigramsOnly = aggregateNgrams(rows, { sizes: [1] });
    expect(unigramsOnly.every((g) => g.n === 1)).toBe(true);
  });

  it('drops thin grams when a click floor is set', () => {
    // 'blue' has 15 clicks and 'widget' 19; 'case' has 10 and 'red' 4.
    const grams = aggregateNgrams(rows, { sizes: [1], minClicks: 11 });
    expect(grams.map((g) => g.gram).sort()).toEqual(['blue', 'widget']);
  });

  it('is ordered by cost and stable regardless of input order', () => {
    const forwards = aggregateNgrams(rows);
    const backwards = aggregateNgrams([...rows].reverse());
    expect(forwards.map((g) => `${g.n}:${g.gram}`)).toEqual(backwards.map((g) => `${g.n}:${g.gram}`));
    for (let i = 1; i < forwards.length; i += 1) {
      expect((forwards[i - 1] as { cost: number }).cost).toBeGreaterThanOrEqual((forwards[i] as { cost: number }).cost);
    }
  });

  it('does not pretend gram totals sum to account spend', () => {
    const accountSpend = rows.reduce((sum, r) => sum + r.cost, 0);
    const unigramSpend = aggregateNgrams(rows, { sizes: [1] }).reduce((sum, g) => sum + g.cost, 0);
    // Overlap is inherent: every term feeds every gram it contains.
    expect(unigramSpend).toBeGreaterThan(accountSpend);
  });
});

describe('negativeCandidates', () => {
  const rows = [
    row('bleeding term', { clicks: 20, cost: 12, purchases7d: 0, sales7d: 0 }),
    row('cheap miss', { clicks: 3, cost: 1.5, purchases7d: 0, sales7d: 0 }),
    row('expensive converter', { clicks: 30, cost: 40, purchases7d: 1, sales7d: 60 }),
    row('good converter', { clicks: 10, cost: 6, purchases7d: 2, sales7d: 60 }),
    row('one click', { clicks: 0, cost: 0, purchases7d: 0, sales7d: 0 }),
  ];

  it('uses the target CPA, not a flat spend number, as the no-sales threshold', () => {
    // Target CPA is 30% x $30 = $9: the $12 term is over it, the $1.50 one is not.
    const candidates = negativeCandidates(rows, { targetAcos: 0.3, aov: 30 });
    const byTerm = new Map(candidates.map((c) => [c.searchTerm, c]));
    expect(byTerm.get('bleeding term')?.reason).toBe('no_sales_over_target_cpa');
    expect(byTerm.get('bleeding term')?.threshold).toBeCloseTo(9, 10);
    expect(byTerm.has('cheap miss')).toBe(false);
  });

  it('flags a converting term only when it is past the ACOS ceiling', () => {
    const candidates = negativeCandidates(rows, { targetAcos: 0.3, aov: 30 });
    const byTerm = new Map(candidates.map((c) => [c.searchTerm, c]));
    // 40/60 = 67% ACOS against a 30% ceiling.
    expect(byTerm.get('expensive converter')?.reason).toBe('acos_over_ceiling');
    // 6/60 = 10%: well inside.
    expect(byTerm.has('good converter')).toBe(false);
  });

  it('ignores rows below the click floor: one click is not evidence', () => {
    const candidates = negativeCandidates(rows, { targetAcos: 0.3, aov: 30, minClicks: 25 });
    expect(candidates.map((c) => c.searchTerm)).toEqual(['expensive converter']);
  });

  it('carries the evidence that produced each proposal', () => {
    const [first] = negativeCandidates(rows, { targetAcos: 0.3, aov: 30 });
    expect(first).toMatchObject({ clicks: expect.any(Number), cost: expect.any(Number), purchases: expect.any(Number) });
  });
});
