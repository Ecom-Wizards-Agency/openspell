'use client';

import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  ContextualNegativeExportSummary,
  ContextualNegativeProposalRecord,
} from '@wizard-ads/db';
import { QUERY_CATEGORY_LABELS } from '@wizard-ads/core';
import { can, isOrgRole } from '../../src/auth/roles';
import styles from './query-intelligence.module.css';

const STATUS_ORDER = ['proposed', 'accepted', 'dismissed', 'exported'] as const;
const STATUS_LABELS = {
  proposed: 'Needs review',
  accepted: 'Accepted',
  dismissed: 'Dismissed',
  exported: 'Exported',
} as const;
const ROLE_LABELS = {
  rank: 'Rank',
  discovery: 'Discovery',
  profit: 'Profit',
  shield: 'Shield',
} as const;

function statusBadge(status: ContextualNegativeProposalRecord['status']): string {
  if (status === 'proposed') return 'wa-badge wa-badge--warn';
  if (status === 'accepted') return 'wa-badge wa-badge--good';
  if (status === 'exported') return 'wa-badge wa-badge--info';
  return 'wa-badge';
}

function exportDate(value: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(value));
}

export interface NegativeProposalReviewProps {
  proposals: readonly ContextualNegativeProposalRecord[];
  exports: readonly ContextualNegativeExportSummary[];
  profileId: string;
  marketplaceId: string;
  role: string;
}

interface Filters {
  status: string;
  route: string;
  text: string;
}

const EMPTY_FILTERS: Filters = { status: '', route: '', text: '' };

export function NegativeProposalReview(props: NegativeProposalReviewProps): ReactNode {
  const [proposals, setProposals] = useState(() => [...props.proposals]);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<{ csv: string; json: string } | null>(null);

  const role = isOrgRole(props.role) ? props.role : 'viewer';
  const canReview = can(role, 'editTargets');
  const canExport = can(role, 'exportBatches');
  const counts = useMemo(
    () => Object.fromEntries(
      STATUS_ORDER.map((status) => [status, proposals.filter((row) => row.status === status).length]),
    ) as Record<(typeof STATUS_ORDER)[number], number>,
    [proposals],
  );
  const visible = useMemo(() => {
    const needle = filters.text.trim().toLocaleLowerCase('und');
    return proposals.filter((proposal) => {
      if (filters.status && proposal.status !== filters.status) return false;
      if (filters.route && proposal.sourceGroupRole !== filters.route) return false;
      if (!needle) return true;
      return [
        proposal.searchTerm,
        proposal.reason,
        proposal.campaignId,
        proposal.adGroupId,
      ].some((value) => value.toLocaleLowerCase('und').includes(needle));
    });
  }, [filters, proposals]);
  const selectedIds = useMemo(
    () => visible
      .filter((proposal) => proposal.status !== 'exported' && selected.has(proposal.id))
      .map((proposal) => proposal.id),
    [selected, visible],
  );
  const acceptedSelected = useMemo(
    () => visible.filter((proposal) =>
      proposal.status === 'accepted' && selected.has(proposal.id),
    ).length,
    [selected, visible],
  );
  const exportCount = selectedIds.length > 0 ? acceptedSelected : counts.accepted;
  const lanes = useMemo(
    () => STATUS_ORDER.map((status) => ({
      status,
      rows: visible.filter((proposal) => proposal.status === status),
    })).filter((lane) => lane.rows.length > 0),
    [visible],
  );

  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const post = useCallback(async (url: string, body: unknown): Promise<Record<string, unknown>> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) throw new Error(String(payload['error'] ?? response.statusText));
    return payload;
  }, []);

  const decide = useCallback(async (
    decision: 'accepted' | 'dismissed' | 'proposed',
  ): Promise<void> => {
    setError(null);
    setMessage(null);
    setDownloads(null);
    if (selectedIds.length === 0) {
      setError('Select at least one proposal first.');
      return;
    }
    if (decision === 'dismissed' && note.trim().length === 0) {
      setError('A dismissal needs a note: record why the proposal is not being taken.');
      return;
    }
    setBusy(true);
    try {
      const result = await post('/api/query-intelligence/negatives/decide', {
        profileId: props.profileId,
        marketplaceId: props.marketplaceId,
        ids: selectedIds,
        decision,
        note,
      });
      const selectedSet = new Set(selectedIds);
      const decidedAt = decision === 'proposed' ? null : new Date();
      setProposals((current) => current.map((proposal) =>
        selectedSet.has(proposal.id) && proposal.status !== 'exported'
          ? {
              ...proposal,
              status: decision,
              decidedAt,
              decisionNote: note.trim() || null,
            }
          : proposal,
      ));
      setSelected(new Set());
      setMessage(
        `${String(result['updated'])} of ${String(result['matched'])} matched proposals moved to ` +
          `${STATUS_LABELS[decision].toLocaleLowerCase('und')}.`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Decision failed');
    } finally {
      setBusy(false);
    }
  }, [note, post, props.marketplaceId, props.profileId, selectedIds]);

  const exportAccepted = useCallback(async (): Promise<void> => {
    setError(null);
    setMessage(null);
    setDownloads(null);
    if (!confirmed) {
      setError('Tick “Yes, export negatives” before creating files.');
      return;
    }
    if (note.trim().length === 0) {
      setError('An export needs a note.');
      return;
    }
    if (exportCount === 0) {
      setError('No accepted proposals are in the selected scope.');
      return;
    }
    setBusy(true);
    try {
      const result = await post('/api/query-intelligence/negatives/export', {
        profileId: props.profileId,
        marketplaceId: props.marketplaceId,
        ids: selectedIds.length > 0 ? selectedIds : null,
        note,
        confirmed: true,
      });
      const links = result['downloads'] as { csv: string; json: string };
      const acceptedIds = new Set(
        proposals
          .filter((proposal) => proposal.status === 'accepted')
          .filter((proposal) => selectedIds.length === 0 || selectedIds.includes(proposal.id))
          .map((proposal) => proposal.id),
      );
      setProposals((current) => current.map((proposal) =>
        acceptedIds.has(proposal.id) ? { ...proposal, status: 'exported' } : proposal,
      ));
      setSelected(new Set());
      setConfirmed(false);
      setDownloads(links);
      setMessage(
        `Exported ${String(result['exported'])} of ${String(result['accepted'])} accepted ` +
          'proposals. Amazon was not updated.',
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  }, [confirmed, exportCount, note, post, proposals, props.marketplaceId, props.profileId, selectedIds]);

  return (
    <section className="wa-card" aria-labelledby="negative-review-title" data-testid="negative-review">
      <header className="wa-card__head">
        <div>
          <span className="wa-label">Contextual negatives</span>
          <h2 id="negative-review-title" className="wa-card__title">Decide a compact queue, then export</h2>
        </div>
        <span className="wa-card__sub">{proposals.length} total · No Amazon writes</span>
      </header>
      <div className="wa-card__body">
        <div className={styles.reviewSummary} data-testid="negative-counts">
          <div><span>Needs review</span><strong>{counts.proposed}</strong></div>
          <div><span>Ready to export</span><strong>{counts.accepted}</strong></div>
          <div><span>Dismissed</span><strong>{counts.dismissed}</strong></div>
          <div><span>Exported</span><strong>{counts.exported}</strong></div>
        </div>

        <fieldset className={styles.reviewToolbar}>
          <legend>Find and select</legend>
          <label>
            Status
            <select
              className="wa-select wa-select--sm"
              value={filters.status}
              onChange={(event) => setFilters({ ...filters, status: event.target.value })}
            >
              <option value="">All statuses</option>
              {STATUS_ORDER.map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}
            </select>
          </label>
          <label>
            Route
            <select
              className="wa-select wa-select--sm"
              value={filters.route}
              onChange={(event) => setFilters({ ...filters, route: event.target.value })}
            >
              <option value="">All routes</option>
              {Object.entries(ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className={styles.reviewSearch}>
            Search
            <input
              className="wa-input wa-input--sm"
              type="search"
              value={filters.text}
              onChange={(event) => setFilters({ ...filters, text: event.target.value })}
              placeholder="Query, reason, campaign, ad group"
            />
          </label>
          <button className="wa-btn wa-btn--ghost wa-btn--sm" type="button" onClick={() => setFilters(EMPTY_FILTERS)}>
            Clear
          </button>
          <button
            className="wa-btn wa-btn--sm"
            type="button"
            onClick={() => setSelected(new Set(visible.filter((row) => row.status !== 'exported').map((row) => row.id)))}
          >
            Select all {visible.filter((row) => row.status !== 'exported').length} filtered
          </button>
        </fieldset>

        <fieldset className={styles.decisionBar}>
          <legend>Human decision</legend>
          <label className={styles.noteField}>
            Note <span>required for dismissal and export</span>
            <textarea
              className="wa-textarea"
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <div className={styles.decisionActions}>
            <button className="wa-btn wa-btn--primary wa-btn--sm" type="button" disabled={busy || !canReview} onClick={() => void decide('accepted')}>
              Accept selected
            </button>
            <button className="wa-btn wa-btn--sm" type="button" disabled={busy || !canReview} onClick={() => void decide('dismissed')}>
              Dismiss selected
            </button>
            <button className="wa-btn wa-btn--ghost wa-btn--sm" type="button" disabled={busy || !canReview} onClick={() => void decide('proposed')}>
              Re-open
            </button>
            <button className="wa-btn wa-btn--ghost wa-btn--sm" type="button" disabled={busy} onClick={() => setSelected(new Set())}>
              Clear selection
            </button>
            <span>{selectedIds.length} selected · {acceptedSelected} accepted</span>
          </div>
        </fieldset>

        <div className={styles.exportBar}>
          <label>
            <input
              className="wa-checkbox"
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            Yes, export negatives
          </label>
          <button
            className="wa-btn wa-btn--primary wa-btn--sm"
            type="button"
            disabled={busy || !canExport || exportCount === 0}
            onClick={() => void exportAccepted()}
            data-testid="export-contextual-negatives"
          >
            Export {exportCount} accepted proposal{exportCount === 1 ? '' : 's'}
          </button>
          <span>
            {canExport
              ? 'Creates immutable CSV and JSON evidence only.'
              : `Role ${role} may review but cannot export.`}
          </span>
        </div>

        {error === null ? null : <p className="wa-banner wa-banner--bad" role="alert">{error}</p>}
        {message === null ? null : (
          <p className="wa-banner wa-banner--good" role="status">
            {message}{' '}
            {downloads === null ? null : <><a href={downloads.csv}>Download CSV</a> · <a href={downloads.json}>Download JSON</a></>}
          </p>
        )}

        {lanes.length === 0 ? (
          <div className="wa-empty">
            <p className="wa-empty__title">No proposal matches this view</p>
            <p className="wa-empty__body">Clear a filter to widen the queue.</p>
          </div>
        ) : (
          <div className={styles.proposalLanes}>
            {lanes.map((lane) => (
              <details key={lane.status} open={lane.status === 'proposed' || lane.status === 'accepted'}>
                <summary><span>{STATUS_LABELS[lane.status]}</span><strong>{lane.rows.length}</strong></summary>
                <div className="wa-tablewrap">
                  <table className="wa-table wa-table--dense">
                    <thead>
                      <tr>
                        <th aria-label="Select" />
                        <th>Search term and reason</th>
                        <th>Category</th>
                        <th>Route</th>
                        <th>Ad group</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lane.rows.slice(0, 250).map((proposal) => (
                        <tr key={proposal.id}>
                          <td>
                            <input
                              className="wa-checkbox"
                              type="checkbox"
                              aria-label={`Select ${proposal.searchTerm}`}
                              checked={selected.has(proposal.id)}
                              disabled={proposal.status === 'exported'}
                              onChange={() => toggle(proposal.id)}
                            />
                          </td>
                          <td>
                            <strong>{proposal.searchTerm}</strong>
                            <small className={styles.cellSub} title={proposal.reason}>{proposal.reason}</small>
                          </td>
                          <td>{QUERY_CATEGORY_LABELS[proposal.category]}</td>
                          <td>{ROLE_LABELS[proposal.sourceGroupRole]}</td>
                          <td>{proposal.adGroupId}</td>
                          <td>
                            <span className={statusBadge(proposal.status)}>{STATUS_LABELS[proposal.status]}</span>
                            {proposal.decisionNote === null ? null : <small className={styles.cellSub}>{proposal.decisionNote}</small>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {lane.rows.length <= 250 ? null : (
                  <p className={styles.cardNote}>
                    Showing 250 of {lane.rows.length}. Filter this status to narrow the table; bulk selection still covers all {lane.rows.length} rows.
                  </p>
                )}
              </details>
            ))}
          </div>
        )}

        {props.exports.length === 0 ? null : (
          <details className={styles.exportHistory}>
            <summary>Recent immutable exports <strong>{props.exports.length}</strong></summary>
            <ul>
              {props.exports.map((record) => (
                <li key={record.id}>
                  <span>{exportDate(record.createdAt)} · {record.rowCount} rows</span>
                  <span><a href={`/api/query-intelligence/negatives/export/${record.id}?format=csv`}>CSV</a> · <a href={`/api/query-intelligence/negatives/export/${record.id}?format=json`}>JSON</a></span>
                </li>
              ))}
            </ul>
          </details>
        )}

        <p className={styles.cardNote}>
          Own Brand remains valid in Shield. Competitor terms remain valid in conquest. Core and
          Generic Head are not negated merely because of category. Every row targets an ad group,
          and exported means a file was created—not that Amazon changed.
        </p>
      </div>
    </section>
  );
}
