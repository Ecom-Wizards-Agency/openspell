'use client';

/**
 * What a visitor sees when a server component throws.
 *
 * Without this file Next renders its own unstyled fallback, which in production
 * says nothing at all — the operator learns that something broke and cannot say
 * what, and support gets a screenshot with no handle in it. The digest is that
 * handle: Next logs the real stack server-side under the same id, so quoting it
 * turns "the dashboard is broken" into one grep.
 *
 * Terse on purpose, and it never guesses. It does not blame the network, does
 * not suggest signing in again, and does not retry by itself: a page that
 * cheerfully reloads a failing route is how a bad deploy becomes a load test.
 */
import type { CSSProperties } from 'react';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main style={main} data-testid="app-error">
      <h1 style={heading}>Something failed on our side</h1>
      <p style={body}>
        This screen could not be rendered. Nothing you did caused it and nothing was changed by
        it — every write in this product is explicit, and none of them run while a page is being
        drawn.
      </p>
      {error.digest ? (
        <p style={body}>
          Quote this reference when you report it: <code data-testid="error-digest">{error.digest}</code>
        </p>
      ) : null}
      <p style={body}>
        <button type="button" onClick={reset} style={button}>
          Try again
        </button>{' '}
        <a href="/" style={link}>
          Back to the index
        </a>
      </p>
    </main>
  );
}

const main: CSSProperties = {
  color: '#111827',
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  margin: '0 auto',
  maxWidth: '36rem',
  padding: '3rem 1.5rem',
};

const heading: CSSProperties = { fontSize: '1.5rem', margin: '0 0 0.75rem' };
const body: CSSProperties = { color: '#6b7280', fontSize: '0.875rem', margin: '0 0 0.75rem' };
const link: CSSProperties = { color: '#111827' };
const button: CSSProperties = {
  background: '#f9fafb',
  border: '1px solid #e5e7eb',
  borderRadius: '0.25rem',
  cursor: 'pointer',
  fontSize: '0.8125rem',
  padding: '0.3125rem 0.75rem',
};
