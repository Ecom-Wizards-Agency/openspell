/**
 * Flags, active and suppressed, in two separate lists.
 *
 * The suppressed list is the point of this component. A wide ACOS swing on a
 * Rank/SKW campaign is a last-click attribution artifact, not an anomaly, so the
 * engine returns it separately -- and the UI has to *show* it, headed "noted,
 * not flagged", with the reason attached. Two failure modes are being avoided at
 * once: raising it as an alert (which trains operators to ignore alerts) and
 * dropping it silently (which makes the tool look like it missed something an
 * operator can plainly see in the numbers).
 *
 * Severity ordering is the engine's; this component never re-ranks.
 */
import type { CSSProperties, ReactNode } from 'react';
import { toneStyle, tokens } from '../theme.js';
import type { Tone } from '../theme.js';

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

const SEVERITY_TONE: Record<FlagSeverity, Tone> = {
  critical: 'bad',
  alert: 'bad',
  warn: 'warn',
  info: 'muted',
};

export function FlagsPanel({
  active,
  suppressed,
}: {
  active: readonly FlagView[];
  suppressed: readonly FlagView[];
}): ReactNode {
  return (
    <section style={card} aria-label="Flags">
      <h3 style={heading}>
        Flags{' '}
        <span style={{ color: tokens.color.textMuted, fontWeight: 400 }}>
          {active.length} active · {suppressed.length} noted
        </span>
      </h3>

      {active.length === 0 ? (
        <p style={muted}>Nothing crossed a threshold on this profile for the selected day.</p>
      ) : (
        <ul style={list}>
          {active.map((flag, index) => (
            <FlagItem key={`${flag.scope}-${flag.metric}-${index}`} flag={flag} />
          ))}
        </ul>
      )}

      {suppressed.length === 0 ? null : (
        <>
          <h4 style={subheading}>Noted, not flagged</h4>
          <p style={muted}>
            These crossed a threshold and were deliberately not raised. They are shown so nobody has
            to wonder whether the tool saw them.
          </p>
          <ul style={list}>
            {suppressed.map((flag, index) => (
              <FlagItem key={`s-${flag.scope}-${flag.metric}-${index}`} flag={flag} dim />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function FlagItem({ flag, dim = false }: { flag: FlagView; dim?: boolean }): ReactNode {
  const tone = toneStyle[dim ? 'muted' : SEVERITY_TONE[flag.severity]];
  return (
    <li style={{ ...item, opacity: dim ? 0.85 : 1 }}>
      <span
        style={{
          background: tone.background,
          border: `1px solid ${tone.border}`,
          borderRadius: tokens.radius.sm,
          color: tone.color,
          fontSize: '0.6875rem',
          letterSpacing: '0.04em',
          padding: '0.0625rem 0.375rem',
          textTransform: 'uppercase',
        }}
      >
        {flag.severity}
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.125rem' }}>
        <div>
          <strong>{flag.scope}</strong> · {flag.message}
        </div>
        <div style={muted}>{flag.likelyCause}</div>
        <div style={{ ...muted, color: tokens.color.textFaint }}>
          {flag.metric} · {flag.threshold}
          {flag.suppressedReason === null ? '' : ` · ${flag.suppressedReason}`}
        </div>
      </div>
    </li>
  );
}

const card: CSSProperties = {
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  display: 'flex',
  flexDirection: 'column',
  fontFamily: tokens.font.sans,
  fontSize: tokens.font.size.sm,
  gap: tokens.space(2),
  padding: tokens.space(3),
};

const heading: CSSProperties = { fontSize: tokens.font.size.lg, margin: 0 };
const subheading: CSSProperties = { fontSize: tokens.font.size.base, margin: `${tokens.space(2)} 0 0` };
const muted: CSSProperties = { color: tokens.color.textMuted, fontSize: tokens.font.size.xs, margin: 0 };
const list: CSSProperties = { display: 'flex', flexDirection: 'column', gap: tokens.space(2), listStyle: 'none', margin: 0, padding: 0 };
const item: CSSProperties = { display: 'flex', gap: tokens.space(2), alignItems: 'flex-start' };
