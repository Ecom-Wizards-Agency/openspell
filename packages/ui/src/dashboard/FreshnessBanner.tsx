/**
 * The freshness banner. Renders an assessment; computes nothing.
 *
 * Current data is routine context, so its surface stays neutral and compact.
 * Warning and failure states still carry the semantic tone because staleness
 * changes how every number on the page should be read.
 *
 * The report ledger expands through `<details>` rather than React state, which
 * keeps this a server component -- no `"use client"`, no hydration, no
 * JavaScript needed for the disclosure to work. The one interaction it has is
 * one the platform already implements.
 */
import type { CSSProperties, ReactNode } from 'react';
import type { FreshnessAssessment } from './freshness.js';
import { toneStyle, tokens } from '../theme.js';

export function FreshnessBanner({
  assessment,
  children,
}: {
  assessment: FreshnessAssessment;
  /** Slot for the crosscheck chip: same row, different question. */
  children?: ReactNode;
}): ReactNode {
  const tone = toneStyle[assessment.tone];
  const status = freshnessStatus(assessment.tone);
  const headline = assessment.tone === 'good' && assessment.coversThrough !== null
    ? `Through ${formatCoverageDate(assessment.coversThrough)}`
    : assessment.headline;
  const needsAttention = assessment.tone === 'warn' || assessment.tone === 'bad';

  return (
    <section
      aria-label="Data freshness"
      style={{
        background: needsAttention ? tone.background : tokens.color.surface,
        border: `1px solid ${needsAttention ? tone.border : tokens.color.border}`,
        borderRadius: tokens.radius.md,
        color: tokens.color.text,
        fontFamily: tokens.font.sans,
        fontSize: tokens.font.size.sm,
        padding: 0,
      }}
    >
      <details>
        <summary style={summary}>
          <span aria-hidden="true" style={{ ...dot, background: tone.color }} />
          <strong>{status}</strong>
          <span style={{ color: tokens.color.textMuted }}>{headline}</span>
          <div style={{ flex: 1 }} />
          {children}
          <span style={action}>
            <span
              aria-label="Freshness is based on completed Amazon report loads, not fact-row timestamps."
              role="img"
              style={info}
              title="Freshness is based on completed Amazon report loads, not fact-row timestamps."
            >
              i
            </span>
            Sync details
          </span>
        </summary>
        <div style={panel}>
          <ul style={list}>
            {assessment.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
          <p style={note}>
            Based on the report ledger. Fact rows cannot prove freshness because Amazon may omit
            rows with no impressions.
          </p>
        </div>
      </details>
    </section>
  );
}

const summary: CSSProperties = {
  alignItems: 'center',
  cursor: 'pointer',
  display: 'flex',
  flexWrap: 'wrap',
  gap: tokens.space(2),
  listStyle: 'none',
  padding: `${tokens.space(2)} ${tokens.space(3)}`,
};

const list: CSSProperties = {
  fontSize: tokens.font.size.xs,
  margin: 0,
  paddingLeft: tokens.space(4),
};

const dot: CSSProperties = {
  borderRadius: '999px',
  height: '0.5rem',
  width: '0.5rem',
};

const action: CSSProperties = {
  alignItems: 'center',
  color: tokens.color.textMuted,
  display: 'inline-flex',
  fontSize: tokens.font.size.xs,
  fontWeight: 600,
  gap: tokens.space(1),
};

const info: CSSProperties = {
  alignItems: 'center',
  border: `1px solid ${tokens.color.border}`,
  borderRadius: '999px',
  display: 'inline-flex',
  fontSize: '0.625rem',
  fontStyle: 'normal',
  height: '1rem',
  justifyContent: 'center',
  width: '1rem',
};

const panel: CSSProperties = {
  background: tokens.color.surfaceAlt,
  borderTop: `1px solid ${tokens.color.border}`,
  color: tokens.color.textMuted,
  padding: `${tokens.space(2)} ${tokens.space(3)}`,
};

const note: CSSProperties = {
  fontSize: tokens.font.size.xs,
  margin: `${tokens.space(2)} 0 0`,
};

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
