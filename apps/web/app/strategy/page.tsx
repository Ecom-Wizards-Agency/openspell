import type { ReactNode } from 'react';
import { readOptimizationWorkspace } from '@wizard-ads/db';
import { gate } from '../../src/auth/guard';
import { gateMessage } from '../../src/ui/gate-message';
import { Badge, Banner, Card, EmptyState, PageHeader } from '../../src/ui/primitives';
import { page } from '../../src/ui/tokens';
import { loadProfileDailyRows } from '../_lib/dashboard-data';
import { listProfiles, requestedProfileId, selectProfile } from '../_lib/profiles';
import { readStrategyEvidence } from '../../src/strategy/overview';
import styles from './strategy.module.css';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ profile?: string }>;
}

export default async function StrategyPage({ searchParams }: PageProps): Promise<ReactNode> {
  const entry = await gate();
  if (entry.state !== 'ok') {
    return <main style={page}><PageHeader title="Strategy Overview" /><p className="wa-page-sub">{gateMessage(entry.state)}</p></main>;
  }

  const params = await searchParams;
  const orgId = entry.context.active?.orgId ?? '';
  const profiles = await listProfiles(entry.handle, orgId);
  const profile = selectProfile(profiles, await requestedProfileId(params.profile));
  if (profile === null) {
    return (
      <main style={page}>
        <PageHeader title="Strategy Overview" />
        <EmptyState
          title="No profiles yet"
          body="Connect Amazon Ads before Wizard Ads can assemble an evidence-backed operating view."
          action={<a className="wa-btn wa-btn--sm" href="/settings/connections">Connect Amazon Ads</a>}
        />
      </main>
    );
  }

  const asOf = localDate(profile.timezone);
  const month = { start: `${asOf.slice(0, 8)}01`, end: asOf };
  const [workspace, evidence, monthRows] = await Promise.all([
    readOptimizationWorkspace(entry.handle, { orgId, profileId: profile.id }),
    readStrategyEvidence(entry.handle, { orgId, profileId: profile.id }),
    loadProfileDailyRows(entry.handle, orgId, profile.id, profile.label, month),
  ]);

  const openBatch = evidence.batches.find((batch) => batch.status === 'staged') ?? null;
  const lastApplied = evidence.batches.find((batch) => batch.status === 'applied') ?? null;
  const mtdSpend = monthRows.reduce((sum, row) => sum + (row.spend ?? 0), 0);
  const pacing = pacingSummary(asOf, profile.monthlyBudget, mtdSpend, monthRows.length, profile.currencyCode);
  const coverage = coverageSummary(evidence.coverage);
  const stock = evidence.knowledge.stockSignals > 0
    ? {
        tone: 'warn' as const,
        value: 'Review',
        detail: `${evidence.knowledge.stockSignals.toLocaleString('en-US')} out-of-stock signal${evidence.knowledge.stockSignals === 1 ? '' : 's'}; latest week ${evidence.knowledge.latestStockWeek ?? 'unknown'}`,
      }
    : {
        tone: 'neutral' as const,
        value: 'Unknown',
        detail: 'No validated inventory feed. Absence of a warning is not proof of stock.',
      };

  return (
    <main style={page}>
      <PageHeader
        title="Strategy Overview"
        subtitle={`${profile.label} · ${asOf} · operating gates and next decisions`}
        actions={<Badge tone="info">Read-only operator view</Badge>}
      />

      <div className="wa-stack">
        <Banner tone="info" role="status">
          Wizard Ads can analyze, propose, preview, and export. This workspace never changes Amazon campaigns.
        </Banner>

        <section className={styles.gates} aria-label="Operating gates">
          <GateCard label="Stock gate" value={stock.value} detail={stock.detail} tone={stock.tone} />
          <GateCard label="Pacing" value={pacing.value} detail={pacing.detail} tone={pacing.tone} />
          <GateCard
            label="Open batch"
            value={openBatch === null ? 'Clear' : `${openBatch.rows} changes`}
            detail={openBatch === null ? 'No staged export is waiting for operator handling.' : `${openBatch.optGroup} · ${openBatch.lever} · Amazon unchanged`}
            tone={openBatch === null ? 'good' : 'warn'}
          />
          <GateCard
            label="Cooldown"
            value={cooldownValue(lastApplied, asOf)}
            detail={lastApplied === null ? 'No applied batch is recorded.' : `${lastApplied.optGroup} · applied ${lastApplied.appliedOn ?? 'date unavailable'}`}
            tone={cooldownTone(lastApplied, asOf)}
          />
        </section>

        <div className={styles.columns}>
          <Card
            title="Next decisions"
            subtitle="One optimization group per preview, with its policy and campaign set carried into the run."
            actions={<a className="wa-btn wa-btn--sm" href={`/optimizer/groups?profile=${profile.id}`}>Manage groups</a>}
          >
            {workspace.groups.length === 0 ? (
              <EmptyState
                title="No optimization groups"
                body="Create Rank, Discovery, Profit, or Shield groups and assign each campaign once before scheduling previews."
                action={<a className="wa-btn wa-btn--sm" href={`/optimizer/groups?profile=${profile.id}`}>Create first group</a>}
              />
            ) : (
              <div className={styles.decisionList}>
                {workspace.groups.map((record) => {
                  const next = groupDecision(record, openBatch, asOf);
                  return (
                    <article className={styles.decision} key={record.group.id}>
                      <div className={styles.decisionName}>
                        <strong>{record.group.name}</strong>
                        <Badge tone={record.group.enabled ? 'info' : 'neutral'}>{titleCase(record.group.role)}</Badge>
                      </div>
                      <div className={styles.decisionMeta}>
                        <span>{record.campaignIds.length} campaign{record.campaignIds.length === 1 ? '' : 's'}</span>
                        <span>{record.lastRun === null ? 'No run yet' : `${record.lastRun.proposalsCount} proposals · ${record.lastRun.status}`}</span>
                        <span>{record.nextRunAt === null ? 'No run scheduled' : `Due ${shortDateTime(record.nextRunAt)}`}</span>
                      </div>
                      <div className={styles.decisionAction}>
                        <Badge tone={next.tone}>{next.label}</Badge>
                        <span>{next.detail}</span>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </Card>

          <Card title="Evidence loop" subtitle="A recommendation must be synchronized and observed before another change compounds it.">
            <div className={styles.evidenceGrid}>
              <EvidenceStat value={evidence.observations.synchronized} label="Synchronized" />
              <EvidenceStat value={evidence.observations.settling} label="Observing" warn={evidence.observations.settling > 0} />
              <EvidenceStat value={evidence.observations.complete} label="Complete" />
              <EvidenceStat value={evidence.observations.revert} label="Revert proposals" warn={evidence.observations.revert > 0} />
            </div>
            <div className={styles.loopCopy}>
              {evidence.observations.total === 0 ? (
                <p>No exported recommendation has entered an observation window yet.</p>
              ) : (
                <p>{evidence.observations.supportedLift} continue · {evidence.observations.hold} hold · {evidence.observations.revert} revert.</p>
              )}
              {evidence.diagnostics === null ? (
                <p>Run diagnostics appear after the next completed optimizer preview.</p>
              ) : (
                <p>
                  Latest run gates: {evidence.diagnostics.blockedOutOfStock} stock-blocked, {evidence.diagnostics.skippedMissingStrategy} missing strategy, {evidence.diagnostics.skippedInactive} inactive, {evidence.diagnostics.preconditionNotes} evidence notes.
                </p>
              )}
              <a href={`/time-machine?profile=${profile.id}`}>Open batch history and reversion previews →</a>
            </div>
          </Card>
        </div>

        <Card
          title="Four-axis keyword cockpit"
          subtitle="Readiness is shown at the evidence grain Wizard Ads can support. Missing axes remain explicit."
          actions={<a className="wa-btn wa-btn--sm" href={`/query-intelligence?profile=${profile.id}`}>Open Query Intelligence</a>}
        >
          <div className={styles.axes}>
            <Axis
              label="Organic rank"
              value={evidence.knowledge.rankObservations > 0 ? `${evidence.knowledge.rankObservations.toLocaleString('en-US')} observations` : 'Not available'}
              detail={evidence.knowledge.latestRankDate === null ? 'Connect validated rank evidence.' : `Latest observation ${evidence.knowledge.latestRankDate}`}
              ready={evidence.knowledge.rankObservations > 0}
            />
            <Axis
              label="Top-of-Search impression share"
              value="Not available"
              detail="Placement evidence is not currently valid at keyword grain; Wizard Ads does not infer it."
              ready={false}
            />
            <Axis
              label="SQP impression share"
              value={axisValue(evidence.knowledge.sqpImpressionShares)}
              detail="Context only—not share of voice."
              ready={evidence.knowledge.sqpImpressionShares > 0}
            />
            <Axis
              label="SQP click / purchase share"
              value={`${axisValue(evidence.knowledge.sqpClickShares)} / ${axisValue(evidence.knowledge.sqpPurchaseShares)}`}
              detail={evidence.knowledge.latestSqpWeek === null ? 'No authoritative SQP week loaded.' : `Latest week ${evidence.knowledge.latestSqpWeek}`}
              ready={evidence.knowledge.sqpClickShares > 0 || evidence.knowledge.sqpPurchaseShares > 0}
            />
          </div>
          <div className={styles.lifecycle}>
            <strong>Keyword lifecycle</strong>
            <span>Entry → Push → Hold → Graduate → Regression</span>
            <Badge tone="neutral">Policy data required</Badge>
            <p>Lifecycle labels are not assigned until tenant-owned rules are configured. Numeric doctrine stays out of frontend source.</p>
          </div>
        </Card>

        <Card
          title="Data coverage"
          subtitle="Comparisons are trustworthy only where source, dates, gaps, and settling state are known."
          actions={<a className="wa-btn wa-btn--sm" href={`/sync-status?profile=${profile.id}`}>Open Sync Status</a>}
          flush
        >
          {evidence.coverage.length === 0 ? (
            <EmptyState title="Coverage ledger is empty" body="The profile may have canonical facts, but maximum-history and source coverage have not been recorded yet." />
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead><tr><th>Report</th><th>Source</th><th>Status</th><th>Returned from</th><th>Loaded through</th><th>Settled through</th><th>Gaps</th></tr></thead>
                <tbody>
                  {evidence.coverage.map((row, index) => (
                    <tr key={`${row.reportType}-${row.source}-${index}`}>
                      <td>{humanReport(row.reportType)}</td><td>{humanReport(row.source)}</td>
                      <td><Badge tone={row.status === 'complete' ? 'good' : row.status === 'failed' ? 'bad' : 'warn'}>{humanReport(row.status)}</Badge></td>
                      <td>{row.earliestReturnedDate ?? '—'}</td><td>{row.latestLoadedDate ?? '—'}</td><td>{row.latestSettledDate ?? '—'}</td><td>{row.missingDates.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className={styles.coverageFoot}>{coverage.reportTypes} report types · {coverage.complete} complete · {coverage.gaps} known missing dates · {coverage.earliest ?? 'unknown'} to {coverage.latest ?? 'unknown'}.</p>
        </Card>
      </div>
    </main>
  );
}

function GateCard({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: 'neutral' | 'good' | 'warn' | 'bad' | 'info' }): ReactNode {
  return <article className={styles.gate}><div><span>{label}</span><Badge tone={tone}>{value}</Badge></div><p>{detail}</p></article>;
}

function EvidenceStat({ value, label, warn = false }: { value: number; label: string; warn?: boolean }): ReactNode {
  return <div className={`${styles.evidenceStat} ${warn ? styles.evidenceWarn : ''}`}><strong>{value.toLocaleString('en-US')}</strong><span>{label}</span></div>;
}

function Axis({ label, value, detail, ready }: { label: string; value: string; detail: string; ready: boolean }): ReactNode {
  return <article className={styles.axis}><div><strong>{label}</strong><Badge tone={ready ? 'good' : 'neutral'}>{ready ? 'Ready' : 'Gap'}</Badge></div><b>{value}</b><p>{detail}</p></article>;
}

function groupDecision(
  record: Awaited<ReturnType<typeof readOptimizationWorkspace>>['groups'][number],
  openBatch: { optGroup: string } | null,
  asOf: string,
): { label: string; detail: string; tone: 'neutral' | 'good' | 'warn' | 'bad' | 'info' } {
  if (!record.group.enabled) return { label: 'Disabled', detail: 'Enable only when this policy should be evaluated.', tone: 'neutral' };
  if (record.campaignIds.length === 0) return { label: 'Assign campaigns', detail: 'No campaign can be evaluated until assignment.', tone: 'warn' };
  if (openBatch?.optGroup === record.group.name) return { label: 'Review export', detail: 'A staged batch is still open; avoid overlapping decisions.', tone: 'warn' };
  if (record.lastRun?.status === 'queued' || record.lastRun?.status === 'running') return { label: 'Monitor run', detail: 'The current preview has not finished.', tone: 'info' };
  if (record.lastRun?.status === 'succeeded' && record.lastRun.proposalsCount > 0) return { label: 'Review proposals', detail: 'Decide, then export only the accepted rows.', tone: 'good' };
  if (record.nextRunAt !== null && record.nextRunAt.slice(0, 10) <= asOf) return { label: 'Run due', detail: 'The cadence is due for a new read-only preview.', tone: 'info' };
  return { label: 'Wait', detail: 'No operator action is due from current evidence.', tone: 'neutral' };
}

function pacingSummary(asOf: string, monthlyBudget: number | null, spend: number, days: number, currency: string): { value: string; detail: string; tone: 'neutral' | 'info' } {
  if (monthlyBudget === null || monthlyBudget <= 0) return { value: 'Not configured', detail: 'Add a profile monthly budget before evaluating pace.', tone: 'neutral' };
  const year = Number(asOf.slice(0, 4));
  const month = Number(asOf.slice(5, 7));
  const day = Number(asOf.slice(8, 10));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const budgetToDate = monthlyBudget * day / daysInMonth;
  const ratio = budgetToDate > 0 ? spend / budgetToDate : 0;
  return {
    value: `${Math.round(ratio * 100)}% of plan`,
    detail: `${money(spend, currency)} spent vs ${money(budgetToDate, currency)} plan-to-date · ${days} loaded days. No action threshold inferred.`,
    tone: 'info',
  };
}

function cooldownValue(batch: { cooldownUntil: string | null } | null, asOf: string): string {
  if (batch?.cooldownUntil === null || batch === null) return 'No record';
  return batch.cooldownUntil >= asOf ? `Until ${batch.cooldownUntil}` : 'Complete';
}

function cooldownTone(batch: { cooldownUntil: string | null } | null, asOf: string): 'neutral' | 'good' | 'warn' {
  if (batch?.cooldownUntil === null || batch === null) return 'neutral';
  return batch.cooldownUntil >= asOf ? 'warn' : 'good';
}

function coverageSummary(rows: Awaited<ReturnType<typeof readStrategyEvidence>>['coverage']): { reportTypes: number; complete: number; gaps: number; earliest: string | null; latest: string | null } {
  const earliest = rows.map((row) => row.earliestReturnedDate).filter((value): value is string => value !== null).sort()[0] ?? null;
  const latestValues = rows.map((row) => row.latestLoadedDate).filter((value): value is string => value !== null).sort();
  return {
    reportTypes: new Set(rows.map((row) => row.reportType)).size,
    complete: rows.filter((row) => row.status === 'complete').length,
    gaps: rows.reduce((sum, row) => sum + row.missingDates.length, 0),
    earliest,
    latest: latestValues.at(-1) ?? null,
  };
}

function localDate(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function money(value: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);
}

function axisValue(rows: number): string {
  return rows > 0 ? `${rows.toLocaleString('en-US')} rows` : 'Not available';
}

function shortDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function humanReport(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
