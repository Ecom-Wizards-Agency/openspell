/**
 * Counted, tenant-scoped persistence for weekly Search Query Performance.
 *
 * The SP-API transport and query doctrine do not belong here. This boundary
 * receives already parsed shared contracts, replaces the complete requested
 * ASIN/week scope transactionally, and proves that the canonical rows match
 * the deduplicated input before commit.
 */
import { createHash } from 'node:crypto';
import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  sql,
} from 'drizzle-orm';
import {
  ContextualNegativeProposal,
  QueryVocabularyEntry,
  SqpIngestionCounts,
  SqpWeeklyFact,
  type ContextualNegativeProposal as ContextualNegativeProposalType,
  type QueryVocabularyEntry as QueryVocabularyEntryType,
  type QueryVocabularyKind,
  type QueryVocabularySource,
  type SqpIngestionCounts as SqpIngestionCountsType,
  type SqpWeeklyFact as SqpWeeklyFactType,
} from '@wizard-ads/shared';
import type { DbHandle } from '../client.js';
import {
  adProfiles,
  contextualNegativeProposals,
  factSqpWeekly,
  queryVocabulary,
  sqpPromotionRuns,
} from '../schema/index.js';
import { chunkForInsert } from './chunk.js';

const SQP_SOURCE_SYSTEM = 'amazon_sp_api_brand_analytics' as const;

export class SqpPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqpPersistenceError';
  }
}

export class StaleSqpPromotionError extends SqpPersistenceError {
  constructor(
    readonly requestIdentity: string,
    readonly requestedAt: Date,
    readonly currentRequestIdentity: string,
    readonly currentRequestedAt: Date,
  ) {
    super(
      `SQP request ${requestIdentity} at ${requestedAt.toISOString()} is older than ` +
        `${currentRequestIdentity} at ${currentRequestedAt.toISOString()}`,
    );
    this.name = 'StaleSqpPromotionError';
  }
}

export interface SqpSourceReportMetadata {
  requestKey: string;
  reportId: string;
  reportDocumentId: string | null;
  /** When this worker requested the source report. */
  requestedAt: Date;
  /** When this worker observed the source report in a terminal state. */
  completedAt: Date;
  /** Provider-created timestamp retained separately from worker freshness. */
  providerCreatedAt: Date | null;
  requestedAsins: readonly string[];
}

export interface SqpWeeklyPromotionInput {
  orgId: string;
  profileId: string;
  marketplaceId: string;
  weekStart: string;
  weekEnd: string;
  /** Every ASIN in the report request, including ASINs that returned no rows. */
  requestedAsins: readonly string[];
  /** Stable across retries of the exact same set of provider reports. */
  requestIdentity: string;
  requestedAt: Date;
  completedAt: Date;
  sourceReports: readonly SqpSourceReportMetadata[];
  rows: readonly SqpWeeklyFactType[];
  counts: SqpIngestionCountsType;
}

export interface SqpWeeklyPromotionResult {
  status: 'promoted' | 'already_promoted';
  promotionRunId: string;
  sourceAsins: number;
  sourceRows: number;
  parsedRows: number;
  deduplicatedRows: number;
  refusedRows: number;
  deletedRows: number;
  promotedRows: number;
  upserts: number;
  canonicalRows: number;
}

/**
 * Replace one complete marketplace/week/requested-ASIN scope.
 *
 * An ASIN omitted from a complete Amazon document is intentionally included
 * in the delete scope. That prevents a no-longer-returned query from surviving
 * as stale canonical evidence.
 */
export async function promoteSqpWeeklyFacts(
  handle: DbHandle,
  input: SqpWeeklyPromotionInput,
): Promise<SqpWeeklyPromotionResult> {
  const staged = validatePromotion(input);

  return handle.db.transaction(async (tx) => {
    // Per-ASIN locks let disjoint batches proceed while serializing any
    // overlap. Sorting is load-bearing: two multi-ASIN transactions cannot
    // deadlock by taking the same locks in a different order.
    for (const asin of staged.requestedAsins) {
      const lockKey = [staged.profileId, staged.marketplaceId, staged.weekStart, asin].join(':');
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    }

    const profiles = await tx
      .select({ id: adProfiles.id })
      .from(adProfiles)
      .where(and(eq(adProfiles.orgId, staged.orgId), eq(adProfiles.id, staged.profileId)))
      .limit(1);
    if (!profiles[0]) {
      throw new SqpPersistenceError('SQP profile does not belong to the organisation');
    }

    const identityRows = await tx
      .select()
      .from(sqpPromotionRuns)
      .where(and(
        eq(sqpPromotionRuns.profileId, staged.profileId),
        eq(sqpPromotionRuns.requestIdentity, staged.requestIdentity),
      ))
      .limit(1);
    const existingIdentity = identityRows[0];

    const scopeRows = await tx
      .select()
      .from(sqpPromotionRuns)
      .where(and(
        eq(sqpPromotionRuns.profileId, staged.profileId),
        eq(sqpPromotionRuns.marketplaceId, staged.marketplaceId),
        eq(sqpPromotionRuns.weekStart, staged.weekStart),
      ))
      .orderBy(desc(sqpPromotionRuns.requestedAt), desc(sqpPromotionRuns.completedAt));
    const requested = new Set(staged.requestedAsins);
    const current = scopeRows.find((row) => row.requestedAsins.some((asin) => requested.has(asin)));

    if (current && staged.requestedAt < current.requestedAt) {
      throw new StaleSqpPromotionError(
        staged.requestIdentity,
        staged.requestedAt,
        current.requestIdentity,
        current.requestedAt,
      );
    }
    if (
      current &&
      staged.requestedAt.getTime() === current.requestedAt.getTime() &&
      staged.requestIdentity !== current.requestIdentity
    ) {
      throw new SqpPersistenceError(
        'two different overlapping SQP requests cannot share one freshness timestamp',
      );
    }
    if (existingIdentity) {
      assertIdempotentPromotion(staged, existingIdentity);
      const canonicalRows = await countCanonicalSqpRows(tx, staged);
      assertCount('SQP idempotent canonical rows', existingIdentity.canonicalRows, canonicalRows);
      return {
        status: 'already_promoted',
        promotionRunId: existingIdentity.id,
        ...staged.counts,
        deletedRows: 0,
        promotedRows: 0,
        upserts: 0,
        canonicalRows,
      };
    }

    const deleted = await tx
      .delete(factSqpWeekly)
      .where(and(
        eq(factSqpWeekly.orgId, staged.orgId),
        eq(factSqpWeekly.profileId, staged.profileId),
        eq(factSqpWeekly.marketplaceId, staged.marketplaceId),
        eq(factSqpWeekly.weekStart, staged.weekStart),
        inArray(factSqpWeekly.asin, staged.requestedAsins),
      ))
      .returning({ profileId: factSqpWeekly.profileId });

    let upserts = 0;
    const values = staged.rows.map((row) => ({
      orgId: staged.orgId,
      profileId: staged.profileId,
      weekStart: row.weekStart,
      marketplaceId: row.marketplaceId,
      asin: row.asin,
      searchQuery: row.searchQuery,
      normalizedQuery: row.normalizedQuery,
      category: row.category,
      searchQueryScore: row.searchQueryScore,
      searchVolume: row.searchQueryVolume,
      // Keep the legacy aliases populated with the ASIN-level numerators.
      impressions: row.asinImpressions,
      totalImpressions: row.totalImpressions,
      asinImpressions: row.asinImpressions,
      impressionShare: row.asinImpressionShare,
      clicks: row.asinClicks,
      totalClicks: row.totalClicks,
      asinClicks: row.asinClicks,
      clickShare: row.asinClickShare,
      totalCartAdds: row.totalCartAdds,
      asinCartAdds: row.asinCartAdds,
      asinCartAddShare: row.asinCartAddShare,
      purchases: row.asinPurchases,
      totalPurchases: row.totalPurchases,
      asinPurchases: row.asinPurchases,
      purchaseShare: row.asinPurchaseShare,
      loadedAt: new Date(),
    }));
    for (const chunk of chunkForInsert(
      values,
      Object.keys(getTableColumns(factSqpWeekly)).length,
    )) {
      const written = await tx
        .insert(factSqpWeekly)
        .values(chunk)
        .returning({ profileId: factSqpWeekly.profileId });
      upserts += written.length;
    }
    assertCount('SQP upserts', staged.rows.length, upserts);

    const canonicalRows = await countCanonicalSqpRows(tx, staged);
    assertCount('SQP canonical rows', staged.rows.length, canonicalRows);

    const [promotionRun] = await tx
      .insert(sqpPromotionRuns)
      .values({
        orgId: staged.orgId,
        profileId: staged.profileId,
        marketplaceId: staged.marketplaceId,
        weekStart: staged.weekStart,
        sourceSystem: SQP_SOURCE_SYSTEM,
        requestIdentity: staged.requestIdentity,
        requestedAt: staged.requestedAt,
        completedAt: staged.completedAt,
        requestedAsins: staged.requestedAsins,
        sourceReports: staged.sourceReports.map(serializeSourceReport),
        inputFingerprint: staged.inputFingerprint,
        sourceAsins: staged.counts.sourceAsins,
        sourceRows: staged.counts.sourceRows,
        parsedRows: staged.counts.parsedRows,
        deduplicatedRows: staged.counts.deduplicatedRows,
        refusedRows: staged.counts.refusedRows,
        promotedRows: upserts,
        canonicalRows,
      })
      .returning({ id: sqpPromotionRuns.id });
    if (!promotionRun) throw new SqpPersistenceError('SQP promotion provenance was not written');

    return {
      status: 'promoted',
      promotionRunId: promotionRun.id,
      ...staged.counts,
      deletedRows: deleted.length,
      promotedRows: upserts,
      upserts,
      canonicalRows,
    };
  });
}

type SqpPromotionTransaction = Parameters<Parameters<DbHandle['db']['transaction']>[0]>[0];
type ValidatedSqpPromotion = ReturnType<typeof validatePromotion>;

async function countCanonicalSqpRows(
  tx: SqpPromotionTransaction,
  staged: ValidatedSqpPromotion,
): Promise<number> {
  const [canonical] = await tx
    .select({ rows: sql<number>`count(*)::int` })
    .from(factSqpWeekly)
    .where(and(
      eq(factSqpWeekly.orgId, staged.orgId),
      eq(factSqpWeekly.profileId, staged.profileId),
      eq(factSqpWeekly.marketplaceId, staged.marketplaceId),
      eq(factSqpWeekly.weekStart, staged.weekStart),
      inArray(factSqpWeekly.asin, staged.requestedAsins),
    ));
  return canonical?.rows ?? 0;
}

function assertIdempotentPromotion(
  staged: ValidatedSqpPromotion,
  existing: typeof sqpPromotionRuns.$inferSelect,
): void {
  if (
    existing.orgId !== staged.orgId ||
    existing.marketplaceId !== staged.marketplaceId ||
    existing.weekStart !== staged.weekStart ||
    existing.sourceSystem !== SQP_SOURCE_SYSTEM ||
    existing.requestedAt.getTime() !== staged.requestedAt.getTime() ||
    existing.completedAt.getTime() !== staged.completedAt.getTime() ||
    existing.requestedAsins.length !== staged.requestedAsins.length ||
    existing.requestedAsins.some((asin, index) => asin !== staged.requestedAsins[index]) ||
    existing.inputFingerprint !== staged.inputFingerprint
  ) {
    throw new SqpPersistenceError('an SQP request identity was reused with different evidence');
  }
}

export async function readSqpWeeklyFacts(
  handle: DbHandle,
  input: {
    orgId: string;
    profileId: string;
    marketplaceId: string;
    weekStart: string;
    asins?: readonly string[];
  },
): Promise<SqpWeeklyFactType[]> {
  const asins = input.asins === undefined ? undefined : normalizeAsins(input.asins);
  if (asins?.length === 0) return [];
  const rows = await handle.db
    .select()
    .from(factSqpWeekly)
    .where(and(
      eq(factSqpWeekly.orgId, input.orgId),
      eq(factSqpWeekly.profileId, input.profileId),
      eq(factSqpWeekly.marketplaceId, input.marketplaceId),
      eq(factSqpWeekly.weekStart, input.weekStart),
      asins === undefined ? undefined : inArray(factSqpWeekly.asin, asins),
    ))
    .orderBy(factSqpWeekly.asin, factSqpWeekly.normalizedQuery);

  return rows.map((row) => SqpWeeklyFact.parse({
    profileId: row.profileId,
    marketplaceId: row.marketplaceId,
    asin: row.asin,
    weekStart: row.weekStart,
    weekEnd: row.weekEnd,
    searchQuery: row.searchQuery,
    normalizedQuery: row.normalizedQuery,
    category: row.category,
    searchQueryScore: row.searchQueryScore,
    searchQueryVolume: row.searchVolume,
    totalImpressions: row.totalImpressions,
    asinImpressions: row.asinImpressions,
    asinImpressionShare: row.impressionShare,
    totalClicks: row.totalClicks,
    asinClicks: row.asinClicks,
    asinClickShare: row.clickShare,
    totalCartAdds: row.totalCartAdds,
    asinCartAdds: row.asinCartAdds,
    asinCartAddShare: row.asinCartAddShare,
    totalPurchases: row.totalPurchases,
    asinPurchases: row.asinPurchases,
    asinPurchaseShare: row.purchaseShare,
  }));
}

export interface WeeklyPpcQueryRecord {
  id: string;
  profileId: string;
  marketplaceId: string;
  weekStart: string;
  campaignId: string;
  adGroupId: string;
  searchTerm: string;
  asin: string | null;
  attributedAsins: string[];
  spend: number;
  sales: number;
  clicks: number;
  orders: number;
  groupRole: 'rank' | 'discovery' | 'profit' | 'shield' | null;
}

/**
 * Aggregate PPC once before resolving advertised ASINs. The lateral ASIN read
 * cannot multiply fact rows, so a multi-ASIN ad group becomes ambiguous rather
 * than duplicating its spend across sibling SQP rows.
 */
export async function readWeeklyPpcQueryFacts(
  handle: DbHandle,
  input: {
    orgId: string;
    profileId: string;
    marketplaceId: string;
    weekStart: string;
    weekEnd: string;
  },
): Promise<WeeklyPpcQueryRecord[]> {
  assertWeek(input.weekStart, input.weekEnd);
  const rows = await handle.sql<{
    campaign_id: string;
    ad_group_id: string;
    search_term: string;
    asins: string[] | null;
    spend: number;
    sales: number;
    clicks: number;
    orders: number;
    group_role: WeeklyPpcQueryRecord['groupRole'];
  }[]>`
    with ppc as (
      select f.campaign_id, f.ad_group_id, f.search_term,
             sum(f.cost)::float8 as spend,
             sum(f.sales_7d)::float8 as sales,
             sum(f.clicks)::float8 as clicks,
             sum(f.purchases_7d)::float8 as orders
        from public.fact_search_term_daily f
       where f.org_id = ${input.orgId}
         and f.profile_id = ${input.profileId}
         and f.date between ${input.weekStart}::date and ${input.weekEnd}::date
       group by f.campaign_id, f.ad_group_id, f.search_term
    )
    select ppc.campaign_id, ppc.ad_group_id, ppc.search_term,
           advertised.asins, ppc.spend, ppc.sales, ppc.clicks, ppc.orders,
           groups.role::text as group_role
      from ppc
      left join lateral (
        select array_agg(distinct upper(product.asin) order by upper(product.asin))
          filter (where product.asin is not null and btrim(product.asin) <> '') as asins
          from public.product_ads product
         where product.org_id = ${input.orgId}
           and product.profile_id = ${input.profileId}
           and product.ad_group_id = ppc.ad_group_id
           and product.deleted_at is null
           and product.state <> 'archived'
      ) advertised on true
      left join public.campaign_optimization_assignments assignment
        on assignment.org_id = ${input.orgId}
       and assignment.profile_id = ${input.profileId}
       and assignment.campaign_id = ppc.campaign_id
      left join public.optimization_groups groups
        on groups.org_id = assignment.org_id
       and groups.profile_id = assignment.profile_id
       and groups.id = assignment.group_id
     order by ppc.campaign_id, ppc.ad_group_id, ppc.search_term
  `;
  return rows.map((row) => {
    const attributedAsins = normalizeAsins(row.asins ?? []);
    return {
      id: [row.campaign_id, row.ad_group_id, row.search_term].join('\u0000'),
      profileId: input.profileId,
      marketplaceId: input.marketplaceId,
      weekStart: input.weekStart,
      campaignId: row.campaign_id,
      adGroupId: row.ad_group_id,
      searchTerm: row.search_term,
      asin: attributedAsins.length === 1 ? attributedAsins[0] ?? null : null,
      attributedAsins,
      spend: row.spend,
      sales: row.sales,
      clicks: row.clicks,
      orders: row.orders,
      groupRole: row.group_role,
    };
  });
}

export interface VocabularyPersistenceCounts {
  offered: number;
  upserts: number;
  readBack: number;
  approvedReadBack: number;
}

/**
 * Upsert imported/operator/suggested terms without undoing a prior human
 * approval. An AI refresh may update the display value, but cannot make an
 * approved term pending again.
 */
export async function persistQueryVocabulary(
  handle: DbHandle,
  entries: readonly QueryVocabularyEntryType[],
): Promise<VocabularyPersistenceCounts> {
  const parsed = entries.map((entry, index) => {
    const value = QueryVocabularyEntry.parse(entry);
    if (value.approved && value.reviewedAt === null) {
      throw new SqpPersistenceError(`vocabulary entry ${index} is approved without review evidence`);
    }
    return value;
  });
  assertUnique(parsed, (entry) => [
    entry.orgId,
    entry.marketplaceId,
    entry.kind,
    entry.normalizedValue,
  ], 'vocabulary entry');
  if (parsed.length === 0) {
    return { offered: 0, upserts: 0, readBack: 0, approvedReadBack: 0 };
  }

  const keysByScope = groupVocabularyKeys(parsed);
  return handle.db.transaction(async (tx) => {
    let upserts = 0;
    const values = parsed.map((entry) => ({
      ...(entry.id === undefined ? {} : { id: entry.id }),
      orgId: entry.orgId,
      marketplaceId: entry.marketplaceId,
      kind: entry.kind,
      value: entry.value,
      normalizedValue: entry.normalizedValue,
      source: entry.source,
      approved: entry.approved,
      reviewedAt: entry.reviewedAt === null ? null : new Date(entry.reviewedAt),
      updatedAt: new Date(),
    }));
    for (const chunk of chunkForInsert(
      values,
      Object.keys(getTableColumns(queryVocabulary)).length,
    )) {
      const written = await tx
        .insert(queryVocabulary)
        .values(chunk)
        .onConflictDoUpdate({
          target: [
            queryVocabulary.orgId,
            queryVocabulary.marketplaceId,
            queryVocabulary.kind,
            queryVocabulary.normalizedValue,
          ],
          set: {
            value: sql`excluded.value`,
            source: sql`case when ${queryVocabulary.approved} then ${queryVocabulary.source} else excluded.source end`,
            approved: sql`${queryVocabulary.approved} or excluded.approved`,
            reviewedAt: sql`coalesce(${queryVocabulary.reviewedAt}, excluded.reviewed_at)`,
            updatedAt: new Date(),
          },
        })
        .returning({ id: queryVocabulary.id });
      upserts += written.length;
    }
    assertCount('vocabulary upserts', parsed.length, upserts);

    const readBackRows = [];
    for (const scope of keysByScope.values()) {
      const rows = await tx
        .select({
          kind: queryVocabulary.kind,
          normalizedValue: queryVocabulary.normalizedValue,
          approved: queryVocabulary.approved,
        })
        .from(queryVocabulary)
        .where(and(
          eq(queryVocabulary.orgId, scope.orgId),
          eq(queryVocabulary.marketplaceId, scope.marketplaceId),
          inArray(queryVocabulary.normalizedValue, scope.normalizedValues),
        ));
      const expected = new Set(scope.keys);
      readBackRows.push(...rows.filter((row) => expected.has(`${row.kind}\u0000${row.normalizedValue}`)));
    }
    assertCount('vocabulary read-back', parsed.length, readBackRows.length);
    return {
      offered: parsed.length,
      upserts,
      readBack: readBackRows.length,
      approvedReadBack: readBackRows.filter((row) => row.approved).length,
    };
  });
}

export async function listQueryVocabulary(
  handle: DbHandle,
  input: { orgId: string; marketplaceId: string; approved?: boolean },
): Promise<QueryVocabularyEntryType[]> {
  const rows = await handle.db
    .select()
    .from(queryVocabulary)
    .where(and(
      eq(queryVocabulary.orgId, input.orgId),
      eq(queryVocabulary.marketplaceId, input.marketplaceId),
      input.approved === undefined ? undefined : eq(queryVocabulary.approved, input.approved),
    ))
    .orderBy(queryVocabulary.kind, queryVocabulary.normalizedValue, queryVocabulary.id);
  return rows.map((row) => QueryVocabularyEntry.parse({
    id: row.id,
    orgId: row.orgId,
    marketplaceId: row.marketplaceId,
    kind: row.kind,
    value: row.value,
    normalizedValue: row.normalizedValue,
    source: row.source,
    approved: row.approved,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
  }));
}

export async function approveQueryVocabularyEntry(
  handle: DbHandle,
  input: { orgId: string; id: string; reviewedBy: string; reviewedAt: Date },
): Promise<QueryVocabularyEntryType> {
  const rows = await handle.db
    .update(queryVocabulary)
    .set({
      approved: true,
      reviewedAt: input.reviewedAt,
      reviewedBy: input.reviewedBy,
      updatedAt: input.reviewedAt,
    })
    .where(and(eq(queryVocabulary.orgId, input.orgId), eq(queryVocabulary.id, input.id)))
    .returning();
  const row = rows[0];
  if (!row) throw new SqpPersistenceError('vocabulary entry was not found in the organisation');
  return QueryVocabularyEntry.parse({
    id: row.id,
    orgId: row.orgId,
    marketplaceId: row.marketplaceId,
    kind: row.kind,
    value: row.value,
    normalizedValue: row.normalizedValue,
    source: row.source,
    approved: row.approved,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
  });
}

export interface ContextualProposalPersistenceCounts {
  offered: number;
  upserts: number;
  readBack: number;
  preservedHumanDecisions: number;
}

/** Persist generated proposals as review-only rows without resetting decisions. */
export async function persistContextualNegativeProposals(
  handle: DbHandle,
  input: { orgId: string; profileId: string; proposals: readonly ContextualNegativeProposalType[] },
): Promise<ContextualProposalPersistenceCounts> {
  const proposals = input.proposals.map((proposal, index) => {
    const parsed = ContextualNegativeProposal.parse(proposal);
    if (parsed.profileId !== input.profileId) {
      throw new SqpPersistenceError(`proposal ${index} belongs to another profile`);
    }
    if (parsed.status !== 'proposed') {
      throw new SqpPersistenceError(`proposal ${index} is not review-only`);
    }
    return parsed;
  });
  assertUnique(proposals, (proposal) => [
    proposal.profileId,
    proposal.campaignId,
    proposal.adGroupId,
    proposal.normalizedQuery,
    proposal.matchType,
  ], 'contextual proposal');
  if (proposals.length === 0) {
    return { offered: 0, upserts: 0, readBack: 0, preservedHumanDecisions: 0 };
  }

  return handle.db.transaction(async (tx) => {
    const profile = await tx
      .select({ id: adProfiles.id })
      .from(adProfiles)
      .where(and(eq(adProfiles.orgId, input.orgId), eq(adProfiles.id, input.profileId)))
      .limit(1);
    if (!profile[0]) {
      throw new SqpPersistenceError('proposal profile does not belong to the organisation');
    }

    let upserts = 0;
    for (const chunk of chunkForInsert(
      proposals.map((proposal) => ({
        ...(proposal.id === undefined ? {} : { id: proposal.id }),
        orgId: input.orgId,
        profileId: input.profileId,
        marketplaceId: proposal.marketplaceId,
        campaignId: proposal.campaignId,
        adGroupId: proposal.adGroupId,
        searchTerm: proposal.searchTerm,
        normalizedQuery: proposal.normalizedQuery,
        category: proposal.category,
        sourceGroupRole: proposal.sourceGroupRole,
        matchType: proposal.matchType,
        reason: proposal.reason,
        status: 'proposed' as const,
        updatedAt: new Date(),
      })),
      Object.keys(getTableColumns(contextualNegativeProposals)).length,
    )) {
      const written = await tx
        .insert(contextualNegativeProposals)
        .values(chunk)
        .onConflictDoUpdate({
          target: [
            contextualNegativeProposals.profileId,
            contextualNegativeProposals.campaignId,
            contextualNegativeProposals.adGroupId,
            contextualNegativeProposals.normalizedQuery,
            contextualNegativeProposals.matchType,
          ],
          set: {
            marketplaceId: sql`excluded.marketplace_id`,
            searchTerm: sql`excluded.search_term`,
            category: sql`excluded.category`,
            sourceGroupRole: sql`excluded.source_group_role`,
            reason: sql`excluded.reason`,
            // A refreshed suggestion never erases an accepted/dismissed/exported decision.
            status: sql`case when ${contextualNegativeProposals.status} = 'proposed' then 'proposed' else ${contextualNegativeProposals.status} end`,
            updatedAt: new Date(),
          },
        })
        .returning({ status: contextualNegativeProposals.status });
      upserts += written.length;
    }
    assertCount('contextual proposal upserts', proposals.length, upserts);

    const keys = proposals.map((proposal) => [
      proposal.campaignId,
      proposal.adGroupId,
      proposal.normalizedQuery,
      proposal.matchType,
    ].join('\u0000'));
    const rows = await tx
      .select({
        campaignId: contextualNegativeProposals.campaignId,
        adGroupId: contextualNegativeProposals.adGroupId,
        normalizedQuery: contextualNegativeProposals.normalizedQuery,
        matchType: contextualNegativeProposals.matchType,
        status: contextualNegativeProposals.status,
      })
      .from(contextualNegativeProposals)
      .where(and(
        eq(contextualNegativeProposals.orgId, input.orgId),
        eq(contextualNegativeProposals.profileId, input.profileId),
      ));
    const expected = new Set(keys);
    const readBack = rows.filter((row) => expected.has([
      row.campaignId,
      row.adGroupId,
      row.normalizedQuery,
      row.matchType,
    ].join('\u0000')));
    assertCount('contextual proposal read-back', proposals.length, readBack.length);
    return {
      offered: proposals.length,
      upserts,
      readBack: readBack.length,
      preservedHumanDecisions: readBack.filter((row) => row.status !== 'proposed').length,
    };
  });
}

function validatePromotion(input: SqpWeeklyPromotionInput): {
  orgId: string;
  profileId: string;
  marketplaceId: string;
  weekStart: string;
  weekEnd: string;
  requestedAsins: string[];
  requestIdentity: string;
  requestedAt: Date;
  completedAt: Date;
  sourceReports: SqpSourceReportMetadata[];
  inputFingerprint: string;
  rows: SqpWeeklyFactType[];
  counts: SqpIngestionCountsType;
} {
  const counts = SqpIngestionCounts.parse(input.counts);
  if (counts.sourceRows !== counts.parsedRows + counts.refusedRows) {
    throw new SqpPersistenceError('SQP source rows do not reconcile with parsed and refused rows');
  }
  if (counts.deduplicatedRows !== input.rows.length || counts.upserts !== input.rows.length) {
    throw new SqpPersistenceError('SQP deduplicated/upsert counts do not match offered rows');
  }
  if (counts.parsedRows < counts.deduplicatedRows) {
    throw new SqpPersistenceError('SQP parsed rows cannot be fewer than deduplicated rows');
  }
  assertWeek(input.weekStart, input.weekEnd);
  const requestedAsins = normalizeAsins(input.requestedAsins);
  if (requestedAsins.length === 0) throw new SqpPersistenceError('SQP promotion has no requested ASINs');
  const requestIdentity = input.requestIdentity.trim();
  if (requestIdentity.length === 0) {
    throw new SqpPersistenceError('SQP promotion has no stable request identity');
  }
  assertTimestamp('SQP requestedAt', input.requestedAt);
  assertTimestamp('SQP completedAt', input.completedAt);
  if (input.completedAt < input.requestedAt) {
    throw new SqpPersistenceError('SQP completion cannot precede its request');
  }
  const sourceReports = validateSourceReports(input.sourceReports, requestedAsins);
  const earliestRequestedAt = sourceReports.reduce(
    (earliest, report) => report.requestedAt < earliest ? report.requestedAt : earliest,
    sourceReports[0]!.requestedAt,
  );
  const latestCompletedAt = sourceReports.reduce(
    (latest, report) => report.completedAt > latest ? report.completedAt : latest,
    sourceReports[0]!.completedAt,
  );
  if (earliestRequestedAt.getTime() !== input.requestedAt.getTime()) {
    throw new SqpPersistenceError('SQP requestedAt does not match its earliest source report');
  }
  if (latestCompletedAt.getTime() !== input.completedAt.getTime()) {
    throw new SqpPersistenceError('SQP completedAt does not match its latest source report');
  }
  if (counts.sourceAsins > requestedAsins.length) {
    throw new SqpPersistenceError('SQP source ASIN count exceeds the requested scope');
  }
  const requested = new Set(requestedAsins);
  const rows = input.rows.map((value, index) => {
    const row = SqpWeeklyFact.parse(value);
    if (
      row.profileId !== input.profileId ||
      row.marketplaceId !== input.marketplaceId ||
      row.weekStart !== input.weekStart ||
      row.weekEnd !== input.weekEnd
    ) {
      throw new SqpPersistenceError(`SQP row ${index} is outside the promotion scope`);
    }
    if (!requested.has(row.asin.toUpperCase())) {
      throw new SqpPersistenceError(`SQP row ${index} returned an unrequested ASIN`);
    }
    return { ...row, asin: row.asin.toUpperCase() };
  });
  assertUnique(rows, (row) => [
    row.profileId,
    row.marketplaceId,
    row.weekStart,
    row.asin,
    row.normalizedQuery,
  ], 'SQP fact');
  const sortedRows = [...rows].sort((left, right) =>
    left.asin.localeCompare(right.asin) || left.normalizedQuery.localeCompare(right.normalizedQuery),
  );
  const inputFingerprint = createHash('sha256').update(JSON.stringify({
    orgId: input.orgId,
    profileId: input.profileId,
    marketplaceId: input.marketplaceId,
    weekStart: input.weekStart,
    weekEnd: input.weekEnd,
    requestedAsins,
    requestIdentity,
    requestedAt: input.requestedAt.toISOString(),
    completedAt: input.completedAt.toISOString(),
    sourceReports: sourceReports.map(serializeSourceReport),
    rows: sortedRows,
    counts,
  })).digest('hex');
  return {
    orgId: input.orgId,
    profileId: input.profileId,
    marketplaceId: input.marketplaceId,
    weekStart: input.weekStart,
    weekEnd: input.weekEnd,
    requestedAsins,
    requestIdentity,
    requestedAt: new Date(input.requestedAt),
    completedAt: new Date(input.completedAt),
    sourceReports,
    inputFingerprint,
    rows: sortedRows,
    counts,
  };
}

function validateSourceReports(
  values: readonly SqpSourceReportMetadata[],
  requestedAsins: readonly string[],
): SqpSourceReportMetadata[] {
  if (values.length === 0) throw new SqpPersistenceError('SQP promotion has no source reports');
  const seenRequestKeys = new Set<string>();
  const seenReportIds = new Set<string>();
  const seenAsins = new Set<string>();
  const reports = values.map((value, index) => {
    const requestKey = value.requestKey.trim();
    const reportId = value.reportId.trim();
    const reportDocumentId = value.reportDocumentId?.trim() || null;
    if (requestKey.length === 0 || reportId.length === 0) {
      throw new SqpPersistenceError(`SQP source report ${index} lacks provider identity`);
    }
    if (seenRequestKeys.has(requestKey) || seenReportIds.has(reportId)) {
      throw new SqpPersistenceError(`duplicate SQP source report identity at index ${index}`);
    }
    seenRequestKeys.add(requestKey);
    seenReportIds.add(reportId);
    assertTimestamp(`SQP source report ${index} requestedAt`, value.requestedAt);
    assertTimestamp(`SQP source report ${index} completedAt`, value.completedAt);
    if (value.completedAt < value.requestedAt) {
      throw new SqpPersistenceError(`SQP source report ${index} completed before it was requested`);
    }
    if (value.providerCreatedAt !== null) {
      assertTimestamp(`SQP source report ${index} providerCreatedAt`, value.providerCreatedAt);
    }
    const asins = normalizeAsins(value.requestedAsins);
    if (asins.length === 0) {
      throw new SqpPersistenceError(`SQP source report ${index} has no requested ASINs`);
    }
    for (const asin of asins) {
      if (seenAsins.has(asin)) {
        throw new SqpPersistenceError(`SQP source reports overlap on ASIN ${asin}`);
      }
      seenAsins.add(asin);
    }
    return {
      requestKey,
      reportId,
      reportDocumentId,
      requestedAt: new Date(value.requestedAt),
      completedAt: new Date(value.completedAt),
      providerCreatedAt: value.providerCreatedAt === null ? null : new Date(value.providerCreatedAt),
      requestedAsins: asins,
    };
  }).sort((left, right) => left.requestKey.localeCompare(right.requestKey));
  if (
    seenAsins.size !== requestedAsins.length ||
    requestedAsins.some((asin) => !seenAsins.has(asin))
  ) {
    throw new SqpPersistenceError('SQP source reports do not exactly cover the requested ASIN scope');
  }
  return reports;
}

function serializeSourceReport(report: SqpSourceReportMetadata): {
  requestKey: string;
  reportId: string;
  reportDocumentId: string | null;
  requestedAt: string;
  completedAt: string;
  providerCreatedAt: string | null;
  requestedAsins: readonly string[];
} {
  return {
    requestKey: report.requestKey,
    reportId: report.reportId,
    reportDocumentId: report.reportDocumentId,
    requestedAt: report.requestedAt.toISOString(),
    completedAt: report.completedAt.toISOString(),
    providerCreatedAt: report.providerCreatedAt?.toISOString() ?? null,
    requestedAsins: report.requestedAsins,
  };
}

function assertTimestamp(label: string, value: Date): void {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new SqpPersistenceError(`${label} is invalid`);
  }
}

function assertWeek(weekStart: string, weekEnd: string): void {
  const start = new Date(`${weekStart}T00:00:00Z`);
  const end = new Date(`${weekEnd}T00:00:00Z`);
  if (
    Number.isNaN(start.valueOf()) ||
    Number.isNaN(end.valueOf()) ||
    start.toISOString().slice(0, 10) !== weekStart ||
    end.toISOString().slice(0, 10) !== weekEnd ||
    start.getUTCDay() !== 0 ||
    end.getUTCDay() !== 6 ||
    end.valueOf() - start.valueOf() !== 6 * 86_400_000
  ) {
    throw new SqpPersistenceError('SQP promotion must cover one Sunday-Saturday week');
  }
}

function normalizeAsins(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toUpperCase()).filter(Boolean))].sort();
}

function assertUnique<T>(
  rows: readonly T[],
  key: (row: T) => readonly string[],
  label: string,
): void {
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const value = key(row).join('\u0000');
    if (seen.has(value)) throw new SqpPersistenceError(`duplicate ${label} at index ${index}`);
    seen.add(value);
  });
}

function assertCount(label: string, expected: number, actual: number): void {
  if (expected !== actual) throw new SqpPersistenceError(`${label}: expected ${expected}, got ${actual}`);
}

function groupVocabularyKeys(entries: readonly QueryVocabularyEntryType[]): Map<string, {
  orgId: string;
  marketplaceId: string;
  normalizedValues: string[];
  keys: string[];
}> {
  const groups = new Map<string, {
    orgId: string;
    marketplaceId: string;
    normalizedValues: string[];
    keys: string[];
  }>();
  for (const entry of entries) {
    const scopeKey = `${entry.orgId}\u0000${entry.marketplaceId}`;
    const current = groups.get(scopeKey) ?? {
      orgId: entry.orgId,
      marketplaceId: entry.marketplaceId,
      normalizedValues: [],
      keys: [],
    };
    current.normalizedValues.push(entry.normalizedValue);
    current.keys.push(`${entry.kind}\u0000${entry.normalizedValue}`);
    groups.set(scopeKey, current);
  }
  return groups;
}

// Keep these imported contract unions exercised in this package's public API.
export type SqpVocabularyKind = QueryVocabularyKind;
export type SqpVocabularySource = QueryVocabularySource;
