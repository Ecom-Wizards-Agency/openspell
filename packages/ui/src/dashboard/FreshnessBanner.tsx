/**
 * The freshness banner. Renders an assessment; computes nothing.
 *
 * Deliberately a banner and not a chip: staleness changes how every number on
 * the page should be read, so it sits above them at full width rather than
 * tucked into a corner. The crosscheck verdict, which answers a different
 * question, sits beside it as a chip.
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

  return (
    <section
      aria-label="Data freshness"
      style={{
        background: tone.background,
        border: `1px solid ${tone.border}`,
        borderRadius: tokens.radius.md,
        color: tone.color,
        fontFamily: tokens.font.sans,
        fontSize: tokens.font.size.sm,
        padding: `${tokens.space(2)} ${tokens.space(3)}`,
      }}
    >
      <details>
        <summary style={summary}>
          <strong>Data</strong>
          <span>{assessment.headline}</span>
          <div style={{ flex: 1 }} />
          {children}
          <span style={{ fontSize: tokens.font.size.xs, textDecoration: 'underline' }}>
            Report ledger
          </span>
        </summary>
        <ul style={list}>
          {assessment.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
          <li style={{ color: tokens.color.textMuted }}>
            Read from <code>report_requests</code>. Fact rows are never used to infer freshness:
            Amazon omits zero-impression rows, so an empty day and a missing sync look identical in
            the facts.
          </li>
        </ul>
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
};

const list: CSSProperties = {
  fontSize: tokens.font.size.xs,
  margin: `${tokens.space(2)} 0 0`,
  paddingLeft: tokens.space(4),
};
