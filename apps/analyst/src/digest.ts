/**
 * The per-profile digest: a `ProfileAnalysis` rendered as Markdown.
 *
 * The shape follows the ads monitor's brief — a one-line headline, the numbers
 * that matter with their deltas, then the findings ranked by severity — because
 * an operator reads both and a consistent shape is one less thing to parse. The
 * string this returns is what lands in `insights.body` and what the operator's
 * downstream step hands, unaltered, to the guarded Wizards AI Slack helper. This
 * module posts nothing itself.
 */
import type { AnalysisFigures, ProfileAnalysis, Severity } from './analyze.js';

const SEVERITY_MARK: Record<Severity, string> = {
  critical: '🔴',
  alert: '🟠',
  warn: '🟡',
  info: '🔵',
};

function money(value: number | null, currency: string): string {
  if (value === null) return 'n/a';
  return `${currency} ${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function pct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function signedPct(value: number | null): string {
  if (value === null) return '';
  const sign = value > 0 ? '+' : '';
  return ` (${sign}${value.toFixed(1)}%)`;
}

function integer(value: number | null): string {
  return value === null ? 'n/a' : Math.round(value).toLocaleString('en-US');
}

function metricsBlock(figures: AnalysisFigures, currency: string): string[] {
  const t = figures.totals;
  const d = figures.deltaPercent;
  return [
    `- Spend: ${money(t.spend, currency)}${signedPct(d.spend)}`,
    `- Sales: ${money(t.sales, currency)}${signedPct(d.sales)}`,
    `- ACOS: ${pct(t.acos)}${signedPct(d.acos)}` +
      (figures.targetAcos !== null ? ` · target ${pct(figures.targetAcos)}` : ''),
    `- Clicks: ${integer(t.clicks)}${signedPct(d.clicks)} · Orders: ${integer(t.orders)}${signedPct(d.orders)}`,
  ];
}

/**
 * The digest, in the profile's own currency, so a JPY account never reads as
 * dollars. Currency is passed rather than guessed: it is a property of the
 * profile, not of the analysis.
 */
export function renderDigest(analysis: ProfileAnalysis, currency: string): string {
  const { figures } = analysis;
  const lines: string[] = [];
  const dateLabel = figures.reportDate ?? 'no completed day';
  const provisional = figures.provisional ? ' · latest day still attributing' : '';

  lines.push(`### ${analysis.accountName} — ${dateLabel}${provisional}`);
  lines.push('');

  if (!figures.hasData) {
    lines.push('_No facts are loaded for this profile yet; nothing can be concluded._');
    if (analysis.findings[0]) lines.push('', analysis.findings[0].detail);
    return lines.join('\n');
  }

  lines.push(
    `Window ${figures.window.from} → ${figures.window.to}. ` +
      `${figures.flags.active} active flag${figures.flags.active === 1 ? '' : 's'}, ` +
      `${figures.flags.suppressed} suppressed.`,
  );
  lines.push('');
  lines.push(...metricsBlock(figures, currency));
  lines.push('');

  if (analysis.findings.length === 0) {
    lines.push('No findings above the reporting floor.');
  } else {
    lines.push('**Findings**');
    for (const finding of analysis.findings) {
      lines.push(`- ${SEVERITY_MARK[finding.severity]} **${finding.headline}** — ${finding.detail}`);
    }
  }

  return lines.join('\n');
}
