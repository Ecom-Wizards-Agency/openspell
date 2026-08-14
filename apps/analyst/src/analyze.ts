/**
 * The analysis: briefing in, structured finding out.
 *
 * This is a pure function of the data the MCP client gathered. It computes no
 * ratio itself that the server already computes — ACOS, CVR and the period
 * deltas arrive recomputed from summed bases, and re-deriving them here would be
 * a second answer to a question that already has one. What it adds is judgement:
 * it reads the profile's target ACOS and goal lens, the doctrine engine's flags,
 * and month-to-date pacing, and turns them into a ranked list of findings and a
 * `figures` object in which every number the prose will quote can be checked.
 *
 * Keeping it pure is what makes the run testable offline: the same briefing
 * always yields the same finding, so a golden assertion means something. A
 * language model can later narrate over the same `figures` without changing what
 * is provably true about the account.
 */
import type {
  EntityDataPayload,
  FlagRecord,
  FlagsPayload,
  McpProfile,
  PacingPayload,
  ProfileContextPayload,
} from './mcp-client.js';

export type Severity = 'critical' | 'alert' | 'warn' | 'info';

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, alert: 1, warn: 2, info: 3 };

export interface Briefing {
  profile: McpProfile;
  context: ProfileContextPayload;
  window: { from: string; to: string };
  entity: EntityDataPayload;
  flags: FlagsPayload;
  pacing: PacingPayload;
  /** Latest completed fact day, and whether it is still attributing. */
  asOf: string | null;
  provisional: boolean | null;
}

export interface Finding {
  severity: Severity;
  headline: string;
  detail: string;
  /** Where the doctrine engine attributed it: "account", a campaign label, or "pacing". */
  scope: string;
}

/** The numbers the prose refers to, so a claim can be checked against the row it came from. */
export interface AnalysisFigures {
  window: { from: string; to: string };
  reportDate: string | null;
  provisional: boolean | null;
  hasData: boolean;
  totals: {
    impressions: number | null;
    clicks: number | null;
    spend: number | null;
    sales: number | null;
    orders: number | null;
    acos: number | null;
    ctr: number | null;
    cvr: number | null;
  };
  deltaPercent: {
    spend: number | null;
    sales: number | null;
    acos: number | null;
    clicks: number | null;
    orders: number | null;
  };
  targetAcos: number | null;
  /** Percentage points ACOS sits above (positive) or below (negative) target. */
  acosVsTargetPoints: number | null;
  monthlyBudget: number | null;
  pacing: { status: string | null; pace: number | null; monthToDateSpend: number | null };
  flags: { active: number; suppressed: number };
}

export interface ProfileAnalysis {
  profileId: string;
  accountName: string;
  reportDate: string | null;
  kind: 'daily';
  title: string;
  figures: AnalysisFigures;
  findings: Finding[];
}

function num(row: Record<string, string | number | boolean | null> | undefined, key: string): number | null {
  if (!row) return null;
  const value = row[key];
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function pct(value: number | null): string {
  if (value === null) return 'n/a';
  return `${(value * 100).toFixed(1)}%`;
}

function signedPct(value: number | null): string {
  if (value === null) return 'n/a';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

function money(value: number | null, currency: string): string {
  if (value === null) return 'n/a';
  return `${currency} ${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

/**
 * A closed period restates for 14+ days and same-day sales are provisional, so a
 * trend finding is only worth stating past a floor. Ten percent is the same
 * floor the ads monitor uses to keep a digest from crying wolf over noise.
 */
const TREND_FLOOR_PCT = 10;

function trendFinding(figures: AnalysisFigures, currency: string): Finding | null {
  const acosDelta = figures.deltaPercent.acos;
  const spendDelta = figures.deltaPercent.spend;
  const salesDelta = figures.deltaPercent.sales;
  if (acosDelta === null && spendDelta === null && salesDelta === null) return null;

  const worthNoting =
    (acosDelta !== null && Math.abs(acosDelta) >= TREND_FLOOR_PCT) ||
    (spendDelta !== null && Math.abs(spendDelta) >= TREND_FLOOR_PCT) ||
    (salesDelta !== null && Math.abs(salesDelta) >= TREND_FLOOR_PCT);

  const detail =
    `Spend ${money(figures.totals.spend, currency)} (${signedPct(spendDelta)}), ` +
    `sales ${money(figures.totals.sales, currency)} (${signedPct(salesDelta)}), ` +
    `ACOS ${pct(figures.totals.acos)} (${signedPct(acosDelta)}) versus the prior period.`;

  // ACOS worsening while it moves is the shape most worth a warn; otherwise the
  // trend is context, not an alarm.
  const severity: Severity = acosDelta !== null && acosDelta >= TREND_FLOOR_PCT ? 'warn' : 'info';
  return worthNoting
    ? { severity, headline: 'Period trend', detail, scope: 'account' }
    : { severity: 'info', headline: 'Period trend', detail, scope: 'account' };
}

function targetFinding(figures: AnalysisFigures): Finding | null {
  const { acos } = figures.totals;
  const target = figures.targetAcos;
  if (acos === null || target === null) return null;
  const points = figures.acosVsTargetPoints;
  if (points !== null && points > 0) {
    return {
      severity: points >= 10 ? 'alert' : 'warn',
      headline: 'ACOS above target',
      detail: `ACOS ${pct(acos)} is ${points.toFixed(1)} points above the ${pct(target)} target.`,
      scope: 'account',
    };
  }
  return {
    severity: 'info',
    headline: 'ACOS within target',
    detail: `ACOS ${pct(acos)} is at or below the ${pct(target)} target.`,
    scope: 'account',
  };
}

function pacingFinding(pacing: PacingPayload, currency: string): Finding | null {
  const p = pacing.pacing;
  if (!p) return null;
  const status = p.status.toLowerCase();
  if (status === 'over' || status === 'over_pace' || status === 'overpace') {
    return {
      severity: 'warn',
      headline: 'Over pace on budget',
      detail:
        `Month-to-date spend ${money(p.monthToDateSpend ?? null, currency)} is pacing ` +
        `${p.pace === null ? 'over' : `${(p.pace * 100).toFixed(0)}% of`} the monthly budget.`,
      scope: 'pacing',
    };
  }
  return null;
}

const flagToFinding = (flag: FlagRecord): Finding => ({
  severity: flag.severity,
  headline: `${flag.metric}: ${flag.message}`,
  detail: flag.likelyCause,
  scope: flag.scope,
});

export function analyzeProfile(briefing: Briefing): ProfileAnalysis {
  const { profile } = briefing;
  const currency = profile.currencyCode;
  const row = briefing.entity.rows[0];
  const hasData = briefing.entity.rows.length > 0;

  const acos = num(row, 'acos');
  const target = profile.targetAcos;
  const figures: AnalysisFigures = {
    window: briefing.window,
    reportDate: briefing.asOf,
    provisional: briefing.provisional,
    hasData,
    totals: {
      impressions: num(row, 'impressions'),
      clicks: num(row, 'clicks'),
      spend: num(row, 'spend'),
      sales: num(row, 'sales'),
      orders: num(row, 'orders'),
      acos,
      ctr: num(row, 'ctr'),
      cvr: num(row, 'cvr'),
    },
    deltaPercent: {
      spend: num(row, 'spend_delta_percent'),
      sales: num(row, 'sales_delta_percent'),
      acos: num(row, 'acos_delta_percent'),
      clicks: num(row, 'clicks_delta_percent'),
      orders: num(row, 'orders_delta_percent'),
    },
    targetAcos: target,
    acosVsTargetPoints: acos !== null && target !== null ? (acos - target) * 100 : null,
    monthlyBudget: profile.monthlyBudget,
    pacing: {
      status: briefing.pacing.pacing?.status ?? null,
      pace: briefing.pacing.pacing?.pace ?? null,
      monthToDateSpend: briefing.pacing.pacing?.monthToDateSpend ?? null,
    },
    flags: {
      active: briefing.flags.active?.length ?? 0,
      suppressed: briefing.flags.suppressed?.length ?? 0,
    },
  };

  const findings: Finding[] = [];
  if (!hasData) {
    findings.push({
      severity: 'info',
      headline: 'No facts loaded',
      detail:
        briefing.entity.freshness.note ||
        'No profile-grain facts exist for this window. Nothing can be concluded yet.',
      scope: 'account',
    });
  } else {
    const trend = trendFinding(figures, currency);
    if (trend) findings.push(trend);
    const vsTarget = targetFinding(figures);
    if (vsTarget) findings.push(vsTarget);
    const pacingResult = pacingFinding(briefing.pacing, currency);
    if (pacingResult) findings.push(pacingResult);
    for (const flag of briefing.flags.active ?? []) findings.push(flagToFinding(flag));
  }

  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  const accountName = profile.accountName ?? `${profile.countryCode} ${profile.amazonProfileId}`;
  const topSeverity = findings[0]?.severity ?? 'info';
  const title = hasData
    ? `${accountName}: ${findings.length} finding${findings.length === 1 ? '' : 's'} (${topSeverity})`
    : `${accountName}: no data`;

  return {
    profileId: profile.id,
    accountName,
    reportDate: briefing.asOf,
    kind: 'daily',
    title,
    figures,
    findings,
  };
}
