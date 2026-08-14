/**
 * The comparison itself: our synced facts against an AdLabs export.
 *
 * The verdict model is not reimplemented here. `crossCheck` in
 * `@wizard-ads/core` is the port of `crosscheck.py` and carries the parity
 * goldens, including the two rules that are easy to get wrong on a rewrite: a
 * figure missing on either side is `no_data` and never a silent zero, and a
 * zero base with a nonzero counterpart is a full mismatch rather than a
 * division. This module's job is to decide *which* figures get compared, at
 * which grain, and what a verdict means once written down.
 *
 * Three decisions worth stating, because each one is the difference between a
 * trustworthy verdict and a noisy one:
 *
 *  1. **The provisional day is excluded, not judged.** Sales restate for 14+
 *     days and AdLabs' `total_*` columns read 0 for the in-progress day. A day
 *     our facts mark provisional, or a day at or after the export's report day,
 *     is recorded as `skipped_provisional` with both values kept. It cannot
 *     fail a headline verdict, and it is still visible, which is the point:
 *     "excluded" is a claim a reader must be able to check.
 *  2. **Absence has a direction.** `no_data` becomes `missing_ours` or
 *     `missing_theirs` depending on which side had nothing. "The sync missed a
 *     campaign" and "AdLabs has not caught up" are different problems and a
 *     single `no_data` hides which one you have.
 *  3. **A campaign that spent nothing on both sides is not a data point.** It
 *     is dropped and counted, so the campaign-grain share is computed over
 *     campaigns that could have disagreed.
 */
import { DEFAULT_TOLERANCE, MISMATCH, NO_DATA, VERIFIED, crossCheck } from '@wizard-ads/core';
import type { FigureSet, Verdict } from '@wizard-ads/core';
import type { AdlabsCampaignRow, AdlabsProfileDay } from './contract.js';

/** The `crosscheck_verdict` enum, exactly. */
export type ResultVerdict =
  | 'verified'
  | 'mismatch'
  | 'missing_ours'
  | 'missing_theirs'
  | 'skipped_provisional';

/** The `grain` column's vocabulary. */
export type ResultGrain = 'profile' | 'campaign_week';

/** The `metric` column's vocabulary. `headline` is the per-day roll-up. */
export type ResultMetric = 'ad_spend' | 'ad_sales' | 'headline';

export interface OurProfileDay {
  date: string;
  adSpend: number | null;
  adSales: number | null;
  /** `fact_profile_daily.provisional`: sales are still attributing. */
  provisional: boolean;
}

export interface OurCampaignTotals {
  campaignId: string;
  adSpend: number | null;
  adSales: number | null;
}

export interface CrosscheckFinding {
  grain: ResultGrain;
  /** Profile grain: the day. Campaign grain: the first day of the compared week. */
  date: string;
  entityId: string | null;
  metric: ResultMetric;
  ours: number | null;
  theirs: number | null;
  deltaPct: number | null;
  tolerance: number;
  verdict: ResultVerdict;
  source: string;
}

export interface CompareOptions {
  tolerance?: number;
  /**
   * The day the export was pulled. That day and anything after it is
   * in-progress on the AdLabs side. Defaults to the day after the window ends,
   * i.e. "the window is complete", which is what a nightly pull produces.
   */
  reportDay?: string;
  /** Provenance stamped on every finding. Defaults to the export's basename. */
  source?: string;
}

export interface CompareSummary {
  /** Days compared, excluding the provisional ones. */
  profileDaysCompared: number;
  profileDaysSkipped: number;
  campaignsCompared: number;
  /** Campaigns dropped because neither side reported spend or sales. */
  campaignsSkippedIdle: number;
  /** The profile's verdict over the window: mismatch beats missing beats verified. */
  headline: ResultVerdict | 'no_data';
}

export interface CompareResult {
  findings: CrosscheckFinding[];
  summary: CompareSummary;
}

export interface ProfileCompareInput {
  ours: readonly OurProfileDay[];
  theirs: readonly AdlabsProfileDay[];
  source: string;
}

export interface CampaignCompareInput {
  weekStart: string;
  ours: readonly OurCampaignTotals[];
  theirs: readonly AdlabsCampaignRow[];
  source: string;
}

/** Profile-day verdicts: one row per figure, plus the day's headline. */
export function compareProfileDays(
  input: ProfileCompareInput,
  options: CompareOptions = {},
): CrosscheckFinding[] {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const source = options.source ?? input.source;
  const ourDays = new Map(input.ours.map((day) => [day.date, day]));
  const theirDays = new Map(input.theirs.map((day) => [day.date, day]));
  const dates = [...new Set([...ourDays.keys(), ...theirDays.keys()])].sort();

  const findings: CrosscheckFinding[] = [];

  for (const date of dates) {
    const ours = ourDays.get(date);
    const theirs = theirDays.get(date);
    const ourFigures: FigureSet = { ad_spend: ours?.adSpend ?? null, ad_sales: ours?.adSales ?? null };
    const theirFigures: FigureSet = {
      ad_spend: theirs?.adSpend ?? null,
      ad_sales: theirs?.adSales ?? null,
    };

    if (isProvisional(date, ours, options)) {
      for (const metric of ['ad_spend', 'ad_sales'] as const) {
        findings.push({
          grain: 'profile',
          date,
          entityId: null,
          metric,
          ours: ourFigures[metric] ?? null,
          theirs: theirFigures[metric] ?? null,
          deltaPct: null,
          tolerance,
          verdict: 'skipped_provisional',
          source,
        });
      }
      findings.push(headlineFinding('profile', date, null, tolerance, 'skipped_provisional', source));
      continue;
    }

    const result = crossCheck(ourFigures, theirFigures, tolerance);
    for (const figure of result.figures) {
      if (figure.figure === 'total_sales') continue;
      if (figure.sellerboardValue === null && figure.adlabsValue === null) continue;
      findings.push({
        grain: 'profile',
        date,
        entityId: null,
        metric: figure.figure,
        ours: figure.sellerboardValue,
        theirs: figure.adlabsValue,
        deltaPct: figure.deltaPct,
        tolerance,
        verdict: resultVerdict(figure.verdict, figure.sellerboardValue, figure.adlabsValue),
        source,
      });
    }

    findings.push(
      headlineFinding(
        'profile',
        date,
        null,
        tolerance,
        resultVerdict(result.headlineVerdict, ours ? 1 : null, theirs ? 1 : null),
        source,
      ),
    );
  }

  return findings;
}

/**
 * Campaign-week verdicts. The export's rows are summed over the window first:
 * an export pulled with a daily breakdown and one pulled as a window total have
 * to produce the same verdict, or the grain means nothing.
 */
export function compareCampaignWeek(
  input: CampaignCompareInput,
  options: CompareOptions = {},
): CrosscheckFinding[] {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const source = options.source ?? input.source;
  const theirs = sumCampaignRows(input.theirs);
  const ours = new Map(input.ours.map((row) => [row.campaignId, row]));
  const campaignIds = [...new Set([...ours.keys(), ...theirs.keys()])].sort();

  const findings: CrosscheckFinding[] = [];

  for (const campaignId of campaignIds) {
    const ourTotals = ours.get(campaignId);
    const theirTotals = theirs.get(campaignId);
    const ourFigures: FigureSet = {
      ad_spend: ourTotals?.adSpend ?? null,
      ad_sales: ourTotals?.adSales ?? null,
    };
    const theirFigures: FigureSet = {
      ad_spend: theirTotals?.adSpend ?? null,
      ad_sales: theirTotals?.adSales ?? null,
    };
    if (isIdle(ourFigures) && isIdle(theirFigures)) continue;

    const result = crossCheck(ourFigures, theirFigures, tolerance);
    for (const figure of result.figures) {
      if (figure.figure === 'total_sales') continue;
      if (figure.sellerboardValue === null && figure.adlabsValue === null) continue;
      findings.push({
        grain: 'campaign_week',
        date: input.weekStart,
        entityId: campaignId,
        metric: figure.figure,
        ours: figure.sellerboardValue,
        theirs: figure.adlabsValue,
        deltaPct: figure.deltaPct,
        tolerance,
        verdict: resultVerdict(figure.verdict, figure.sellerboardValue, figure.adlabsValue),
        source,
      });
    }

    findings.push(
      headlineFinding(
        'campaign_week',
        input.weekStart,
        campaignId,
        tolerance,
        resultVerdict(result.headlineVerdict, ourTotals ? 1 : null, theirTotals ? 1 : null),
        source,
      ),
    );
  }

  return findings;
}

export function summarize(findings: readonly CrosscheckFinding[]): CompareSummary {
  const profileHeadlines = findings.filter((f) => f.grain === 'profile' && f.metric === 'headline');
  const campaignHeadlines = findings.filter(
    (f) => f.grain === 'campaign_week' && f.metric === 'headline',
  );
  const compared = profileHeadlines.filter((f) => f.verdict !== 'skipped_provisional');

  return {
    profileDaysCompared: compared.length,
    profileDaysSkipped: profileHeadlines.length - compared.length,
    campaignsCompared: campaignHeadlines.length,
    campaignsSkippedIdle: 0,
    headline: rollUp([...compared, ...campaignHeadlines].map((f) => f.verdict)),
  };
}

/** Mismatch beats missing beats verified; nothing comparable is `no_data`. */
export function rollUp(verdicts: readonly ResultVerdict[]): ResultVerdict | 'no_data' {
  const counted = verdicts.filter((verdict) => verdict !== 'skipped_provisional');
  if (counted.length === 0) return 'no_data';
  if (counted.includes('mismatch')) return 'mismatch';
  if (counted.includes('missing_ours')) return 'missing_ours';
  if (counted.includes('missing_theirs')) return 'missing_theirs';
  return 'verified';
}

/** Compare a whole export in one call: profile days and campaign week together. */
export function compare(
  input: { profile?: ProfileCompareInput; campaign?: CampaignCompareInput },
  options: CompareOptions = {},
): CompareResult {
  const findings = [
    ...(input.profile ? compareProfileDays(input.profile, options) : []),
    ...(input.campaign ? compareCampaignWeek(input.campaign, options) : []),
  ];
  const summary = summarize(findings);
  if (input.campaign) {
    const offered = new Set([
      ...input.campaign.ours.map((row) => row.campaignId),
      ...input.campaign.theirs.map((row) => row.campaignId),
    ]).size;
    summary.campaignsSkippedIdle = offered - summary.campaignsCompared;
  }
  return { findings, summary };
}

function headlineFinding(
  grain: ResultGrain,
  date: string,
  entityId: string | null,
  tolerance: number,
  verdict: ResultVerdict,
  source: string,
): CrosscheckFinding {
  return {
    grain,
    date,
    entityId,
    metric: 'headline',
    ours: null,
    theirs: null,
    deltaPct: null,
    tolerance,
    verdict,
    source,
  };
}

/**
 * `no_data` from the port carries no direction, so the direction is recovered
 * from which side was actually null.
 */
function resultVerdict(
  verdict: Verdict,
  ours: number | null,
  theirs: number | null,
): ResultVerdict {
  if (verdict === VERIFIED) return 'verified';
  if (verdict === MISMATCH) return 'mismatch';
  if (verdict === NO_DATA && ours === null) return 'missing_ours';
  if (verdict === NO_DATA && theirs === null) return 'missing_theirs';
  // Both sides present and still incomparable: a zero base against a zero
  // counterpart. Nothing disagreed, so nothing is missing on either side.
  return 'verified';
}

function isProvisional(
  date: string,
  ours: OurProfileDay | undefined,
  options: CompareOptions,
): boolean {
  if (ours?.provisional === true) return true;
  return options.reportDay !== undefined && date >= options.reportDay;
}

function isIdle(figures: FigureSet): boolean {
  const spend = figures.ad_spend ?? 0;
  const sales = figures.ad_sales ?? 0;
  return spend === 0 && sales === 0;
}

function sumCampaignRows(rows: readonly AdlabsCampaignRow[]): Map<string, OurCampaignTotals> {
  const totals = new Map<string, OurCampaignTotals>();
  for (const row of rows) {
    const current = totals.get(row.campaignId) ?? {
      campaignId: row.campaignId,
      adSpend: null,
      adSales: null,
    };
    totals.set(row.campaignId, {
      campaignId: row.campaignId,
      adSpend: add(current.adSpend, row.adSpend),
      adSales: add(current.adSales, row.adSales),
    });
  }
  return totals;
}

/** Null plus a number is that number; null plus null stays missing. */
function add(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return left + right;
}
