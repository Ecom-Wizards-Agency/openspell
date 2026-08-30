'use client';

/**
 * The Campaign Optimizer's presentational pieces.
 *
 * The settings chip and reason coverage are stateless; each group table owns
 * only the target id of its open bid-history modal. The preview keeps the
 * change-reasons / limit-reasons split as two separate pill columns
 * (`tools/recon/04-optimizer.md` §3). "This bid went up because low visibility"
 * and "it did not go up as far as we wanted because the smart ceiling bound"
 * are two different facts and remain two different columns.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Badge } from '../../src/ui/primitives';
import { BidHistoryModal } from '../../src/ui/bid-history-modal';
import type { CampaignReviewGroup, SettingsSummary } from '../../src/optimizer/view';
import type { ReasonCoverage } from '../../src/recommendations/view';
import type { OptimizationGroupSnapshot } from '@wizard-ads/shared';

function percent(value: number | null): string {
  if (value === null) return '—';
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
}

function acosLabel(value: number | null): string | null {
  return value === null ? null : `${(value * 100).toFixed(0)}%`;
}

/** The run's policy, collapsed into one chip: `Target ACOS 30% · Balanced`. */
export function SettingsChip({
  summary,
  group,
}: {
  summary: SettingsSummary;
  group?: OptimizationGroupSnapshot | null;
}): ReactNode {
  if (group) {
    return (
      <span className="wa-badge wa-badge--info" data-testid="optimizer-settings" title="Immutable optimization-group policy stored with this run">
        <span aria-hidden="true">⚙</span>
        {group.name} · {group.role} · Target ACOS {acosLabel(group.targetAcos)}
      </span>
    );
  }
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

export interface BidHistoryContext {
  profileId: string;
  window: { start: string; end: string };
  currencyCode: string;
}

/** One campaign drill-down inside a persisted group run or legacy profile run. */
export function OptimizerGroupTable({
  group,
  bidHistoryContext,
}: {
  group: CampaignReviewGroup;
  bidHistoryContext: BidHistoryContext;
}): ReactNode {
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const acos = acosLabel(group.targetAcos);
  return (
    <>
      <section className="wa-card" aria-label={`Campaign review group ${group.label}`}>
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
              <th scope="col">Bid history</th>
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
                <td>
                  {proposal.entityType === 'keyword' || proposal.entityType === 'target' ? (
                    <button
                      type="button"
                      className="wa-btn wa-btn--ghost wa-btn--sm"
                      data-testid={`view-bid-history-${proposal.id}`}
                      onClick={() => setSelectedTargetId(proposal.entityId)}
                    >
                      view bid history
                    </button>
                  ) : (
                    <span className="wa-hint">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </section>
      {selectedTargetId === null ? null : (
        <BidHistoryModal
          profileId={bidHistoryContext.profileId}
          targetId={selectedTargetId}
          window={bidHistoryContext.window}
          currencyCode={bidHistoryContext.currencyCode}
          onClose={() => setSelectedTargetId(null)}
        />
      )}
    </>
  );
}
