'use client';

/**
 * The tracker list.
 *
 * Triage controls render only for a role that holds `triageFeedback`, and that
 * is decoration: the same rule is checked by the route, by the query layer and
 * by a database trigger. A viewer who forges the request gets a 403 from the
 * first of those three, and the two behind it are why that 403 is not the only
 * thing standing between a viewer and the roadmap.
 */
import { useCallback, useEffect, useState } from 'react';
import { STATUS_LABELS } from '../../src/feedback/ui';
import type { UiFeedbackItem } from '../../src/feedback/ui';
import { banner, button, colors, heading, muted, page } from '../../src/ui/tokens';

interface Counts {
  openBugs: number;
  openFeatures: number;
  shipped: number;
  declined: number;
  total: number;
}

const STATUSES = ['new', 'triaged', 'planned', 'in_progress', 'shipped', 'declined'] as const;

const card = {
  border: `1px solid ${colors.border}`,
  borderRadius: '0.5rem',
  marginBottom: '0.75rem',
  padding: '0.875rem 1rem',
} as const;

export function FeedbackTracker({
  items: initialItems,
  counts: initialCounts,
  canTriage,
  role,
}: {
  items: UiFeedbackItem[];
  counts: Counts;
  canTriage: boolean;
  role: string;
}) {
  const [items, setItems] = useState(initialItems);
  const [counts, setCounts] = useState(initialCounts);
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState<'newest' | 'votes'>('newest');
  const [message, setMessage] = useState('');
  const [ready, setReady] = useState(false);

  const reload = useCallback(
    async (next?: { type?: string; status?: string; sort?: 'newest' | 'votes' }) => {
      const query = new URLSearchParams();
      const wantedType = next?.type ?? type;
      const wantedStatus = next?.status ?? status;
      if (wantedType) query.set('type', wantedType);
      if (wantedStatus) query.set('status', wantedStatus);
      query.set('sort', next?.sort ?? sort);
      const response = await fetch(`/api/feedback?${query.toString()}`);
      const payload = (await response.json().catch(() => null)) as {
        items?: UiFeedbackItem[];
        counts?: Counts;
        error?: string;
      } | null;
      if (!response.ok || !payload?.items || !payload.counts) {
        throw new Error(payload?.error ?? `Could not read feedback (${response.status})`);
      }
      setItems(payload.items);
      setCounts(payload.counts);
    },
    [type, status, sort],
  );

  useEffect(() => setReady(true), []);

  /**
   * A filter change is one server read, not a client-side narrowing: the list
   * and the counts have to be answers to the same question.
   */
  const applyFilter = (next: { type?: string; status?: string; sort?: 'newest' | 'votes' }) => {
    if (next.type !== undefined) setType(next.type);
    if (next.status !== undefined) setStatus(next.status);
    if (next.sort !== undefined) setSort(next.sort);
    setMessage('');
    void reload(next).catch((error: unknown) =>
      setMessage(error instanceof Error ? error.message : 'Could not read feedback'),
    );
  };

  const vote = async (item: UiFeedbackItem) => {
    setMessage('');
    try {
      const response = await fetch(`/api/feedback/${item.id}/vote`, { method: 'POST' });
      const payload = (await response.json().catch(() => null)) as {
        voted?: boolean;
        votes?: number;
        error?: string;
      } | null;
      if (!response.ok || payload?.votes === undefined) {
        throw new Error(payload?.error ?? `Vote failed (${response.status})`);
      }
      setItems((current) =>
        current.map((row) =>
          row.id === item.id
            ? { ...row, votes: payload.votes ?? row.votes, viewerHasVoted: payload.voted ?? false }
            : row,
        ),
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Vote failed');
    }
  };

  const triage = async (
    item: UiFeedbackItem,
    changes: { status?: string; adminNote?: string; duplicateOf?: string },
  ) => {
    setMessage('');
    try {
      const response = await fetch(`/api/feedback/${item.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(changes),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? `Update failed (${response.status})`);
      await reload({});
      setMessage('Saved');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Update failed');
    }
  };

  return (
    <main style={page} data-interactive={ready ? 'true' : 'false'}>
      <h1 style={heading}>Feedback</h1>
      <p style={muted} data-testid="feedback-counts">
        {counts.openBugs} open bug{counts.openBugs === 1 ? '' : 's'} · {counts.openFeatures} open
        request{counts.openFeatures === 1 ? '' : 's'} · {counts.shipped} shipped ·{' '}
        {counts.declined} not planned
      </p>
      <p style={muted}>
        You are signed in as <strong data-testid="feedback-role">{role}</strong>.{' '}
        <a href="/feedback/new">File something new</a> · <a href="/roadmap">See the roadmap</a>
      </p>

      {message && <p role="status" style={banner(message === 'Saved' ? 'good' : 'bad')}>{message}</p>}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', margin: '1rem 0' }}>
        <label style={{ fontSize: '0.8125rem' }}>
          Type{' '}
          <select
            value={type}
            data-testid="filter-type"
            onChange={(event) => applyFilter({ type: event.target.value })}
          >
            <option value="">All</option>
            <option value="bug">Bugs</option>
            <option value="feature">Requests</option>
          </select>
        </label>
        <label style={{ fontSize: '0.8125rem' }}>
          Status{' '}
          <select
            value={status}
            data-testid="filter-status"
            onChange={(event) => applyFilter({ status: event.target.value })}
          >
            <option value="">All</option>
            {STATUSES.map((option) => (
              <option key={option} value={option}>
                {STATUS_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: '0.8125rem' }}>
          Sort{' '}
          <select
            value={sort}
            data-testid="filter-sort"
            onChange={(event) =>
              applyFilter({ sort: event.target.value === 'votes' ? 'votes' : 'newest' })
            }
          >
            <option value="newest">Newest</option>
            <option value="votes">Most votes</option>
          </select>
        </label>
      </div>

      <ul data-testid="feedback-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {items.map((item) => (
          <li
            key={item.id}
            id={`feedback-${item.id}`}
            style={card}
            data-testid="feedback-item"
            data-item-id={item.id}
          >
            <div style={{ alignItems: 'baseline', display: 'flex', gap: '0.5rem' }}>
              <button
                type="button"
                aria-label={`Vote for ${item.title}`}
                data-testid="vote-button"
                onClick={() => void vote(item)}
                style={{
                  ...button,
                  background: item.viewerHasVoted ? colors.goodBg : colors.subtle,
                  minWidth: '3.25rem',
                }}
              >
                ▲ <span data-testid="vote-count">{item.votes}</span>
              </button>
              <strong style={{ fontSize: '0.9375rem' }}>{item.title}</strong>
              <span style={muted} data-testid="item-type">
                {item.type}
              </span>
              {item.severity && (
                <span style={muted} data-testid="item-severity">
                  {item.severity}
                </span>
              )}
              <span style={muted} data-testid="item-status">
                {STATUS_LABELS[item.status] ?? item.status}
              </span>
            </div>
            {item.body && (
              <p style={{ fontSize: '0.875rem', margin: '0.5rem 0 0', whiteSpace: 'pre-wrap' }}>
                {item.body}
              </p>
            )}
            <p style={{ ...muted, margin: '0.5rem 0 0' }} data-testid="item-context">
              filed from {item.route ?? 'an unknown page'}
              {item.profileId ? ` · profile ${item.profileId}` : ''}
              {' · '}item <code data-testid="item-id">{item.id}</code>
            </p>
            {item.adminNote && (
              <p style={{ ...muted, margin: '0.25rem 0 0' }} data-testid="item-note">
                note: {item.adminNote}
              </p>
            )}
            {canTriage ? (
              <TriageControls item={item} onSave={triage} />
            ) : (
              <p style={{ ...muted, margin: '0.5rem 0 0' }} data-testid="triage-readonly">
                Only an owner or admin can change a status.
              </p>
            )}
          </li>
        ))}
      </ul>
      {items.length === 0 && <p data-testid="feedback-empty">Nothing matches this filter.</p>}
    </main>
  );
}

function TriageControls({
  item,
  onSave,
}: {
  item: UiFeedbackItem;
  onSave: (
    item: UiFeedbackItem,
    changes: { status?: string; adminNote?: string; duplicateOf?: string },
  ) => Promise<void>;
}) {
  const [status, setStatus] = useState(item.status);
  const [note, setNote] = useState(item.adminNote ?? '');
  const [duplicateOf, setDuplicateOf] = useState(item.duplicateOf ?? '');

  useEffect(() => {
    setStatus(item.status);
    setNote(item.adminNote ?? '');
    setDuplicateOf(item.duplicateOf ?? '');
  }, [item.status, item.adminNote, item.duplicateOf]);

  return (
    <div style={{ alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.625rem' }}>
      <select
        value={status}
        aria-label={`Status of ${item.title}`}
        data-testid="status-select"
        onChange={(event) => setStatus(event.target.value)}
      >
        {STATUSES.map((option) => (
          <option key={option} value={option}>
            {STATUS_LABELS[option]}
          </option>
        ))}
      </select>
      <input
        value={note}
        aria-label={`Admin note on ${item.title}`}
        data-testid="admin-note"
        placeholder="Admin note (shown on the roadmap)"
        onChange={(event) => setNote(event.target.value)}
        style={{
          border: `1px solid ${colors.border}`,
          borderRadius: '0.25rem',
          fontSize: '0.8125rem',
          padding: '0.25rem 0.375rem',
          width: '22rem',
        }}
      />
      <button
        type="button"
        data-testid="save-triage"
        style={button}
        onClick={() => void onSave(item, { status, adminNote: note })}
      >
        Save
      </button>
      {item.type === 'bug' ? (
        <span style={{ alignItems: 'center', display: 'inline-flex', gap: '0.375rem' }}>
          <input
            value={duplicateOf}
            aria-label={`Duplicate target for ${item.title}`}
            data-testid="duplicate-of"
            placeholder="Duplicate target item id"
            onChange={(event) => setDuplicateOf(event.target.value)}
            style={{
              border: `1px solid ${colors.border}`,
              borderRadius: '0.25rem',
              fontSize: '0.8125rem',
              padding: '0.25rem 0.375rem',
              width: '18rem',
            }}
          />
          <button
            type="button"
            data-testid="mark-duplicate"
            disabled={duplicateOf.trim() === '' || duplicateOf.trim() === item.id}
            style={button}
            onClick={() => void onSave(item, { duplicateOf: duplicateOf.trim() })}
          >
            Mark duplicate
          </button>
        </span>
      ) : null}
    </div>
  );
}
