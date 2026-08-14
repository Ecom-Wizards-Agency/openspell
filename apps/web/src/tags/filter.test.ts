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

  /**
   * The hand-off to WP-06. The grid owns its row type and its columns; the
   * only thing this interface asks of it is a `tagIds` field, and nothing here
   * imports a component. The dashboard tile aggregates the *same* filtered
   * rows, which is what stops a grid and a tile disagreeing on screen.
   */
  it('filters an arbitrary grid row type and its dashboard aggregate identically', () => {
    interface GridRow {
      campaignId: string;
      name: string;
      cost: number;
      tagIds: readonly string[];
    }
    const gridRows: GridRow[] = [
      { campaignId: 'c-1', name: 'Brand exact', cost: 12.5, tagIds: ['child-a'] },
      { campaignId: 'c-2', name: 'Generic broad', cost: 30, tagIds: ['facet-x'] },
      { campaignId: 'c-3', name: 'Auto', cost: 7.25, tagIds: [] },
    ];
    const filter = { tagIds: ['parent'], mode: 'any' as const };
    const descendants = { parent: ['child-a'] };

    const visible = applyTagFilter(gridRows, filter, descendants);
    // The row type survives: the grid still has its own columns.
    expect(visible.map((row) => row.name)).toEqual(['Brand exact']);
    expect(visible.map((row) => row.cost)).toEqual([12.5]);

    // A dashboard tile over the same rows and the same filter.
    const spend = applyTagFilter(gridRows, filter, descendants).reduce(
      (total, row) => total + row.cost,
      0,
    );
    expect(spend).toBe(12.5);
    expect(visible).toHaveLength(1);

    // And a filter restored from a goto link produces exactly the same set.
    const restored = tagFilterFromState(tagFilterState(filter));
    expect(applyTagFilter(gridRows, restored, descendants)).toEqual(visible);
  });
});
