/**
 * Doctrine outputs: flags and pacing, straight from `@wizard-ads/core`.
 *
 * This module does no analysis of its own. It reads rows, hands them to the
 * engine, and hands the engine's answer back. That is deliberate: the engine is
 * a pure port with 122 parity cases against the Python reference, and a second
 * implementation living inside an MCP tool would be a second answer to the same
 * question. Everything here is plumbing.
 *
 * The one judgement call it does make is the `asOf` default: the latest day
 * that has facts, with the provisional flag reported beside it. Same-day sales
 * are still attributing, so a flag computed on today is a flag computed on a
 * number that will change.
 */
import {
  addDays,
  analyzeAccount,
  classifyCampaignCategory,
  computePacing,
  evaluate,
  pacingFlag,
  resolveGoalLens,
} from '@wizard-ads/core';
import type { DailyRow, Flag, PacingResult } from '@wizard-ads/core';
import type { DbHandle } from '@wizard-ads/db';
import { readCampaignDaily, readProfileDaily } from './data.js';
import type { KeyScopeContext, ProfileRecord } from './data.js';

/** Flags and trends need the report day plus its trailing week; pacing needs the month. */
const LOOKBACK_DAYS = 45;

export interface FlagsResult {
  asOf: string;
  provisional: boolean;
  goalLens: { key: string; label: string; description: string };
  active: Flag[];
  /** Noted, not flagged. Never silently dropped: a suppressed flag is evidence too. */
  suppressed: Flag[];
  daysWithData: number;
  notes: string[];
}

export interface PacingReport {
  asOf: string;
  pacing: PacingResult | null;
  flag: Flag | null;
  notes: string[];
}

async function latestFactDay(
  handle: DbHandle,
  scope: KeyScopeContext,
  profileId: string,
): Promise<{ date: string; provisional: boolean } | null> {
  const rows = await handle.sql<{ date: string; provisional: boolean }[]>`
    select date::text as date, provisional
      from public.fact_profile_daily
     where org_id = ${scope.orgId} and profile_id = ${profileId}
     order by date desc
     limit 1
  `;
  return rows[0] ?? null;
}

function accountLabel(profile: ProfileRecord): string {
  return profile.accountName ?? `${profile.countryCode} ${profile.amazonProfileId}`;
}

export async function buildFlags(
  handle: DbHandle,
  scope: KeyScopeContext,
  profile: ProfileRecord,
  asOfInput?: string,
): Promise<FlagsResult | null> {
  const latest = await latestFactDay(handle, scope, profile.id);
  const asOf = asOfInput ?? latest?.date;
  if (!asOf) return null;

  const window = { from: addDays(asOf, -LOOKBACK_DAYS), to: asOf };
  const label = accountLabel(profile);
  const accountRows = await readProfileDaily(handle, scope, profile.id, window);
  const campaignRows = await readCampaignDaily(handle, scope, profile.id, window);

  const account: DailyRow[] = accountRows.map((row) => ({
    account: label,
    date: row.date,
    level: 'account',
    impressions: row.impressions,
    clicks: row.clicks,
    spend: row.spend,
    sales: row.sales,
    orders: row.orders,
  }));

  const campaigns: DailyRow[] = campaignRows.map((row) => ({
    account: label,
    date: row.date,
    level: 'campaign',
    impressions: row.impressions,
    clicks: row.clicks,
    spend: row.spend,
    sales: row.sales,
    orders: row.orders,
    campaignId: row.campaignId ?? null,
    campaignName: row.campaignName ?? null,
    category: classifyCampaignCategory(row.campaignName),
    budget: row.budget ?? null,
  }));

  const analysis = analyzeAccount(label, asOf, account, campaigns);
  const { active, suppressed } = evaluate(analysis, null, profile.goalLens);
  const lens = resolveGoalLens(profile.goalLens);

  const notes: string[] = [];
  if (latest && asOf === latest.date && latest.provisional) {
    notes.push(
      `${asOf} is still attributing: sales restate for 14+ days, so every flag on this day is provisional.`,
    );
  }
  if (account.length === 0) {
    notes.push('No profile-grain facts in the window. Flags are computed on nothing; check get_sync_status.');
  }

  return {
    asOf,
    provisional: latest?.date === asOf ? latest.provisional : false,
    goalLens: { key: profile.goalLens ?? 'neutral', label: lens.label, description: lens.description },
    active,
    suppressed,
    daysWithData: account.length,
    notes,
  };
}

export async function buildPacing(
  handle: DbHandle,
  scope: KeyScopeContext,
  profile: ProfileRecord,
  asOfInput?: string,
): Promise<PacingReport | null> {
  const latest = await latestFactDay(handle, scope, profile.id);
  const asOf = asOfInput ?? latest?.date;
  if (!asOf) return null;

  const monthStart = `${asOf.slice(0, 7)}-01`;
  const rows = await readProfileDaily(handle, scope, profile.id, { from: monthStart, to: asOf });
  const lens = resolveGoalLens(profile.goalLens);
  const pacing = computePacing(
    rows.map((row) => ({ date: row.date, spend: row.spend })),
    asOf,
    profile.monthlyBudget,
    lens,
  );

  const notes: string[] = [];
  if (pacing === null) {
    notes.push(
      'No monthly budget is set on this profile, so pacing does not apply. ' +
        'That is a statement about the configuration, not about the account.',
    );
  }

  return { asOf, pacing, flag: pacingFlag(pacing, lens), notes };
}
