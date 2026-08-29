'use client';

import { Button, PageHeader } from '../../src/ui/primitives';
import { page } from '../../src/ui/tokens';

export default function StrategyError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main style={page}>
      <PageHeader title="Strategy Overview" />
      <div className="wa-empty" role="alert">
        <p className="wa-empty__title">Strategy evidence could not be loaded.</p>
        <p className="wa-empty__body">No decision was produced and no Amazon change ran.</p>
        {error.digest ? <p className="wa-empty__meta">Reference: {error.digest}</p> : null}
        <div className="wa-row"><Button size="sm" onClick={reset}>Try again</Button><a className="wa-btn wa-btn--ghost wa-btn--sm" href="/sync-status">Check Sync Status</a></div>
      </div>
    </main>
  );
}
