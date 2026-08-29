import { Card, PageHeader } from '../../src/ui/primitives';
import { page } from '../../src/ui/tokens';

export default function DaypartingLoading() {
  return <main style={page} aria-busy="true"><PageHeader title="Dayparting" subtitle="Loading settled hourly evidence…" /><Card><p className="wa-page-sub">Reading the raw ledger, hourly facts, and schedule proposals.</p></Card></main>;
}
