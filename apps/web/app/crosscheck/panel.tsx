/**
 * The crosscheck panel and its chip.
 *
 * Presentational and pure: it takes the view model and renders it, so the
 * dashboard owner can drop `<CrosscheckChip>` into the header and
 * `<CrosscheckPanel>` onto a page without inheriting a data dependency. Every
 * decision about what a verdict *means* was made in the view model; this file
 * only decides what it looks like.
 */
import type { CSSProperties, ReactNode } from 'react';
import { verdictLabel, verdictTone } from '@wizard-ads/crosscheck-cli/pure';
import type {
  ChipTone,
  CrosscheckPanelModel,
  PanelCampaign,
  PanelDay,
  PanelFigure,
  VerdictChip,
} from '@wizard-ads/crosscheck-cli/pure';

const TONE_COLORS: Record<ChipTone, { background: string; border: string; text: string }> = {
  good: { background: '#ecfdf5', border: '#a7f3d0', text: '#065f46' },
  warn: { background: '#fffbeb', border: '#fde68a', text: '#92400e' },
  bad: { background: '#fef2f2', border: '#fecaca', text: '#991b1b' },
  muted: { background: '#f9fafb', border: '#e5e7eb', text: '#4b5563' },
};

export function CrosscheckChip({ chip }: { chip: VerdictChip }): ReactNode {
  const tone = TONE_COLORS[chip.tone];
  return (
    <span
      style={{
        background: tone.background,
        border: `1px solid ${tone.border}`,
        borderRadius: '999px',
        color: tone.text,
        display: 'inline-block',
        fontSize: '0.8125rem',
        padding: '0.1875rem 0.625rem',
      }}
      title={
        chip.asOf === null
          ? 'No day has been cross-checked yet'
          : `As of ${chip.asOf} · ${chip.verifiedStreak} consecutive verified day(s)`
      }
    >
      {chip.label}
      {chip.asOf === null ? '' : ` · ${chip.asOf}`}
    </span>
  );
}

export function CrosscheckPanel({ model }: { model: CrosscheckPanelModel }): ReactNode {
  return (
    <section>
      <div style={{ alignItems: 'center', display: 'flex', gap: '0.75rem', margin: '1rem 0' }}>
        <CrosscheckChip chip={model.chip} />
        <span style={muted}>
          {model.chip.verifiedStreak} consecutive verified day(s) · tolerance ±
          {(model.tolerance * 100).toFixed(0)}% · {model.campaignsCompared} campaign-week(s) compared
        </span>
      </div>

      <h2 style={subheading}>Profile-day verdicts</h2>
      <table style={table}>
        <thead>
          <tr>
            <th style={th}>Day</th>
            <th style={th}>Verdict</th>
            <th style={thRight}>Spend ours</th>
            <th style={thRight}>Spend theirs</th>
            <th style={thRight}>Δ</th>
            <th style={thRight}>Sales ours</th>
            <th style={thRight}>Sales theirs</th>
            <th style={thRight}>Δ</th>
          </tr>
        </thead>
        <tbody>
          {model.days.map((day) => (
            <DayRow key={day.date} day={day} />
          ))}
        </tbody>
      </table>

      <h2 style={subheading}>Campaign-weeks that disagree</h2>
      {model.mismatchingCampaigns.length === 0 ? (
        <p style={muted}>
          Every compared campaign agreed within tolerance. Campaigns neither side reported spend or
          sales for are not compared.
        </p>
      ) : (
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>Week</th>
              <th style={th}>Campaign</th>
              <th style={th}>Verdict</th>
              <th style={thRight}>Spend ours</th>
              <th style={thRight}>Spend theirs</th>
              <th style={thRight}>Δ</th>
            </tr>
          </thead>
          <tbody>
            {model.mismatchingCampaigns.map((campaign) => (
              <CampaignRow key={`${campaign.weekStart}-${campaign.campaignId}`} campaign={campaign} />
            ))}
          </tbody>
        </table>
      )}

      {model.sources.length > 0 ? (
        <p style={muted}>
          From {model.sources.join(', ')}. The export is the evidence for the verdict and is kept.
        </p>
      ) : null}
    </section>
  );
}

function DayRow({ day }: { day: PanelDay }): ReactNode {
  const spend = figure(day.figures, 'ad_spend');
  const sales = figure(day.figures, 'ad_sales');
  return (
    <tr style={day.verdict === 'skipped_provisional' ? { opacity: 0.6 } : undefined}>
      <td style={td}>{day.date}</td>
      <td style={td}>
        <VerdictText verdict={day.verdict} />
      </td>
      <td style={tdRight}>{money(spend?.ours)}</td>
      <td style={tdRight}>{money(spend?.theirs)}</td>
      <td style={tdRight}>{percent(spend?.deltaPct)}</td>
      <td style={tdRight}>{money(sales?.ours)}</td>
      <td style={tdRight}>{money(sales?.theirs)}</td>
      <td style={tdRight}>{percent(sales?.deltaPct)}</td>
    </tr>
  );
}

function CampaignRow({ campaign }: { campaign: PanelCampaign }): ReactNode {
  const spend = figure(campaign.figures, 'ad_spend');
  return (
    <tr>
      <td style={td}>{campaign.weekStart}</td>
      <td style={td}>
        {campaign.campaignName ?? campaign.campaignId}
        <div style={muted}>{campaign.campaignId}</div>
      </td>
      <td style={td}>
        <VerdictText verdict={campaign.verdict} />
      </td>
      <td style={tdRight}>{money(spend?.ours)}</td>
      <td style={tdRight}>{money(spend?.theirs)}</td>
      <td style={tdRight}>{percent(spend?.deltaPct)}</td>
    </tr>
  );
}

function VerdictText({ verdict }: { verdict: PanelDay['verdict'] }): ReactNode {
  return <span style={{ color: TONE_COLORS[verdictTone(verdict)].text }}>{verdictLabel(verdict)}</span>;
}

function figure(figures: readonly PanelFigure[], metric: PanelFigure['metric']): PanelFigure | undefined {
  return figures.find((candidate) => candidate.metric === metric);
}

function money(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toFixed(2);
}

function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
}

const muted: CSSProperties = { color: '#6b7280', fontSize: '0.8125rem' };
const subheading: CSSProperties = { fontSize: '1rem', margin: '1.5rem 0 0.5rem' };
const table: CSSProperties = {
  borderCollapse: 'collapse',
  fontSize: '0.875rem',
  width: '100%',
};
const th: CSSProperties = {
  borderBottom: '1px solid #e5e7eb',
  padding: '0.375rem 0.5rem',
  textAlign: 'left',
};
const thRight: CSSProperties = { ...th, textAlign: 'right' };
const td: CSSProperties = { borderBottom: '1px solid #f3f4f6', padding: '0.375rem 0.5rem' };
const tdRight: CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
