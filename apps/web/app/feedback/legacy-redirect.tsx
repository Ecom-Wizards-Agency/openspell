'use client';

import { useEffect } from 'react';
import { heading, muted, page } from '../../src/ui/tokens';

const LEGACY_ANCHOR = /^#feedback-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

/**
 * URL fragments never reach a server. Convert the old fragment to a query once,
 * then let the server perform the tenant-scoped type lookup and final redirect.
 */
export function LegacyFeedbackRedirect() {
  useEffect(() => {
    const itemId = LEGACY_ANCHOR.exec(window.location.hash)?.[1];
    window.location.replace(itemId ? `/feedback?item=${encodeURIComponent(itemId)}` : '/bugs');
  }, []);

  return (
    <main style={page}>
      <h1 style={heading}>Redirecting…</h1>
      <p style={muted}>Taking you to Bugs or Roadmap.</p>
    </main>
  );
}
