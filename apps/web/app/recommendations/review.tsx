'use client';

/**
 * The review workspace: filter, inspect, decide, export.
 *
 * Shape cloned from the recon (`tools/recon/04-optimizer.md`), with the two
 * things it says are the reason operators trust the incumbent kept intact:
 *
 * - **Bulk action over a filtered set.** Narrow by reason, status, strategy or
 *   text; the decision buttons then act on exactly what is on screen. "The
 *   single most valuable interaction in the product."
 * - **The three-act approval gesture for anything that leaves the tool.**
 *   Choose rows, tick a separate "I confirm this export" box, then press
 *   Export. Three distinct acts, one of which is affirming intent.
 *
 * And the one place we deliberately differ: the incumbent's optimizer can run
 * unattended on a schedule. Ours is preview-first by design — nothing leaves
 * this screen without a human, a note, and a confirmation.
 */
import { useCallback, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { ProposalView } from '../../src/recommendations/view';
import { groupByReason, reasonCoverage } from '../../src/recommendations/view';

export interface ReviewWorkspaceProps {
  proposals: readonly ProposalView[];
  runId: string;
  profileId: string;
  client: string;
  counts: Record<string, number>;
  role: string;
  hasStrategySnapshot: boolean;
}

const STATUSES = ['proposed', 'accepted', 'dismissed', 'exported', 'applied', 'superseded'];
const LEVERS = ['bid-down', 'push', 'waste-cut', 'budget', 'placement', 'negative', 'pause', 'other'];
const EXPORT_ROLES = ['owner', 'admin'];

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
  const [optGroup, setOptGroup] = useState('ungrouped');
  const [lever, setLever] = useState('bid-down');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(
    () => props.proposals.filter((proposal) => matches(proposal, filters)),
    [props.proposals, filters],
  );
  const groups = useMemo(() => groupByReason(visible), [visible]);
  const coverage = useMemo(() => reasonCoverage(props.proposals), [props.proposals]);
  const objectives = useMemo(
    () => [...new Set(props.proposals.map((proposal) => proposal.strategy.objective))].sort(),
    [props.proposals],
  );

  const selectedIds = useMemo(
    () => visible.filter((proposal) => selected.has(proposal.id)).map((proposal) => proposal.id),
    [visible, selected],
  );
  const canExport = EXPORT_ROLES.includes(props.role);
  const acceptedSelected = useMemo(
    () => visible.filter((proposal) => selected.has(proposal.id) && proposal.status === 'accepted').length,
    [visible, selected],
  );

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
      setError('Tick "I confirm this export" before exporting.');
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
    <section style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={summary} data-testid="run-counts">
        <span>
          <strong>{props.counts['proposed'] ?? 0}</strong> proposed
        </span>
        <span>
          <strong>{props.counts['accepted'] ?? 0}</strong> accepted
        </span>
        <span>
          <strong>{props.counts['dismissed'] ?? 0}</strong> dismissed
        </span>
        <span data-testid="exported-count">
          exported <strong>{props.counts['exported'] ?? 0}</strong> of{' '}
          {(props.counts['exported'] ?? 0) + (props.counts['accepted'] ?? 0)} accepted
        </span>
      </div>

      {props.hasStrategySnapshot ? null : (
        <p style={warning} role="status">
          This run stored no strategy snapshot, so every proposal shows as unassigned. The objective
          column is honest about that rather than guessing one.
        </p>
      )}

      <div style={coverageRow} data-testid="reason-coverage">
        {coverage.map((entry) => (
          <span key={entry.reason} style={pill}>
            {entry.label}: {entry.count} ({(entry.share * 100).toFixed(0)}%)
          </span>
        ))}
      </div>

      <fieldset style={panel}>
        <legend style={legend}>Filter</legend>
        <label style={label}>
          Reason
          <select
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
            type="text"
            value={filters.text}
            onChange={(event) => setFilters({ ...filters, text: event.target.value })}
          />
        </label>
        <button type="button" onClick={() => setFilters(EMPTY_FILTERS)}>
          Clear
        </button>
      </fieldset>

      <fieldset style={panel}>
        <legend style={legend}>Decide</legend>
        <label style={{ ...label, flex: '1 1 24rem' }}>
          Note (required to dismiss, and to export)
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            aria-label="Decision note"
          />
        </label>
        <button type="button" onClick={selectAllVisible} disabled={busy}>
          Select all {visible.length} filtered
        </button>
        <button type="button" onClick={() => setSelected(new Set())} disabled={busy}>
          Clear selection
        </button>
        <button type="button" onClick={() => void decide('accepted')} disabled={busy}>
          Accept selected
        </button>
        <button type="button" onClick={() => void decide('dismissed')} disabled={busy}>
          Dismiss selected
        </button>
        <button type="button" onClick={() => void decide('proposed')} disabled={busy}>
          Re-open selected
        </button>
        <span style={muted} data-testid="selection-count">
          {selectedIds.length} selected ({acceptedSelected} accepted)
        </span>
      </fieldset>

      <fieldset style={panel}>
        <legend style={legend}>Export accepted proposals</legend>
        <label style={label}>
          Opt group
          <input type="text" value={optGroup} onChange={(event) => setOptGroup(event.target.value)} />
        </label>
        <label style={label}>
          Lever
          <select value={lever} onChange={(event) => setLever(event.target.value)}>
            {LEVERS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label style={{ ...label, flexDirection: 'row', alignItems: 'center', gap: '0.375rem' }}>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          I confirm this export
        </label>
        <button type="button" onClick={() => void exportBatch()} disabled={busy || !canExport}>
          Export
        </button>
        <span style={muted}>
          {canExport
            ? 'v1 writes nothing to Amazon: this stages a batch and produces the files the operator flow applies.'
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

      {groups.length === 0 ? (
        <p style={muted}>No proposal matches this filter.</p>
      ) : (
        groups.map((group) => (
          <section key={group.reason} data-testid={`reason-group-${group.reason}`}>
            <h2 style={{ fontSize: '1rem', margin: '0.5rem 0' }}>
              {group.label} · {group.proposals.length}
            </h2>
            <table className="wa-table" style={table}>
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
                  <th style={th} scope="col">Work</th>
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
          <button type="button" onClick={onExpand} aria-expanded={expanded}>
            {expanded ? 'Hide work' : 'Show work'}
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

const summary: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '1rem',
  fontSize: '0.875rem',
};
const coverageRow: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '0.5rem' };
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
const pill: CSSProperties = {
  background: 'var(--wa-surface-3)',
  borderRadius: '999px',
  fontSize: '0.75rem',
  padding: '0.125rem 0.5rem',
};
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
  padding: '0.75rem',
};
const definitions: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.25rem', margin: 0 };
const definitionRow: CSSProperties = { display: 'flex', gap: '0.5rem' };
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
