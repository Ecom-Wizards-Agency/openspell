'use client';

import { useCallback, useState } from 'react';
import type { ReversionBatchPreview, ReversionRowPreview } from '@wizard-ads/shared';

export interface ReversionPanelProps {
  preview: ReversionBatchPreview;
  canExport: boolean;
}

const STATE_LABEL: Record<ReversionRowPreview['state'], string> = {
  awaiting_sync: 'Waiting for sync',
  ready: 'Ready',
  conflict: 'Conflict',
  already_reverted: 'Already original',
  unsupported: 'Unsupported',
  ambiguous: 'Ambiguous',
};

function value(value: ReversionRowPreview['originalValue'] | null): string {
  if (value === null) return '—';
  return String(value);
}

export function ReversionPanel({ preview, canExport }: ReversionPanelProps) {
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ rows: number; tag: string; download: string } | null>(null);

  const exportReversion = useCallback(async () => {
    setError(null);
    setResult(null);
    if (!confirmed) {
      setError('Tick “Yes, export reversion” before exporting.');
      return;
    }
    if (note.trim().length === 0) {
      setError('Add a note explaining why this reversion is being exported.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/time-machine/reversion', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          batchId: preview.batchId,
          profileId: preview.profileId,
          expectedRows: preview.readyRows,
          note,
          confirmation: 'Yes, export reversion',
        }),
      });
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(payload['error'] ?? response.statusText));
      const downloads = payload['downloads'] as Record<string, string>;
      setResult({
        rows: Number(payload['rows']),
        tag: String(payload['tag']),
        download: downloads['rows'] ?? '',
      });
      setConfirmed(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Reversion export failed');
    } finally {
      setBusy(false);
    }
  }, [confirmed, note, preview.batchId, preview.profileId, preview.readyRows]);

  return (
    <section className="wa-tm-review" aria-labelledby="reversion-title" data-testid="reversion-preview">
      <header className="wa-tm-review__head">
        <div>
          <span className="wa-label">Reversion review</span>
          <h2 id="reversion-title">{preview.tag}</h2>
          <p>{preview.optGroup} · {preview.lever} · {preview.lifecycleStatus.replaceAll('_', ' ')}</p>
        </div>
        <div className={`wa-tm-verdict${preview.exportAllowed ? ' is-ready' : ' is-blocked'}`}>
          <strong>{preview.exportAllowed ? `${preview.readyRows} ready` : `${preview.blockedRows} blocked`}</strong>
          <span>{preview.reason}</span>
        </div>
      </header>

      <div className="wa-tm-guardrails" role="note">
        <strong>Guardrails</strong>
        <span>Every row must have one uniquely linked sync observation.</span>
        <span>The current mirror must still equal the exported value.</span>
        <span>This creates a review file only. Wizard Ads does not update Amazon.</span>
      </div>

      <div className="wa-tablewrap">
        <table className="wa-table wa-table--dense wa-tm-table">
          <thead>
            <tr>
              <th>Entity / field</th>
              <th>Original</th>
              <th>Exported</th>
              <th>Synchronized</th>
              <th>Current</th>
              <th>Inverse</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row) => (
              <tr key={row.rowId} data-testid="reversion-row" data-state={row.state}>
                <td>
                  <strong>{row.entityName ?? row.entityId}</strong>
                  <small>{row.entityType} · {row.field} · {row.entityId}</small>
                </td>
                <td><code>{value(row.originalValue)}</code></td>
                <td><code>{value(row.exportedValue)}</code></td>
                <td><code>{value(row.synchronizedValue)}</code></td>
                <td><code>{value(row.currentValue)}</code></td>
                <td><code>{value(row.inverseValue)}</code></td>
                <td title={row.reason}>
                  <span className={`wa-tm-state wa-tm-state--${row.state}`}>{STATE_LABEL[row.state]}</span>
                  <small>{row.reason}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <footer className="wa-tm-export">
        <label>
          Reversion note
          <textarea
            className="wa-textarea"
            rows={2}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Why should this batch return to its original values?"
            disabled={!preview.exportAllowed || !canExport || busy}
          />
        </label>
        <div className="wa-tm-export__action">
          <label className="wa-tm-confirm">
            <input
              className="wa-checkbox"
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              disabled={!preview.exportAllowed || !canExport || busy}
            />
            Yes, export reversion
          </label>
          <button
            className="wa-btn wa-btn--primary"
            type="button"
            onClick={() => void exportReversion()}
            disabled={!preview.exportAllowed || !canExport || busy}
            data-testid="export-reversion"
          >
            {busy ? 'Re-checking evidence…' : `Export ${preview.readyRows} inverse change${preview.readyRows === 1 ? '' : 's'}`}
          </button>
          {!canExport ? <small>Your role may inspect evidence but cannot export changes.</small> : null}
        </div>
      </footer>

      {error === null ? null : <p className="wa-notice wa-notice--error" role="alert">{error}</p>}
      {result === null ? null : (
        <p className="wa-notice" role="status" data-testid="reversion-result">
          Exported {result.rows} inverse change{result.rows === 1 ? '' : 's'} as {result.tag}.{' '}
          <a href={result.download}>Download inverse rows JSON</a>. Amazon was not updated.
        </p>
      )}
    </section>
  );
}
