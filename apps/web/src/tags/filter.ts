'use client';

import { useMemo } from 'react';
import type { EntityTagFilter } from '../../../../packages/db/src/queries/tags.js';
import type { JsonValue } from '../../../../packages/db/src/queries/goto.js';

export type TagFilter = EntityTagFilter;

export interface TagFilterableRow {
  tagIds: readonly string[];
}

export type TagDescendants = Readonly<Record<string, readonly string[]>>;

/** Pure adapter shared by the standalone list and its dashboard-style count. */
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

/** WP-06 can consume this hook without importing any grid component. */
export function useTagFilter<Row extends TagFilterableRow>(
  rows: readonly Row[],
  filter: TagFilter,
  descendants: TagDescendants = {},
): Row[] {
  return useMemo(
    () => applyTagFilter(rows, filter, descendants),
    [rows, filter, descendants],
  );
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
