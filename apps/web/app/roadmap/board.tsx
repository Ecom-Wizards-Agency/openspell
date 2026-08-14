'use client';

/**
 * Three columns, ordered by votes, with the vote toggle on the card.
 *
 * The order comes from the server (the query sorts on the vote count), and a
 * vote cast here updates the count in place rather than resorting under the
 * reader's cursor: a list that reorders while you are clicking it is how a
 * second vote lands on the wrong card. The new order is what the next load
 * shows.
 */
import { useEffect, useState } from 'react';
import type { UiFeedbackItem } from '../../src/feedback/ui';
import { banner, button, colors, heading, muted, page } from '../../src/ui/tokens';

interface BoardProps {
  planned: UiFeedbackItem[];
  inProgress: UiFeedbackItem[];
  shipped: UiFeedbackItem[];
  declined: UiFeedbackItem[];
}

const COLUMNS: { key: keyof BoardProps; title: string; testId: string }[] = [
  { key: 'planned', title: 'Planned', testId: 'column-planned' },
  { key: 'inProgress', title: 'In progress', testId: 'column-in-progress' },
  { key: 'shipped', title: 'Shipped', testId: 'column-shipped' },
];

export function RoadmapBoardView(initial: BoardProps) {
  const [board, setBoard] = useState<BoardProps>(initial);
  const [message, setMessage] = useState('');
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

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
      const apply = (items: UiFeedbackItem[]) =>
        items.map((row) =>
          row.id === item.id
            ? { ...row, votes: payload.votes ?? row.votes, viewerHasVoted: payload.voted ?? false }
            : row,
        );
      setBoard((current) => ({
        planned: apply(current.planned),
        inProgress: apply(current.inProgress),
        shipped: apply(current.shipped),
        declined: apply(current.declined),
      }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Vote failed');
    }
  };

  return (
    <main style={page} data-interactive={ready ? 'true' : 'false'}>
      <h1 style={heading}>Roadmap</h1>
      <p style={muted}>
        Fed by the same items as <a href="/feedback">the tracker</a>, ordered by votes. A card moves
        when an admin moves its status.
      </p>
      {message && <p role="status" style={banner('bad')}>{message}</p>}

      <div
        style={{
          display: 'grid',
          gap: '1rem',
          gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))',
          marginTop: '1rem',
        }}
      >
        {COLUMNS.map((column) => {
          const items = board[column.key];
          return (
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
                {column.title} <span style={muted}>({items.length})</span>
              </h2>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {items.map((item) => (
                  <li
                    key={item.id}
                    data-testid="roadmap-card"
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
                        onClick={() => void vote(item)}
                        style={{
                          ...button,
                          background: item.viewerHasVoted ? colors.goodBg : colors.subtle,
                          minWidth: '3.25rem',
                        }}
                      >
                        ▲ <span data-testid="vote-count">{item.votes}</span>
                      </button>
                      <strong style={{ fontSize: '0.875rem' }}>{item.title}</strong>
                    </div>
                    <p style={{ ...muted, margin: '0.375rem 0 0' }}>{item.type}</p>
                  </li>
                ))}
              </ul>
              {items.length === 0 && <p style={muted}>Nothing here yet.</p>}
            </section>
          );
        })}
      </div>

      <details style={{ marginTop: '1.5rem' }} data-testid="not-planned">
        <summary style={{ cursor: 'pointer', fontSize: '0.9375rem' }}>
          Not planned ({board.declined.length})
        </summary>
        <ul style={{ listStyle: 'none', margin: '0.75rem 0 0', padding: 0 }}>
          {board.declined.map((item) => (
            <li
              key={item.id}
              data-testid="declined-card"
              data-item-id={item.id}
              style={{
                border: `1px solid ${colors.border}`,
                borderRadius: '0.375rem',
                marginBottom: '0.5rem',
                padding: '0.625rem 0.75rem',
              }}
            >
              <strong style={{ fontSize: '0.875rem' }}>{item.title}</strong>
              <p style={{ ...muted, margin: '0.375rem 0 0' }} data-testid="declined-note">
                {item.adminNote ?? 'No reason recorded yet.'}
              </p>
            </li>
          ))}
        </ul>
        {board.declined.length === 0 && <p style={muted}>Nothing has been declined.</p>}
      </details>
    </main>
  );
}
