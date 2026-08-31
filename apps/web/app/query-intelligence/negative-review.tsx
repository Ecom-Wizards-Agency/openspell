'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { QUERY_CATEGORY_LABELS } from '@wizard-ads/core';
import type { ContextualNegativeProposal } from '@wizard-ads/shared';
import { can, isOrgRole } from '../../src/auth/roles';
import styles from './query-intelligence.module.css';

export const NEGATIVE_REVIEW_PAGE_SIZE = 50;
export const NEGATIVE_REVIEW_ACTION_LIMIT = 500;

const STATUSES = ['proposed', 'accepted', 'dismissed', 'exported'] as const;
type ProposalStatus = (typeof STATUSES)[number];

const STATUS_LABELS: Record<ProposalStatus, string> = {
  proposed: 'Needs review',
  accepted: 'Ready to export',
  dismissed: 'Dismissed',
  exported: 'Exported',
};

const ROUTE_LABELS = {
  rank: 'Rank',
  discovery: 'Discovery',
  profit: 'Profit',
  shield: 'Shield',
} as const;

export type ContextualNegativeReviewProposal = Omit<ContextualNegativeProposal, 'id'> & {
  id: string;
  reviewFingerprint: string;
};

export type ContextualNegativeReviewState =
  | {
      status: 'ready';
      proposals: ContextualNegativeReviewProposal[];
      counts: Record<ProposalStatus, number>;
      rowCount: number;
      reviewBytes: number;
    }
  | {
      status: 'capacity_exceeded';
      rowCount: number;
      reviewBytes: number;
      rowLimit: number;
      byteLimit: number;
      measurementsAvailable: boolean;
      reason: string;
    };

export interface ContextualNegativeExportHistoryItem {
  id: string;
  rowCount: number;
  createdAt: string;
  note: string;
}

export interface NegativeProposalReviewProps {
  review: ContextualNegativeReviewState;
  exports: readonly ContextualNegativeExportHistoryItem[];
  profileId: string;
  marketplaceId: string;
  role: string;
}

interface ActionResult {
  offered?: number;
  matched?: number;
  updated?: number;
  unchanged?: number;
  exported?: number;
  exportId?: string;
  amazonUpdated?: boolean;
  downloads?: { csv?: string; json?: string };
}

class ReviewConflictError extends Error {}

function statusBadge(status: ProposalStatus): string {
  if (status === 'proposed') return 'wa-badge wa-badge--warn';
  if (status === 'accepted') return 'wa-badge wa-badge--good';
  if (status === 'exported') return 'wa-badge wa-badge--info';
  return 'wa-badge';
}

function expectation(proposal: ContextualNegativeReviewProposal) {
  return { id: proposal.id, expectedFingerprint: proposal.reviewFingerprint };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(value));
}

export function NegativeProposalReview(props: NegativeProposalReviewProps): ReactNode {
  if (props.review.status === 'capacity_exceeded') {
    return <CapacityState review={props.review} />;
  }
  return <ReadyReview key={`${props.profileId}:${props.marketplaceId}`} {...props} review={props.review} />;
}

function CapacityState({
  review,
}: {
  review: Extract<ContextualNegativeReviewState, { status: 'capacity_exceeded' }>;
}): ReactNode {
  return (
    <section className="wa-card" aria-labelledby="negative-review-title" data-testid="negative-review-capacity">
      <header className="wa-card__head">
        <div>
          <span className="wa-label">Contextual negatives</span>
          <h2 id="negative-review-title" className="wa-card__title">Review queue unavailable</h2>
        </div>
        <span className="wa-card__sub">Amazon not updated</span>
      </header>
      <div className="wa-card__body">
        <p className="wa-banner wa-banner--warn" role="status">
          This scope exceeds the bounded review capacity, so no proposal bodies were loaded.
        </p>
        <dl className={styles.capacityFacts}>
          <div>
            <dt>Rows found</dt>
            <dd>{review.measurementsAvailable ? review.rowCount.toLocaleString() : 'Not measured'}</dd>
          </div>
          <div>
            <dt>Review fields</dt>
            <dd>{review.measurementsAvailable ? formatBytes(review.reviewBytes) : 'Not measured'}</dd>
          </div>
          <div><dt>Current limits</dt><dd>{review.rowLimit.toLocaleString()} rows · {formatBytes(review.byteLimit)}</dd></div>
        </dl>
        <p className={styles.cardNote}>{review.reason} Keyset pagination is required before this scope can be enabled.</p>
      </div>
    </section>
  );
}

function ReadyReview(
  props: Omit<NegativeProposalReviewProps, 'review'> & {
    review: Extract<ContextualNegativeReviewState, { status: 'ready' }>;
  },
): ReactNode {
  const router = useRouter();
  const [proposals, setProposals] = useState(() => props.review.proposals);
  const [status, setStatus] = useState<ProposalStatus>('proposed');
  const [route, setRoute] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<ReadonlyMap<string, ContextualNegativeReviewProposal>>(new Map());
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<{ csv?: string; json?: string } | null>(null);

  useEffect(() => {
    setProposals(props.review.proposals);
    setSelected(new Map());
    setPage(0);
  }, [props.review.proposals]);

  const role = isOrgRole(props.role) ? props.role : 'viewer';
  const mayReview = can(role, 'editTargets');
  const mayExport = can(role, 'exportBatches');
  const counts = props.review.counts;
  const visible = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('und');
    return proposals.filter((proposal) => {
      if (proposal.status !== status) return false;
      if (route && proposal.sourceGroupRole !== route) return false;
      if (!needle) return true;
      return [proposal.searchTerm, proposal.reason, proposal.campaignId, proposal.adGroupId]
        .some((value) => value.toLocaleLowerCase('und').includes(needle));
    });
  }, [proposals, route, search, status]);
  const pageCount = Math.max(1, Math.ceil(visible.length / NEGATIVE_REVIEW_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const rendered = visible.slice(
    currentPage * NEGATIVE_REVIEW_PAGE_SIZE,
    (currentPage + 1) * NEGATIVE_REVIEW_PAGE_SIZE,
  );
  const selectedRows = [...selected.values()];
  const selectedAccepted = selectedRows.filter((proposal) => proposal.status === 'accepted').length;
  const exportEligible = selectedRows.length > 0 && selectedAccepted === selectedRows.length;

  useEffect(() => setPage(0), [route, search, status]);

  function toggle(proposal: ContextualNegativeReviewProposal): void {
    setError(null);
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(proposal.id)) {
        next.delete(proposal.id);
      } else if (next.size >= NEGATIVE_REVIEW_ACTION_LIMIT) {
        setError(`A command may contain at most ${NEGATIVE_REVIEW_ACTION_LIMIT} explicit proposals.`);
      } else {
        next.set(proposal.id, proposal);
      }
      return next;
    });
  }

  function selectRendered(): void {
    setError(null);
    setSelected((current) => {
      const next = new Map(current);
      for (const proposal of rendered) {
        if (proposal.status === 'exported' || next.has(proposal.id)) continue;
        if (next.size >= NEGATIVE_REVIEW_ACTION_LIMIT) {
          setError(`Selection stopped at the ${NEGATIVE_REVIEW_ACTION_LIMIT}-proposal command limit.`);
          break;
        }
        next.set(proposal.id, proposal);
      }
      return next;
    });
  }

  async function post(url: string, body: unknown): Promise<ActionResult> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as ActionResult & { error?: string; reloadRequired?: boolean };
    if (!response.ok) {
      const actionError = payload.reloadRequired
        ? new ReviewConflictError(payload.error ?? 'The review changed. Reload and try again.')
        : new Error(payload.error ?? response.statusText);
      throw actionError;
    }
    return payload;
  }

  async function decide(decision: 'accepted' | 'dismissed' | 'proposed'): Promise<void> {
    setError(null);
    setMessage(null);
    setDownloads(null);
    if (selectedRows.length === 0) {
      setError('Select at least one rendered proposal.');
      return;
    }
    if (decision === 'dismissed' && note.trim().length === 0) {
      setError('A dismissal needs a note.');
      return;
    }
    setBusy(true);
    try {
      const result = await post('/api/query-intelligence/negatives/decide', {
        profileId: props.profileId,
        marketplaceId: props.marketplaceId,
        proposals: selectedRows.map(expectation),
        decision,
        note,
      });
      setMessage(
        `${String(result.updated ?? 0)} updated and ${String(result.unchanged ?? 0)} unchanged ` +
        `of ${String(result.matched ?? result.offered ?? selectedRows.length)} matched. Amazon not updated.`,
      );
      setSelected(new Map());
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Decision failed');
      if (caught instanceof ReviewConflictError) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function createExport(): Promise<void> {
    setError(null);
    setMessage(null);
    setDownloads(null);
    if (!confirmed) {
      setError('Confirm “Yes, create evidence files” before exporting.');
      return;
    }
    if (note.trim().length === 0) {
      setError('An export needs a note.');
      return;
    }
    if (!exportEligible) {
      setError('Export requires a non-empty explicit selection containing only accepted proposals.');
      return;
    }
    setBusy(true);
    try {
      const result = await post('/api/query-intelligence/negatives/export', {
        profileId: props.profileId,
        marketplaceId: props.marketplaceId,
        proposals: selectedRows.map(expectation),
        note,
        confirmed: true,
      });
      setDownloads(result.downloads ?? null);
      setMessage(`Created evidence for ${String(result.exported ?? selectedRows.length)} proposals. Amazon not updated.`);
      setSelected(new Map());
      setConfirmed(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Export failed');
      if (caught instanceof ReviewConflictError) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="wa-card" aria-labelledby="negative-review-title" data-testid="negative-review-ready">
      <header className="wa-card__head">
        <div>
          <span className="wa-label">Contextual negatives</span>
          <h2 id="negative-review-title" className="wa-card__title">Review and evidence export</h2>
        </div>
        <span className="wa-card__sub">{props.review.rowCount.toLocaleString()} complete rows · Amazon not updated</span>
      </header>
      <div className="wa-card__body">
        <div className={styles.reviewSummary} data-testid="negative-review-counts">
          {STATUSES.map((value) => (
            <button
              className={status === value ? styles.statusActive : styles.statusButton}
              key={value}
              type="button"
              onClick={() => setStatus(value)}
            >
              <span>{STATUS_LABELS[value]}</span><strong>{counts[value]}</strong>
            </button>
          ))}
        </div>

        <div className={styles.reviewToolbar}>
          <label>
            Route
            <select className="wa-select wa-select--sm" value={route} onChange={(event) => setRoute(event.target.value)}>
              <option value="">All routes</option>
              {Object.entries(ROUTE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className={styles.reviewSearch}>
            Search this complete scope
            <input className="wa-input wa-input--sm" type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
          </label>
          <button className="wa-btn wa-btn--sm" type="button" onClick={selectRendered}>Select rendered page</button>
        </div>

        {selectedRows.length === 0 ? null : (
          <div className={styles.selectionTray} data-testid="negative-selection-tray">
            <strong>{selectedRows.length} explicitly selected</strong>
            <span>{selectedAccepted} accepted · maximum {NEGATIVE_REVIEW_ACTION_LIMIT}</span>
            <button className="wa-btn wa-btn--ghost wa-btn--sm" type="button" onClick={() => setSelected(new Map())}>Clear selection</button>
          </div>
        )}

        {rendered.length === 0 ? (
          <div className="wa-empty">
            <p className="wa-empty__title">No proposals in this status page</p>
            <p className="wa-empty__body">Choose another status or clear the local filters.</p>
          </div>
        ) : (
          <div className="wa-tablewrap">
            <table className="wa-table wa-table--dense">
              <thead><tr><th aria-label="Select" /><th>Search term and reason</th><th>Category</th><th>Route</th><th>Ad group</th><th>Status</th></tr></thead>
              <tbody>
                {rendered.map((proposal) => (
                  <tr key={proposal.id}>
                    <td><input className="wa-checkbox" type="checkbox" aria-label={`Select ${proposal.searchTerm}`} checked={selected.has(proposal.id)} disabled={proposal.status === 'exported'} onChange={() => toggle(proposal)} /></td>
                    <td><strong>{proposal.searchTerm}</strong><small className={styles.cellSub} title={proposal.reason}>{proposal.reason}</small></td>
                    <td>{QUERY_CATEGORY_LABELS[proposal.category]}<small className={styles.cellSub}>{proposal.matchType.replace('_', ' ')}</small></td>
                    <td>{ROUTE_LABELS[proposal.sourceGroupRole]}</td>
                    <td>{proposal.adGroupId}</td>
                    <td><span className={statusBadge(proposal.status)}>{STATUS_LABELS[proposal.status]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className={styles.reviewPager}>
          <span>Showing {rendered.length} of {visible.length} filtered · page {currentPage + 1} of {pageCount}</span>
          <div>
            <button className="wa-btn wa-btn--ghost wa-btn--sm" type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button>
            <button className="wa-btn wa-btn--ghost wa-btn--sm" type="button" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>Next</button>
          </div>
        </div>

        <fieldset className={styles.decisionBar}>
          <legend>Explicit command</legend>
          <label className={styles.noteField}>Note <span>required for dismissal and export</span><textarea className="wa-textarea" rows={2} value={note} onChange={(event) => setNote(event.target.value)} /></label>
          <div className={styles.decisionActions}>
            <button className="wa-btn wa-btn--primary wa-btn--sm" type="button" disabled={busy || !mayReview} onClick={() => void decide('accepted')}>Accept selected</button>
            <button className="wa-btn wa-btn--sm" type="button" disabled={busy || !mayReview} onClick={() => void decide('dismissed')}>Dismiss selected</button>
            <button className="wa-btn wa-btn--ghost wa-btn--sm" type="button" disabled={busy || !mayReview} onClick={() => void decide('proposed')}>Reopen selected</button>
            <span>{mayReview ? 'Only explicitly selected rows are changed.' : `Role ${role} is read-only.`}</span>
          </div>
        </fieldset>

        <div className={styles.exportBar}>
          <label><input className="wa-checkbox" type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> Yes, create evidence files</label>
          <button className="wa-btn wa-btn--primary wa-btn--sm" type="button" disabled={busy || !mayExport || !exportEligible} onClick={() => void createExport()}>Export {selectedAccepted} selected accepted</button>
          <span>{mayExport ? 'Creates immutable CSV and JSON bytes. Amazon is not updated.' : `Role ${role} may review but cannot export.`}</span>
        </div>

        {error === null ? null : <p className="wa-banner wa-banner--bad" role="alert">{error}</p>}
        {message === null ? null : <p className="wa-banner wa-banner--good" role="status">{message}{downloads?.csv ? <> <a href={downloads.csv}>Download CSV</a></> : null}{downloads?.json ? <> · <a href={downloads.json}>Download JSON</a></> : null}</p>}

        {props.exports.length === 0 ? null : (
          <details className={styles.exportHistory}>
            <summary>Recent immutable evidence exports <strong>{props.exports.length}</strong></summary>
            <ul>{props.exports.map((record) => <li key={record.id}><span>{formatDate(record.createdAt)} · {record.rowCount} rows · {record.note}</span><span><a href={`/api/query-intelligence/negatives/export/${record.id}?format=csv`}>CSV</a> · <a href={`/api/query-intelligence/negatives/export/${record.id}?format=json`}>JSON</a></span></li>)}</ul>
          </details>
        )}

        <p className={styles.cardNote}>Own Brand remains valid in Shield. Competitor terms remain valid in conquest. Every proposal targets an ad group; an export is evidence only and never applies a negative in Amazon.</p>
      </div>
    </section>
  );
}
