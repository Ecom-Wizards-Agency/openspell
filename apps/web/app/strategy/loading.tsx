import { Card, PageHeader } from '../../src/ui/primitives';
import { page } from '../../src/ui/tokens';

export default function StrategyLoading() {
  return (
    <main style={page} aria-busy="true">
      <PageHeader title="Dashboard" subtitle="Loading operating constraints and decision evidence…" />
      <div className="wa-stack">
        <Card><p className="wa-page-sub">Reading stock, pacing, batch, and cooldown state.</p></Card>
        <Card><p className="wa-page-sub">Reading optimization groups and observation windows.</p></Card>
      </div>
    </main>
  );
}
