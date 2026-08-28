import type { QueryCategory } from '@wizard-ads/shared';
import { isAddressableOpportunityCategory } from './classification.js';

const CATEGORIES = [
  'own_brand',
  'competitor',
  'core',
  'head',
  'excluded',
  'unreviewed',
] as const satisfies readonly QueryCategory[];

export interface CategorizedMetricRow {
  category: QueryCategory;
  value: number;
}

export interface QueryCategoryRollup {
  rawTotal: number;
  detailed: Record<QueryCategory, number>;
  branded: number;
  nonBranded: number;
  addressableOpportunity: number;
}

/** Keep the detailed taxonomy while deriving presentation rollups. */
export function rollupQueryCategories(
  rows: readonly CategorizedMetricRow[],
  options: { includeCompetitorOpportunity?: boolean } = {},
): QueryCategoryRollup {
  const detailed = Object.fromEntries(CATEGORIES.map((category) => [category, 0])) as Record<
    QueryCategory,
    number
  >;

  for (const row of rows) detailed[row.category] += row.value;
  const rawTotal = rows.reduce((sum, row) => sum + row.value, 0);
  const branded = detailed.own_brand;
  const addressableOpportunity = CATEGORIES.filter((category) =>
    isAddressableOpportunityCategory(category, {
      includeCompetitor: options.includeCompetitorOpportunity,
    }),
  ).reduce((sum, category) => sum + detailed[category], 0);

  return {
    rawTotal,
    detailed,
    branded,
    nonBranded: rawTotal - branded,
    addressableOpportunity,
  };
}

export interface IntentComparison {
  category: QueryCategory;
  previous: number;
  current: number;
  delta: number;
}

/** Reject unlike intent comparisons instead of producing a misleading delta. */
export function compareLikeForLikeIntent(
  previous: CategorizedMetricRow,
  current: CategorizedMetricRow,
): IntentComparison {
  if (previous.category !== current.category) {
    throw new Error(
      `Intent mismatch: ${previous.category} cannot be compared with ${current.category}`,
    );
  }
  return {
    category: current.category,
    previous: previous.value,
    current: current.value,
    delta: current.value - previous.value,
  };
}
