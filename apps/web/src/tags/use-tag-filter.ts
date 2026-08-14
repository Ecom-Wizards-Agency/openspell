'use client';

/**
 * The client-side half of the tag filter: a memo over the pure predicate in
 * `filter.ts`. A grid can call this without importing a single tag component,
 * and a server-rendered tile can call `applyTagFilter` directly and get the
 * same rows.
 */
import { useMemo } from 'react';
import { applyTagFilter } from './filter.js';
import type { TagDescendants, TagFilter, TagFilterableRow } from './filter.js';

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
