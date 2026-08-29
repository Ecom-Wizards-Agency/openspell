import { Card, PageHeader } from '../../src/ui/primitives';
import { page } from '../../src/ui/tokens';

/** Immediate feedback while account facts and freshness evidence are loading. */
export default function DashboardLoading() {
  return (
    <main style={page} aria-busy="true" data-testid="dashboard-loading">
      <PageHeader
        title="Dashboard"
        subtitle="Loading current account performance and data coverage…"
      />
      <div className="wa-stack">
        <Card title="Performance overview" subtitle="Preparing the selected account window…">
          <LoadingSignals labels={['Spend', 'Ad sales', 'Orders', 'ACOS']} />
        </Card>
        <Card title="Performance trend" subtitle="Loading complete daily reporting bins…">
          <LoadingSignals labels={['Selected period', 'Comparison', 'Settling window']} />
        </Card>
      </div>
    </main>
  );
}

function LoadingSignals({ labels }: { labels: readonly string[] }) {
  return (
    <div className="wa-operating-status" aria-label="Dashboard data loading">
      {labels.map((label) => (
        <div className="wa-operating-signal" key={label}>
          <span>{label}</span>
          <strong>—</strong>
        </div>
      ))}
    </div>
  );
}
