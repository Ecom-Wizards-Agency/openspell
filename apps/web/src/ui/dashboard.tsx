/**
 * The dashboard's own widgets.
 *
 * WP-06 shipped equivalents in `packages/ui`; these app-level versions use the
 * same visual tokens while retaining the existing route view models.
 *
 * Nothing here computes. Freshness is assessed by `assessFreshness`, pacing by
 * `computePacing`, flags by `evaluate`; this file decides only how the answers
 * look. That division is what lets the numbers be tested without a browser.
 */
import type { ReactNode } from 'react';
import { formatValue } from '@wizard-ads/ui';
import type { FormatContext, FreshnessAssessment } from '@wizard-ads/ui';
import { Badge, Card } from './primitives';
import type { Tone } from './primitives';

/* ----------------------------------------------------------------- kpi ---- */

export interface KpiDelta {
  caption: string;
  pct: number | null;
  reference: number | null;
}

export interface KpiTileProps {
  label: string;
  value: number | null;
  scale: 'money' | 'percent' | 'ratio' | 'integer';
  /** Which direction is good. `null` for a metric where neither is. */
  better: 'higher' | 'lower' | null;
  /** Exactly one visible comparison. */
  delta: KpiDelta;
  /** Optional secondary comparison exposed as hover detail, never another line. */
  detail?: KpiDelta;
  context: FormatContext;
}

/**
 * One metric and one visible comparison. A second comparison belongs in hover
 * detail, not in the scan line operators use to read the KPI row.
 *
 * Colour follows the metric's `better` direction, never the sign of the number:
 * ACOS down is green, spend down is neither. And the arrow is not decoration —
 * it is the second channel, so direction survives being read in grayscale or by
 * somebody who cannot separate the two hues.
 */
export function KpiTile({
  label,
  value,
  scale,
  better,
  delta,
  detail,
  context,
}: KpiTileProps): ReactNode {
  const detailText = detail === undefined ? undefined : formatDeltaDetail(detail, scale, context);
  return (
    <article className="wa-kpi" title={detailText}>
      <span className="wa-kpi__label">{label}</span>
      <span className="wa-kpi__value">{formatValue(value, scale, context)}</span>
      <div className="wa-kpi__deltas">
        <DeltaLine delta={delta} better={better} scale={scale} context={context} />
      </div>
    </article>
  );
}

function formatDeltaDetail(
  delta: KpiDelta,
  scale: KpiTileProps['scale'],
  context: FormatContext,
): string {
  const pct = delta.pct === null ? 'No comparison' : `${(delta.pct * 100).toFixed(1)}%`;
  const reference = delta.reference === null ? '' : ` (${formatValue(delta.reference, scale, context)})`;
  return `${pct} ${delta.caption}${reference}`;
}

function DeltaLine({
  delta,
  better,
  scale,
  context,
}: {
  delta: KpiDelta;
  better: 'higher' | 'lower' | null;
  scale: KpiTileProps['scale'];
  context: FormatContext;
}): ReactNode {
  if (delta.pct === null) {
    return (
      <p className="wa-kpi__delta wa-delta--flat" style={{ margin: 0 }}>
        <span style={{ color: 'var(--wa-text-muted)' }}>No comparison data</span>
      </p>
    );
  }
  const direction = deltaDirection(delta.pct, better);
  return (
    <p className={`wa-kpi__delta wa-delta--${direction}`} style={{ margin: 0 }}>
      <strong>
        <span aria-hidden="true">{delta.pct === 0 ? '·' : delta.pct > 0 ? '↑' : '↓'}</span>{' '}
        {`${Math.abs(delta.pct * 100).toFixed(1)}%`}
      </strong>
      <span style={{ color: 'var(--wa-text-muted)' }}>
        {delta.caption}
        {delta.reference === null ? '' : ` (${formatValue(delta.reference, scale, context)})`}
      </span>
    </p>
  );
}

function deltaDirection(pct: number | null, better: 'higher' | 'lower' | null): string {
  if (pct === null || pct === 0 || better === null) return 'flat';
  return (better === 'higher' ? pct > 0 : pct < 0) ? 'good' : 'bad';
}

/* ----------------------------------------------------------- freshness ---- */

const FRESHNESS_TONE: Record<string, Exclude<Tone, 'neutral'>> = {
  good: 'good',
  warn: 'warn',
  bad: 'bad',
  muted: 'info',
  neutral: 'info',
};

/**
 * Fresh data is routine context, not a success alert. Keep the current state
 * compact and neutral; warning and failure states still receive a tinted
 * surface because they change how every number below should be read.
 *
 * The ledger expands through `<details>`, so the disclosure needs no JavaScript
 * and this stays a server component.
 */
export function FreshnessBar({
  assessment,
  children,
}: {
  assessment: FreshnessAssessment;
  children?: ReactNode;
}): ReactNode {
  const tone = FRESHNESS_TONE[assessment.tone] ?? 'info';
  const status = freshnessStatus(assessment.tone);
  const summary = assessment.tone === 'good' && assessment.coversThrough !== null
    ? `Through ${formatCoverageDate(assessment.coversThrough)}`
    : assessment.headline;
  return (
    <section aria-label="Data freshness" className={`wa-freshness wa-freshness--${tone}`}>
      <details>
        <summary className="wa-freshness__summary">
          <span className="wa-freshness__primary">
            <span aria-hidden="true" className="wa-freshness__dot" />
            <strong>{status}</strong>
            <span className="wa-freshness__meta">{summary}</span>
          </span>
          <span className="wa-freshness__spacer" />
          {children}
          <span className="wa-freshness__action">
            <span
              aria-label="Freshness is based on completed Amazon report loads, not fact-row timestamps."
              className="wa-info-mark"
              role="img"
              title="Freshness is based on completed Amazon report loads, not fact-row timestamps."
            >
              i
            </span>
            Sync details
          </span>
        </summary>
        <div className="wa-freshness__panel">
          <ul>
            {assessment.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
          <p>
            Based on the report ledger. Fact rows cannot prove freshness because Amazon may omit
            rows with no impressions.
          </p>
        </div>
      </details>
    </section>
  );
}

function freshnessStatus(tone: FreshnessAssessment['tone']): string {
  if (tone === 'good') return 'Data current';
  if (tone === 'warn') return 'Data delayed';
  if (tone === 'bad') return 'Data issue';
  return 'No data yet';
}

function formatCoverageDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return value;
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
    year: 'numeric',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/* ------------------------------------------------------------- pacing ----- */

export type PacingStatus = 'on_pace' | 'warn' | 'act' | 'underpace';

export interface PacingView {
  asOf: string;
  dayOfMonth: number;
  daysInMonth: number;
  monthlyBudget: number;
  mtdSpend: number;
  budgetToDate: number;
  pace: number | null;
  status: PacingStatus;
  daysWithData: number;
  coverageComplete: boolean;
  guidance: readonly string[];
  notes: readonly string[];
}

const PACING_TONE: Record<PacingStatus, Exclude<Tone, 'neutral'>> = {
  on_pace: 'good',
  warn: 'warn',
  act: 'bad',
  underpace: 'warn',
};

const PACING_LABEL: Record<PacingStatus, string> = {
  on_pace: 'On pace',
  warn: 'Slightly over pace',
  act: 'Over pace — apply the cut order',
  underpace: 'Under pace',
};

/**
 * Month-to-date pace against the monthly budget.
 *
 * No budget means no meter, not a zero: a pace read against an invented target
 * is worse than none, so the card says what is missing and what would turn it
 * on.
 */
export function PacingCard({
  pacing,
  context,
}: {
  pacing: PacingView | null;
  context: FormatContext;
}): ReactNode {
  if (pacing === null) {
    return (
      <Card title="Pacing" aria-label="Pacing">
        <p className="wa-card__sub" style={{ margin: 0 }}>
          No monthly ad budget is set for this profile, so there is nothing to pace against. Set one
          on <a href="/settings/profiles">the profile</a> to turn this on — the widget will not
          invent a target.
        </p>
      </Card>
    );
  }

  const tone = PACING_TONE[pacing.status];
  const fill = pacing.pace === null ? 0 : Math.min(1.5, Math.max(0, pacing.pace));

  return (
    <Card
      title="Pacing"
      aria-label="Pacing"
      actions={
        <span className="wa-row" style={{ gap: '0.5rem' }}>
          <Badge tone={tone} dot>
            {PACING_LABEL[pacing.status]}
          </Badge>
          <strong className="wa-num" style={{ fontSize: 'var(--wa-fs-lg)' }}>
            {pacing.pace === null ? '—' : `${pacing.pace.toFixed(2)}×`}
          </strong>
        </span>
      }
    >
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={1.5}
        aria-valuenow={fill}
        aria-label="Month-to-date spend against budget-to-date"
        style={{
          background: 'var(--wa-surface-3)',
          borderRadius: 'var(--wa-radius-pill)',
          height: '0.5rem',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <div
          style={{
            background: `var(--wa-${tone}-text)`,
            height: '100%',
            width: `${(fill / 1.5) * 100}%`,
          }}
        />
        {/* The 1.0 mark: budget-to-date, the line the pace is measured against. */}
        <div
          style={{
            background: 'var(--wa-text)',
            bottom: 0,
            left: `${(1 / 1.5) * 100}%`,
            opacity: 0.45,
            position: 'absolute',
            top: 0,
            width: '1px',
          }}
        />
      </div>

      <dl
        style={{
          display: 'grid',
          gap: '0.5rem 1rem',
          gridTemplateColumns: 'repeat(auto-fit, minmax(7rem, 1fr))',
          margin: '0.875rem 0 0',
        }}
      >
        <Figure label="MTD spend" value={formatValue(pacing.mtdSpend, 'money', context)} />
        <Figure label="Budget to date" value={formatValue(pacing.budgetToDate, 'money', context)} />
        <Figure label="Monthly budget" value={formatValue(pacing.monthlyBudget, 'money', context)} />
        <Figure label="Day" value={`${pacing.dayOfMonth} / ${pacing.daysInMonth}`} />
      </dl>

      {pacing.notes.map((note) => (
        <p key={note} className="wa-hint" style={{ color: 'var(--wa-warn-text)', margin: '0.5rem 0 0' }}>
          {note}
        </p>
      ))}

      {pacing.guidance.length === 0 ? null : (
        <ol style={{ fontSize: 'var(--wa-fs-sm)', margin: '0.75rem 0 0', paddingLeft: '1.25rem' }}>
          {pacing.guidance.map((line) => (
            <li key={line}>{line.replace(/^\d+\.\s*/, '')}</li>
          ))}
        </ol>
      )}

      {pacing.coverageComplete ? null : (
        <p className="wa-hint" style={{ margin: '0.5rem 0 0' }}>
          {pacing.daysWithData} of {pacing.dayOfMonth} month-to-date days carry a spend figure.
        </p>
      )}
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div>
      <dt className="wa-hint">{label}</dt>
      <dd className="wa-num" style={{ margin: 0 }}>
        {value}
      </dd>
    </div>
  );
}

/* -------------------------------------------------------------- flags ----- */

export type FlagSeverity = 'critical' | 'alert' | 'warn' | 'info';

export interface FlagView {
  severity: FlagSeverity;
  metric: string;
  threshold: string;
  message: string;
  likelyCause: string;
  scope: string;
  category: string;
  suppressed: boolean;
  suppressedReason: string | null;
}

const SEVERITY_TONE: Record<FlagSeverity, Exclude<Tone, 'neutral'>> = {
  critical: 'bad',
  alert: 'bad',
  warn: 'warn',
  info: 'info',
};

export interface FlagGroup {
  key: string;
  severity: FlagSeverity;
  metric: string;
  category: string;
  label: string;
  flags: FlagView[];
}

const SEVERITY_RANK: Record<FlagSeverity, number> = { critical: 0, alert: 1, warn: 2, info: 3 };

/** Collapse repeated campaign-level signals into operator-sized issue groups. */
export function groupFlags(flags: readonly FlagView[]): FlagGroup[] {
  const grouped = new Map<string, FlagView[]>();
  for (const flag of flags) {
    const key = `${flag.severity}:${flag.metric}:${flag.category}`;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(flag);
    else grouped.set(key, [flag]);
  }
  return [...grouped.entries()]
    .map(([key, entries]) => {
      const first = entries[0]!;
      return {
        key,
        severity: first.severity,
        metric: first.metric,
        category: first.category,
        label: `${humanMetric(first.metric)} · ${first.category}`,
        flags: entries,
      };
    })
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.flags.length - a.flags.length);
}

/**
 * The dashboard shows ranked issue groups, not a raw event log. A repeated
 * campaign signal remains inspectable inside its group without forcing every
 * row to compete for attention on first paint.
 */
export function FlagsCard({
  active,
  suppressed,
}: {
  active: readonly FlagView[];
  suppressed: readonly FlagView[];
}): ReactNode {
  const groups = groupFlags(active);
  const primary = groups.slice(0, 4);
  const remaining = groups.slice(4);
  const topSeverity = groups[0]?.severity ?? null;
  return (
    <Card
      title="Priority alerts"
      aria-label="Priority alerts"
      actions={
        <span className="wa-row" style={{ gap: '0.375rem' }}>
          <Badge tone={topSeverity === null ? 'good' : SEVERITY_TONE[topSeverity]} dot>
            {groups.length} issue group{groups.length === 1 ? '' : 's'}
          </Badge>
          <Badge>{active.length} signal{active.length === 1 ? '' : 's'}</Badge>
        </span>
      }
    >
      {active.length === 0 ? (
        <p className="wa-card__sub" style={{ margin: 0 }}>
          No issue needs operator attention for the selected evidence window.
        </p>
      ) : (
        <div className="wa-flag-groups">
          {primary.map((group) => <FlagGroupItem group={group} key={group.key} />)}
          {remaining.length === 0 ? null : (
            <details className="wa-flag-groups__more">
              <summary>Show {remaining.length} more issue group{remaining.length === 1 ? '' : 's'}</summary>
              <div className="wa-flag-groups">
                {remaining.map((group) => <FlagGroupItem group={group} key={group.key} />)}
              </div>
            </details>
          )}
        </div>
      )}

      {suppressed.length === 0 ? null : (
        <details className="wa-flag-groups__noted">
          <summary>{suppressed.length} threshold observation{suppressed.length === 1 ? '' : 's'} deliberately not raised</summary>
          <p className="wa-hint">
            The strategy rules suppressed these signals. They remain visible for auditability.
          </p>
          <div className="wa-flag-groups">
            {groupFlags(suppressed).map((group) => <FlagGroupItem group={group} key={`noted:${group.key}`} dim />)}
          </div>
        </details>
      )}
    </Card>
  );
}

function FlagGroupItem({ group, dim = false }: { group: FlagGroup; dim?: boolean }): ReactNode {
  const scopes = new Set(group.flags.map((flag) => flag.scope));
  const first = group.flags[0]!;
  return (
    <details className="wa-flag-group" style={{ opacity: dim ? 0.82 : 1 }}>
      <summary>
        <Badge tone={dim ? 'neutral' : SEVERITY_TONE[group.severity]}>{group.severity}</Badge>
        <span className="wa-flag-group__title">
          <strong>{group.label}</strong>
          <span>{scopes.size} scope{scopes.size === 1 ? '' : 's'} · {group.flags.length} signal{group.flags.length === 1 ? '' : 's'}</span>
        </span>
        <span className="wa-flag-group__example">{first.message}</span>
        <span aria-hidden="true" className="wa-flag__chev">›</span>
      </summary>
      <div className="wa-flag-group__body">
        <p>{first.likelyCause}</p>
        <p className="wa-hint">Rule: {first.metric} · {first.threshold}</p>
        <ul>
          {group.flags.map((flag, index) => (
            <li key={`${flag.scope}-${flag.metric}-${index}`}>
              <strong>{flag.scope}</strong><span>{flag.message}</span>
              {flag.suppressedReason === null ? null : <small>{flag.suppressedReason}</small>}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

function humanMetric(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
