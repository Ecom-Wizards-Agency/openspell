/**
 * The Campaign Optimizer's presentational pieces.
 *
 * All server-renderable and stateless: the settings chip, the reason-coverage
 * clusters, and the per-group preview table with the change-reasons /
 * limit-reasons split rendered as two pill columns (`tools/recon/04-optimizer.md`
 * §3). "This bid went up because low visibility" and "it did not go up as far as
 * we wanted because the smart ceiling bound" are two different facts, so they get
 * two different columns — the single pattern the recon says to clone hardest.
 */
import type { ReactNode } from 'react';
import { Badge } from '../../src/ui/primitives';
import { BidCorridorChart } from '../../src/ui/viz';
import type { BidCorridorPoint } from '../../src/ui/viz';
import type { OptimizationGroup, SettingsSummary } from '../../src/optimizer/view';
import type { ReasonCoverage } from '../../src/recommendations/view';

/** A target that has a corridor, as the chooser renders it. */
export interface CorridorTargetOption {
  targetId: string;
  isKeyword: boolean;
}

/**
 * The bid-corridor drill-down (`tools/recon/04-optimizer.md` §3), on the
 * optimizer detail. A chooser of the targets that carry a corridor, then the
 * band chart for the selected one: Amazon's suggested-bid band drawn around the
 * target's bid, realized CPC and max-potential CPC. Read-only market evidence —
 * the last check on a row before it ships.
 */
export function CorridorSection({
  targets,
  selectedTargetId,
  points,
  currencyCode,
  hrefFor,
}: {
  targets: readonly CorridorTargetOption[];
  selectedTargetId: string | null;
  points: readonly BidCorridorPoint[];
  currencyCode: string;
  hrefFor: (targetId: string) => string;
}): ReactNode {
  const selected = targets.find((t) => t.targetId === selectedTargetId) ?? null;
  return (
    <section className="wa-card" aria-label="Bid corridor" data-testid="bid-corridor-section">
      <header className="wa-card__head">
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <h3 className="wa-card__title">Bid corridor</h3>
          <p className="wa-card__sub">
            Amazon&apos;s daily suggested-bid band with the bid, realized CPC and max-potential CPC
            drawn inside it — the market&apos;s opinion next to ours.
          </p>
        </div>
      </header>

      {targets.length === 0 ? null : (
        <div className="wa-row" style={{ gap: '0.375rem', flexWrap: 'wrap', padding: '0 1rem 0.5rem' }} data-testid="corridor-targets">
          {targets.map((target) => (
            <a
              key={target.targetId}
              href={hrefFor(target.targetId)}
              className="wa-pill"
              data-testid={`corridor-target-${target.targetId}`}
              aria-current={target.targetId === selectedTargetId ? 'true' : undefined}
              style={target.targetId === selectedTargetId ? { outline: '2px solid var(--wa-accent-border)' } : undefined}
            >
              {target.isKeyword ? 'kw' : 'tgt'} · {target.targetId}
            </a>
          ))}
        </div>
      )}

      <div style={{ padding: '0 1rem 1rem' }}>
        <BidCorridorChart
          title={selected === null ? undefined : `${selected.isKeyword ? 'Keyword' : 'Target'} ${selected.targetId}`}
          ariaLabel="Amazon suggested-bid corridor with bid, CPC and max potential CPC"
          currencyCode={currencyCode}
          points={points}
          caption={`Suggested-bid band, bid, realized CPC and max potential CPC. In ${currencyCode}.`}
        />
      </div>
    </section>
  );
}

function percent(value: number | null): string {
  if (value === null) return '—';
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
}

function acosLabel(value: number | null): string | null {
  return value === null ? null : `${(value * 100).toFixed(0)}%`;
}

/** The run's policy, collapsed into one chip: `Target ACOS 30% · Balanced`. */
export function SettingsChip({ summary }: { summary: SettingsSummary }): ReactNode {
  const acos = acosLabel(summary.targetAcos);
  return (
    <span className="wa-badge wa-badge--info" data-testid="optimizer-settings" title="The policy this run was computed under">
      <span aria-hidden="true">⚙</span>
      {summary.uniform
        ? `Target ACOS ${acos} · ${summary.objective}`
        : 'Per-campaign strategy'}
    </span>
  );
}

/**
 * Reason coverage, the recon's QA metric (`04-optimizer.md` §7 beat #4): a
 * manager samples 4,000 rows, so the surface says how concentrated the run is
 * and puts the largest clusters first.
 */
export function ReasonCoverageRow({
  coverage,
  total,
}: {
  coverage: readonly ReasonCoverage[];
  total: number;
}): ReactNode {
  if (coverage.length === 0) return null;
  return (
    <div className="wa-card" style={{ padding: '0.75rem 1rem' }}>
      <div className="wa-row" style={{ gap: '0.5rem' }}>
        <span className="wa-label" style={{ marginRight: '0.25rem' }}>
          Reason coverage
        </span>
        {coverage.map((entry) => (
          <span key={entry.reason} className="wa-pill" data-testid={`coverage-${entry.reason}`}>
            {entry.label}
            <span className="wa-pill__count">
              {entry.count} · {(entry.share * 100).toFixed(0)}%
            </span>
          </span>
        ))}
        <span className="wa-hint" style={{ marginLeft: 'auto' }}>
          {total} proposal{total === 1 ? '' : 's'} in this run
        </span>
      </div>
    </div>
  );
}

/** One optimization group: a header of shared policy, then its proposal rows. */
export function OptimizerGroupTable({ group }: { group: OptimizationGroup }): ReactNode {
  const acos = acosLabel(group.targetAcos);
  return (
    <section className="wa-card" aria-label={`Optimization group ${group.label}`}>
      <header className="wa-card__head">
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <h3 className="wa-card__title" title={group.label}>
            {group.label}
          </h3>
          <p className="wa-card__sub">
            {group.proposals.length} proposal{group.proposals.length === 1 ? '' : 's'}
            {group.reasons.length === 0
              ? ''
              : ` · ${group.reasons.map((reason) => `${reason.label} (${reason.count})`).join(', ')}`}
          </p>
        </div>
        <span className="wa-row" style={{ gap: '0.375rem' }}>
          {acos === null ? (
            <Badge>mixed target</Badge>
          ) : (
            <Badge tone="info">Target ACOS {acos}</Badge>
          )}
          {group.objective === null ? null : <Badge>{group.objective}</Badge>}
        </span>
      </header>
      <div className="wa-tablewrap" style={{ border: 0, borderRadius: 0, boxShadow: 'none' }}>
        <table className="wa-table wa-table--numeric">
          <thead>
            <tr>
              <th scope="col">Entity</th>
              <th scope="col">Field</th>
              <th scope="col" style={{ textAlign: 'right' }}>
                Current
              </th>
              <th scope="col" style={{ textAlign: 'right' }}>
                Proposed
              </th>
              <th scope="col" style={{ textAlign: 'right' }}>
                Δ
              </th>
              <th scope="col">Change reasons</th>
              <th scope="col">Limit reasons</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {group.proposals.map((proposal) => (
              <tr key={proposal.id} data-testid={`optimizer-row-${proposal.id}`}>
                <td>
                  <div>{proposal.entityLabel}</div>
                  <div className="wa-hint">{proposal.scope}</div>
                </td>
                <td>{proposal.field}</td>
                <td style={{ textAlign: 'right' }}>{proposal.currentValue}</td>
                <td style={{ textAlign: 'right' }}>{proposal.proposedValue}</td>
                <td style={{ textAlign: 'right' }}>{percent(proposal.delta)}</td>
                <td>
                  <span className="wa-pill wa-pill--reason" title={proposal.changeReason}>
                    {proposal.reasonLabel}
                  </span>
                </td>
                <td>
                  {proposal.limitReason === null ? (
                    <span className="wa-hint">—</span>
                  ) : (
                    <span className="wa-pill wa-pill--limit" title={proposal.limitReason}>
                      {proposal.limitReason}
                    </span>
                  )}
                </td>
                <td>
                  <Badge tone={proposal.status === 'accepted' ? 'good' : 'neutral'}>
                    {proposal.status}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
