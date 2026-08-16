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
    sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    size: { xs: '0.75rem', sm: '0.8125rem', base: '0.875rem', lg: '1rem', xl: '1.5rem' },
  },
  /*
   * Custom properties with the original literal as the fallback.
   *
   * These are written into `style` attributes, and a host that themes itself
   * cannot reach them there: the browser re-serialises an inline `#ffffff` to
   * `rgb(255, 255, 255)` through the CSSOM, so the attribute-substring bridge
   * `apps/web` used to retheme this palette never matched a single element. The
   * grid rendered the host's light-on-dark text over this package's white rows.
   *
   * A `var()` inverts that: the host supplies the value when it defines one, and
   * the fallback keeps this package standalone — Storybook, a test renderer, or
   * any consumer without the wizard-ads stylesheet still gets the light palette
   * these literals always were. Light mode resolves to identical values.
   */
  color: {
    text: 'var(--wa-text, #111827)',
    textMuted: 'var(--wa-text-muted, #6b7280)',
    textFaint: 'var(--wa-text-faint, #9ca3af)',
    border: 'var(--wa-border, #e5e7eb)',
    borderStrong: 'var(--wa-border-strong, #d1d5db)',
    surface: 'var(--wa-surface, #ffffff)',
    surfaceAlt: 'var(--wa-surface-2, #f9fafb)',
    surfaceHover: 'var(--wa-surface-3, #f3f4f6)',
    accent: 'var(--wa-accent, #1d4ed8)',
    accentSoft: 'var(--wa-accent-soft, #eff6ff)',
    good: 'var(--wa-good-text, #065f46)',
    goodSoft: 'var(--wa-good-bg, #ecfdf5)',
    goodBorder: 'var(--wa-good-border, #a7f3d0)',
    warn: 'var(--wa-warn-text, #92400e)',
    warnSoft: 'var(--wa-warn-bg, #fffbeb)',
    warnBorder: 'var(--wa-warn-border, #fde68a)',
    bad: 'var(--wa-bad-text, #991b1b)',
    badSoft: 'var(--wa-bad-bg, #fef2f2)',
    badBorder: 'var(--wa-bad-border, #fecaca)',
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
  neutral: { background: tokens.color.accentSoft, border: 'var(--wa-accent-border, #bfdbfe)', color: tokens.color.accent },
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
