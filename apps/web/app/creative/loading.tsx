import { PageHeader } from '../../src/ui/primitives';
import { page } from '../../src/ui/tokens';
import styles from './creative.module.css';

export default function CreativePerformanceLoading() {
  return (
    <main style={{ ...page, maxWidth: '96rem' }} aria-busy="true" data-testid="creative-loading">
      <PageHeader
        title="Creative Performance"
        subtitle="Loading Sponsored Brands Video assets and ad-level mappings…"
      />
      <div className={styles.loadingScope} />
      <div className={styles.loadingSummary}>
        {Array.from({ length: 4 }, (_, index) => <div key={index} />)}
      </div>
      <div className={styles.loadingTable} />
    </main>
  );
}
