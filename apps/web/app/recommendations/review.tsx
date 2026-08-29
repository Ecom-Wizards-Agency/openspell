'use client';

/**
 * The review workspace: filter, inspect, decide, export.
 *
 * A human-sized operator queue, with the two trust-building interactions from
 * the recon (`tools/recon/04-optimizer.md`) kept intact:
 *
 * - **Bulk action over a filtered set.** Narrow by reason, status, strategy or
 *   text; the decision buttons then act on exactly what is on screen. "The
 *   single most valuable interaction in the product."
 * - **The three-act approval gesture for anything that leaves the tool.**
 *   Choose rows, tick a separate "Yes, export changes" box, then press
 *   Export. Three distinct acts, one of which is affirming intent.
 *
 * And the one place we deliberately differ: the incumbent's optimizer can run
 * unattended on a schedule. Ours is preview-first by design — nothing leaves
 * this screen without a human, a note, and a confirmation.
 */
import { useCallback, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { ProposalView } from '../../src/recommendations/view';
import { groupByDecision, groupByReason } from '../../src/recommendations/view';
import { can } from '../../src/auth/roles';
import type { OrgRole } from '../../src/auth/roles';

export interface ReviewWorkspaceProps {
  proposals: readonly ProposalView[];
  runId: string;
  profileId: string;
  client: string;
  counts: Record<string, number>;
  role: string;
  hasStrategySnapshot: boolean;
  runGroupName?: string | null;
}

const STATUSES = ['proposed', 'accepted', 'dismissed', 'exported', 'applied', 'superseded'];
const LEVERS = ['bid-down', 'push', 'waste-cut', 'budget', 'placement', 'negative', 'pause', 'other'];

interface Filters {
  reason: string;
  status: string;
  objective: string;
  text: string;
}

const EMPTY_FILTERS: Filters = { reason: '', status: '', objective: '', text: '' };

function matches(proposal: ProposalView, filters: Filters): boolean {
  if (filters.reason && proposal.reason !== filters.reason) return false;
  if (filters.status && proposal.status !== filters.status) return false;
  if (filters.objective && proposal.strategy.objective !== filters.objective) return false;
  if (filters.text) {
    const needle = filters.text.toLowerCase();
    const haystack = `${proposal.entityLabel} ${proposal.scope} ${proposal.entityId}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

function percent(value: number | null): string {
  if (value === null) return '—';
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
}

export function ReviewWorkspace(props: ReviewWorkspaceProps): ReactNode {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [optGroup, setOptGroup] = useState(
    () => props.runGroupName ?? props.proposals.find((proposal) => proposal.strategy.optGroup !== null)?.strategy.optGroup ?? 'ungrouped',
  );
  const [lever, setLever] = useState('bid-down');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(
    () => props.proposals.filter((proposal) => matches(proposal, filters)),
    [props.proposals, filters],
  );
  const queue = useMemo(() => groupByDecision(visible), [visible]);
  const objectives = useMemo(
    () => [...new Set(props.proposals.map((proposal) => proposal.strategy.objective))].sort(),
    [props.proposals],
  );
  const strategyGroups = useMemo(
    () => [
      ...new Set(
        props.proposals.flatMap((proposal) =>
          proposal.strategy.optGroup === null ? [] : [proposal.strategy.optGroup],
        ),
      ),
    ].sort(),
    [props.proposals],
  );

  const selectedIds = useMemo(
    () => visible.filter((proposal) => selected.has(proposal.id)).map((proposal) => proposal.id),
    [visible, selected],
  );
  const canExport = can(props.role as OrgRole, 'exportBatches');
  const acceptedSelected = useMemo(
    () => visible.filter((proposal) => selected.has(proposal.id) && proposal.status === 'accepted').length,
    [visible, selected],
  );
  const exportCount = selectedIds.length > 0 ? acceptedSelected : (props.counts['accepted'] ?? 0);

  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAllVisible = useCallback(() => {
    setSelected(new Set(visible.map((proposal) => proposal.id)));
  }, [visible]);

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

  const decide = useCallback(
    async (decision: 'accepted' | 'dismissed' | 'proposed') => {
      setError(null);
      setMessage(null);
      if (selectedIds.length === 0) {
        setError('Select at least one proposal first.');
        return;
      }
      if (decision === 'dismissed' && note.trim().length === 0) {
        setError('A dismissal needs a note: record why this proposal is not being taken.');
        return;
      }
      setBusy(true);
      try {
        const result = await post('/api/recommendations/decide', {
          ids: selectedIds,
          decision,
          note,
        });
        setMessage(
          `${String(result['updated'])} of ${String(result['offered'])} proposals moved to ${decision}.`,
        );
        window.location.reload();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Decision failed');
      } finally {
        setBusy(false);
      }
    },
    [note, post, selectedIds],
  );

  const exportBatch = useCallback(async () => {
    setError(null);
    setMessage(null);
    if (!confirmed) {
      setError('Tick "Yes, export changes" before exporting.');
      return;
    }
    if (note.trim().length === 0) {
      setError('An export needs a note: it is the note the staged apply carries.');
      return;
    }
    setBusy(true);
    try {
      const result = await post('/api/recommendations/export', {
        runId: props.runId,
        profileId: props.profileId,
        client: props.client,
        optGroup,
        lever,
        note,
        ids: selectedIds.length > 0 ? selectedIds : null,
      });
      const downloads = result['downloads'] as Record<string, string>;
      setMessage(
        `Exported ${String(result['exported'])} of ${String(result['accepted'])} accepted proposals as ${String(result['tag'])}. ` +
          `Download: rows ${downloads['rows']} · caps ${downloads['caps']} · workbook ${downloads['workbook']}`,
      );
      setConfirmed(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  }, [confirmed, lever, note, optGroup, post, props.client, props.profileId, props.runId, selectedIds]);

  return (
    <section className="wa-review" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div className="wa-review__summary" data-testid="run-counts">
        <div className="wa-review__stat wa-review__stat--attention">
          <span className="wa-label">Needs review</span>
          <strong>{props.counts['proposed'] ?? 0}</strong>
          {' '}
          <span>new proposals</span>
        </div>
        <div className="wa-review__stat">
          <span className="wa-label">Ready to export</span>
          <strong>{props.counts['accepted'] ?? 0}</strong>
          {' '}
          <span>accepted proposals</span>
        </div>
        <div className="wa-review__stat">
          <span className="wa-label">Completed</span>
          <strong>
            {(props.counts['dismissed'] ?? 0) +
              (props.counts['exported'] ?? 0) +
              (props.counts['applied'] ?? 0) +
              (props.counts['superseded'] ?? 0)}
          </strong>
          <span data-testid="exported-count">
            {props.counts['exported'] ?? 0} exported · {props.counts['dismissed'] ?? 0} dismissed
          </span>
        </div>
      </div>

      {props.hasStrategySnapshot ? null : (
        <p style={warning} role="status">
          This run stored no strategy snapshot, so every proposal shows as unassigned. The objective
          column is honest about that rather than guessing one.
        </p>
      )}

      <fieldset className="wa-review__toolbar" style={panel}>
        <legend style={legend}>Find and select</legend>
        <label style={label}>
          Reason
          <select
            className="wa-select wa-select--sm"
            value={filters.reason}
            onChange={(event) => setFilters({ ...filters, reason: event.target.value })}
          >
            <option value="">All</option>
            {groupByReason(props.proposals).map((group) => (
              <option key={group.reason} value={group.reason}>
                {group.label}
              </option>
            ))}
          </select>
        </label>
        <label style={label}>
          Status
          <select
            className="wa-select wa-select--sm"
            value={filters.status}
            onChange={(event) => setFilters({ ...filters, status: event.target.value })}
          >
            <option value="">All</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>
        <label style={label}>
          Objective
          <select
            className="wa-select wa-select--sm"
            value={filters.objective}
            onChange={(event) => setFilters({ ...filters, objective: event.target.value })}
          >
            <option value="">All</option>
            {objectives.map((objective) => (
              <option key={objective} value={objective}>
                {objective}
              </option>
            ))}
          </select>
        </label>
        <label style={label}>
          Search
          <input
            className="wa-input wa-input--sm"
            type="text"
            value={filters.text}
            onChange={(event) => setFilters({ ...filters, text: event.target.value })}
          />
        </label>
        <button className="wa-btn wa-btn--ghost wa-btn--sm" type="button" onClick={() => setFilters(EMPTY_FILTERS)}>
          Clear
        </button>
      </fieldset>

      <fieldset style={panel}>
        <legend style={legend}>Decide</legend>
        <label style={{ ...label, flex: '1 1 24rem' }}>
          Note (required to dismiss, and to export)
          <textarea
            className="wa-textarea"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            aria-label="Decision note"
          />
        </label>
        <button className="wa-btn wa-btn--sm" type="button" onClick={selectAllVisible} disabled={busy}>
          Select all {visible.length} filtered
        </button>
        <button className="wa-btn wa-btn--ghost wa-btn--sm" type="button" onClick={() => setSelected(new Set())} disabled={busy}>
          Clear selection
        </button>
        <button className="wa-btn wa-btn--primary wa-btn--sm" type="button" onClick={() => void decide('accepted')} disabled={busy}>
          Accept selected
        </button>
        <button className="wa-btn wa-btn--sm" type="button" onClick={() => void decide('dismissed')} disabled={busy}>
          Dismiss selected
        </button>
        <button className="wa-btn wa-btn--ghost wa-btn--sm" type="button" onClick={() => void decide('proposed')} disabled={busy}>
          Re-open selected
        </button>
        <span style={muted} data-testid="selection-count">
          {selectedIds.length} selected ({acceptedSelected} accepted)
        </span>
      </fieldset>

      <fieldset style={panel}>
        <legend style={legend}>Export accepted changes</legend>
        <label style={label}>
          Strategy group for export
          <select className="wa-select wa-select--sm" value={optGroup} onChange={(event) => setOptGroup(event.target.value)}>
            <option value="ungrouped">Ungrouped</option>
            {strategyGroups.map((group) => (
              <option key={group} value={group}>{group}</option>
            ))}
          </select>
          <span style={muted}>Selects caps from this run’s snapshot; it is not a persisted campaign assignment.</span>
        </label>
        <label style={label}>
          Lever
          <select className="wa-select wa-select--sm" value={lever} onChange={(event) => setLever(event.target.value)}>
            {LEVERS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label style={{ ...label, flexDirection: 'row', alignItems: 'center', gap: '0.375rem' }}>
          <input
            className="wa-checkbox"
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          Yes, export changes
        </label>
        <button
          className="wa-btn wa-btn--primary wa-btn--sm"
          type="button"
          onClick={() => void exportBatch()}
          disabled={busy || !canExport}
          data-testid="export-accepted"
        >
          Export {exportCount} accepted change{exportCount === 1 ? '' : 's'}
        </button>
        <span style={muted}>
          {canExport
            ? 'Creates review files only. Wizard Ads does not update Amazon.'
            : `role ${props.role} may review but not export.`}
        </span>
      </fieldset>

      {error === null ? null : (
        <p role="alert" style={warning} data-testid="review-error">
          {error}
        </p>
      )}
      {message === null ? null : (
        <p role="status" style={notice} data-testid="export-result">
          {message}
        </p>
      )}

      {queue.length === 0 ? (
        <p style={muted}>No proposal matches this filter.</p>
      ) : (
        queue.map((lane) => (
          <section
            key={lane.id}
            className="wa-review__lane"
            data-testid={`decision-lane-${lane.id}`}
            aria-labelledby={`decision-lane-title-${lane.id}`}
          >
            <header className="wa-review__lane-head">
              <div>
                <h2 id={`decision-lane-title-${lane.id}`}>{lane.label}</h2>
                <p>{lane.description}</p>
              </div>
              <strong>{lane.proposals.length}</strong>
            </header>
            <div className="wa-review__clusters">
              {lane.reasons.map((group, index) => (
                <details
                  key={group.reason}
                  className="wa-review__cluster"
                  data-testid={`reason-group-${lane.id}-${group.reason}`}
                  open={lane.id === 'needs_review' && index === 0}
                >
                  <summary>
                    <span>
                      <strong>{group.label}</strong>
                      <small>{group.proposals[0]?.changeReason}</small>
                    </span>
                    <span className="wa-review__cluster-count">{group.proposals.length}</span>
                  </summary>
                  <div className="wa-tablewrap wa-review__tablewrap">
                    <table className="wa-table wa-table--dense" style={table}>
                      <thead>
                        <tr>
                          <th style={th} scope="col">
                            <span aria-hidden="true">✓</span>
                            <span style={visuallyHidden}>Select</span>
                          </th>
                          <th style={th} scope="col">Entity</th>
                          <th style={th} scope="col">Scope</th>
                          <th style={th} scope="col">Objective</th>
                          <th style={th} scope="col">Field</th>
                          <th style={thRight} scope="col">Current</th>
                          <th style={thRight} scope="col">Proposed</th>
                          <th style={thRight} scope="col">Δ</th>
                          <th style={th} scope="col">Status</th>
                          <th style={th} scope="col">Evidence</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.proposals.map((proposal) => (
                          <ProposalRow
                            key={proposal.id}
                            proposal={proposal}
                            selected={selected.has(proposal.id)}
                            expanded={expanded === proposal.id}
                            onToggle={() => toggle(proposal.id)}
                            onExpand={() => setExpanded(expanded === proposal.id ? null : proposal.id)}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              ))}
            </div>
          </section>
        ))
      )}
    </section>
  );
}

function ProposalRow({
  proposal,
  selected,
  expanded,
  onToggle,
  onExpand,
}: {
  proposal: ProposalView;
  selected: boolean;
  expanded: boolean;
  onToggle: () => void;
  onExpand: () => void;
}): ReactNode {
  return (
    <>
      <tr
        data-testid={`proposal-${proposal.id}`}
        data-status={proposal.status}
        aria-selected={selected}
      >
        <td style={td}>
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            aria-label={`Select ${proposal.entityLabel}`}
          />
        </td>
        <td style={td}>{proposal.entityLabel}</td>
        <td style={td}>{proposal.scope}</td>
        <td style={td} data-testid={`objective-${proposal.id}`}>
          {proposal.strategyLabel}
        </td>
        <td style={td}>{proposal.field}</td>
        <td style={tdRight}>{proposal.currentValue}</td>
        <td style={tdRight}>{proposal.proposedValue}</td>
        <td style={tdRight}>{percent(proposal.delta)}</td>
        <td style={td}>{proposal.status}</td>
        <td style={td}>
          <button className="wa-btn wa-btn--ghost wa-btn--sm" type="button" onClick={onExpand} aria-expanded={expanded}>
            {expanded ? 'Hide evidence' : 'Show evidence'}
          </button>
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td style={td} colSpan={10}>
            <div style={provenancePanel} data-testid={`provenance-${proposal.id}`}>
              <p style={{ margin: '0 0 0.5rem' }}>
                <strong>Change reason — {proposal.reasonLabel}:</strong> {proposal.changeReason}
              </p>
              <p style={{ margin: '0 0 0.5rem' }} data-testid={`limit-${proposal.id}`}>
                <strong>Limit reason:</strong>{' '}
                {proposal.limitReason ?? 'nothing bound this value: no ceiling applied and no cap clamped.'}
              </p>
              <p style={{ margin: '0 0 0.5rem' }} data-testid={`strategy-${proposal.id}`}>
                <strong>Strategy — {proposal.strategyLabel}:</strong> {proposal.strategy.explanation}
                {proposal.strategy.targetAcos === null
                  ? ''
                  : ` Target ACOS ${(proposal.strategy.targetAcos * 100).toFixed(0)}%.`}
              </p>
              <dl style={definitions}>
                {proposal.provenance.map((line) => (
                  <div key={line.key} style={definitionRow} data-provenance={line.key}>
                    <dt style={{ fontWeight: 600 }}>{line.label}</dt>
                    <dd style={{ margin: 0 }}>
                      {line.value} <span style={muted}>— {line.hint}</span>
                    </dd>
                  </div>
                ))}
              </dl>
              {proposal.decisionNote === null ? null : (
                <p style={{ margin: '0.5rem 0 0' }}>
                  <strong>Decision note:</strong> {proposal.decisionNote}
                </p>
              )}
              {proposal.exportBatchTag === null ? null : (
                <p style={{ margin: '0.5rem 0 0' }}>
                  <strong>Exported in batch:</strong> {proposal.exportBatchTag}
                </p>
              )}
              {proposal.exportable ? null : (
                <p style={{ margin: '0.5rem 0 0' }}>
                  This proposal creates an entity rather than changing one, so it ships as a create
                  row in the workbook and is absent from the rows JSON.
                </p>
              )}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

const panel: CSSProperties = {
  alignItems: 'flex-end',
  border: '1px solid var(--wa-border)',
  borderRadius: '0.5rem',
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.75rem',
  padding: '0.75rem',
};
const legend: CSSProperties = { fontSize: '0.8125rem', fontWeight: 600, padding: '0 0.25rem' };
const label: CSSProperties = { display: 'flex', flexDirection: 'column', fontSize: '0.8125rem', gap: '0.25rem' };
const muted: CSSProperties = { color: 'var(--wa-text-muted)', fontSize: '0.8125rem' };
const table: CSSProperties = { borderCollapse: 'collapse', fontSize: '0.8125rem', width: '100%' };
const th: CSSProperties = {
  borderBottom: '1px solid var(--wa-border-strong)',
  padding: '0.25rem 0.5rem',
  textAlign: 'left',
};
const thRight: CSSProperties = { ...th, textAlign: 'right' };
const td: CSSProperties = { borderBottom: '1px solid var(--wa-surface-3)', padding: '0.25rem 0.5rem' };
const tdRight: CSSProperties = { ...td, textAlign: 'right' };
const provenancePanel: CSSProperties = {
  background: 'var(--wa-surface-2)',
  borderRadius: '0.375rem',
  overflowWrap: 'anywhere',
  padding: '0.75rem',
};
const definitions: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.25rem', margin: 0 };
const definitionRow: CSSProperties = {
  alignItems: 'baseline',
  display: 'grid',
  gap: '0.25rem 0.75rem',
  gridTemplateColumns: 'minmax(9rem, 13rem) minmax(0, 1fr)',
  overflowWrap: 'anywhere',
};
const warning: CSSProperties = {
  background: 'var(--wa-bad-bg)',
  border: '1px solid var(--wa-bad-border)',
  borderRadius: '0.375rem',
  color: 'var(--wa-bad-text)',
  margin: 0,
  padding: '0.5rem 0.75rem',
};
const notice: CSSProperties = {
  background: 'var(--wa-good-bg)',
  border: '1px solid var(--wa-good-border)',
  borderRadius: '0.375rem',
  color: 'var(--wa-good-text)',
  margin: 0,
  padding: '0.5rem 0.75rem',
};
const visuallyHidden: CSSProperties = {
  clip: 'rect(0 0 0 0)',
  height: '1px',
  overflow: 'hidden',
  position: 'absolute',
  width: '1px',
};
