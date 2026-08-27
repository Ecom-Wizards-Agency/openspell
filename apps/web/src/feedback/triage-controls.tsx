'use client';

import { useEffect, useState } from 'react';
import type { FeedbackStatus } from '@wizard-ads/db';
import type { UiFeedbackItem } from './ui';
import { STATUS_LABELS } from './ui';
import { button, colors } from '../ui/tokens';

const STATUSES = [
  'new',
  'triaged',
  'planned',
  'in_progress',
  'shipped',
  'declined',
] as const satisfies readonly FeedbackStatus[];

export interface FeedbackTriageChanges {
  status?: FeedbackStatus;
  adminNote?: string;
  duplicateOf?: string;
}

export function FeedbackTriageControls({
  item,
  allowDuplicate = false,
  onSave,
}: {
  item: UiFeedbackItem;
  allowDuplicate?: boolean;
  onSave: (item: UiFeedbackItem, changes: FeedbackTriageChanges) => Promise<void>;
}) {
  const [status, setStatus] = useState<FeedbackStatus>(item.status as FeedbackStatus);
  const [note, setNote] = useState(item.adminNote ?? '');
  const [duplicateOf, setDuplicateOf] = useState(item.duplicateOf ?? '');

  useEffect(() => {
    setStatus(item.status as FeedbackStatus);
    setNote(item.adminNote ?? '');
    setDuplicateOf(item.duplicateOf ?? '');
  }, [item.status, item.adminNote, item.duplicateOf]);

  return (
    <div
      style={{
        alignItems: 'center',
        display: 'flex',
        flexWrap: 'wrap',
        gap: '0.5rem',
        marginTop: '0.625rem',
      }}
    >
      <select
        value={status}
        aria-label={`Status of ${item.title}`}
        data-testid="status-select"
        onChange={(event) => setStatus(event.target.value as FeedbackStatus)}
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
        placeholder="Admin note"
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
      {allowDuplicate ? (
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
