'use client';

import { Button, PageHeader } from '../../src/ui/primitives';
import { page } from '../../src/ui/tokens';
import styles from './creative.module.css';

export default function CreativePerformanceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main style={page} data-testid="creative-error">
      <PageHeader title="Creative Performance" />
      <section className={styles.errorState} role="alert">
        <strong>Creative performance could not be loaded.</strong>
        <p>No result was produced and no Amazon write ran.</p>
        {error.digest ? <p>Reference: <code>{error.digest}</code></p> : null}
        <div>
          <Button size="sm" onClick={reset}>Try again</Button>
          <a className="wa-btn wa-btn--ghost wa-btn--sm" href="/sync-status">Check Sync status</a>
        </div>
      </section>
    </main>
  );
}
