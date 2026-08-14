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
  color: {
    text: '#111827',
    textMuted: '#6b7280',
    textFaint: '#9ca3af',
    border: '#e5e7eb',
    borderStrong: '#d1d5db',
    surface: '#ffffff',
    surfaceAlt: '#f9fafb',
    surfaceHover: '#f3f4f6',
    accent: '#1d4ed8',
    accentSoft: '#eff6ff',
    good: '#065f46',
    goodSoft: '#ecfdf5',
    goodBorder: '#a7f3d0',
    warn: '#92400e',
    warnSoft: '#fffbeb',
    warnBorder: '#fde68a',
    bad: '#991b1b',
    badSoft: '#fef2f2',
    badBorder: '#fecaca',
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
  neutral: { background: tokens.color.accentSoft, border: '#bfdbfe', color: tokens.color.accent },
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
