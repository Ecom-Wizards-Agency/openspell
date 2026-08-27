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
  const direction = deltaDirection(delta.pct, better);
  return (
    <p className={`wa-kpi__delta wa-delta--${direction}`} style={{ margin: 0 }}>
      <strong>
        <span aria-hidden="true">{delta.pct === null || delta.pct === 0 ? '·' : delta.pct > 0 ? '↑' : '↓'}</span>{' '}
        {delta.pct === null ? '—' : `${Math.abs(delta.pct * 100).toFixed(1)}%`}
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
 * Staleness changes how every number on the page should be read, so it sits
 * above them at full width rather than tucked into a corner. The crosscheck
 * verdict answers a different question and rides beside it as a chip.
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
  return (
    <section aria-label="Data freshness" className={`wa-banner wa-banner--${tone}`} style={{ display: 'block' }}>
      <details>
        <summary
          className="wa-row"
          style={{ cursor: 'pointer', gap: '0.5rem', listStyle: 'none' }}
        >
          <Badge tone={tone} dot>
            Data
          </Badge>
          <span style={{ fontSize: 'var(--wa-fs-sm)' }}>{assessment.headline}</span>
          <span style={{ flex: 1 }} />
          {children}
          <span className="wa-hint" style={{ textDecoration: 'underline' }}>
            Report ledger
          </span>
        </summary>
        <ul style={{ fontSize: 'var(--wa-fs-xs)', margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
          {assessment.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
          <li style={{ opacity: 0.85 }}>
            Read from <code>report_requests</code>. Fact rows are never used to infer freshness:
            Amazon omits zero-impression rows, so an empty day and a missing sync look identical in
            the facts.
          </li>
        </ul>
      </details>
    </section>
  );
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

/**
 * Flags, active and suppressed, in two separate lists.
 *
 * The suppressed list is the point. A wide ACOS swing on a Rank/SKW campaign is
 * an attribution artifact, not an anomaly, so the engine returns it separately —
 * and the UI has to *show* it, headed "noted, not flagged", with the reason
 * attached. Raising it trains operators to ignore alerts; dropping it silently
 * makes the tool look like it missed something plainly visible in the numbers.
 *
 * Severity ordering is the engine's; this component never re-ranks.
 */
export function FlagsCard({
  active,
  suppressed,
}: {
  active: readonly FlagView[];
  suppressed: readonly FlagView[];
}): ReactNode {
  return (
    <Card
      title="Flags"
      aria-label="Flags"
      actions={
        <span className="wa-row" style={{ gap: '0.375rem' }}>
          <Badge tone={active.length === 0 ? 'good' : 'bad'} dot>
            {active.length} active
          </Badge>
          <Badge>{suppressed.length} noted</Badge>
        </span>
      }
    >
      {active.length === 0 ? (
        <p className="wa-card__sub" style={{ margin: 0 }}>
          Nothing crossed a threshold on this profile for the selected day. That is a result, not an
          empty panel.
        </p>
      ) : (
        <ul style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem', listStyle: 'none', margin: 0, padding: 0 }}>
          {active.map((flag, index) => (
            <FlagItem key={`${flag.scope}-${flag.metric}-${index}`} flag={flag} />
          ))}
        </ul>
      )}

      {suppressed.length === 0 ? null : (
        <>
          <h3 className="wa-card__title" style={{ fontSize: 'var(--wa-fs-base)', marginTop: '1rem' }}>
            Noted, not flagged
          </h3>
          <p className="wa-hint" style={{ margin: '0.25rem 0 0.625rem' }}>
            These crossed a threshold and were deliberately not raised. They are shown so nobody has
            to wonder whether the tool saw them.
          </p>
          <ul style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem', listStyle: 'none', margin: 0, padding: 0 }}>
            {suppressed.map((flag, index) => (
              <FlagItem key={`s-${flag.scope}-${flag.metric}-${index}`} flag={flag} dim />
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function FlagItem({ flag, dim = false }: { flag: FlagView; dim?: boolean }): ReactNode {
  return (
    <li
      className="wa-row"
      style={{ alignItems: 'flex-start', gap: '0.5rem', opacity: dim ? 0.85 : 1 }}
    >
      <Badge tone={dim ? 'neutral' : SEVERITY_TONE[flag.severity]}>{flag.severity}</Badge>
      <div style={{ flex: '1 1 14rem', fontSize: 'var(--wa-fs-sm)', minWidth: 0 }}>
        <div>
          <strong>{flag.scope}</strong> · {flag.message}
        </div>
        <div style={{ color: 'var(--wa-text-muted)' }}>{flag.likelyCause}</div>
        <div className="wa-hint">
          {flag.metric} · {flag.threshold}
          {flag.suppressedReason === null ? '' : ` · ${flag.suppressedReason}`}
        </div>
      </div>
    </li>
  );
}
