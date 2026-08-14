/**
 * The view model behind the crosscheck panel and the dashboard chip.
 *
 * Pure: stored rows in, a shape a component can render out. No database, no
 * React, no formatting decisions that belong to a designer. That is what lets
 * the dashboard owner (WP-06) drop the chip onto their page without importing
 * anything of mine that touches I/O, and what lets the panel be tested without
 * a browser.
 *
 * The one editorial decision it does make: a day whose figures were skipped as
 * provisional is shown, labelled, and excluded from the chip. Hiding it would
 * leave a hole in a verdict history somebody is using to decide whether to
 * trust the numbers, and a hole reads as a failure nobody can investigate.
 */
import type { ResultVerdict } from './compare.js';
import type { StoredResult } from './results.js';

export type ChipTone = 'good' | 'warn' | 'bad' | 'muted';

export interface VerdictChip {
  verdict: ResultVerdict | 'no_data';
  label: string;
  tone: ChipTone;
  /** The most recent compared day. Null when nothing has been compared. */
  asOf: string | null;
  /** Consecutive verified days ending at `asOf`: the v1 gate, live. */
  verifiedStreak: number;
}

export interface PanelFigure {
  metric: 'ad_spend' | 'ad_sales';
  ours: number | null;
  theirs: number | null;
  deltaPct: number | null;
  verdict: ResultVerdict;
}

export interface PanelDay {
  date: string;
  verdict: ResultVerdict;
  figures: PanelFigure[];
}

export interface PanelCampaign {
  weekStart: string;
  campaignId: string;
  campaignName: string | null;
  verdict: ResultVerdict;
  figures: PanelFigure[];
}

export interface CrosscheckPanelModel {
  profileId: string | null;
  chip: VerdictChip;
  /** Newest first: a verdict history is read from the top. */
  days: PanelDay[];
  /** Only the campaign-weeks that disagree. The rest is not a drill-down. */
  mismatchingCampaigns: PanelCampaign[];
  campaignsCompared: number;
  tolerance: number;
  sources: string[];
}

const LABELS: Record<ResultVerdict | 'no_data', string> = {
  verified: 'Verified',
  mismatch: 'Mismatch',
  missing_ours: 'Missing on our side',
  missing_theirs: 'Missing in AdLabs',
  skipped_provisional: 'Provisional, not compared',
  no_data: 'Not cross-checked',
};

const TONES: Record<ResultVerdict | 'no_data', ChipTone> = {
  verified: 'good',
  mismatch: 'bad',
  missing_ours: 'warn',
  missing_theirs: 'warn',
  skipped_provisional: 'muted',
  no_data: 'muted',
};

export function verdictLabel(verdict: ResultVerdict | 'no_data'): string {
  return LABELS[verdict];
}

export function verdictTone(verdict: ResultVerdict | 'no_data'): ChipTone {
  return TONES[verdict];
}

export interface BuildPanelOptions {
  /** Campaign names from the entity mirror, for the drill-down. */
  campaignNames?: ReadonlyMap<string, string>;
  profileId?: string;
}

export function buildPanelModel(
  rows: readonly StoredResult[],
  options: BuildPanelOptions = {},
): CrosscheckPanelModel {
  const days = buildDays(rows);
  const campaigns = buildCampaigns(rows, options.campaignNames ?? new Map());
  const compared = days.filter((day) => day.verdict !== 'skipped_provisional');
  const latest = compared[0] ?? null;

  return {
    profileId: options.profileId ?? rows[0]?.profileId ?? null,
    chip: {
      verdict: latest?.verdict ?? 'no_data',
      label: LABELS[latest?.verdict ?? 'no_data'],
      tone: TONES[latest?.verdict ?? 'no_data'],
      asOf: latest?.date ?? null,
      verifiedStreak: trailingVerifiedStreak(compared),
    },
    days,
    mismatchingCampaigns: campaigns.filter((campaign) => campaign.verdict !== 'verified'),
    campaignsCompared: campaigns.length,
    tolerance: rows[0]?.tolerance ?? 0.07,
    sources: [...new Set(rows.map((row) => row.source).filter((s): s is string => s !== null))],
  };
}

/** Verified days ending at the most recent compared day. Stops at the first that is not. */
export function trailingVerifiedStreak(days: readonly PanelDay[]): number {
  let streak = 0;
  for (const day of days) {
    if (day.verdict !== 'verified') break;
    streak += 1;
  }
  return streak;
}

function buildDays(rows: readonly StoredResult[]): PanelDay[] {
  const byDate = new Map<string, PanelDay>();
  for (const row of rows) {
    if (row.grain !== 'profile') continue;
    const day = byDate.get(row.date) ?? { date: row.date, verdict: 'missing_theirs', figures: [] };
    if (row.metric === 'headline') day.verdict = row.verdict;
    else day.figures.push(figure(row));
    byDate.set(row.date, day);
  }
  return [...byDate.values()].sort((left, right) => right.date.localeCompare(left.date));
}

function buildCampaigns(
  rows: readonly StoredResult[],
  names: ReadonlyMap<string, string>,
): PanelCampaign[] {
  const byKey = new Map<string, PanelCampaign>();
  for (const row of rows) {
    if (row.grain !== 'campaign_week' || row.entityId === null) continue;
    const key = `${row.date} ${row.entityId}`;
    const campaign = byKey.get(key) ?? {
      weekStart: row.date,
      campaignId: row.entityId,
      campaignName: names.get(row.entityId) ?? null,
      verdict: 'missing_theirs' as ResultVerdict,
      figures: [],
    };
    if (row.metric === 'headline') campaign.verdict = row.verdict;
    else campaign.figures.push(figure(row));
    byKey.set(key, campaign);
  }
  return [...byKey.values()].sort((left, right) =>
    left.weekStart === right.weekStart
      ? worst(right) - worst(left)
      : right.weekStart.localeCompare(left.weekStart),
  );
}

function figure(row: StoredResult): PanelFigure {
  return {
    metric: row.metric === 'ad_sales' ? 'ad_sales' : 'ad_spend',
    ours: row.ours,
    theirs: row.theirs,
    deltaPct: row.deltaPct,
    verdict: row.verdict,
  };
}

/** Sort key: the biggest disagreement first, because that is what gets opened. */
function worst(campaign: PanelCampaign): number {
  return campaign.figures.reduce(
    (largest, current) => Math.max(largest, Math.abs(current.deltaPct ?? 0)),
    0,
  );
}
