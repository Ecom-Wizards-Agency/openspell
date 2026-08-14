/**
 * Everything the tools read, in one place.
 *
 * The org boundary is enforced here, on every function, and not left to RLS.
 * The MCP server connects as the service role because it has to write the audit
 * log, so RLS is not in the path at all: the predicate that keeps org A out of
 * org B is the `org_id = $1` in these queries and the profile resolution above
 * them. That is why WP-09's acceptance check demands a negative test at the
 * tool layer rather than only in the database.
 */
import type { DbHandle } from '@wizard-ads/db';
import { ToolError } from './errors.js';
import { jsonText } from './json.js';
import { buildFactQuery, buildProductCoverageQuery } from './sql.js';
import type { BuiltQuery, DateWindow, FactQuerySpec } from './sql.js';

export interface KeyScopeContext {
  orgId: string;
  /** Null means every profile in the org. */
  profileIds: string[] | null;
}

export interface ProfileRecord {
  id: string;
  amazonProfileId: string;
  region: string;
  countryCode: string;
  currencyCode: string;
  timezone: string;
  accountType: string | null;
  accountName: string | null;
  syncEnabled: boolean;
  targetAcos: number | null;
  goalLens: string | null;
  monthlyBudget: number | null;
  syncedAt: Date | null;
}

interface ProfileRow {
  id: string;
  amazon_profile_id: string;
  region: string;
  country_code: string;
  currency_code: string;
  timezone: string;
  account_type: string | null;
  account_name: string | null;
  sync_enabled: boolean;
  target_acos: string | number | null;
  goal_lens: string | null;
  monthly_budget: string | number | null;
  synced_at: Date | null;
}

const num = (value: string | number | null): number | null =>
  value === null ? null : typeof value === 'number' ? value : Number(value);

const toProfile = (row: ProfileRow): ProfileRecord => ({
  id: row.id,
  amazonProfileId: row.amazon_profile_id,
  region: row.region,
  countryCode: row.country_code,
  currencyCode: row.currency_code,
  timezone: row.timezone,
  accountType: row.account_type,
  accountName: row.account_name,
  syncEnabled: row.sync_enabled,
  targetAcos: num(row.target_acos),
  goalLens: row.goal_lens,
  monthlyBudget: num(row.monthly_budget),
  syncedAt: row.synced_at,
});

export async function listProfiles(
  handle: DbHandle,
  scope: KeyScopeContext,
): Promise<ProfileRecord[]> {
  if (scope.profileIds !== null && scope.profileIds.length === 0) return [];

  const rows = await handle.sql<ProfileRow[]>`
    select id, amazon_profile_id, region::text as region, country_code, currency_code,
           timezone, account_type::text as account_type, account_name, sync_enabled,
           target_acos, goal_lens, monthly_budget, synced_at
      from public.ad_profiles
     where org_id = ${scope.orgId}
       ${
         scope.profileIds === null
           ? handle.sql``
           : handle.sql`and id = any(${handle.sql.array(scope.profileIds)}::uuid[])`
       }
     order by country_code, amazon_profile_id
  `;
  return rows.map(toProfile);
}

/**
 * Resolve a profile the caller named, by internal id or by Amazon profile id.
 *
 * Out of scope and non-existent produce the same message on purpose. "That
 * profile exists but is not yours" is a fact about another org's account, and
 * this server never states one.
 */
export async function resolveProfile(
  handle: DbHandle,
  scope: KeyScopeContext,
  profileId: string,
): Promise<ProfileRecord> {
  const rows = await handle.sql<ProfileRow[]>`
    select id, amazon_profile_id, region::text as region, country_code, currency_code,
           timezone, account_type::text as account_type, account_name, sync_enabled,
           target_acos, goal_lens, monthly_budget, synced_at
      from public.ad_profiles
     where org_id = ${scope.orgId}
       and (id::text = ${profileId} or amazon_profile_id = ${profileId})
     limit 1
  `;
  const row = rows[0];
  if (!row || (scope.profileIds !== null && !scope.profileIds.includes(row.id))) {
    throw new ToolError(
      'not_found',
      `no profile "${profileId}" is visible to this API key. Call list_profiles for the ids you can use.`,
    );
  }
  return toProfile(row);
}

export async function runBuiltQuery<T>(handle: DbHandle, query: BuiltQuery): Promise<T[]> {
  return (await handle.sql.unsafe(query.text, query.params as never[])) as unknown as T[];
}

export type FactRow = Record<string, string | number | boolean | null>;

export interface FactResult {
  rows: FactRow[];
  columns: BuiltQuery['columns'];
  /** True when the row count hit the limit, so the caller knows it is looking at a slice. */
  truncated: boolean;
}

export async function runFactQuery(
  handle: DbHandle,
  spec: FactQuerySpec,
): Promise<FactResult> {
  const query = buildFactQuery(spec);
  const rows = await runBuiltQuery<FactRow>(handle, query);
  return { rows, columns: query.columns, truncated: rows.length >= spec.limit };
}

export interface ProductCoverage {
  totalSpend: number;
  attributedSpend: number;
  excludedAdGroups: number;
  attributedShare: number | null;
}

export async function productCoverage(
  handle: DbHandle,
  orgId: string,
  profileId: string,
  window: DateWindow,
): Promise<ProductCoverage> {
  const query = buildProductCoverageQuery(orgId, profileId, window);
  const rows = await runBuiltQuery<{
    total_spend: number;
    attributed_spend: number;
    excluded_ad_groups: number;
  }>(handle, query);
  const row = rows[0] ?? { total_spend: 0, attributed_spend: 0, excluded_ad_groups: 0 };
  return {
    totalSpend: row.total_spend,
    attributedSpend: row.attributed_spend,
    excludedAdGroups: row.excluded_ad_groups,
    attributedShare: row.total_spend > 0 ? row.attributed_spend / row.total_spend : null,
  };
}

// ---------------------------------------------------------------------------
// Freshness and sync state
// ---------------------------------------------------------------------------

export interface ReportFreshness {
  reportType: string;
  status: string;
  startDate: string;
  endDate: string;
  requestedAt: Date;
  completedAt: Date | null;
  rowsParsed: number | null;
  rowsLoaded: number | null;
  countsMatch: boolean | null;
  error: string | null;
}

export interface SyncStatus {
  profileId: string;
  amazonProfileId: string;
  accountName: string | null;
  syncEnabled: boolean;
  entitiesSyncedAt: Date | null;
  /** The most recent completed day per report type: the real freshness clock. */
  reports: ReportFreshness[];
  queue: { status: string; count: number }[];
  /** Latest fact day and whether it is still attributing. */
  latestFactDate: string | null;
  latestFactProvisional: boolean | null;
}

export async function getSyncStatus(
  handle: DbHandle,
  scope: KeyScopeContext,
  profile: ProfileRecord,
): Promise<SyncStatus> {
  const reports = await handle.sql<
    {
      report_type: string;
      status: string;
      start_date: string;
      end_date: string;
      requested_at: Date;
      completed_at: Date | null;
      rows_parsed: string | null;
      rows_loaded: string | null;
      counts_match: boolean | null;
      error: string | null;
    }[]
  >`
    select distinct on (report_type)
           report_type::text as report_type, status::text as status,
           start_date::text as start_date, end_date::text as end_date,
           requested_at, completed_at, rows_parsed, rows_loaded, counts_match, error
      from public.report_requests
     where org_id = ${scope.orgId} and profile_id = ${profile.id}
     order by report_type, requested_at desc
  `;

  const queue = await handle.sql<{ status: string; count: string }[]>`
    select status::text as status, count(*)::text as count
      from public.sync_jobs
     where org_id = ${scope.orgId} and profile_id = ${profile.id}
     group by status
     order by status
  `;

  const latest = await handle.sql<{ date: string; provisional: boolean }[]>`
    select date::text as date, provisional
      from public.fact_profile_daily
     where org_id = ${scope.orgId} and profile_id = ${profile.id}
     order by date desc
     limit 1
  `;

  return {
    profileId: profile.id,
    amazonProfileId: profile.amazonProfileId,
    accountName: profile.accountName,
    syncEnabled: profile.syncEnabled,
    entitiesSyncedAt: profile.syncedAt,
    reports: reports.map((row) => ({
      reportType: row.report_type,
      status: row.status,
      startDate: row.start_date,
      endDate: row.end_date,
      requestedAt: row.requested_at,
      completedAt: row.completed_at,
      rowsParsed: row.rows_parsed === null ? null : Number(row.rows_parsed),
      rowsLoaded: row.rows_loaded === null ? null : Number(row.rows_loaded),
      countsMatch: row.counts_match,
      error: row.error,
    })),
    queue: queue.map((row) => ({ status: row.status, count: Number(row.count) })),
    latestFactDate: latest[0]?.date ?? null,
    latestFactProvisional: latest[0]?.provisional ?? null,
  };
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

export interface RecommendationRecord {
  id: string;
  runId: string;
  reason: string;
  entityType: string;
  entityId: string;
  entityName: string | null;
  campaignId: string | null;
  adGroupId: string | null;
  field: string;
  currentValue: unknown;
  proposedValue: unknown;
  inputs: unknown;
  status: string;
  createdAt: Date;
}

export interface RecommendationRunRecord {
  id: string;
  status: string;
  lookbackDays: number;
  windowStart: string | null;
  windowEnd: string | null;
  engineVersion: string | null;
  proposalsCount: number;
  finishedAt: Date | null;
  recommendations: RecommendationRecord[];
}

export async function getLatestRecommendations(
  handle: DbHandle,
  scope: KeyScopeContext,
  profile: ProfileRecord,
  options: { status?: string | undefined; reason?: string | undefined; limit: number },
): Promise<RecommendationRunRecord | null> {
  const runs = await handle.sql<
    {
      id: string;
      status: string;
      lookback_days: number;
      window_start: string | null;
      window_end: string | null;
      engine_version: string | null;
      proposals_count: number;
      finished_at: Date | null;
    }[]
  >`
    select id, status::text as status, lookback_days, window_start::text as window_start,
           window_end::text as window_end, engine_version, proposals_count, finished_at
      from public.recommendation_runs
     where org_id = ${scope.orgId} and profile_id = ${profile.id} and status = 'succeeded'
     order by coalesce(finished_at, created_at) desc
     limit 1
  `;

  const run = runs[0];
  if (!run) return null;

  const rows = await handle.sql<
    {
      id: string;
      run_id: string;
      reason: string;
      entity_type: string;
      entity_id: string;
      entity_name: string | null;
      campaign_id: string | null;
      ad_group_id: string | null;
      field: string;
      current_value: unknown;
      proposed_value: unknown;
      inputs: unknown;
      status: string;
      created_at: Date;
    }[]
  >`
    select id, run_id, reason::text as reason, entity_type::text as entity_type, entity_id,
           entity_name, campaign_id, ad_group_id, field, current_value, proposed_value,
           inputs, status::text as status, created_at
      from public.recommendations
     where org_id = ${scope.orgId} and run_id = ${run.id}
       and (${options.status ?? null}::text is null or status::text = ${options.status ?? null})
       and (${options.reason ?? null}::text is null or reason::text = ${options.reason ?? null})
     order by created_at
     limit ${options.limit}
  `;

  return {
    id: run.id,
    status: run.status,
    lookbackDays: run.lookback_days,
    windowStart: run.window_start,
    windowEnd: run.window_end,
    engineVersion: run.engine_version,
    proposalsCount: run.proposals_count,
    finishedAt: run.finished_at,
    recommendations: rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      reason: row.reason,
      entityType: row.entity_type,
      entityId: row.entity_id,
      entityName: row.entity_name,
      campaignId: row.campaign_id,
      adGroupId: row.ad_group_id,
      field: row.field,
      currentValue: row.current_value,
      proposedValue: row.proposed_value,
      inputs: row.inputs,
      status: row.status,
      createdAt: row.created_at,
    })),
  };
}

// ---------------------------------------------------------------------------
// Daily series, for the doctrine engine
// ---------------------------------------------------------------------------

export interface DailySeriesRow {
  date: string;
  impressions: number;
  clicks: number;
  spend: number;
  sales: number;
  orders: number;
  campaignId?: string;
  campaignName?: string | null;
  budget?: number | null;
}

export async function readProfileDaily(
  handle: DbHandle,
  scope: KeyScopeContext,
  profileId: string,
  window: DateWindow,
): Promise<DailySeriesRow[]> {
  const rows = await handle.sql<
    {
      date: string;
      impressions: string;
      clicks: string;
      spend: string;
      sales: string;
      orders: string;
    }[]
  >`
    select date::text as date, impressions, clicks, cost as spend,
           sales_7d as sales, purchases_7d as orders
      from public.fact_profile_daily
     where org_id = ${scope.orgId} and profile_id = ${profileId}
       and date >= ${window.from}::date and date <= ${window.to}::date
     order by date
  `;
  return rows.map((row) => ({
    date: row.date,
    impressions: Number(row.impressions),
    clicks: Number(row.clicks),
    spend: Number(row.spend),
    sales: Number(row.sales),
    orders: Number(row.orders),
  }));
}

export async function readCampaignDaily(
  handle: DbHandle,
  scope: KeyScopeContext,
  profileId: string,
  window: DateWindow,
): Promise<DailySeriesRow[]> {
  const rows = await handle.sql<
    {
      date: string;
      campaign_id: string;
      campaign_name: string | null;
      budget: string | null;
      impressions: string;
      clicks: string;
      spend: string;
      sales: string;
      orders: string;
    }[]
  >`
    with facts as (
      select date, campaign_id,
             sum(impressions) as impressions, sum(clicks) as clicks, sum(cost) as spend,
             sum(sales_7d) as sales, sum(purchases_7d) as orders
        from public.fact_sp_target_daily
       where org_id = ${scope.orgId} and profile_id = ${profileId}
         and date >= ${window.from}::date and date <= ${window.to}::date
       group by date, campaign_id
      union all
      select date, campaign_id, impressions, clicks, cost, sales_7d, purchases_7d
        from public.fact_sb_daily
       where org_id = ${scope.orgId} and profile_id = ${profileId}
         and date >= ${window.from}::date and date <= ${window.to}::date
      union all
      select date, campaign_id, impressions, clicks, cost, sales_7d, purchases_7d
        from public.fact_sd_daily
       where org_id = ${scope.orgId} and profile_id = ${profileId}
         and date >= ${window.from}::date and date <= ${window.to}::date
    ),
    totals as (
      select date, campaign_id, sum(impressions) as impressions, sum(clicks) as clicks,
             sum(spend) as spend, sum(sales) as sales, sum(orders) as orders
        from facts
       group by date, campaign_id
    )
    select t.date::text as date, t.campaign_id, c.name as campaign_name, c.budget_amount as budget,
           t.impressions, t.clicks, t.spend, t.sales, t.orders
      from totals t
      left join public.campaigns c on c.profile_id = ${profileId} and c.amazon_id = t.campaign_id
     order by t.date, t.campaign_id
  `;
  return rows.map((row) => ({
    date: row.date,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    budget: row.budget === null ? null : Number(row.budget),
    impressions: Number(row.impressions),
    clicks: Number(row.clicks),
    spend: Number(row.spend),
    sales: Number(row.sales),
    orders: Number(row.orders),
  }));
}

// ---------------------------------------------------------------------------
// Deep links
// ---------------------------------------------------------------------------

/**
 * Routes a link may point at. A whitelist because a goto link is a durable
 * artifact handed to a human: an arbitrary path would make this tool an open
 * redirect generator with a database row behind it.
 */
export const GOTO_ROUTES = [
  '/dashboard',
  '/grid',
  '/search-terms',
  '/ngrams',
  '/recommendations',
  '/sync',
  '/crosscheck',
] as const;
export type GotoRoute = (typeof GOTO_ROUTES)[number];

export interface GotoLinkRecord {
  token: string;
  url: string;
  route: string;
  expiresAt: Date | null;
}

export async function createGotoLink(
  handle: DbHandle,
  scope: KeyScopeContext,
  input: {
    route: GotoRoute;
    state: Record<string, unknown>;
    label?: string | undefined;
    expiresAt?: Date | null;
    webBaseUrl: string;
    token: string;
  },
): Promise<GotoLinkRecord> {
  const rows = await handle.sql<{ token: string; route: string; expires_at: Date | null }[]>`
    insert into public.goto_links (org_id, token, route, state, label, expires_at)
    values (${scope.orgId}, ${input.token}, ${input.route}, ${jsonText(input.state)}::jsonb,
            ${input.label ?? null}, ${input.expiresAt ? input.expiresAt.toISOString() : null}::timestamptz)
    returning token, route, expires_at
  `;
  const row = rows[0];
  if (!row) throw new Error('createGotoLink wrote no row');
  return {
    token: row.token,
    route: row.route,
    expiresAt: row.expires_at,
    url: `${input.webBaseUrl}/go/${row.token}`,
  };
}

// ---------------------------------------------------------------------------
// Context (the Context-Manager equivalent), assembled from the org's own data
// ---------------------------------------------------------------------------

export interface ProfileContext {
  profile: ProfileRecord;
  strategySummary: {
    present: boolean;
    schemaVersion: string | null;
    scope: 'profile' | 'org' | null;
    /** Section names only. The values are the agency's method and stay in the database. */
    sections: string[];
    refreshedAt: string | null;
  };
  recentChanges: {
    entityType: string;
    amazonId: string;
    entityName: string | null;
    field: string;
    oldValue: unknown;
    newValue: unknown;
    source: string;
    observedAt: Date;
  }[];
  sync: SyncStatus;
  counts: { campaigns: number; adGroups: number; keywords: number; targets: number };
}

export async function getProfileContext(
  handle: DbHandle,
  scope: KeyScopeContext,
  profile: ProfileRecord,
): Promise<ProfileContext> {
  const strategy = await handle.sql<
    { schema_version: string; doc: Record<string, unknown>; profile_id: string | null; refreshed_at: string | null }[]
  >`
    select schema_version, doc, profile_id, refreshed_at::text as refreshed_at
      from public.profile_strategy
     where org_id = ${scope.orgId} and (profile_id = ${profile.id} or profile_id is null)
     order by profile_id nulls last, updated_at desc
     limit 1
  `;

  const changes = await handle.sql<
    {
      entity_type: string;
      amazon_id: string;
      entity_name: string | null;
      field: string;
      old_value: unknown;
      new_value: unknown;
      source: string;
      observed_at: Date;
    }[]
  >`
    select entity_type::text as entity_type, amazon_id, entity_name, field,
           old_value, new_value, source::text as source, observed_at
      from public.entity_changes
     where org_id = ${scope.orgId} and profile_id = ${profile.id}
     order by observed_at desc
     limit 25
  `;

  const counts = await handle.sql<
    { campaigns: string; ad_groups: string; keywords: string; targets: string }[]
  >`
    select
      (select count(*) from public.campaigns where profile_id = ${profile.id})::text as campaigns,
      (select count(*) from public.ad_groups where profile_id = ${profile.id})::text as ad_groups,
      (select count(*) from public.keywords where profile_id = ${profile.id})::text as keywords,
      (select count(*) from public.targets where profile_id = ${profile.id})::text as targets
  `;

  const row = strategy[0];
  const countRow = counts[0];

  return {
    profile,
    strategySummary: {
      present: row !== undefined,
      schemaVersion: row?.schema_version ?? null,
      scope: row === undefined ? null : row.profile_id === null ? 'org' : 'profile',
      sections: row ? Object.keys(row.doc).sort() : [],
      refreshedAt: row?.refreshed_at ?? null,
    },
    recentChanges: changes.map((change) => ({
      entityType: change.entity_type,
      amazonId: change.amazon_id,
      entityName: change.entity_name,
      field: change.field,
      oldValue: change.old_value,
      newValue: change.new_value,
      source: change.source,
      observedAt: change.observed_at,
    })),
    sync: await getSyncStatus(handle, scope, profile),
    counts: {
      campaigns: Number(countRow?.campaigns ?? 0),
      adGroups: Number(countRow?.ad_groups ?? 0),
      keywords: Number(countRow?.keywords ?? 0),
      targets: Number(countRow?.targets ?? 0),
    },
  };
}
