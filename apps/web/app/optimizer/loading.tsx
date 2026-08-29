import { Card, PageHeader } from '../../src/ui/primitives';
import { page } from '../../src/ui/tokens';

/** Honest route feedback while campaigns and recommendation evidence load. */
export default function OptimizerLoading() {
  return (
    <main style={page} aria-busy="true" data-testid="optimizer-loading">
      <PageHeader
        title="Campaign Optimizer"
        subtitle="Loading campaigns, group settings, and recommendation evidence…"
      />
      <div className="wa-stack">
        <Card title="Campaign performance" subtitle="Preparing the selected and comparison windows…">
          <LoadingSignals labels={['Spend', 'Ad sales', 'Orders', 'ACOS']} />
        </Card>
        <Card title="Campaign workspace" subtitle="Loading every current campaign, including zero-activity rows…">
          <LoadingSignals labels={['Campaign roster', 'Optimization groups', 'Latest preview']} />
        </Card>
      </div>
    </main>
  );
}

function LoadingSignals({ labels }: { labels: readonly string[] }) {
  return (
    <div className="wa-operating-status" aria-label="Optimizer data loading">
      {labels.map((label) => (
        <div className="wa-operating-signal" key={label}>
          <span>{label}</span>
          <strong>—</strong>
        </div>
      ))}
    </div>
  );
}
