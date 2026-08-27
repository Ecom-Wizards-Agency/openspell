'use client';

import { useEffect, useState } from 'react';
import { FeedbackTriageControls } from '../../src/feedback/triage-controls';
import type { FeedbackTriageChanges } from '../../src/feedback/triage-controls';
import type { UiFeedbackItem } from '../../src/feedback/ui';
import { banner, button, colors, heading, muted, page } from '../../src/ui/tokens';

export interface BugBoardProps {
  open: UiFeedbackItem[];
  inProgress: UiFeedbackItem[];
  fixed: UiFeedbackItem[];
  declined: UiFeedbackItem[];
  duplicates: UiFeedbackItem[];
  canTriage: boolean;
}

const COLUMNS: { key: 'open' | 'inProgress' | 'fixed'; title: string; testId: string }[] = [
  { key: 'open', title: 'Open', testId: 'column-open' },
  { key: 'inProgress', title: 'In progress', testId: 'column-in-progress' },
  { key: 'fixed', title: 'Fixed', testId: 'column-fixed' },
];

export function BugBoardView(initial: BugBoardProps) {
  const [board, setBoard] = useState(initial);
  const [message, setMessage] = useState('');
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  const vote = async (item: UiFeedbackItem): Promise<void> => {
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
      const apply = (items: UiFeedbackItem[]): UiFeedbackItem[] =>
        items.map((row) =>
          row.id === item.id
            ? { ...row, votes: payload.votes ?? row.votes, viewerHasVoted: payload.voted ?? false }
            : row,
        );
      setBoard((current) => ({
        open: apply(current.open),
        inProgress: apply(current.inProgress),
        fixed: apply(current.fixed),
        declined: apply(current.declined),
        duplicates: apply(current.duplicates),
        canTriage: current.canTriage,
      }));
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Vote failed');
    }
  };

  const triage = async (item: UiFeedbackItem, changes: FeedbackTriageChanges): Promise<void> => {
    setMessage('');
    try {
      const response = await fetch(`/api/feedback/${item.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(changes),
      });
      const payload = (await response.json().catch(() => null)) as {
        item?: Partial<UiFeedbackItem>;
        error?: string;
      } | null;
      if (!response.ok || !payload?.item) {
        throw new Error(payload?.error ?? `Update failed (${response.status})`);
      }
      setBoard((current) => regroupBugs(current, { ...item, ...payload.item }));
      setMessage('Saved');
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Update failed');
    }
  };

  const targetIds = new Set(
    [...board.open, ...board.inProgress, ...board.fixed, ...board.declined].map((item) => item.id),
  );
  const ungroupedDuplicates = board.duplicates.filter(
    (item) => item.duplicateOf === null || !targetIds.has(item.duplicateOf),
  );

  return (
    <main style={page} data-interactive={ready ? 'true' : 'false'}>
      <h1 style={heading}>Bugs</h1>
      <p style={muted}>
        Operational failures, ordered by votes. Check here before filing so an existing report can
        collect the vote instead. <a href="/feedback/new?type=bug">Report a bug</a>
      </p>
      {message === '' ? null : (
        <p role="status" style={banner(message === 'Saved' ? 'good' : 'bad')}>
          {message}
        </p>
      )}

      <div
        style={{
          display: 'grid',
          gap: '1rem',
          gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))',
          marginTop: '1rem',
        }}
      >
        {COLUMNS.map((column) => (
          <section
            key={column.key}
            aria-label={column.title}
            data-testid={column.testId}
            style={{
              background: colors.subtle,
              border: `1px solid ${colors.border}`,
              borderRadius: '0.5rem',
              // Grid children default to min-width auto; without 0 an overlong
              // card overflows under the neighbouring column, which then
              // swallows its clicks.
              minWidth: 0,
              overflow: 'hidden',
              padding: '0.75rem',
            }}
          >
            <h2 style={{ fontSize: '0.9375rem', margin: '0 0 0.5rem' }}>
              {column.title} <span style={muted}>({board[column.key].length})</span>
            </h2>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {board[column.key].map((item) => (
                <BugCard
                  key={item.id}
                  item={item}
                  duplicates={board.duplicates.filter((row) => row.duplicateOf === item.id)}
                  onVote={vote}
                  onTriage={triage}
                  canTriage={initial.canTriage}
                />
              ))}
            </ul>
            {board[column.key].length === 0 ? <p style={muted}>Nothing here yet.</p> : null}
          </section>
        ))}
      </div>

      <details style={{ marginTop: '1.5rem' }} data-testid="declined-duplicates">
        <summary style={{ cursor: 'pointer', fontSize: '0.9375rem' }}>
          Declined / duplicate ({board.declined.length + board.duplicates.length})
        </summary>
        <ul style={{ listStyle: 'none', margin: '0.75rem 0 0', padding: 0 }}>
          {board.declined.map((item) => (
            <BugCard
              key={item.id}
              item={item}
              duplicates={board.duplicates.filter((row) => row.duplicateOf === item.id)}
              onVote={vote}
              onTriage={triage}
              canTriage={initial.canTriage}
            />
          ))}
        </ul>
        {board.declined.length === 0 && board.duplicates.length === 0 ? (
          <p style={muted}>Nothing has been declined or marked duplicate.</p>
        ) : null}
        {ungroupedDuplicates.length === 0 ? null : (
          <div>
            <h3 style={{ fontSize: '0.875rem' }}>Duplicates whose target is unavailable</h3>
            <ul>
              {ungroupedDuplicates.map((item) => (
                <BugCard
                  key={item.id}
                  item={item}
                  duplicates={[]}
                  onVote={vote}
                  onTriage={triage}
                  canTriage={initial.canTriage}
                  duplicateCard
                />
              ))}
            </ul>
          </div>
        )}
      </details>
    </main>
  );
}

function BugCard({
  item,
  duplicates,
  onVote,
  onTriage,
  canTriage,
  duplicateCard = false,
}: {
  item: UiFeedbackItem;
  duplicates: UiFeedbackItem[];
  onVote: (item: UiFeedbackItem) => Promise<void>;
  onTriage: (item: UiFeedbackItem, changes: FeedbackTriageChanges) => Promise<void>;
  canTriage: boolean;
  duplicateCard?: boolean;
}) {
  return (
    <li
      id={`bug-${item.id}`}
      data-testid={duplicateCard ? 'duplicate-card' : 'bug-card'}
      data-item-id={item.id}
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: '0.375rem',
        marginBottom: '0.5rem',
        padding: '0.625rem 0.75rem',
      }}
    >
      <div style={{ alignItems: 'baseline', display: 'flex', gap: '0.5rem' }}>
        <button
          type="button"
          aria-label={`Vote for ${item.title}`}
          data-testid="vote-button"
          onClick={() => void onVote(item)}
          style={{
            ...button,
            background: item.viewerHasVoted ? colors.goodBg : colors.subtle,
            minWidth: '3.25rem',
          }}
        >
          ▲ <span data-testid="vote-count">{item.votes}</span>
        </button>
        <strong style={{ fontSize: '0.875rem', fontWeight: 650 }}>
          {item.title}
        </strong>
      </div>
      <p style={{ ...muted, margin: '0.375rem 0 0' }} data-testid="item-severity">
        {item.severity ?? 'severity not set'}
        {item.adminNote ? ` · ${item.adminNote}` : ''}
      </p>
      {item.body ? (
        <p style={{ fontSize: '0.875rem', margin: '0.375rem 0 0', whiteSpace: 'pre-wrap' }}>
          {item.body}
        </p>
      ) : null}
      <p style={{ ...muted, margin: '0.375rem 0 0' }} data-testid="item-context">
        filed from {item.route ?? 'an unknown page'} {' · '}item{' '}
        <code data-testid="item-id">{item.id}</code>
      </p>
      {canTriage ? (
        <FeedbackTriageControls
          item={item}
          allowDuplicate={item.duplicateOf === null}
          onSave={onTriage}
        />
      ) : (
        <p style={{ ...muted, margin: '0.5rem 0 0' }} data-testid="triage-readonly">
          Only an owner or admin can triage a bug.
        </p>
      )}
      {duplicates.length === 0 ? null : (
        <details data-testid="duplicate-group" style={{ marginTop: '0.5rem' }}>
          <summary style={{ cursor: 'pointer', fontSize: '0.8125rem' }}>
            Duplicates ({duplicates.length})
          </summary>
          <ul style={{ margin: '0.375rem 0 0', paddingLeft: '1.25rem' }}>
            {duplicates.map((duplicate) => (
              <BugCard
                key={duplicate.id}
                item={duplicate}
                duplicates={[]}
                onVote={onVote}
                onTriage={onTriage}
                canTriage={canTriage}
                duplicateCard
              />
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

function regroupBugs(current: BugBoardProps, saved: UiFeedbackItem): BugBoardProps {
  const byId = new Map<string, UiFeedbackItem>();
  for (const row of [
    ...current.open,
    ...current.inProgress,
    ...current.fixed,
    ...current.declined,
    ...current.duplicates,
  ]) {
    byId.set(row.id, row.id === saved.id ? saved : row);
  }
  byId.set(saved.id, saved);
  const items = [...byId.values()];
  const ordinary = items.filter((row) => row.duplicateOf === null);
  return {
    canTriage: current.canTriage,
    open: ordinary.filter((row) => row.status === 'new' || row.status === 'triaged'),
    inProgress: ordinary.filter(
      (row) => row.status === 'planned' || row.status === 'in_progress',
    ),
    fixed: ordinary.filter((row) => row.status === 'shipped'),
    declined: ordinary.filter((row) => row.status === 'declined'),
    duplicates: items.filter((row) => row.duplicateOf !== null),
  };
}
