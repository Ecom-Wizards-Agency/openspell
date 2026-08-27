'use client';

/**
 * The experiment detail view.
 *
 * The status controls, the chart, the comparison and the change log are all one
 * client component because they share one piece of state — the experiment's
 * status — and a move has to re-read all four. The comparison's numbers are the
 * real sums the query layer derived; this component only formats them, and it
 * keeps the "not a randomized test" caveat next to them rather than in a
 * footnote nobody scrolls to.
 */
import { useEffect, useMemo, useState } from 'react';
import type {
  ExperimentComparison,
  ExperimentMetric,
  ExperimentScope,
  ExperimentStatus,
  ExperimentType,
} from '@wizard-ads/db';
import { TrendChart } from '../../../src/ui/viz';
import type { TrendPoint } from '../../../src/ui/viz';
import { canTransition } from '../../../src/experiments/ui';
import {
  EXPERIMENT_STATUS_OPTIONS,
  METRIC_LABELS,
  STATUS_LABELS,
  STATUS_TEXT_COLOR,
  TYPE_LABELS,
} from '../../../src/experiments/labels';
import { banner, colors, heading, muted, page } from '../../../src/ui/tokens';

interface UiExperiment {
  id: string;
  profileId: string;
  name: string;
  hypothesis: string;
  type: ExperimentType;
  metricFocus: ExperimentMetric;
  status: ExperimentStatus;
  scope: ExperimentScope;
  resultNote: string | null;
  startAt: string;
  endAt: string | null;
}

interface UiChange {
  id: number;
  entityType: string;
  amazonId: string;
  entityName: string | null;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  source: string;
  observedAt: string;
}

interface UiEvent {
  id: number;
  fromStatus: ExperimentStatus | null;
  toStatus: ExperimentStatus;
  note: string | null;
  createdAt: string;
}

interface DailyPoint {
  date: string;
  value: number | null;
}

const day = (iso: string): string => iso.slice(0, 10);

const money = (value: number | null, currency: string): string =>
  value === null
    ? '—'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value);

const percent = (value: number | null): string =>
  value === null ? '—' : `${(value * 100).toFixed(1)}%`;

const integer = (value: number | null): string =>
  value === null ? '—' : new Intl.NumberFormat('en-US').format(Math.round(value));

/** One series to the union of every date, so the chart's axes line up. */
function alignSeries(sets: { label: string; points: DailyPoint[] }[]): {
  dates: string[];
  series: { label: string; points: TrendPoint[] }[];
} {
  const dates = Array.from(new Set(sets.flatMap((set) => set.points.map((point) => point.date)))).sort();
  const series = sets.map((set) => {
    const byDate = new Map(set.points.map((point) => [point.date, point.value]));
    return { label: set.label, points: dates.map((date) => ({ date, value: byDate.get(date) ?? null })) };
  });
  return { dates, series };
}

export function ExperimentDetail({
  experiment: initial,
  comparison,
  changes,
  events: initialEvents,
  trend,
  currencyCode,
  canManage,
}: {
  experiment: UiExperiment;
  comparison: ExperimentComparison;
  changes: UiChange[];
  events: UiEvent[];
  trend: { profile: DailyPoint[]; scoped: DailyPoint[] | null };
  currencyCode: string;
  canManage: boolean;
}) {
  const [experiment, setExperiment] = useState(initial);
  const [events, setEvents] = useState(initialEvents);
  const [note, setNote] = useState('');
  const [resultNote, setResultNote] = useState(initial.resultNote ?? '');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  const nextStatuses = EXPERIMENT_STATUS_OPTIONS.filter(
    (status) => status !== experiment.status && canTransition(experiment.status, status),
  );

  const chart = useMemo(() => {
    const sets = [{ label: 'Account spend', points: trend.profile }];
    if (trend.scoped) sets.push({ label: 'Scoped spend', points: trend.scoped });
    return alignSeries(sets);
  }, [trend]);

  const during = comparison.windows.find((window) => window.label === 'during');
  const chartWindows = during
    ? [
        {
          id: experiment.id,
          label: experiment.name,
          start: during.start,
          end: experiment.status === 'running' ? null : during.end,
        },
      ]
    : [];

  const transition = (to: ExperimentStatus) => {
    setPending(true);
    setMessage('Saving…');
    void (async () => {
      try {
        const response = await fetch(`/api/experiments/${experiment.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            status: to,
            ...(note.trim() ? { note } : {}),
            ...(to === 'ended' || to === 'analyzed' ? { resultNote } : {}),
          }),
        });
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
          item?: UiExperiment;
        } | null;
        if (!response.ok || !payload?.item) {
          throw new Error(payload?.error ?? `Could not move the experiment (${response.status})`);
        }
        setExperiment({ ...payload.item, scope: payload.item.scope ?? experiment.scope });
        setEvents((current) => [
          ...current,
          {
            id: Date.now(),
            fromStatus: experiment.status,
            toStatus: to,
            note: note.trim() || null,
            createdAt: new Date().toISOString(),
          },
        ]);
        setNote('');
        setMessage('Saved');
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Could not move the experiment');
      } finally {
        setPending(false);
      }
    })();
  };

  const formatMetric = (
    metrics: { spend: number; sales: number; orders: number; clicks: number; impressions: number; acos: number | null; cvr: number | null; ctr: number | null; cpc: number | null } | null,
    key: string,
  ): string => {
    if (metrics === null) return '—';
    switch (key) {
      case 'spend':
        return money(metrics.spend, currencyCode);
      case 'sales':
        return money(metrics.sales, currencyCode);
      case 'cpc':
        return money(metrics.cpc, currencyCode);
      case 'acos':
        return percent(metrics.acos);
      case 'cvr':
        return percent(metrics.cvr);
      case 'ctr':
        return percent(metrics.ctr);
      case 'orders':
        return integer(metrics.orders);
      case 'clicks':
        return integer(metrics.clicks);
      case 'impressions':
        return integer(metrics.impressions);
      default:
        return '—';
    }
  };

  const rows: { key: string; label: string }[] = [
    { key: 'spend', label: 'Spend' },
    { key: 'sales', label: 'Sales' },
    { key: 'acos', label: 'ACOS' },
    { key: 'cvr', label: 'Conversion rate' },
    { key: 'ctr', label: 'Click-through rate' },
    { key: 'cpc', label: 'CPC' },
    { key: 'orders', label: 'Orders' },
  ];

  return (
    <main style={page} data-interactive={ready ? 'true' : 'false'}>
      <p style={muted}>
        <a href="/experiments">← All experiments</a>
      </p>
      <h1 style={heading} data-testid="experiment-name">
        {experiment.name}
      </h1>
      <p style={muted}>
        <span
          data-testid="experiment-status"
          style={{ color: STATUS_TEXT_COLOR[experiment.status], fontWeight: 600 }}
        >
          {STATUS_LABELS[experiment.status]}
        </span>{' '}
        · {TYPE_LABELS[experiment.type]} · focus: {METRIC_LABELS[experiment.metricFocus]} ·{' '}
        {day(experiment.startAt)} → {experiment.endAt ? day(experiment.endAt) : 'running'}
      </p>

      {experiment.hypothesis && (
        <p style={{ fontSize: '0.9rem' }}>
          <strong>Hypothesis:</strong> {experiment.hypothesis}
        </p>
      )}
      {experiment.resultNote && (
        <p style={{ fontSize: '0.9rem' }} data-testid="experiment-result">
          <strong>Result:</strong> {experiment.resultNote}
        </p>
      )}

      {message && (
        <p role="status" style={banner(message === 'Saved' ? 'good' : pending ? 'warn' : 'bad')}>
          {message}
        </p>
      )}

      {canManage && nextStatuses.length > 0 && (
        <section
          data-testid="status-controls"
          style={{ ...cardStyle, display: 'grid', gap: '0.625rem' }}
        >
          <strong style={{ fontSize: '0.9rem' }}>Move this experiment</strong>
          {(experiment.status === 'running' || nextStatuses.includes('ended')) && (
            <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.8125rem' }}>
              Result note (stored when you end or analyze it)
              <input
                value={resultNote}
                data-testid="result-note"
                onChange={(event) => setResultNote(event.target.value)}
                style={inputStyle}
              />
            </label>
          )}
          <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.8125rem' }}>
            Transition note (optional)
            <input
              value={note}
              data-testid="transition-note"
              onChange={(event) => setNote(event.target.value)}
              style={inputStyle}
            />
          </label>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {nextStatuses.map((status) => (
              <button
                key={status}
                type="button"
                disabled={pending}
                data-testid={`transition-${status}`}
                className="wa-btn wa-btn--sm"
                onClick={() => transition(status)}
              >
                {STATUS_LABELS[status]}
              </button>
            ))}
          </div>
        </section>
      )}

      <section style={{ ...cardStyle, marginTop: '1rem' }}>
        <TrendChart
          title="Account spend, with the test window shaded"
          ariaLabel="Daily account spend with the experiment window shaded"
          scale="money"
          currencyCode={currencyCode}
          windows={chartWindows}
          caption="The shaded band is this experiment's window. Scoped spend, when shown, is the summed spend of the entities under test."
          series={chart.series}
        />
      </section>

      <section style={{ ...cardStyle, marginTop: '1rem' }} data-testid="comparison">
        <h2 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>Before / during / after</h2>
        <p style={{ ...muted, marginTop: 0 }} data-testid="comparison-caveat">
          This is a rough measurement, <strong>not a randomized test</strong>: the account was not
          split into a treated and an untreated half. Windows are of equal length; ratios are
          recomputed from summed spend and sales. The account column is the whole profile over the
          same window, as a loose control for seasonality.
        </p>
        {!comparison.hasScopedFacts && (
          <p style={muted} data-testid="comparison-no-scope">
            This experiment names no campaign or keyword we hold ad-facts for, so only the
            account-level control is shown. A price or listing test moves ad-facts only indirectly.
          </p>
        )}
        <div className="wa-tablewrap">
          <table className="wa-table wa-table--numeric" data-testid="comparison-table">
            <thead>
              <tr>
                <th scope="col">Metric</th>
                {comparison.windows.map((window) => (
                  <th
                    key={`${window.label}-scoped`}
                    scope="col"
                    data-numeric="true"
                    data-testid={`col-scoped-${window.label}`}
                  >
                    {window.label} · scoped
                  </th>
                ))}
                {comparison.windows.map((window) => (
                  <th key={`${window.label}-acct`} scope="col" data-numeric="true">
                    {window.label} · account
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td>{row.label}</td>
                  {comparison.windows.map((window) => (
                    <td
                      key={`${window.label}-scoped-${row.key}`}
                      data-numeric="true"
                      data-testid={`cell-scoped-${window.label}-${row.key}`}
                    >
                      {formatMetric(window.scoped, row.key)}
                    </td>
                  ))}
                  {comparison.windows.map((window) => (
                    <td key={`${window.label}-acct-${row.key}`} data-numeric="true">
                      {formatMetric(window.profile, row.key)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ ...muted, marginBottom: 0 }}>
          Windows: {comparison.windows.map((window) => `${window.label} ${window.start}→${window.end}`).join(' · ')}
          {' · '}
          {comparison.windowDays} day(s) each.
          {!comparison.windows.some((window) => window.label === 'after') && (
            <span data-testid="no-after"> No “after” window yet — end the experiment to measure one.</span>
          )}
        </p>
      </section>

      <section style={{ ...cardStyle, marginTop: '1rem' }} data-testid="entity-changes">
        <h2 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>What changed during the window</h2>
        {changes.length === 0 ? (
          <p style={muted} data-testid="entity-changes-empty">
            No tracked entity changes fell inside this window. That is a statement about what the
            sync observed, not proof nothing was touched off-platform.
          </p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.875rem' }}>
            {changes.map((change) => (
              <li key={change.id} data-testid="entity-change">
                <code>{change.amazonId}</code>
                {change.entityName ? ` (${change.entityName})` : ''} · {change.field}:{' '}
                {JSON.stringify(change.oldValue)} → {JSON.stringify(change.newValue)} ·{' '}
                <span style={muted}>
                  {change.source} · {day(change.observedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ScopeLinks scope={experiment.scope} profileId={experiment.profileId} />

      <section style={{ ...cardStyle, marginTop: '1rem' }} data-testid="timeline">
        <h2 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>Timeline</h2>
        <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.875rem' }}>
          {events.map((event) => (
            <li key={event.id} data-testid="timeline-event">
              {event.fromStatus ? `${STATUS_LABELS[event.fromStatus]} → ` : 'Created as '}
              <strong>{STATUS_LABELS[event.toStatus]}</strong>
              {event.note ? ` — ${event.note}` : ''} <span style={muted}>· {day(event.createdAt)}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function ScopeLinks({ scope, profileId }: { scope: ExperimentScope; profileId: string }) {
  const links: { label: string; href: string }[] = [];
  if (scope.campaignIds?.length) {
    links.push({ label: `${scope.campaignIds.length} campaign(s) in the grid`, href: `/grid?profile=${profileId}&entity=campaign` });
  }
  if (scope.targetIds?.length) {
    links.push({ label: `${scope.targetIds.length} keyword/target(s) in the grid`, href: `/grid?profile=${profileId}&entity=keyword` });
  }
  if (links.length === 0) return null;
  return (
    <section style={{ ...cardStyle, marginTop: '1rem' }} data-testid="scope-links">
      <h2 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>Scoped entities</h2>
      <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.875rem' }}>
        {links.map((link) => (
          <li key={link.href}>
            <a href={link.href}>{link.label} →</a>
          </li>
        ))}
      </ul>
    </section>
  );
}

const cardStyle = {
  background: colors.surface,
  border: `1px solid ${colors.border}`,
  borderRadius: '0.5rem',
  padding: '0.875rem 1rem',
} as const;

const inputStyle = {
  border: `1px solid ${colors.border}`,
  borderRadius: '0.25rem',
  fontSize: '0.8125rem',
  padding: '0.3rem 0.4rem',
  width: '100%',
} as const;
