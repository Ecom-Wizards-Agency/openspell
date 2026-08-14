/**
 * The design tokens, as inline-style values.
 *
 * Every value here is a `var(--wa-*)` reference into `theme.css`. That single
 * change is what gives the whole application a dark mode: the screens that were
 * written against these tokens did not have to be rewritten to get one, because
 * a token that resolves at paint time follows the theme by construction.
 *
 * The export surface is deliberately unchanged from the WP-04 version — same
 * names, same shapes — so this landed as a re-pointing rather than a rewrite of
 * ten screens. New work should prefer the class-based primitives in
 * `primitives.tsx`; these remain for the table/banner/field styles that predate
 * them and are still perfectly legible.
 */
import type { CSSProperties } from 'react';

export const colors = {
  text: 'var(--wa-text)',
  muted: 'var(--wa-text-muted)',
  faint: 'var(--wa-text-faint)',
  border: 'var(--wa-border)',
  borderStrong: 'var(--wa-border-strong)',
  surface: 'var(--wa-surface)',
  subtle: 'var(--wa-surface-2)',
  hover: 'var(--wa-surface-3)',
  accent: 'var(--wa-accent)',
  accentText: 'var(--wa-accent-text)',
  accentBg: 'var(--wa-accent-soft)',
  accentBorder: 'var(--wa-accent-border)',
  good: 'var(--wa-good-text)',
  goodBg: 'var(--wa-good-bg)',
  goodBorder: 'var(--wa-good-border)',
  warn: 'var(--wa-warn-text)',
  warnBg: 'var(--wa-warn-bg)',
  warnBorder: 'var(--wa-warn-border)',
  bad: 'var(--wa-bad-text)',
  badBg: 'var(--wa-bad-bg)',
  badBorder: 'var(--wa-bad-border)',
} as const;

export const font = {
  sans: 'var(--wa-font)',
  mono: 'var(--wa-font-mono)',
  size: {
    xs2: 'var(--wa-fs-2xs)',
    xs: 'var(--wa-fs-xs)',
    sm: 'var(--wa-fs-sm)',
    base: 'var(--wa-fs-base)',
    md: 'var(--wa-fs-md)',
    lg: 'var(--wa-fs-lg)',
    xl: 'var(--wa-fs-xl)',
    xl2: 'var(--wa-fs-2xl)',
  },
} as const;

export const radius = {
  sm: 'var(--wa-radius-sm)',
  md: 'var(--wa-radius)',
  lg: 'var(--wa-radius-lg)',
  pill: 'var(--wa-radius-pill)',
} as const;

export const shadow = {
  low: 'var(--wa-shadow-1)',
  mid: 'var(--wa-shadow-2)',
  high: 'var(--wa-shadow-3)',
} as const;

/** `space(3)` is `0.75rem`. Kept numeric so it composes into calc-free styles. */
export const space = (n: number): string => `${n * 0.25}rem`;

/**
 * The page block.
 *
 * The frame (`app-shell.tsx`) owns the outer padding now, so this only carries
 * the measure. A screen that needs a wider one overrides `maxWidth`; the grid
 * and the review table both do.
 */
export const page: CSSProperties = {
  margin: '0 auto',
  maxWidth: '84rem',
  width: '100%',
};

export const heading: CSSProperties = {
  fontSize: font.size.xl,
  fontWeight: 640,
  letterSpacing: '-0.02em',
  margin: '0 0 0.375rem',
};

export const subheading: CSSProperties = {
  fontSize: font.size.md,
  fontWeight: 620,
  margin: '1.75rem 0 0.625rem',
};

export const muted: CSSProperties = { color: colors.muted, fontSize: font.size.base };

export const table: CSSProperties = {
  borderCollapse: 'separate',
  borderSpacing: 0,
  fontSize: font.size.sm,
  width: '100%',
};

export const th: CSSProperties = {
  background: colors.subtle,
  borderBottom: `1px solid ${colors.border}`,
  color: colors.muted,
  fontSize: font.size.xs,
  fontWeight: 650,
  letterSpacing: '0.03em',
  padding: '0.5rem 0.75rem',
  textAlign: 'left',
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
};

export const td: CSSProperties = {
  borderBottom: `1px solid ${colors.border}`,
  padding: '0.5rem 0.75rem',
  verticalAlign: 'middle',
};

export const input: CSSProperties = {
  background: colors.surface,
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: radius.sm,
  color: colors.text,
  fontSize: font.size.sm,
  padding: '0.3125rem 0.5rem',
  width: '6rem',
};

export const button: CSSProperties = {
  alignItems: 'center',
  background: colors.surface,
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: radius.md,
  color: colors.text,
  cursor: 'pointer',
  display: 'inline-flex',
  fontSize: font.size.sm,
  fontWeight: 500,
  gap: '0.375rem',
  justifyContent: 'center',
  padding: '0.3125rem 0.75rem',
};

export type Tone = 'good' | 'warn' | 'bad' | 'info';

export const banner = (tone: Tone): CSSProperties => ({
  background: `var(--wa-${tone}-bg)`,
  border: `1px solid var(--wa-${tone}-border)`,
  borderRadius: radius.md,
  color: `var(--wa-${tone}-text)`,
  fontSize: font.size.base,
  margin: '1rem 0',
  padding: '0.6875rem 0.875rem',
});

/** A surface a card-shaped thing sits on. */
export const card: CSSProperties = {
  background: colors.surface,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.lg,
  boxShadow: shadow.low,
};
