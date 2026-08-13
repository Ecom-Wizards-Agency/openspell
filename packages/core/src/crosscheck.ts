/**
 * Port of `crosscheck.py`: the data-quality verdict model.
 *
 * Two feeds cover the same day from different angles. They should agree within
 * tolerance on the figures they both carry; when they do not, that is a signal
 * (same-day lag, a missing marketplace, a mis-scoped filter) to state, not a
 * discrepancy to resolve by silently picking one number.
 *
 * A figure missing on either side is `no_data` for that figure and is excluded
 * from the headline. If every figure is missing the headline is `no_data`:
 * "not cross-checked", never a false "verified".
 */
import { formatFixed, formatMoney } from './num.js';

export const DEFAULT_TOLERANCE = 0.07;

export const VERIFIED = 'verified';
export const MISMATCH = 'mismatch';
export const NO_DATA = 'no_data';

export type Verdict = typeof VERIFIED | typeof MISMATCH | typeof NO_DATA;

export type FigureName = 'ad_spend' | 'ad_sales' | 'total_sales';

const FIGURE_LABELS: Record<FigureName, string> = {
  ad_spend: 'ad spend',
  ad_sales: 'ad sales',
  total_sales: 'total sales',
};

const FIGURES: FigureName[] = ['ad_spend', 'ad_sales', 'total_sales'];

export interface FigureCheck {
  figure: FigureName;
  sellerboardValue: number | null;
  adlabsValue: number | null;
  deltaAbs: number | null;
  /** `(adlabs - sellerboard) / abs(sellerboard)`. */
  deltaPct: number | null;
  verdict: Verdict;
}

export interface CrossCheckResult {
  tolerance: number;
  figures: FigureCheck[];
  headlineVerdict: Verdict;
}

export type FigureSet = Partial<Record<FigureName, number | null | undefined>>;

function pctDelta(sbValue: number, alValue: number): number | null {
  // Undefined base: any nonzero counterpart is a full mismatch, not a divide.
  if (sbValue === 0) return alValue === 0 ? null : 1.0;
  return (alValue - sbValue) / Math.abs(sbValue);
}

function checkFigure(
  name: FigureName,
  sbValue: number | null | undefined,
  alValue: number | null | undefined,
  tolerance: number,
): FigureCheck {
  const sb = sbValue ?? null;
  const al = alValue ?? null;
  if (sb === null || al === null) {
    return { figure: name, sellerboardValue: sb, adlabsValue: al, deltaAbs: null, deltaPct: null, verdict: NO_DATA };
  }
  const deltaAbs = al - sb;
  const deltaPct = pctDelta(sb, al);
  let verdict: Verdict;
  if (deltaPct === null) verdict = NO_DATA;
  else if (Math.abs(deltaPct) <= tolerance) verdict = VERIFIED;
  else verdict = MISMATCH;
  return { figure: name, sellerboardValue: sb, adlabsValue: al, deltaAbs, deltaPct, verdict };
}

/**
 * Compare two figure sets for the same report day and the same account scope.
 */
export function crossCheck(
  sellerboard: FigureSet,
  adlabs: FigureSet,
  tolerance: number = DEFAULT_TOLERANCE,
): CrossCheckResult {
  const figures = FIGURES.map((name) => checkFigure(name, sellerboard[name], adlabs[name], tolerance));
  const comparable = figures.filter((f) => f.verdict !== NO_DATA);
  let headline: Verdict;
  if (comparable.length === 0) headline = NO_DATA;
  else if (comparable.some((f) => f.verdict === MISMATCH)) headline = MISMATCH;
  else headline = VERIFIED;
  return { tolerance, figures, headlineVerdict: headline };
}

export function mismatches(result: CrossCheckResult): FigureCheck[] {
  return result.figures.filter((f) => f.verdict === MISMATCH);
}

/** One scannable, markdown-safe line. */
export function renderVerdictLine(result: CrossCheckResult): string {
  if (result.headlineVerdict === VERIFIED) {
    return `Data verified: Sellerboard and AdLabs agree within tolerance (+/-${formatFixed(result.tolerance * 100, 0)}%).`;
  }
  if (result.headlineVerdict === NO_DATA) {
    return 'Data verified: not cross-checked (AdLabs or Sellerboard figure missing for this day).';
  }
  const parts = mismatches(result).map((f) => {
    const sb = f.sellerboardValue !== null ? formatMoney(f.sellerboardValue) : 'n/a';
    const al = f.adlabsValue !== null ? formatMoney(f.adlabsValue) : 'n/a';
    const pctStr = f.deltaPct !== null ? `${f.deltaPct * 100 >= 0 ? '+' : ''}${formatFixed(f.deltaPct * 100, 0)}%` : 'n/a';
    const label = FIGURE_LABELS[f.figure] ?? f.figure;
    return `${label} SB ${sb} vs AdLabs ${al} (${pctStr})`;
  });
  return `Data mismatch: ${parts.join('; ')}.`;
}

/** The same line, prefixed with the scannable status emoji. */
export function renderVerdictEmojiLine(result: CrossCheckResult): string {
  const body = renderVerdictLine(result);
  if (result.headlineVerdict === VERIFIED) return `✅ ${body}`;
  if (result.headlineVerdict === NO_DATA) return `ℹ️ ${body}`;
  return `⚠️ ${body}`;
}
