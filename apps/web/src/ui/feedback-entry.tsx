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

export function FeedbackEntry(): React.ReactElement {
  const [from, setFrom] = useState<string | null>(null);

  useEffect(() => {
    setFrom(`${window.location.pathname}${window.location.search}`);
  }, []);

  const href = from === null ? '/feedback/new' : `/feedback/new?from=${encodeURIComponent(from)}`;

  return (
    <a href={href} data-testid="feedback-entry" className="wa-feedback-entry">
      <span aria-hidden="true">✎</span>
      Feedback
    </a>
  );
}
