/**
 * Inline style tokens for the WP-04 screens.
 *
 * WP-06 owns look and feel and `packages/ui`; these routes ship before it does
 * and still have to be legible. Inline styles rather than a stylesheet, and a
 * handful of tokens rather than a system, so that replacing them later is a
 * deletion and not an untangling. The same choice `/crosscheck` already made.
 */
import type { CSSProperties } from 'react';

export const colors = {
  text: '#111827',
  muted: '#6b7280',
  border: '#e5e7eb',
  surface: '#ffffff',
  subtle: '#f9fafb',
  good: '#065f46',
  goodBg: '#ecfdf5',
  goodBorder: '#a7f3d0',
  warn: '#92400e',
  warnBg: '#fffbeb',
  warnBorder: '#fde68a',
  bad: '#991b1b',
  badBg: '#fef2f2',
  badBorder: '#fecaca',
} as const;

export const page: CSSProperties = {
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  color: colors.text,
  margin: '0 auto',
  maxWidth: '78rem',
  padding: '2rem 1.5rem',
};

export const heading: CSSProperties = { fontSize: '1.5rem', margin: '0 0 0.5rem' };
export const subheading: CSSProperties = { fontSize: '1.05rem', margin: '1.5rem 0 0.5rem' };
export const muted: CSSProperties = { color: colors.muted, fontSize: '0.875rem' };

export const table: CSSProperties = {
  borderCollapse: 'collapse',
  fontSize: '0.8125rem',
  width: '100%',
};

export const th: CSSProperties = {
  borderBottom: `1px solid ${colors.border}`,
  color: colors.muted,
  fontWeight: 600,
  padding: '0.375rem 0.5rem',
  textAlign: 'left',
  whiteSpace: 'nowrap',
};

export const td: CSSProperties = {
  borderBottom: `1px solid ${colors.border}`,
  padding: '0.375rem 0.5rem',
  verticalAlign: 'middle',
};

export const input: CSSProperties = {
  border: `1px solid ${colors.border}`,
  borderRadius: '0.25rem',
  fontSize: '0.8125rem',
  padding: '0.25rem 0.375rem',
  width: '6rem',
};

export const button: CSSProperties = {
  background: colors.subtle,
  border: `1px solid ${colors.border}`,
  borderRadius: '0.25rem',
  cursor: 'pointer',
  fontSize: '0.8125rem',
  padding: '0.3125rem 0.75rem',
};

export const banner = (tone: 'good' | 'warn' | 'bad'): CSSProperties => ({
  background: tone === 'good' ? colors.goodBg : tone === 'warn' ? colors.warnBg : colors.badBg,
  border: `1px solid ${
    tone === 'good' ? colors.goodBorder : tone === 'warn' ? colors.warnBorder : colors.badBorder
  }`,
  borderRadius: '0.375rem',
  color: tone === 'good' ? colors.good : tone === 'warn' ? colors.warn : colors.bad,
  fontSize: '0.875rem',
  margin: '1rem 0',
  padding: '0.75rem 1rem',
});
