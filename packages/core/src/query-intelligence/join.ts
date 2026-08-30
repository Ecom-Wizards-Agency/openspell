import type { QueryJoinAttribution, SqpWeeklyFact } from '@wizard-ads/shared';
import { normalizeQuery } from './normalize.js';

export interface PpcQueryFact {
  id: string;
  profileId: string;
  marketplaceId: string;
  weekStart: string;
  searchTerm: string;
  asin?: string | null;
  attributedAsins?: readonly string[];
  spend: number;
  sales: number;
  clicks: number;
  orders: number;
}

export interface SqpPpcJoinRow {
  ppc: PpcQueryFact;
  normalizedQuery: string;
  asin: string | null;
  attribution: QueryJoinAttribution;
  sqp: SqpWeeklyFact | null;
  candidateAsins: string[];
}

function queryWeekKey(
  profileId: string,
  marketplaceId: string,
  weekStart: string,
  normalizedQuery: string,
): string {
  return `${profileId}\u0000${marketplaceId}\u0000${weekStart}\u0000${normalizedQuery}`;
}

function exactKey(
  profileId: string,
  marketplaceId: string,
  weekStart: string,
  normalizedQuery: string,
  asin: string,
): string {
  return `${queryWeekKey(profileId, marketplaceId, weekStart, normalizedQuery)}\u0000${asin.toUpperCase()}`;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.toUpperCase()))].sort();
}

/**
 * Join PPC to SQP only where ASIN attribution supports it.
 *
 * Every PPC input produces exactly one output. Profile-only or ambiguous spend
 * stays on an ASIN-null row, so sibling SQP rows can never duplicate spend.
 */
export function joinSqpAndPpc(
  sqpFacts: readonly SqpWeeklyFact[],
  ppcFacts: readonly PpcQueryFact[],
): SqpPpcJoinRow[] {
  const byExact = new Map<string, SqpWeeklyFact[]>();
  const asinSetsByQueryWeek = new Map<string, Set<string>>();

  for (const sqp of sqpFacts) {
    const normalized = normalizeQuery(sqp.normalizedQuery || sqp.searchQuery);
    const qKey = queryWeekKey(sqp.profileId, sqp.marketplaceId, sqp.weekStart, normalized);
    const eKey = exactKey(sqp.profileId, sqp.marketplaceId, sqp.weekStart, normalized, sqp.asin);
    byExact.set(eKey, [...(byExact.get(eKey) ?? []), sqp]);
    const asins = asinSetsByQueryWeek.get(qKey) ?? new Set<string>();
    asins.add(sqp.asin.toUpperCase());
    asinSetsByQueryWeek.set(qKey, asins);
  }

  const asinsByQueryWeek = new Map(
    [...asinSetsByQueryWeek].map(([key, values]) => [key, [...values].sort()] as const),
  );

  return ppcFacts.map((ppc) => {
    const normalizedQuery = normalizeQuery(ppc.searchTerm);
    const qKey = queryWeekKey(
      ppc.profileId,
      ppc.marketplaceId,
      ppc.weekStart,
      normalizedQuery,
    );
    const queryCandidates = asinsByQueryWeek.get(qKey) ?? [];
    const declaredAsins = uniqueSorted([
      ...(ppc.asin ? [ppc.asin] : []),
      ...(ppc.attributedAsins ?? []),
    ]);

    if (declaredAsins.length > 1) {
      return {
        ppc,
        normalizedQuery,
        asin: null,
        attribution: 'ambiguous',
        sqp: null,
        candidateAsins: declaredAsins,
      };
    }

    const [declaredAsin] = declaredAsins;
    if (declaredAsin) {
      const exact = byExact.get(
        exactKey(ppc.profileId, ppc.marketplaceId, ppc.weekStart, normalizedQuery, declaredAsin),
      );
      if (exact?.length === 1) {
        return {
          ppc,
          normalizedQuery,
          asin: declaredAsin,
          attribution: 'asin_exact',
          sqp: exact[0] as SqpWeeklyFact,
          candidateAsins: [declaredAsin],
        };
      }
      return {
        ppc,
        normalizedQuery,
        asin: null,
        attribution: exact && exact.length > 1 ? 'ambiguous' : 'unmatched',
        sqp: null,
        candidateAsins: exact ? [declaredAsin] : queryCandidates,
      };
    }

    return {
      ppc,
      normalizedQuery,
      asin: null,
      attribution:
        queryCandidates.length === 0
          ? 'unmatched'
          : queryCandidates.length === 1
            ? 'profile_only'
            : 'ambiguous',
      sqp: null,
      candidateAsins: queryCandidates,
    };
  });
}

export interface SpendConservation {
  inputSpend: number;
  outputSpend: number;
  inputRows: number;
  outputRows: number;
  conserved: boolean;
}

export function verifySpendConservation(
  inputs: readonly PpcQueryFact[],
  outputs: readonly SqpPpcJoinRow[],
  tolerance = Number.EPSILON * 16,
): SpendConservation {
  const inputSpend = inputs.reduce((sum, row) => sum + row.spend, 0);
  const outputSpend = outputs.reduce((sum, row) => sum + row.ppc.spend, 0);
  return {
    inputSpend,
    outputSpend,
    inputRows: inputs.length,
    outputRows: outputs.length,
    conserved:
      inputs.length === outputs.length && Math.abs(inputSpend - outputSpend) <= tolerance,
  };
}
