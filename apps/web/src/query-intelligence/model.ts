import {
  QUERY_CATEGORY_LABELS,
  joinSqpAndPpc,
  rollupQueryCategories,
  verifySpendConservation,
} from '@wizard-ads/core';
import type { WeeklyPpcQueryRecord } from '@wizard-ads/db';
import type {
  ContextualNegativeProposal,
  QueryCategory,
  QueryJoinAttribution,
  QueryVocabularyEntry,
  SqpWeeklyFact,
} from '@wizard-ads/shared';

const CATEGORIES = [
  'own_brand',
  'competitor',
  'core',
  'head',
  'excluded',
  'unreviewed',
] as const satisfies readonly QueryCategory[];

const ATTRIBUTIONS = [
  'asin_exact',
  'profile_only',
  'ambiguous',
  'unmatched',
] as const satisfies readonly QueryJoinAttribution[];

export const PPC_ATTRIBUTION_LABELS = {
  asin_exact: 'ASIN exact',
  profile_only: 'Profile-only',
  ambiguous: 'Ambiguous',
  unmatched: 'No SQP match',
} as const satisfies Record<QueryJoinAttribution, string>;

export interface SqpPromotionEvidence {
  id: string;
  sourceSystem: string;
  promotedAt: string;
  requestedAsins: string[];
  sourceRows: number;
  parsedRows: number;
  refusedRows: number;
  deduplicatedRows: number;
  promotedRows: number;
  canonicalRows: number;
}

export interface QueryIntelligenceSource {
  facts: SqpWeeklyFact[];
  ppc: WeeklyPpcQueryRecord[];
  vocabulary: QueryVocabularyEntry[];
  proposals: ContextualNegativeProposal[];
  promotionRuns: SqpPromotionEvidence[];
}

export interface QueryCategorySummary {
  category: QueryCategory;
  label: string;
  queryCount: number;
  asinCount: number;
  searchVolume: number;
  clickShare: number | null;
  purchaseShare: number | null;
  impressionShare: number | null;
}

export interface QueryEvidenceRow extends SqpWeeklyFact {
  categoryLabel: string;
}

export interface PpcAttributionRow {
  id: string;
  searchTerm: string;
  normalizedQuery: string;
  category: QueryCategory | null;
  categoryLabel: string;
  attribution: QueryJoinAttribution;
  attributionLabel: string;
  asin: string | null;
  candidateAsins: string[];
  campaignId: string;
  adGroupId: string;
  groupRole: WeeklyPpcQueryRecord['groupRole'];
  spend: number;
  sales: number;
  clicks: number;
  orders: number;
}

export interface PpcAttributionSummary {
  attribution: QueryJoinAttribution;
  label: string;
  rows: number;
  spend: number;
}

export interface QueryIntelligenceModel {
  categorySummaries: QueryCategorySummary[];
  queryRows: QueryEvidenceRow[];
  rawDemand: number;
  addressableDemand: number;
  uniqueQueries: number;
  uniqueAsins: number;
  needsReview: number;
  ppcRows: PpcAttributionRow[];
  ppcSummaries: PpcAttributionSummary[];
  vocabulary: QueryVocabularyEntry[];
  approvedVocabulary: number;
  pendingVocabulary: number;
  proposals: ContextualNegativeProposal[];
  promotionRuns: SqpPromotionEvidence[];
  promotionReconciled: boolean | null;
  assertions: {
    sourceFacts: number;
    displayedFactRows: number;
    ppcInputRows: number;
    ppcOutputRows: number;
    ppcSpendConserved: boolean;
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function queryCategoryMap(facts: readonly SqpWeeklyFact[]): Map<string, QueryCategory | null> {
  const categories = new Map<string, Set<QueryCategory>>();
  for (const fact of facts) {
    const seen = categories.get(fact.normalizedQuery) ?? new Set<QueryCategory>();
    seen.add(fact.category);
    categories.set(fact.normalizedQuery, seen);
  }
  return new Map(
    [...categories].map(([query, values]) => [
      query,
      values.size === 1 ? ([...values][0] as QueryCategory) : null,
    ]),
  );
}

function uniqueDemandRows(facts: readonly SqpWeeklyFact[]): Array<{
  category: QueryCategory;
  value: number;
}> {
  const rows = new Map<string, { category: QueryCategory; value: number }>();
  const categories = queryCategoryMap(facts);
  for (const fact of facts) {
    const current = rows.get(fact.normalizedQuery);
    rows.set(fact.normalizedQuery, {
      // A query carrying conflicting stored categories is not silently forced
      // into one segment. It returns to the human review queue.
      category: categories.get(fact.normalizedQuery) ?? 'unreviewed',
      value: Math.max(current?.value ?? 0, fact.searchQueryVolume),
    });
  }
  return [...rows.values()];
}

function categorySummary(
  category: QueryCategory,
  facts: readonly SqpWeeklyFact[],
): QueryCategorySummary {
  const rows = facts.filter((fact) => fact.category === category);
  const volumeByQuery = new Map<string, number>();
  for (const row of rows) {
    volumeByQuery.set(
      row.normalizedQuery,
      Math.max(volumeByQuery.get(row.normalizedQuery) ?? 0, row.searchQueryVolume),
    );
  }

  return {
    category,
    label: QUERY_CATEGORY_LABELS[category],
    queryCount: volumeByQuery.size,
    asinCount: new Set(rows.map((row) => row.asin)).size,
    searchVolume: [...volumeByQuery.values()].reduce((sum, value) => sum + value, 0),
    clickShare: ratio(
      rows.reduce((sum, row) => sum + row.asinClicks, 0),
      rows.reduce((sum, row) => sum + row.totalClicks, 0),
    ),
    purchaseShare: ratio(
      rows.reduce((sum, row) => sum + row.asinPurchases, 0),
      rows.reduce((sum, row) => sum + row.totalPurchases, 0),
    ),
    impressionShare: ratio(
      rows.reduce((sum, row) => sum + row.asinImpressions, 0),
      rows.reduce((sum, row) => sum + row.totalImpressions, 0),
    ),
  };
}

function promotionIsReconciled(run: SqpPromotionEvidence): boolean {
  return (
    run.sourceRows === run.parsedRows + run.refusedRows &&
    run.deduplicatedRows === run.promotedRows &&
    run.promotedRows === run.canonicalRows
  );
}

/**
 * Build the presentation model without changing analytical categories or PPC
 * attribution. Every source SQP row remains one visible query/ASIN row, and
 * every PPC row remains one output row with spend conserved.
 */
export function buildQueryIntelligenceModel(
  source: QueryIntelligenceSource,
): QueryIntelligenceModel {
  const queryRows = source.facts
    .map((fact) => ({ ...fact, categoryLabel: QUERY_CATEGORY_LABELS[fact.category] }))
    .sort(
      (left, right) =>
        right.searchQueryVolume - left.searchQueryVolume ||
        right.asinPurchases - left.asinPurchases ||
        left.searchQuery.localeCompare(right.searchQuery),
    );
  if (queryRows.length !== source.facts.length) {
    throw new Error('SQP source-to-view row count mismatch');
  }

  const categoryByQuery = queryCategoryMap(source.facts);
  const joined = joinSqpAndPpc(source.facts, source.ppc);
  const spend = verifySpendConservation(source.ppc, joined);
  if (!spend.conserved) throw new Error('PPC spend was not conserved through the SQP join');

  const ppcById = new Map(source.ppc.map((record) => [record.id, record]));
  if (ppcById.size !== source.ppc.length) throw new Error('PPC input contains duplicate row ids');

  const ppcRows: PpcAttributionRow[] = joined
    .map((row) => {
      const record = ppcById.get(row.ppc.id);
      if (!record) throw new Error('PPC join returned a row that was not in its input');
      const category = row.sqp?.category ?? categoryByQuery.get(row.normalizedQuery) ?? null;
      return {
        id: record.id,
        searchTerm: record.searchTerm,
        normalizedQuery: row.normalizedQuery,
        category,
        categoryLabel: category === null ? 'Unclassified' : QUERY_CATEGORY_LABELS[category],
        attribution: row.attribution,
        attributionLabel: PPC_ATTRIBUTION_LABELS[row.attribution],
        asin: row.asin,
        candidateAsins: row.candidateAsins,
        campaignId: record.campaignId,
        adGroupId: record.adGroupId,
        groupRole: record.groupRole,
        spend: record.spend,
        sales: record.sales,
        clicks: record.clicks,
        orders: record.orders,
      };
    })
    .sort((left, right) => right.spend - left.spend || left.searchTerm.localeCompare(right.searchTerm));

  const demand = rollupQueryCategories(uniqueDemandRows(source.facts));

  return {
    categorySummaries: CATEGORIES.map((category) => categorySummary(category, source.facts)),
    queryRows,
    rawDemand: demand.rawTotal,
    addressableDemand: demand.addressableOpportunity,
    uniqueQueries: new Set(source.facts.map((row) => row.normalizedQuery)).size,
    uniqueAsins: new Set(source.facts.map((row) => row.asin)).size,
    needsReview: new Set(
      source.facts
        .filter((row) => row.category === 'unreviewed')
        .map((row) => row.normalizedQuery),
    ).size,
    ppcRows,
    ppcSummaries: ATTRIBUTIONS.map((attribution) => {
      const rows = ppcRows.filter((row) => row.attribution === attribution);
      return {
        attribution,
        label: PPC_ATTRIBUTION_LABELS[attribution],
        rows: rows.length,
        spend: rows.reduce((sum, row) => sum + row.spend, 0),
      };
    }),
    vocabulary: [...source.vocabulary].sort(
      (left, right) =>
        Number(right.approved) - Number(left.approved) ||
        left.kind.localeCompare(right.kind) ||
        left.value.localeCompare(right.value),
    ),
    approvedVocabulary: source.vocabulary.filter((entry) => entry.approved).length,
    pendingVocabulary: source.vocabulary.filter((entry) => !entry.approved).length,
    proposals: [...source.proposals].sort(
      (left, right) =>
        left.status.localeCompare(right.status) || left.searchTerm.localeCompare(right.searchTerm),
    ),
    promotionRuns: source.promotionRuns,
    promotionReconciled:
      source.promotionRuns.length === 0
        ? null
        : source.promotionRuns.every(promotionIsReconciled),
    assertions: {
      sourceFacts: source.facts.length,
      displayedFactRows: queryRows.length,
      ppcInputRows: spend.inputRows,
      ppcOutputRows: spend.outputRows,
      ppcSpendConserved: spend.conserved,
    },
  };
}
