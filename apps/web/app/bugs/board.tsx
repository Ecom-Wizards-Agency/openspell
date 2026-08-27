'use client';

import { useEffect, useState } from 'react';
import type { UiFeedbackItem } from '../../src/feedback/ui';
import { banner, button, colors, heading, muted, page } from '../../src/ui/tokens';

export interface BugBoardProps {
  open: UiFeedbackItem[];
  inProgress: UiFeedbackItem[];
  fixed: UiFeedbackItem[];
  declined: UiFeedbackItem[];
  duplicates: UiFeedbackItem[];
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
      }));
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Vote failed');
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
        Known bugs from <a href="/feedback">the tracker</a>, ordered by votes. Check here before
        filing so an existing report can collect the vote instead.
      </p>
      {message === '' ? null : <p role="status" style={banner('bad')}>{message}</p>}

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
                <li key={item.id} data-testid="duplicate-card" data-item-id={item.id}>
                  <a href={`/feedback#feedback-${item.id}`}>{item.title}</a>
                </li>
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
}: {
  item: UiFeedbackItem;
  duplicates: UiFeedbackItem[];
  onVote: (item: UiFeedbackItem) => Promise<void>;
}) {
  return (
    <li
      id={`bug-${item.id}`}
      data-testid="bug-card"
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
        <a href={`/feedback#feedback-${item.id}`} style={{ fontSize: '0.875rem', fontWeight: 650 }}>
          {item.title}
        </a>
      </div>
      <p style={{ ...muted, margin: '0.375rem 0 0' }}>
        {item.severity ?? 'severity not set'}
        {item.adminNote ? ` · ${item.adminNote}` : ''}
      </p>
      {duplicates.length === 0 ? null : (
        <details data-testid="duplicate-group" style={{ marginTop: '0.5rem' }}>
          <summary style={{ cursor: 'pointer', fontSize: '0.8125rem' }}>
            Duplicates ({duplicates.length})
          </summary>
          <ul style={{ margin: '0.375rem 0 0', paddingLeft: '1.25rem' }}>
            {duplicates.map((duplicate) => (
              <li key={duplicate.id} data-testid="duplicate-card" data-item-id={duplicate.id}>
                <a href={`/feedback#feedback-${duplicate.id}`}>{duplicate.title}</a>
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}
