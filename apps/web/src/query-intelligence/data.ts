import type { RequestDatabase, WeeklyPpcQueryRecord } from '@wizard-ads/db';
import {
  ContextualNegativeProposal,
  QueryVocabularyEntry,
  SqpWeeklyFact,
} from '@wizard-ads/shared';
import type {
  ContextualNegativeProposal as ContextualNegativeProposalType,
  QueryVocabularyEntry as QueryVocabularyEntryType,
  SqpWeeklyFact as SqpWeeklyFactType,
} from '@wizard-ads/shared';
import type { QueryIntelligenceSource, SqpPromotionEvidence } from './model';

export interface QueryIntelligenceScope {
  marketplaceId: string;
  weekStart: string;
  weekEnd: string;
  factRows: number;
  asinCount: number;
  queryCount: number;
  loadedAt: string;
}

type DateValue = Date | string;

function isoDate(value: DateValue): string {
  const text = String(value);
  const date = value instanceof Date
    ? value
    : /^\d{4}-\d{2}-\d{2}$/.test(text)
      ? new Date(`${text}T00:00:00Z`)
      : new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date from database: ${String(value)}`);
  return date.toISOString().slice(0, 10);
}

function isoTimestamp(value: DateValue): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp from database: ${String(value)}`);
  }
  return date.toISOString();
}

function number(value: string | number | null): number {
  return value === null ? 0 : Number(value);
}

export async function listQueryIntelligenceScopes(
  handle: Pick<RequestDatabase, 'sql'>,
  input: { orgId: string; profileId: string },
): Promise<QueryIntelligenceScope[]> {
  const rows = await handle.sql<{
    marketplace_id: string;
    week_start: DateValue;
    week_end: DateValue;
    fact_rows: number;
    asin_count: number;
    query_count: number;
    loaded_at: DateValue;
  }[]>`
    select marketplace_id, week_start, max(week_end)::date as week_end,
           count(*)::int as fact_rows,
           count(distinct asin)::int as asin_count,
           count(distinct normalized_query)::int as query_count,
           max(loaded_at) as loaded_at
      from public.fact_sqp_weekly
     where org_id = ${input.orgId}
       and profile_id = ${input.profileId}
       and marketplace_id is not null
       and normalized_query is not null
     group by marketplace_id, week_start
     order by week_start desc, marketplace_id
     limit 104
  `;

  return rows.map((row) => ({
    marketplaceId: row.marketplace_id,
    weekStart: isoDate(row.week_start),
    weekEnd: isoDate(row.week_end),
    factRows: Number(row.fact_rows),
    asinCount: Number(row.asin_count),
    queryCount: Number(row.query_count),
    loadedAt: isoTimestamp(row.loaded_at),
  }));
}

async function readFacts(
  handle: Pick<RequestDatabase, 'sql'>,
  input: { orgId: string; profileId: string; marketplaceId: string; weekStart: string },
): Promise<SqpWeeklyFactType[]> {
  const rows = await handle.sql<{
    profile_id: string;
    marketplace_id: string;
    asin: string;
    week_start: DateValue;
    week_end: DateValue;
    search_query: string;
    normalized_query: string;
    category: SqpWeeklyFactType['category'];
    search_query_score: string | number | null;
    search_volume: string | number;
    total_impressions: string | number;
    asin_impressions: string | number;
    impression_share: string | number;
    total_clicks: string | number;
    asin_clicks: string | number;
    click_share: string | number;
    total_cart_adds: string | number;
    asin_cart_adds: string | number;
    asin_cart_add_share: string | number;
    total_purchases: string | number;
    asin_purchases: string | number;
    purchase_share: string | number;
  }[]>`
    select profile_id, marketplace_id, asin, week_start, week_end,
           search_query, normalized_query, category, search_query_score,
           search_volume, total_impressions, asin_impressions, impression_share,
           total_clicks, asin_clicks, click_share,
           total_cart_adds, asin_cart_adds, asin_cart_add_share,
           total_purchases, asin_purchases, purchase_share
      from public.fact_sqp_weekly
     where org_id = ${input.orgId}
       and profile_id = ${input.profileId}
       and marketplace_id = ${input.marketplaceId}
       and week_start = ${input.weekStart}::date
     order by search_volume desc, asin_purchases desc, normalized_query, asin
  `;

  const facts = rows.map((row) => SqpWeeklyFact.parse({
    profileId: row.profile_id,
    marketplaceId: row.marketplace_id,
    asin: row.asin,
    weekStart: isoDate(row.week_start),
    weekEnd: isoDate(row.week_end),
    searchQuery: row.search_query,
    normalizedQuery: row.normalized_query,
    category: row.category,
    searchQueryScore: row.search_query_score === null ? null : Number(row.search_query_score),
    searchQueryVolume: number(row.search_volume),
    totalImpressions: number(row.total_impressions),
    asinImpressions: number(row.asin_impressions),
    asinImpressionShare: number(row.impression_share),
    totalClicks: number(row.total_clicks),
    asinClicks: number(row.asin_clicks),
    asinClickShare: number(row.click_share),
    totalCartAdds: number(row.total_cart_adds),
    asinCartAdds: number(row.asin_cart_adds),
    asinCartAddShare: number(row.asin_cart_add_share),
    totalPurchases: number(row.total_purchases),
    asinPurchases: number(row.asin_purchases),
    asinPurchaseShare: number(row.purchase_share),
  }));
  if (facts.length !== rows.length) throw new Error('SQP fact parse count mismatch');
  return facts;
}

async function readPpc(
  handle: Pick<RequestDatabase, 'sql'>,
  input: {
    orgId: string;
    profileId: string;
    marketplaceId: string;
    weekStart: string;
    weekEnd: string;
  },
): Promise<WeeklyPpcQueryRecord[]> {
  const rows = await handle.sql<{
    campaign_id: string;
    ad_group_id: string;
    search_term: string;
    asins: string[] | null;
    spend: string | number;
    sales: string | number;
    clicks: string | number;
    orders: string | number;
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
     order by ppc.spend desc, ppc.campaign_id, ppc.ad_group_id, ppc.search_term
  `;

  const records = rows.map((row) => {
    const attributedAsins = [...new Set((row.asins ?? []).map((asin) => asin.toUpperCase()))].sort();
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
      spend: Number(row.spend),
      sales: Number(row.sales),
      clicks: Number(row.clicks),
      orders: Number(row.orders),
      groupRole: row.group_role,
    } satisfies WeeklyPpcQueryRecord;
  });
  if (records.length !== rows.length) throw new Error('PPC query parse count mismatch');
  return records;
}

async function readVocabulary(
  handle: Pick<RequestDatabase, 'sql'>,
  input: { orgId: string; marketplaceId: string },
): Promise<QueryVocabularyEntryType[]> {
  const rows = await handle.sql<{
    id: string;
    org_id: string;
    marketplace_id: string;
    kind: QueryVocabularyEntryType['kind'];
    value: string;
    normalized_value: string;
    source: QueryVocabularyEntryType['source'];
    approved: boolean;
    reviewed_at: DateValue | null;
  }[]>`
    select id, org_id, marketplace_id, kind, value, normalized_value,
           source, approved, reviewed_at
      from public.query_vocabulary
     where org_id = ${input.orgId}
       and marketplace_id = ${input.marketplaceId}
     order by approved desc, kind, normalized_value
  `;
  const vocabulary = rows.map((row) => QueryVocabularyEntry.parse({
    id: row.id,
    orgId: row.org_id,
    marketplaceId: row.marketplace_id,
    kind: row.kind,
    value: row.value,
    normalizedValue: row.normalized_value,
    source: row.source,
    approved: row.approved,
    reviewedAt: row.reviewed_at === null ? null : isoTimestamp(row.reviewed_at),
  }));
  if (vocabulary.length !== rows.length) throw new Error('Vocabulary parse count mismatch');
  return vocabulary;
}

async function readProposals(
  handle: Pick<RequestDatabase, 'sql'>,
  input: { orgId: string; profileId: string; marketplaceId: string },
): Promise<ContextualNegativeProposalType[]> {
  const rows = await handle.sql<{
    id: string;
    profile_id: string;
    marketplace_id: string;
    campaign_id: string;
    ad_group_id: string;
    search_term: string;
    normalized_query: string;
    category: ContextualNegativeProposalType['category'];
    source_group_role: ContextualNegativeProposalType['sourceGroupRole'];
    match_type: ContextualNegativeProposalType['matchType'];
    reason: string;
    status: ContextualNegativeProposalType['status'];
  }[]>`
    select id, profile_id, marketplace_id, campaign_id, ad_group_id,
           search_term, normalized_query, category, source_group_role,
           match_type, reason, status
      from public.contextual_negative_proposals
     where org_id = ${input.orgId}
       and profile_id = ${input.profileId}
       and marketplace_id = ${input.marketplaceId}
     order by case status when 'proposed' then 0 else 1 end, search_term
     limit 250
  `;
  const proposals = rows.map((row) => ContextualNegativeProposal.parse({
    id: row.id,
    profileId: row.profile_id,
    marketplaceId: row.marketplace_id,
    campaignId: row.campaign_id,
    adGroupId: row.ad_group_id,
    searchTerm: row.search_term,
    normalizedQuery: row.normalized_query,
    category: row.category,
    sourceGroupRole: row.source_group_role,
    matchType: row.match_type,
    reason: row.reason,
    status: row.status,
  }));
  if (proposals.length !== rows.length) throw new Error('Contextual proposal parse count mismatch');
  return proposals;
}

async function readPromotionEvidence(
  handle: Pick<RequestDatabase, 'sql'>,
  input: { orgId: string; profileId: string; marketplaceId: string; weekStart: string },
): Promise<SqpPromotionEvidence[]> {
  const rows = await handle.sql<{
    id: string;
    source_system: string;
    promoted_at: DateValue;
    requested_asins: string[];
    source_rows: string | number;
    parsed_rows: string | number;
    refused_rows: string | number;
    deduplicated_rows: string | number;
    promoted_rows: string | number;
    canonical_rows: string | number;
  }[]>`
    select id, source_system, promoted_at, requested_asins,
           source_rows, parsed_rows, refused_rows, deduplicated_rows,
           promoted_rows, canonical_rows
      from public.sqp_promotion_runs
     where org_id = ${input.orgId}
       and profile_id = ${input.profileId}
       and marketplace_id = ${input.marketplaceId}
       and week_start = ${input.weekStart}::date
     order by promoted_at desc
     limit 100
  `;
  return rows.map((row) => ({
    id: row.id,
    sourceSystem: row.source_system,
    promotedAt: isoTimestamp(row.promoted_at),
    requestedAsins: row.requested_asins,
    sourceRows: Number(row.source_rows),
    parsedRows: Number(row.parsed_rows),
    refusedRows: Number(row.refused_rows),
    deduplicatedRows: Number(row.deduplicated_rows),
    promotedRows: Number(row.promoted_rows),
    canonicalRows: Number(row.canonical_rows),
  }));
}

export async function loadQueryIntelligenceSource(
  handle: Pick<RequestDatabase, 'sql'>,
  input: {
    orgId: string;
    profileId: string;
    marketplaceId: string;
    weekStart: string;
    weekEnd: string;
  },
): Promise<QueryIntelligenceSource> {
  const [facts, ppc, vocabulary, proposals, promotionRuns] = await Promise.all([
    readFacts(handle, input),
    readPpc(handle, input),
    readVocabulary(handle, input),
    readProposals(handle, input),
    readPromotionEvidence(handle, input),
  ]);
  return { facts, ppc, vocabulary, proposals, promotionRuns };
}
