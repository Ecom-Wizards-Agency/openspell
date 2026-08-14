/**
 * The tag filter, as a shape and three pure functions over it.
 *
 * Deliberately free of React and of any `'use client'` boundary: the grid
 * filters rows on the client, a dashboard tile counts the same rows on the
 * server, and both have to reach the identical predicate or the two disagree
 * on screen. `useTagFilter` (the client-side memo) lives next door in
 * `use-tag-filter.ts` for exactly that reason.
 *
 * A consumer supplies its own row type; the only requirement is a `tagIds`
 * field, so no grid needs to know that tags have a UI at all.
 */
import type { EntityTagFilter, JsonValue } from '@wizard-ads/db';

export type TagFilter = EntityTagFilter;

export interface TagFilterableRow {
  tagIds: readonly string[];
}

export type TagDescendants = Readonly<Record<string, readonly string[]>>;

/** The one predicate the list and the dashboard count both go through. */
export function applyTagFilter<Row extends TagFilterableRow>(
  rows: readonly Row[],
  filter: TagFilter,
  descendants: TagDescendants = {},
): Row[] {
  if (filter.mode === 'untagged') return rows.filter((row) => row.tagIds.length === 0);
  if (filter.tagIds.length === 0) return [...rows];
  const groups = filter.tagIds.map((tagId) =>
    new Set(
      filter.includeDescendants === false ? [tagId] : [tagId, ...(descendants[tagId] ?? [])],
    ),
  );
  return rows.filter((row) => {
    const matches = groups.map((group) => row.tagIds.some((tagId) => group.has(tagId)));
    if (filter.mode === 'all') return matches.every(Boolean);
    if (filter.mode === 'none') return matches.every((value) => !value);
    return matches.some(Boolean);
  });
}

export function tagFilterFromState(state: JsonValue | undefined): TagFilter {
  const fallback: TagFilter = { tagIds: [], mode: 'any', includeDescendants: true };
  if (!state || typeof state !== 'object' || Array.isArray(state)) return fallback;
  const candidate = state['tagFilter'];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return fallback;
  const tagIds = candidate['tagIds'];
  const mode = candidate['mode'];
  const includeDescendants = candidate['includeDescendants'];
  if (
    !Array.isArray(tagIds) ||
    !tagIds.every((value) => typeof value === 'string') ||
    !['any', 'all', 'none', 'untagged'].includes(String(mode))
  ) {
    return fallback;
  }
  return {
    tagIds,
    mode: mode as TagFilter['mode'],
    includeDescendants: includeDescendants !== false,
  };
}

export function tagFilterState(filter: TagFilter): JsonValue {
  return {
    tagFilter: {
      tagIds: [...filter.tagIds],
      mode: filter.mode,
      includeDescendants: filter.includeDescendants !== false,
    },
  };
}
