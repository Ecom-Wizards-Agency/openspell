/**
 * The v1 exit criterion, evaluated and written down.
 *
 * This is the gate that unlocks writes (WP-12), so the generator is deliberately
 * hard to please and easy to audit:
 *
 *  (a) 14 consecutive `verified` profile-grain days, on at least five pilot
 *      profiles. Provisional days are *skipped*, not counted and not fatal —
 *      excluding them is the whole point of the provisional rule. A calendar
 *      gap, a mismatch, or a missing side ends a streak: a day nobody compared
 *      is not a day that passed.
 *  (b) campaign-grain spend and sales within tolerance for at least 95% of
 *      *spending* campaigns over a week. Idle campaigns are excluded before the
 *      share is taken, because a profile full of paused campaigns would
 *      otherwise pass by having nothing to disagree about.
 *  (c) the optimizer parity spot-check, which no code here can perform: it
 *      compares our proposals against AdLabs' preview and explains the
 *      remainder. It is a section with a status, supplied by the operator, and
 *      until it is supplied the overall verdict is `pending` rather than
 *      `pass`. A gate that grades its own missing homework is not a gate.
 *
 * Pure functions over a history object, so both directions can be tested
 * without a database and a real report can be regenerated from stored rows.
 */
import type { ResultVerdict } from './compare.js';

export interface ProfileDayVerdict {
  date: string;
  verdict: ResultVerdict;
}

export interface CampaignWeekVerdict {
  weekStart: string;
  campaignId: string;
  /** Did either side report spend or sales? Only these count toward the share. */
  spending: boolean;
  verdict: ResultVerdict;
}

export interface ProfileHistory {
  profileId: string;
  /** A neutral label. Never a client or brand name: this report is committable. */
  label?: string;
  region?: string;
  profileDays: readonly ProfileDayVerdict[];
  campaignWeeks: readonly CampaignWeekVerdict[];
}

export interface ExitCriterionOptions {
  consecutiveDays?: number;
  minProfiles?: number;
  campaignShare?: number;
  tolerance?: number;
  /** The operator's optimizer parity finding. Absent means criterion (c) is open. */
  optimizerParityNote?: string;
  optimizerParityPassed?: boolean;
  generatedOn?: string;
}

export interface ProfileEvaluation {
  profileId: string;
  label: string;
  region: string | null;
  /** Longest run of calendar-consecutive verified days, provisional days skipped. */
  longestVerifiedStreak: number;
  streakStart: string | null;
  streakEnd: string | null;
  daysPassed: boolean;
  /** Best week's share of spending campaigns that verified. */
  bestWeek: string | null;
  bestWeekShare: number | null;
  bestWeekSpendingCampaigns: number;
  campaignsPassed: boolean;
  passed: boolean;
}

export interface ExitReport {
  criterion: {
    consecutiveDays: number;
    minProfiles: number;
    campaignShare: number;
    tolerance: number;
  };
  profiles: ProfileEvaluation[];
  profilesPassing: number;
  daysCriterionMet: boolean;
  campaignCriterionMet: boolean;
  optimizerParity: { status: 'passed' | 'failed' | 'not_recorded'; note: string | null };
  verdict: 'pass' | 'fail' | 'pending';
  generatedOn: string;
}

const DEFAULTS = {
  consecutiveDays: 14,
  minProfiles: 5,
  campaignShare: 0.95,
  tolerance: 0.07,
} as const;

export function evaluateExitCriterion(
  histories: readonly ProfileHistory[],
  options: ExitCriterionOptions = {},
): ExitReport {
  const criterion = {
    consecutiveDays: options.consecutiveDays ?? DEFAULTS.consecutiveDays,
    minProfiles: options.minProfiles ?? DEFAULTS.minProfiles,
    campaignShare: options.campaignShare ?? DEFAULTS.campaignShare,
    tolerance: options.tolerance ?? DEFAULTS.tolerance,
  };

  const profiles = histories.map((history) => evaluateProfile(history, criterion));
  const profilesPassing = profiles.filter((profile) => profile.passed).length;
  const daysCriterionMet =
    profiles.filter((profile) => profile.daysPassed).length >= criterion.minProfiles;
  const campaignCriterionMet =
    profiles.filter((profile) => profile.campaignsPassed).length >= criterion.minProfiles;

  const optimizerParity = {
    status:
      options.optimizerParityPassed === undefined
        ? ('not_recorded' as const)
        : options.optimizerParityPassed
          ? ('passed' as const)
          : ('failed' as const),
    note: options.optimizerParityNote ?? null,
  };

  let verdict: ExitReport['verdict'];
  if (!daysCriterionMet || !campaignCriterionMet || optimizerParity.status === 'failed') {
    verdict = 'fail';
  } else if (optimizerParity.status === 'not_recorded') {
    verdict = 'pending';
  } else {
    verdict = 'pass';
  }

  return {
    criterion,
    profiles,
    profilesPassing,
    daysCriterionMet,
    campaignCriterionMet,
    optimizerParity,
    verdict,
    generatedOn: options.generatedOn ?? new Date().toISOString().slice(0, 10),
  };
}

function evaluateProfile(
  history: ProfileHistory,
  criterion: ExitReport['criterion'],
): ProfileEvaluation {
  const streak = longestVerifiedStreak(history.profileDays);
  const week = bestCampaignWeek(history.campaignWeeks);
  const daysPassed = streak.length >= criterion.consecutiveDays;
  const campaignsPassed = week !== null && week.share >= criterion.campaignShare;

  return {
    profileId: history.profileId,
    label: history.label ?? history.profileId,
    region: history.region ?? null,
    longestVerifiedStreak: streak.length,
    streakStart: streak.start,
    streakEnd: streak.end,
    daysPassed,
    bestWeek: week?.weekStart ?? null,
    bestWeekShare: week?.share ?? null,
    bestWeekSpendingCampaigns: week?.spending ?? 0,
    campaignsPassed,
    passed: daysPassed && campaignsPassed,
  };
}

export interface Streak {
  length: number;
  start: string | null;
  end: string | null;
}

/**
 * Longest run of calendar-consecutive verified days.
 *
 * Provisional days are removed first, and removing one does *not* join the days
 * either side of it into a run: 12 verified days either side of an excluded day
 * is not 24 consecutive verified days, it is two runs of 12. The gap check
 * after the removal is what enforces that.
 */
export function longestVerifiedStreak(days: readonly ProfileDayVerdict[]): Streak {
  const ordered = [...days]
    .filter((day) => day.verdict !== 'skipped_provisional')
    .sort((left, right) => left.date.localeCompare(right.date));

  let best: Streak = { length: 0, start: null, end: null };
  let current: Streak = { length: 0, start: null, end: null };
  let previous: string | null = null;

  for (const day of ordered) {
    const contiguous = previous !== null && isNextDay(previous, day.date);
    if (day.verdict === 'verified' && contiguous && current.length > 0) {
      current = { length: current.length + 1, start: current.start, end: day.date };
    } else if (day.verdict === 'verified') {
      current = { length: 1, start: day.date, end: day.date };
    } else {
      current = { length: 0, start: null, end: null };
    }
    if (current.length > best.length) best = current;
    previous = day.date;
  }

  return best;
}

export interface CampaignWeekShare {
  weekStart: string;
  spending: number;
  verified: number;
  share: number;
}

/** Every week's share of spending campaigns that verified, best week first. */
export function campaignWeekShares(
  weeks: readonly CampaignWeekVerdict[],
): CampaignWeekShare[] {
  const byWeek = new Map<string, CampaignWeekVerdict[]>();
  for (const row of weeks) {
    const bucket = byWeek.get(row.weekStart) ?? [];
    bucket.push(row);
    byWeek.set(row.weekStart, bucket);
  }

  const shares: CampaignWeekShare[] = [];
  for (const [weekStart, rows] of byWeek) {
    const spending = rows.filter((row) => row.spending);
    if (spending.length === 0) continue;
    const verified = spending.filter((row) => row.verdict === 'verified').length;
    shares.push({
      weekStart,
      spending: spending.length,
      verified,
      share: verified / spending.length,
    });
  }

  return shares.sort((left, right) =>
    right.share === left.share
      ? right.weekStart.localeCompare(left.weekStart)
      : right.share - left.share,
  );
}

function bestCampaignWeek(weeks: readonly CampaignWeekVerdict[]): CampaignWeekShare | null {
  return campaignWeekShares(weeks)[0] ?? null;
}

function isNextDay(previous: string, next: string): boolean {
  const day = 24 * 60 * 60 * 1000;
  return Date.parse(`${next}T00:00:00Z`) - Date.parse(`${previous}T00:00:00Z`) === day;
}

/** The report an operator reads, and the manager signs off on. */
export function renderExitReport(report: ExitReport): string {
  const { criterion } = report;
  const lines: string[] = [];
  const mark = (passed: boolean) => (passed ? 'PASS' : 'FAIL');

  lines.push('# wizard-ads v1 exit criterion');
  lines.push('');
  lines.push(`Generated ${report.generatedOn} · verdict **${report.verdict.toUpperCase()}**`);
  lines.push('');
  lines.push(
    `The gate: ${criterion.consecutiveDays} consecutive verified profile-grain days and ` +
      `campaign-grain agreement within ±${(criterion.tolerance * 100).toFixed(0)}% for ` +
      `≥${(criterion.campaignShare * 100).toFixed(0)}% of spending campaigns over a week, ` +
      `on ≥${criterion.minProfiles} pilot profiles, plus an explained optimizer parity ` +
      'spot-check. Until every line reads PASS, the write engine stays closed.',
  );
  lines.push('');

  lines.push('## (a) Profile-grain streak');
  lines.push('');
  lines.push(
    `${mark(report.daysCriterionMet)} — ` +
      `${report.profiles.filter((p) => p.daysPassed).length} of ${report.profiles.length} profiles ` +
      `reached ${criterion.consecutiveDays} consecutive verified days ` +
      `(${criterion.minProfiles} required).`,
  );
  lines.push('');
  lines.push('| Profile | Region | Longest verified streak | Window | Verdict |');
  lines.push('|---|---|---:|---|---|');
  for (const profile of report.profiles) {
    const window =
      profile.streakStart && profile.streakEnd ? `${profile.streakStart} → ${profile.streakEnd}` : '—';
    lines.push(
      `| ${profile.label} | ${profile.region ?? '—'} | ${profile.longestVerifiedStreak} | ${window} | ${mark(profile.daysPassed)} |`,
    );
  }
  lines.push('');

  lines.push('## (b) Campaign-grain share');
  lines.push('');
  lines.push(
    `${mark(report.campaignCriterionMet)} — ` +
      `${report.profiles.filter((p) => p.campaignsPassed).length} of ${report.profiles.length} profiles ` +
      `reached ${(criterion.campaignShare * 100).toFixed(0)}% on their best week ` +
      `(${criterion.minProfiles} required).`,
  );
  lines.push('');
  lines.push('| Profile | Best week | Spending campaigns | Verified share | Verdict |');
  lines.push('|---|---|---:|---:|---|');
  for (const profile of report.profiles) {
    const share = profile.bestWeekShare === null ? '—' : `${(profile.bestWeekShare * 100).toFixed(1)}%`;
    lines.push(
      `| ${profile.label} | ${profile.bestWeek ?? '—'} | ${profile.bestWeekSpendingCampaigns} | ${share} | ${mark(profile.campaignsPassed)} |`,
    );
  }
  lines.push('');

  lines.push('## (c) Optimizer parity spot-check');
  lines.push('');
  if (report.optimizerParity.status === 'not_recorded') {
    lines.push(
      'NOT RECORDED — a one-week spot-check of our proposals against the incumbent preview ' +
        'has not been supplied. Our White Box math must match exactly; divergence from their ' +
        'preview is expected only where their trade-secret weighting layer sits, and that ' +
        'divergence has to be explained rather than eliminated. Supply the finding with ' +
        '`--optimizer-parity-note` to close this section.',
    );
  } else {
    lines.push(`${report.optimizerParity.status === 'passed' ? 'PASS' : 'FAIL'} — ${report.optimizerParity.note ?? 'no note supplied'}`);
  }
  lines.push('');

  lines.push('## Verdict');
  lines.push('');
  lines.push(verdictSentence(report));
  lines.push('');

  return lines.join('\n');
}

function verdictSentence(report: ExitReport): string {
  if (report.verdict === 'pass') {
    return 'PASS — every criterion is met. WP-12 (staged apply) may open, on the manager\'s sign-off.';
  }
  if (report.verdict === 'pending') {
    return (
      'PENDING — the data criteria are met and the optimizer parity spot-check is outstanding. ' +
      'The write engine stays closed until it is recorded.'
    );
  }
  const reasons: string[] = [];
  if (!report.daysCriterionMet) reasons.push('the profile-grain streak');
  if (!report.campaignCriterionMet) reasons.push('the campaign-grain share');
  if (report.optimizerParity.status === 'failed') reasons.push('the optimizer parity spot-check');
  return `FAIL — ${reasons.join(' and ')} did not clear. The write engine stays closed.`;
}

/** Build histories from stored verdict rows. */
export function historiesFromResults(
  rows: readonly {
    profileId: string;
    date: string;
    grain: string;
    entityId: string | null;
    metric: string;
    ours: number | null;
    theirs: number | null;
    verdict: ResultVerdict;
  }[],
  labels: ReadonlyMap<string, { label: string; region: string | null }> = new Map(),
): ProfileHistory[] {
  const byProfile = new Map<string, ProfileHistory>();

  for (const row of rows) {
    if (row.metric !== 'headline') continue;
    const identity = labels.get(row.profileId);
    const history =
      byProfile.get(row.profileId) ??
      ({
        profileId: row.profileId,
        label: identity?.label ?? row.profileId,
        region: identity?.region ?? undefined,
        profileDays: [],
        campaignWeeks: [],
      } satisfies ProfileHistory);

    if (row.grain === 'profile') {
      (history.profileDays as ProfileDayVerdict[]).push({ date: row.date, verdict: row.verdict });
    } else if (row.grain === 'campaign_week' && row.entityId !== null) {
      (history.campaignWeeks as CampaignWeekVerdict[]).push({
        weekStart: row.date,
        campaignId: row.entityId,
        // A headline row carries no figures; spending is decided from the
        // spend rows in `spendingCampaigns` below, so default to true and let
        // the caller narrow it.
        spending: true,
        verdict: row.verdict,
      });
    }
    byProfile.set(row.profileId, history);
  }

  return [...byProfile.values()];
}

/**
 * Which campaign-weeks actually spent, from the `ad_spend` rows. The headline
 * rows carry no figures, so this is the only honest source for "spending".
 */
export function spendingCampaignWeeks(
  rows: readonly {
    profileId: string;
    date: string;
    grain: string;
    entityId: string | null;
    metric: string;
    ours: number | null;
    theirs: number | null;
  }[],
): Set<string> {
  const spending = new Set<string>();
  for (const row of rows) {
    if (row.grain !== 'campaign_week' || row.metric !== 'ad_spend' || row.entityId === null) continue;
    if ((row.ours ?? 0) > 0 || (row.theirs ?? 0) > 0) {
      spending.add(`${row.profileId} ${row.date} ${row.entityId}`);
    }
  }
  return spending;
}

/** Narrow the `spending` flag on histories built by `historiesFromResults`. */
export function applySpendingFlags(
  histories: readonly ProfileHistory[],
  spending: ReadonlySet<string>,
): ProfileHistory[] {
  return histories.map((history) => ({
    ...history,
    campaignWeeks: history.campaignWeeks.map((week) => ({
      ...week,
      spending: spending.has(`${history.profileId} ${week.weekStart} ${week.campaignId}`),
    })),
  }));
}
