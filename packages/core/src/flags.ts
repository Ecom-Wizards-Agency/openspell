/**
 * Port of `flags.py`: severity-tagged, goal-aware performance flags.
 *
 * The part of this module that matters most is the part that does NOT fire.
 * A wide ACOS swing on a Rank/SKW campaign is a last-click attribution
 * artifact, not an anomaly, so it is returned in a separate `suppressed` list:
 * visible as "noted, not flagged", never silently dropped and never raised as
 * an alert. Everything else here is ordinary thresholding.
 *
 * The default thresholds and the goal-lens presets below are the reference
 * toolkit's own published defaults, not tenant doctrine. Tenant doctrine
 * (target ACOS, change caps, search-volume bands) never appears in this
 * repository; it arrives at runtime through `config`.
 */
import { formatFixed, formatMoney } from './num.js';
import {
  CATEGORY_DISCOVERY,
  CATEGORY_RANK,
  CATEGORY_UNKNOWN,
  type AnalysisResult,
  type Flag,
  type SeriesAnalysis,
  type Severity,
} from './types.js';

export const SEVERITY_CRITICAL: Severity = 'critical';
export const SEVERITY_ALERT: Severity = 'alert';
export const SEVERITY_WARN: Severity = 'warn';
export const SEVERITY_INFO: Severity = 'info';

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  alert: 1,
  warn: 2,
  info: 3,
};
const SEVERITY_LADDER: Severity[] = [SEVERITY_CRITICAL, SEVERITY_ALERT, SEVERITY_WARN, SEVERITY_INFO];

export interface Thresholds {
  spend_spike_pct: number;
  spend_collapse_pct: number;
  cvr_drop_pct: number;
  clicks_stable_band_pct: number;
  near_zero_impressions_abs: number;
  near_zero_impressions_ratio: number;
  discovery_share_max: number;
  acos_swing_pct: number;
  zero_sales_spend_min: number;
  budget_capped_min_days: number;
  tacos_rise_alert_pct: number;
  margin_drop_alert_pct: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  spend_spike_pct: 0.6,
  spend_collapse_pct: -0.5,
  cvr_drop_pct: -0.25,
  clicks_stable_band_pct: 0.15,
  near_zero_impressions_abs: 50,
  near_zero_impressions_ratio: 0.15,
  discovery_share_max: 0.2,
  acos_swing_pct: 0.5,
  zero_sales_spend_min: 20.0,
  budget_capped_min_days: 1,
  tacos_rise_alert_pct: 0.2,
  margin_drop_alert_pct: -0.15,
};

export type TacosMarginBehavior = 'expected_high' | 'alert_on_rise' | 'ignore';

/** Pacing knobs a lens may nudge; `pacing.ts` owns their defaults. */
export interface PacingOverrides {
  warn_above?: number;
  act_above?: number;
  underpace_below?: number;
}

export interface GoalLens {
  label: string;
  description: string;
  threshold_overrides: Partial<Thresholds>;
  tacos_margin_behavior: TacosMarginBehavior;
  impression_rank_critical: boolean;
  escalate_spend_spike?: boolean;
  downgrade_zero_sales?: boolean;
  pacing_overrides?: PacingOverrides;
}

export const GOAL_RANK_LAUNCH = 'rank-launch';
export const GOAL_SCALE = 'scale';
export const GOAL_PROFIT_MAINTAIN = 'profit-maintain';
export const GOAL_DEFEND = 'defend';
export const GOAL_MAINTAIN = 'maintain';
export const GOAL_LIQUIDATE = 'liquidate';
export const GOAL_INACTIVE = 'inactive';
export const GOAL_NEUTRAL = 'neutral';
export const DEFAULT_GOAL = GOAL_NEUTRAL;

export const GOAL_LENSES: Record<string, GoalLens> = {
  [GOAL_RANK_LAUNCH]: {
    label: 'Rank / Launch',
    description:
      'Building organic rank on a new/young ASIN. High or rising TACOS/ACOS is the plan, ' +
      'not a problem -- the real emergency is losing impression share on the Rank keyword ' +
      "we're trying to rank.",
    threshold_overrides: { tacos_rise_alert_pct: 0.35, acos_swing_pct: 0.75 },
    tacos_margin_behavior: 'expected_high',
    impression_rank_critical: true,
    pacing_overrides: { warn_above: 1.2, act_above: 1.4 },
  },
  [GOAL_SCALE]: {
    label: 'Scale',
    description:
      'Proven winner, pushing volume. Efficiency matters more than at launch but growth ' +
      'still leads -- watch discovery bloat and CVR more closely than raw ACOS/TACOS.',
    threshold_overrides: { discovery_share_max: 0.15 },
    tacos_margin_behavior: 'ignore',
    impression_rank_critical: false,
  },
  [GOAL_PROFIT_MAINTAIN]: {
    label: 'Profit / Maintain',
    description:
      'Mature ASIN, defending margin. Rising TACOS or falling margin IS the alert; ' +
      'aggressive spend growth is the flag, not expected upside.',
    threshold_overrides: {
      tacos_rise_alert_pct: 0.15,
      margin_drop_alert_pct: -0.1,
      spend_spike_pct: 0.35,
    },
    tacos_margin_behavior: 'alert_on_rise',
    impression_rank_critical: false,
    escalate_spend_spike: true,
    pacing_overrides: { warn_above: 1.05, act_above: 1.15 },
  },
  [GOAL_DEFEND]: {
    label: 'Defend',
    description:
      'Protecting rank/share against a competitor or hijacker push. Near-zero impressions ' +
      'and Shield-category anomalies are urgent; some extra spend to hold position is expected.',
    threshold_overrides: { tacos_rise_alert_pct: 0.25, near_zero_impressions_ratio: 0.25 },
    tacos_margin_behavior: 'alert_on_rise',
    impression_rank_critical: true,
  },
  [GOAL_MAINTAIN]: {
    label: 'Maintain / Stability',
    description:
      'Keep the account steady with no surprises (e.g. offboarding client, caretaker mode). ' +
      'Any sharp move -- spend spike, TACOS rise, margin drop -- is the alert; growth pushes ' +
      'are out of scope, stability is the goal.',
    threshold_overrides: {
      tacos_rise_alert_pct: 0.2,
      margin_drop_alert_pct: -0.1,
      spend_spike_pct: 0.3,
    },
    tacos_margin_behavior: 'alert_on_rise',
    impression_rank_critical: false,
    escalate_spend_spike: true,
    pacing_overrides: { warn_above: 1.05, act_above: 1.15 },
  },
  [GOAL_LIQUIDATE]: {
    label: 'Liquidate',
    description:
      'Clearing inventory fast (excess stock, sunsetting SKU). Margin erosion, and even a ' +
      'real loss on ads, is expected -- the real risk is NOT selling through fast enough.',
    threshold_overrides: { near_zero_impressions_ratio: 0.25, zero_sales_spend_min: 40.0 },
    tacos_margin_behavior: 'expected_high',
    impression_rank_critical: false,
    downgrade_zero_sales: true,
  },
  [GOAL_INACTIVE]: {
    label: 'Inactive',
    description:
      'Account not live yet (or paused entirely) -- runs are normally skipped. If data does ' +
      'show up, any ad spend at all is unexpected and worth a look; everything else is noise.',
    threshold_overrides: { spend_spike_pct: 0.2, zero_sales_spend_min: 10.0 },
    tacos_margin_behavior: 'ignore',
    impression_rank_critical: false,
  },
  [GOAL_NEUTRAL]: {
    label: 'Neutral',
    description: 'No goal profile on file yet -- plain thresholds, no goal-based severity changes.',
    threshold_overrides: {},
    tacos_margin_behavior: 'ignore',
    impression_rank_critical: false,
  },
};

/** Unknown or missing goal resolves to the neutral lens. */
export function resolveGoalLens(goal: string | null | undefined): GoalLens {
  return (goal !== null && goal !== undefined ? GOAL_LENSES[goal] : undefined) ?? (GOAL_LENSES[DEFAULT_GOAL] as GoalLens);
}

/** Per-account config: only the keys the engine knows are read. */
export interface FlagsConfig {
  thresholds?: Partial<Thresholds>;
}

/**
 * Layering, lowest to highest: toolkit defaults, goal-lens overrides, explicit
 * per-account config. Config always wins; a lens is a per-goal default, never
 * a hard rule.
 */
export function resolveThresholds(config?: FlagsConfig | null, lens?: GoalLens | null): Thresholds {
  const merged: Thresholds = { ...DEFAULT_THRESHOLDS };
  const known = Object.keys(DEFAULT_THRESHOLDS) as Array<keyof Thresholds>;
  if (lens?.threshold_overrides) {
    for (const key of known) {
      const value = lens.threshold_overrides[key];
      if (value !== undefined) merged[key] = value;
    }
  }
  if (config?.thresholds) {
    for (const key of known) {
      const value = config.thresholds[key];
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged;
}

/** Python `_pct`: `None` renders as `n/a`, otherwise a whole-percent string. */
export function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? 'n/a' : `${formatFixed(value * 100, 0)}%`;
}

function escalate(severity: Severity): Severity {
  const idx = SEVERITY_LADDER.indexOf(severity);
  const from = idx === -1 ? SEVERITY_LADDER.length - 1 : idx;
  return SEVERITY_LADDER[Math.max(from - 1, 0)] as Severity;
}

function downgrade(severity: Severity): Severity {
  const idx = SEVERITY_LADDER.indexOf(severity);
  const from = idx === -1 ? SEVERITY_LADDER.length - 1 : idx;
  return SEVERITY_LADDER[Math.min(from + 1, SEVERITY_LADDER.length - 1)] as Severity;
}

function flag(partial: Omit<Flag, 'suppressed' | 'suppressedReason'> & Partial<Pick<Flag, 'suppressed' | 'suppressedReason'>>): Flag {
  return {
    suppressed: false,
    suppressedReason: null,
    ...partial,
  };
}

type CampaignCheck = (series: SeriesAnalysis, thresholds: Thresholds, lens?: GoalLens | null) => Flag | null;

const checkSpendSpikeOrCollapse: CampaignCheck = (series, thresholds, lens) => {
  const d = series.deltas['spend'];
  if (!d || d.trailing7PctChange === null) return null;
  if (d.trailing7PctChange >= thresholds.spend_spike_pct) {
    let severity: Severity = SEVERITY_WARN;
    let cause =
      'Spend spike: bid/budget change, new campaign, or a competitor pullback opening cheaper auctions. Check for an intentional change first.';
    if (lens?.escalate_spend_spike) {
      severity = escalate(severity);
      cause += ` Escalated under the '${lens.label}' goal: aggressive spend growth needs a reason, not a shrug.`;
    }
    return flag({
      severity,
      metric: 'spend',
      threshold: `>= +${pct(thresholds.spend_spike_pct)} vs trailing-7 avg`,
      message: `Spend ${pct(d.trailing7PctChange)} vs trailing-7 avg (${formatMoney(d.value as number)} vs ${formatMoney(d.trailing7Avg as number)} avg).`,
      likelyCause: cause,
      scope: series.label,
      category: series.category,
    });
  }
  if (d.trailing7PctChange <= thresholds.spend_collapse_pct) {
    return flag({
      severity: SEVERITY_WARN,
      metric: 'spend',
      threshold: `<= ${pct(thresholds.spend_collapse_pct)} vs trailing-7 avg`,
      message: `Spend ${pct(d.trailing7PctChange)} vs trailing-7 avg (${formatMoney(d.value as number)} vs ${formatMoney(d.trailing7Avg as number)} avg).`,
      likelyCause:
        'Spend collapse: budget exhaustion earlier in the day, a paused campaign/ad group, out-of-stock advertised SKU, or a suppressed listing.',
      scope: series.label,
      category: series.category,
    });
  }
  return null;
};

const checkBudgetCapped: CampaignCheck = (series, thresholds) => {
  const row = series.reportRow;
  if (!row || !row.budgetCapped) return null;
  let cause = 'Campaign hit its daily budget cap; it stopped serving before demand ran out.';
  if (series.category === CATEGORY_RANK) {
    cause +=
      " On a Rank/SKW campaign this means lost impression share on the exact keyword we're trying to rank -- raise the budget rather than let it cap.";
  }
  return flag({
    severity: SEVERITY_WARN,
    metric: 'spend',
    threshold: `budget-capped >= ${thresholds.budget_capped_min_days} day(s)`,
    message: row.budget
      ? `Budget-capped on the report date (spend ${formatMoney(row.spend)} of ${formatMoney(row.budget)} budget).`
      : 'Budget-capped on the report date.',
    likelyCause: cause,
    scope: series.label,
    category: series.category,
  });
};

const checkCvrDropStableClicks: CampaignCheck = (series, thresholds) => {
  const cvrD = series.deltas['cvr'];
  const clicksD = series.deltas['clicks'];
  if (!cvrD || !clicksD) return null;
  if (cvrD.trailing7PctChange === null || clicksD.trailing7PctChange === null) return null;
  if (cvrD.trailing7PctChange > thresholds.cvr_drop_pct) return null;
  if (Math.abs(clicksD.trailing7PctChange) > thresholds.clicks_stable_band_pct) return null;
  return flag({
    severity: SEVERITY_WARN,
    metric: 'cvr',
    threshold: `<= ${pct(thresholds.cvr_drop_pct)} vs trailing-7 avg with clicks within +/-${pct(thresholds.clicks_stable_band_pct)}`,
    message: `CVR ${pct(cvrD.trailing7PctChange)} vs trailing-7 avg while clicks held (${pct(clicksD.trailing7PctChange)}).`,
    likelyCause:
      "Clicks are stable so this isn't a bid/visibility issue -- check the listing (price, stock, reviews, image, buy box) rather than the campaign.",
    scope: series.label,
    category: series.category,
  });
};

const checkNearZeroImpressionsRank: CampaignCheck = (series, thresholds, lens) => {
  if (series.category !== CATEGORY_RANK) return null;
  const d = series.deltas['impressions'];
  if (!d || d.value === null) return null;
  const ratioOk = Boolean(d.trailing7Avg) && d.value <= thresholds.near_zero_impressions_ratio * (d.trailing7Avg as number);
  const absOk = d.value <= thresholds.near_zero_impressions_abs;
  if (!ratioOk && !absOk) return null;
  let severity: Severity = SEVERITY_ALERT;
  let cause =
    "Likely suppressed listing, out-bid, budget/end-date issue, or paused by mistake. This is the keyword we're trying to rank -- treat as urgent.";
  if (lens?.impression_rank_critical) {
    severity = escalate(severity);
    cause += ` Escalated to CRITICAL under the '${lens.label}' goal: losing impression share on the keyword we're trying to rank/hold is the single worst outcome.`;
  }
  return flag({
    severity,
    metric: 'impressions',
    threshold: `<= ${thresholds.near_zero_impressions_abs} impressions or <= ${pct(thresholds.near_zero_impressions_ratio)} of trailing-7 avg`,
    message: `Rank/SKW campaign impressions collapsed to ${formatFixed(d.value, 0, true)} (trailing-7 avg ${formatFixed(d.trailing7Avg as number, 0, true)}).`,
    likelyCause: cause,
    scope: series.label,
    category: series.category,
  });
};

const checkZeroSalesSpend: CampaignCheck = (series, thresholds, lens) => {
  const row = series.reportRow;
  const spendD = series.deltas['spend'];
  const ordersD = series.deltas['orders'];
  if (!row || !spendD || !ordersD) return null;
  // The trailing week, not the single report day, so one lucky click does not
  // hide a genuine negative-keyword candidate.
  const trailingSpend = spendD.trailing7Avg ?? 0.0;
  const trailingOrders = ordersD.trailing7Avg ?? 0.0;
  if (trailingSpend < thresholds.zero_sales_spend_min || trailingOrders > 0 || (row.orders || 0) > 0) return null;
  let severity: Severity = SEVERITY_ALERT;
  let cause = 'Zero orders despite real spend over the trailing week -- negative-keyword/target candidate.';
  if (series.category === CATEGORY_RANK) {
    severity = SEVERITY_WARN;
    cause +=
      ' Rank/SKW campaigns may intentionally run at break-even or a loss to drive rank (strategy.md) -- verify this is the plan, not simply wasted spend, before cutting it.';
  }
  if (lens?.downgrade_zero_sales) {
    severity = downgrade(severity);
    cause += ` Downgraded under the '${lens.label}' goal: some loss-driving spend to sell through fast is the plan.`;
  }
  return flag({
    severity,
    metric: 'orders',
    threshold: `>= $${formatFixed(thresholds.zero_sales_spend_min, 0)} trailing-7 avg spend with 0 orders`,
    message: `~${formatMoney(trailingSpend)}/day trailing-7 avg spend with 0 orders (report day spend ${formatMoney(row.spend)}).`,
    likelyCause: cause,
    scope: series.label,
    category: series.category,
  });
};

/**
 * A real ACOS swing outside Rank/SKW. Rank/SKW suppression lives in
 * `evaluate` so the suppressed-versus-active split stays in one place.
 */
const checkAcosSwing: CampaignCheck = (series, thresholds) => {
  if (series.category === CATEGORY_RANK) return null;
  const d = series.deltas['acos'];
  if (!d || d.trailing7PctChange === null) return null;
  if (Math.abs(d.trailing7PctChange) < thresholds.acos_swing_pct) return null;
  const direction = d.trailing7PctChange > 0 ? 'up' : 'down';
  return flag({
    severity: SEVERITY_INFO,
    metric: 'acos',
    threshold: `>= +/-${pct(thresholds.acos_swing_pct)} vs trailing-7 avg`,
    message: `ACOS swung ${direction} ${pct(d.trailing7PctChange)} vs trailing-7 avg (${pct(d.value)} vs ${pct(d.trailing7Avg)} avg).`,
    likelyCause:
      'Wait for a full attribution window before reacting; exclude event days from the read. Check bid/placement changes and competitor activity before touching bids.',
    scope: series.label,
    category: series.category,
  });
};

function acosSwingWouldFire(series: SeriesAnalysis, thresholds: Thresholds): boolean {
  const d = series.deltas['acos'];
  if (!d || d.trailing7PctChange === null) return false;
  return Math.abs(d.trailing7PctChange) >= thresholds.acos_swing_pct;
}

const CAMPAIGN_CHECKS: CampaignCheck[] = [
  checkSpendSpikeOrCollapse,
  checkBudgetCapped,
  checkCvrDropStableClicks,
  checkNearZeroImpressionsRank,
  checkZeroSalesSpend,
  checkAcosSwing,
];

function checkDiscoveryShare(analysis: AnalysisResult, thresholds: Thresholds): Flag | null {
  let discoverySpend = 0.0;
  let totalSpend = 0.0;
  let anyData = false;
  for (const series of analysis.campaignSeries) {
    const d = series.deltas['spend'];
    if (!d || d.value === null) continue;
    anyData = true;
    totalSpend += d.value;
    if (series.category === CATEGORY_DISCOVERY) discoverySpend += d.value;
  }
  if (!anyData || totalSpend <= 0) return null;
  const share = discoverySpend / totalSpend;
  if (share <= thresholds.discovery_share_max) return null;
  return flag({
    severity: SEVERITY_WARN,
    metric: 'discovery_share_of_spend',
    threshold: `> ${pct(thresholds.discovery_share_max)} of total spend`,
    message: `Discovery campaigns are ${pct(share)} of today's spend (target ~${pct(thresholds.discovery_share_max)} or less).`,
    likelyCause:
      'Discovery bloat: broad/auto/phrase campaigns are absorbing budget that should be funding Rank/exact. Review Discovery bids and search-term hygiene.',
    scope: 'account',
    category: CATEGORY_DISCOVERY,
  });
}

/**
 * Account-level TACOS-rise / margin-drop read, gated entirely by the lens.
 * Returns `[active, suppressed]`, either of which may be null.
 */
function checkGoalAwareTacosMargin(
  analysis: AnalysisResult,
  thresholds: Thresholds,
  lens: GoalLens,
): [Flag | null, Flag | null] {
  const behavior = lens.tacos_margin_behavior ?? 'ignore';
  if (behavior === 'ignore') return [null, null];

  const series = analysis.accountSeries;
  const tacosD = series.deltas['tacos'];
  const marginD = series.deltas['margin'];
  const tacosRise = Boolean(
    tacosD && tacosD.trailing7PctChange !== null && tacosD.trailing7PctChange >= thresholds.tacos_rise_alert_pct,
  );
  const marginDrop = Boolean(
    marginD && marginD.trailing7PctChange !== null && marginD.trailing7PctChange <= thresholds.margin_drop_alert_pct,
  );
  if (!tacosRise && !marginDrop) return [null, null];

  const bits: string[] = [];
  if (tacosRise && tacosD) {
    bits.push(
      `TACOS ${pct(tacosD.trailing7PctChange)} vs trailing-7 avg (${pct(tacosD.value)} vs ${pct(tacosD.trailing7Avg)} avg)`,
    );
  }
  if (marginDrop && marginD) {
    bits.push(
      `margin ${pct(marginD.trailing7PctChange)} vs trailing-7 avg (${pct(marginD.value)} vs ${pct(marginD.trailing7Avg)} avg)`,
    );
  }
  const message = `${bits.join('; ')}.`;
  const threshold =
    `>= +${pct(thresholds.tacos_rise_alert_pct)} TACOS or ` +
    `<= ${pct(thresholds.margin_drop_alert_pct)} margin vs trailing-7 avg`;

  if (behavior === 'expected_high') {
    return [
      null,
      flag({
        severity: SEVERITY_INFO,
        metric: 'tacos_margin',
        threshold,
        message,
        likelyCause: `Expected under the '${lens.label}' goal: ${lens.description}`,
        scope: 'account',
        category: CATEGORY_UNKNOWN,
        suppressed: true,
        suppressedReason: `'${lens.label}' goal treats rising TACOS / falling margin as the plan, not a problem.`,
      }),
    ];
  }

  return [
    flag({
      severity: SEVERITY_ALERT,
      metric: 'tacos_margin',
      threshold,
      message,
      likelyCause: `Under the '${lens.label}' goal this is exactly the signal to act on: ${lens.description}`,
      scope: 'account',
      category: CATEGORY_UNKNOWN,
    }),
    null,
  ];
}

function sortFlags(flags: Flag[]): Flag[] {
  return [...flags].sort((a, b) => {
    const sa = SEVERITY_ORDER[a.severity] ?? 9;
    const sb = SEVERITY_ORDER[b.severity] ?? 9;
    if (sa !== sb) return sa - sb;
    if (a.scope !== b.scope) return a.scope < b.scope ? -1 : 1;
    if (a.metric !== b.metric) return a.metric < b.metric ? -1 : 1;
    return 0;
  });
}

export interface EvaluateResult {
  active: Flag[];
  suppressed: Flag[];
}

/**
 * Evaluate every rule over an analysis.
 *
 * `goal` is the brand's stage from its ops profile; unknown or missing resolves
 * to the neutral lens, which leaves every threshold and severity untouched.
 */
export function evaluate(
  analysis: AnalysisResult,
  config?: FlagsConfig | null,
  goal?: string | null,
): EvaluateResult {
  const lens = resolveGoalLens(goal);
  const thresholds = resolveThresholds(config, lens);
  const active: Flag[] = [];
  const suppressed: Flag[] = [];

  const allSeries = [analysis.accountSeries, ...analysis.campaignSeries];
  for (const series of allSeries) {
    if (series.reportRow === null) continue;
    for (const check of CAMPAIGN_CHECKS) {
      const result = check(series, thresholds, lens);
      if (result !== null) active.push(result);
    }
    // A Rank/SKW campaign's ACOS swing is expected under last-click
    // attribution: surfaced as suppressed, never as an active flag, even
    // though the raw threshold would trigger.
    if (series.category === CATEGORY_RANK && acosSwingWouldFire(series, thresholds)) {
      const d = series.deltas['acos'];
      if (d) {
        suppressed.push(
          flag({
            severity: SEVERITY_INFO,
            metric: 'acos',
            threshold: `>= +/-${pct(thresholds.acos_swing_pct)} vs trailing-7 avg`,
            message: `ACOS swung ${pct(d.trailing7PctChange)} vs trailing-7 avg (${pct(d.value)} vs ${pct(d.trailing7Avg)} avg).`,
            likelyCause:
              'Expected on a Rank/SKW campaign: last-click attribution makes top-of-search ACOS unreliable as a decision signal (strategy.md). Not flagged.',
            scope: series.label,
            category: series.category,
            suppressed: true,
            suppressedReason:
              'High/volatile ACOS on a Rank/SKW campaign is a known attribution artifact, not a real anomaly, per the rank-first philosophy.',
          }),
        );
      }
    }
  }

  const discoveryFlag = checkDiscoveryShare(analysis, thresholds);
  if (discoveryFlag !== null) active.push(discoveryFlag);

  const [tacosMarginActive, tacosMarginSuppressed] = checkGoalAwareTacosMargin(analysis, thresholds, lens);
  if (tacosMarginActive !== null) active.push(tacosMarginActive);
  if (tacosMarginSuppressed !== null) suppressed.push(tacosMarginSuppressed);

  return { active: sortFlags(active), suppressed: sortFlags(suppressed) };
}
