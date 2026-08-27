/**
 * Design tokens.
 *
 * Inline styles rather than a CSS pipeline, matching what already ships in
 * `apps/web` (the crosscheck panel): every component here is drop-in and cannot
 * collide with a stylesheet somebody adds later. Tokens live in one object so
 * the eventual move to CSS variables is a find-and-replace rather than an
 * archaeology exercise.
 *
 * Colours are the neutral-plus-semantic set the crosscheck chip already uses,
 * so a verdict chip on the dashboard and a verdict cell in the grid are the
 * same green.
 */
export const tokens = {
  font: {
    sans: 'var(--wa-font, Inter, sans-serif)',
    mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    size: { eyebrow: '0.6875rem', xs: '0.75rem', sm: '0.8125rem', base: '0.875rem', lg: '1rem', xl: '1.5rem', kpi: '1.75rem' },
  },
  /*
   * Custom properties with the original literal as the fallback.
   *
   * These are written into `style` attributes, and a host that themes itself
   * cannot reach them there: the browser re-serialises an inline hex color to
   * an `rgb()` value through the CSSOM, so the attribute-substring bridge
   * `apps/web` used to retheme this palette never matched a single element. The
   * grid rendered the host's light-on-dark text over this package's white rows.
   *
   * A `var()` inverts that: the host supplies the value when it defines one, and
   * the fallback keeps this package standalone — Storybook, a test renderer, or
   * any consumer without the wizard-ads stylesheet still gets the light palette
   * these literals always were. Light mode resolves to identical values.
   */
  color: {
    text: 'var(--wa-text, #11151C)',
    textMuted: 'var(--wa-text-muted, #5B6573)',
    textFaint: 'var(--wa-text-faint, #5B6573)',
    border: 'var(--wa-border, #DADCE0)',
    borderStrong: 'var(--wa-border-strong, #C6C8CD)',
    surface: 'var(--wa-surface, #F5F6F8)',
    surfaceAlt: 'var(--wa-surface-2, #FFFFFF)',
    surfaceHover: 'var(--wa-surface-3, #E5E7EA)',
    accent: 'var(--wa-accent, #FD4807)',
    accentGradient: 'var(--wa-accent-grad, linear-gradient(#FF8A2B, #E2120A))',
    accentSoft: 'var(--wa-accent-soft, rgba(253, 72, 7, 0.12))',
    indigo: 'var(--wa-indigo, #3322E0)',
    indigoSoft: 'var(--wa-indigo-soft, rgba(51, 34, 224, 0.12))',
    onAccent: 'var(--wa-on-accent, #11151C)',
    good: 'var(--wa-good-text, #1B7F44)',
    goodSoft: 'var(--wa-good-bg, #DCEFE4)',
    goodBorder: 'var(--wa-good-border, #86CFA1)',
    warn: 'var(--wa-warn-text, #C23B0C)',
    warnSoft: 'var(--wa-warn-bg, #FBE8E1)',
    warnBorder: 'var(--wa-warn-border, #E7A084)',
    bad: 'var(--wa-bad-text, #C33B3C)',
    badSoft: 'var(--wa-bad-bg, #F8E4E5)',
    badBorder: 'var(--wa-bad-border, #E89A9A)',
  },
  radius: { sm: '0.25rem', md: '0.375rem', pill: '999px' },
  space: (n: number) => `${n * 0.25}rem`,
} as const;

export type Tone = 'good' | 'warn' | 'bad' | 'muted' | 'neutral';

export const toneStyle: Record<Tone, { background: string; border: string; color: string }> = {
  good: { background: tokens.color.goodSoft, border: tokens.color.goodBorder, color: tokens.color.good },
  warn: { background: tokens.color.warnSoft, border: tokens.color.warnBorder, color: tokens.color.warn },
  bad: { background: tokens.color.badSoft, border: tokens.color.badBorder, color: tokens.color.bad },
  muted: { background: tokens.color.surfaceAlt, border: tokens.color.border, color: tokens.color.textMuted },
  neutral: { background: tokens.color.indigoSoft, border: 'var(--wa-info-border, #938BEF)', color: tokens.color.indigo },
};

/**
 * Delta colouring, driven by the metric's `better` direction rather than the
 * sign. ACOS down is green; spend down is neither, so it stays neutral. Sign
 * alone would paint a 40% spend cut as a triumph on a rank push.
 */
export function deltaColor(value: number | null, better: 'higher' | 'lower' | null): string {
  if (value === null || value === 0 || better === null) return tokens.color.textMuted;
  const good = better === 'higher' ? value > 0 : value < 0;
  return good ? tokens.color.good : tokens.color.bad;
}
