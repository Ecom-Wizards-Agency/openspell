'use client';

/**
 * The last resort: the root layout itself threw.
 *
 * `app/error.tsx` renders *inside* the layout, so it cannot catch a failure in
 * the layout — and the nav in the layout reads the session, which is exactly the
 * kind of code that can fail. This file replaces the whole document, which is
 * why it carries its own `<html>` and `<body>`: there is no frame left to
 * render into.
 *
 * Deliberately styled inline and dependent on nothing. A fallback that imports
 * the thing that just broke is not a fallback.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          color: 'var(--wa-text)',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          margin: 0,
        }}
      >
        <main style={{ margin: '0 auto', maxWidth: '36rem', padding: '3rem 1.5rem' }} data-testid="app-global-error">
          <h1 style={{ fontSize: '1.5rem', margin: '0 0 0.75rem' }}>
            Something failed on our side
          </h1>
          <p style={{ color: 'var(--wa-text-muted)', fontSize: '0.875rem', margin: '0 0 0.75rem' }}>
            wizard-ads could not render this page at all. Nothing was changed by it.
          </p>
          {error.digest ? (
            <p style={{ color: 'var(--wa-text-muted)', fontSize: '0.875rem', margin: '0 0 0.75rem' }}>
              Quote this reference when you report it: <code>{error.digest}</code>
            </p>
          ) : null}
          <p style={{ color: 'var(--wa-text-muted)', fontSize: '0.875rem', margin: 0 }}>
            <button
              type="button"
              onClick={reset}
              style={{
                background: 'var(--wa-surface-2)',
                border: '1px solid var(--wa-border)',
                borderRadius: '0.25rem',
                cursor: 'pointer',
                fontSize: '0.8125rem',
                padding: '0.3125rem 0.75rem',
              }}
            >
              Try again
            </button>{' '}
            <a href="/" style={{ color: 'var(--wa-text)' }}>
              Back to the index
            </a>
          </p>
        </main>
      </body>
    </html>
  );
}
