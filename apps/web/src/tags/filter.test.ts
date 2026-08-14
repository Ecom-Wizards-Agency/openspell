import { describe, expect, it } from 'vitest';
import { applyTagFilter, tagFilterFromState, tagFilterState } from './filter.js';

const rows = [
  { id: 'campaign-a', tagIds: ['child-a', 'facet-x'] },
  { id: 'campaign-b', tagIds: ['facet-x'] },
  { id: 'campaign-c', tagIds: [] },
];

describe('tag filter adapter', () => {
  it('applies descendant, exclusion, all, and untagged semantics to any list consumer', () => {
    const descendants = { parent: ['child-a'] };
    expect(
      applyTagFilter(rows, { tagIds: ['parent'], mode: 'any' }, descendants).map((row) => row.id),
    ).toEqual(['campaign-a']);
    expect(
      applyTagFilter(rows, { tagIds: ['parent'], mode: 'none' }, descendants).map((row) => row.id),
    ).toEqual(['campaign-b', 'campaign-c']);
    expect(
      applyTagFilter(rows, { tagIds: ['parent', 'facet-x'], mode: 'all' }, descendants).map(
        (row) => row.id,
      ),
    ).toEqual(['campaign-a']);
    expect(
      applyTagFilter(rows, { tagIds: [], mode: 'untagged' }, descendants).map((row) => row.id),
    ).toEqual(['campaign-c']);
  });

  it('round-trips the filter state consumed by /go links', () => {
    const filter = { tagIds: ['one', 'two'], mode: 'all' as const, includeDescendants: false };
    expect(tagFilterFromState(tagFilterState(filter))).toEqual(filter);
  });
});
