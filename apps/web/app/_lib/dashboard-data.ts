/**
 * Everything the dashboard reads, in one module.
 *
 * The freshness read is the one to look at twice. It comes from
 * `report_requests` and never from the fact tables, which is a correctness rule
 * rather than a preference: Amazon omits zero-impression rows, so "the newest
 * fact is from Tuesday" is equally consistent with "the sync broke on Tuesday"
 * and "the account has spent nothing since Tuesday". Only the ledger tells them
 * apart, and telling them apart is the entire question the banner answers.
 *
 * Every read here takes the actor's `orgId` alongside the profile id and puts
 * both in the predicate. The profile is already org-checked by the caller, so
 * the second half is defence in depth rather than the only lock — but the web
 * tier connects as the service role, so "already checked upstream" is the only
 * kind of lock this layer has, and one that is written twice is the one that
 * survives a refactor.
 */
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { factProfileDaily, reportRequests } from '@wizard-ads/db';
import type { DbHandle } from '@wizard-ads/db';
import type { DailyRow } from '@wizard-ads/core';
import type { ReportLedgerEntry } from '@wizard-ads/ui';
import type { Period } from './periods.js';

/**
 * Ledger rows for one profile, newest first.
 *
 * Deliberately not filtered to completed rows: a failed newest attempt over a
 * successful older one is exactly the state an operator needs to see, and
 * filtering it out here would make the banner unable to say "loaded 3 days ago,
 * newest attempt failed".
 */
export async function loadReportLedger(
  handle: DbHandle,
  orgId: string,
  profileId: string,
  limit = 40,
): Promise<ReportLedgerEntry[]> {
  const rows = await handle.db
    .select()
    .from(reportRequests)
    .where(and(eq(reportRequests.orgId, orgId), eq(reportRequests.profileId, profileId)))
    .orderBy(desc(reportRequests.requestedAt))
    .limit(limit);

  return rows.map((row) => ({
    reportType: row.reportType,
    status: row.status,
    endDate: row.endDate,
    requestedAt: row.requestedAt.toISOString(),
    completedAt: row.completedAt === null ? null : row.completedAt.toISOString(),
    rowsParsed: row.rowsParsed,
    rowsLoaded: row.rowsLoaded,
    countsMatch: row.countsMatch,
    error: row.error,
  }));
}

/**
 * Profile-grain daily rows, mapped onto the doctrine engine's `DailyRow`.
 *
 * The mapping happens here, at the edge, exactly as `packages/core` documents:
 * the engine speaks its own vocabulary so the Python parity goldens can be
 * replayed against it, and the web tier is the thing that translates.
 */
export async function loadProfileDailyRows(
  handle: DbHandle,
  orgId: string,
  profileId: string,
  account: string,
  window: Period,
): Promise<DailyRow[]> {
  const rows = await handle.db
    .select()
    .from(factProfileDaily)
    .where(
      and(
        eq(factProfileDaily.orgId, orgId),
        eq(factProfileDaily.profileId, profileId),
        gte(factProfileDaily.date, window.start),
        lte(factProfileDaily.date, window.end),
      ),
    )
    .orderBy(factProfileDaily.date);

  return rows.map((row) => ({
    account,
    date: row.date,
    level: 'account' as const,
    impressions: row.impressions,
    clicks: row.clicks,
    spend: row.cost,
    sales: row.sales7d,
    orders: row.purchases7d,
  }));
}

/** Which of those days Amazon is still attributing. The dashboard must say so. */
export async function loadProvisionalDates(
  handle: DbHandle,
  orgId: string,
  profileId: string,
  window: Period,
): Promise<string[]> {
  const rows = await handle.db
    .select({ date: factProfileDaily.date, provisional: factProfileDaily.provisional })
    .from(factProfileDaily)
    .where(
      and(
        eq(factProfileDaily.orgId, orgId),
        eq(factProfileDaily.profileId, profileId),
        gte(factProfileDaily.date, window.start),
        lte(factProfileDaily.date, window.end),
      ),
    );
  return rows.filter((row) => row.provisional).map((row) => row.date);
}

/**
 * Campaign-grain daily rows for the flag engine.
 *
 * Built from the target grain because that is the grain we hold: summing
 * targets to a campaign is the same arithmetic the grid does, and doing it in
 * SQL keeps a month of target rows out of the web tier's memory.
 */
export async function loadCampaignDailyRows(
  handle: DbHandle,
  orgId: string,
  profileId: string,
  account: string,
  window: Period,
): Promise<DailyRow[]> {
  const rows = await handle.sql<
    {
      date: string;
      campaign_id: string;
      campaign_name: string | null;
      impressions: string | number;
      clicks: string | number;
      spend: string | number;
      sales: string | number;
      orders: string | number;
    }[]
  >`
    select f.date::text as date,
           f.campaign_id,
           c.name as campaign_name,
           sum(f.impressions) as impressions,
           sum(f.clicks) as clicks,
           sum(f.cost) as spend,
           sum(f.sales_7d) as sales,
           sum(f.purchases_7d) as orders
      from public.fact_sp_target_daily f
      left join public.campaigns c
        on c.org_id = ${orgId} and c.profile_id = ${profileId} and c.amazon_id = f.campaign_id
     where f.org_id = ${orgId}
       and f.profile_id = ${profileId}
       and f.date between ${window.start} and ${window.end}
     group by f.date, f.campaign_id, c.name
     order by f.date
  `;

  return rows.map((row) => ({
    account,
    date: row.date,
    level: 'campaign' as const,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name ?? row.campaign_id,
    impressions: Number(row.impressions),
    clicks: Number(row.clicks),
    spend: Number(row.spend),
    sales: Number(row.sales),
    orders: Number(row.orders),
  }));
}
