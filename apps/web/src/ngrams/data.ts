/**
 * Search-term rows for the n-gram explorer, and the scopes it can be run over.
 *
 * The explorer aggregates in the engine (`@wizard-ads/core`'s `aggregateNgrams`)
 * rather than in SQL, deliberately: the counting rule that makes n-grams honest
 * — a gram is counted **once per search term**, however many times it occurs in
 * it — is one line in that module and several subqueries here, and the module
 * is the one with the tests. So this file's whole job is to hand the engine the
 * rows for a scope.
 *
 * Every query carries `org_id` as well as `profile_id`. The web handle connects
 * as the application's own role, so RLS is the second fence rather than the
 * first; a query that forgot the org predicate would be a cross-tenant read in
 * the browser even though the same statement is safe from PostgREST.
 */
import type { SearchTermRow } from '@wizard-ads/core';
import type { RequestDatabase } from '@wizard-ads/db';

export type NgramQueryHandle = Pick<RequestDatabase, 'sql'>;

export interface NgramScope {
  orgId: string;
  profileId: string;
  period: { start: string; end: string };
  /** Restrict to these Amazon campaign ids. Empty or absent means the profile. */
  campaignIds?: readonly string[] | null;
  /** Hard cap: the explorer holds the set in memory, like the grid. */
  limit?: number;
}

export const SEARCH_TERM_CAP = 50_000;

const num = (value: string | number | null | undefined): number => {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : Number(value);
};

interface Row {
  search_term: string;
  campaign_id: string;
  ad_group_id: string;
  target_id: string | null;
  match_type: string | null;
  impressions: string | number | null;
  clicks: string | number | null;
  cost: string | number | null;
  purchases_7d: string | number | null;
  sales_7d: string | number | null;
}

export interface SearchTermPayload {
  rows: SearchTermRow[];
  truncated: boolean;
}

/**
 * Search-term facts for a scope, summed over the period.
 *
 * Grouped by term *and* by its campaign/ad group, not by term alone: a
 * "propose as negative" click has to know which ad group to negate in, and a
 * term rolled up across the account cannot answer that.
 */
export async function loadSearchTermRows(
  handle: NgramQueryHandle,
  scope: NgramScope,
): Promise<SearchTermPayload> {
  const limit = scope.limit ?? SEARCH_TERM_CAP;
  const campaignIds =
    scope.campaignIds && scope.campaignIds.length > 0 ? [...scope.campaignIds] : null;

  const rows = await handle.sql<Row[]>`
    select search_term, campaign_id, ad_group_id,
           max(target_id) as target_id, max(match_type::text) as match_type,
           sum(impressions) as impressions, sum(clicks) as clicks, sum(cost) as cost,
           sum(purchases_7d) as purchases_7d, sum(sales_7d) as sales_7d
      from public.fact_search_term_daily
     where org_id = ${scope.orgId}
       and profile_id = ${scope.profileId}
       and date between ${scope.period.start} and ${scope.period.end}
       and (${campaignIds}::text[] is null or campaign_id = any (${campaignIds}::text[]))
     group by search_term, campaign_id, ad_group_id
     order by sum(cost) desc, search_term
     limit ${limit}
  `;

  return {
    rows: rows.map((row) => ({
      searchTerm: row.search_term,
      impressions: num(row.impressions),
      clicks: num(row.clicks),
      cost: num(row.cost),
      purchases7d: num(row.purchases_7d),
      sales7d: num(row.sales_7d),
      campaignId: row.campaign_id,
      adGroupId: row.ad_group_id,
      targetId: row.target_id,
      matchType: row.match_type,
    })),
    truncated: rows.length >= limit,
  };
}

export interface ScopeOption {
  id: string;
  label: string;
  /** Campaign ids the scope covers. */
  campaignIds: string[];
}

/**
 * The scopes the explorer offers: the whole profile, each campaign, each tag.
 *
 * Tags come from WP-08's `entity_tags`; a tag with no campaigns is offered
 * anyway, so an operator can see that the tag exists and covers nothing rather
 * than wondering why it is missing.
 */
export async function loadScopes(
  handle: NgramQueryHandle,
  options: { orgId: string; profileId: string },
): Promise<{ campaigns: ScopeOption[]; tags: ScopeOption[] }> {
  const campaigns = await handle.sql<{ amazon_id: string; name: string | null }[]>`
    select amazon_id, name
      from public.campaigns
     where org_id = ${options.orgId} and profile_id = ${options.profileId}
       and deleted_at is null
     order by name nulls last, amazon_id
  `;

  const tagRows = await handle.sql<{ id: string; name: string; campaign_id: string | null }[]>`
    select t.id, t.name, et.entity_id as campaign_id
      from public.tags t
      left join public.entity_tags et
        on et.tag_id = t.id and et.entity_type = 'campaign' and et.profile_id = ${options.profileId}
     where t.org_id = ${options.orgId}
     order by t.name, et.entity_id
  `;

  const byTag = new Map<string, ScopeOption>();
  for (const row of tagRows) {
    const existing = byTag.get(row.id) ?? { id: row.id, label: row.name, campaignIds: [] };
    if (row.campaign_id !== null) existing.campaignIds.push(row.campaign_id);
    byTag.set(row.id, existing);
  }

  return {
    campaigns: campaigns.map((row) => ({
      id: row.amazon_id,
      label: row.name ?? row.amazon_id,
      campaignIds: [row.amazon_id],
    })),
    tags: [...byTag.values()],
  };
}
