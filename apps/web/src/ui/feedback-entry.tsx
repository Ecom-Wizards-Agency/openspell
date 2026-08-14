'use client';

/**
 * The "Feedback" entry point, on every page.
 *
 * It is in the root layout rather than in each screen's header because the
 * whole value of an in-product feedback button is that it is there at the
 * moment something goes wrong, on whatever page that happened to be. A screen
 * that has to remember to include it is a screen that will not have it on the
 * day it matters.
 *
 * A client component for one reason: it captures the route the reporter was on.
 * `window.location` is read after mount, so the server render is a plain link
 * and nothing depends on hydration to be usable.
 */
import { useEffect, useState } from 'react';
import { colors } from './tokens';

export function FeedbackEntry(): React.ReactElement {
  const [from, setFrom] = useState<string | null>(null);

  useEffect(() => {
    setFrom(`${window.location.pathname}${window.location.search}`);
  }, []);

  const href = from === null ? '/feedback/new' : `/feedback/new?from=${encodeURIComponent(from)}`;

  return (
    <a
      href={href}
      data-testid="feedback-entry"
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: '999px',
        bottom: '0.75rem',
        boxShadow: '0 1px 3px rgba(17, 24, 39, 0.12)',
        color: colors.text,
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        fontSize: '0.8125rem',
        padding: '0.375rem 0.875rem',
        position: 'fixed',
        right: '0.75rem',
        textDecoration: 'none',
        zIndex: 40,
      }}
    >
      Feedback
    </a>
  );
}
