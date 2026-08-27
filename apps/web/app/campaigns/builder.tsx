'use client';

/** Interactive JSON-paste shell around the two pure campaign-builder modes. */
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { BulkRow } from '@wizard-ads/campaigns';
import type {
  CampaignBuilderMode,
  CampaignBuilderPreview,
} from '../../src/campaigns/artifact';
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  TableFrame,
  Textarea,
} from '../../src/ui/primitives';

export interface CampaignBuilderProps {
  profileId: string | null;
  profileLabel: string;
  marketplace: string;
}

function createSample(client: string, marketplace: string): string {
  return JSON.stringify({
    client,
    marketplace,
    naming: {
      variableOrder: ['Goal', 'AdType', 'MatchType', 'TriggerWord', 'ProductName', 'Keyword', 'CampCounter', 'EW'],
      delimiter: ' | ',
      suffix: 'EW',
      custom1Value: '',
      custom2Value: '',
    },
    defaults: { dailyBudget: 10, keywordBid: 0.5, state: 'paused' },
    campaigns: [{
      campaignType: 'Halo',
      productName: 'Product name',
      targetDescriptor: 'long-tail',
      sku: ['SKU'],
      keywords: ['keyword'],
    }],
  }, null, 2);
}

function updateSample(): string {
  return JSON.stringify({
    allowEndDateClear: false,
    changes: {
      campaigns: [{ campaignId: '123456789012345', dailyBudget: 25 }],
    },
  }, null, 2);
}

const ID_COLUMNS = [
  'Keyword ID',
  'Product Targeting ID',
  'Ad ID',
  'Ad Group ID',
  'Campaign ID',
] as const;

const CONTROL_COLUMNS = new Set([
  'Product',
  'Entity',
  'Operation',
  ...ID_COLUMNS,
]);

export function updateRowId(row: BulkRow): string {
  for (const column of ID_COLUMNS) {
    const value = String(row[column] ?? '').trim();
    if (value) return value;
  }
  return '—';
}

export function updateRowDetails(row: BulkRow): string {
  const values = Object.entries(row)
    .filter(([column, value]) => !CONTROL_COLUMNS.has(column) && String(value).trim() !== '')
    .map(([column, value]) => `${column}: ${String(value)}`);
  return values.join(' · ') || 'ID-only archive';
}

function responseFilename(response: Response): string {
  const disposition = response.headers.get('content-disposition') ?? '';
  return /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'campaign-bulk.xlsx';
}

export function CampaignBuilder({
  profileId,
  profileLabel,
  marketplace,
}: CampaignBuilderProps): ReactNode {
  const [mode, setMode] = useState<CampaignBuilderMode>('update');
  const [document, setDocument] = useState(updateSample());
  const [preview, setPreview] = useState<CampaignBuilderPreview | null>(null);
  const [busy, setBusy] = useState<'preview' | 'xlsx' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectMode = (next: CampaignBuilderMode): void => {
    setMode(next);
    setDocument(next === 'create' ? createSample(profileLabel, marketplace) : updateSample());
    setPreview(null);
    setError(null);
  };

  const request = async (output: 'preview' | 'xlsx'): Promise<void> => {
    setBusy(output);
    setError(null);
    try {
      let config: unknown;
      try {
        config = JSON.parse(document) as unknown;
      } catch {
        throw new Error('The builder input is not valid JSON.');
      }
      const response = await fetch('/api/campaigns/build', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, output, profileId, config }),
      });
      if (output === 'preview') {
        const body = (await response.json()) as CampaignBuilderPreview | { error?: string };
        if (!response.ok || !('rows' in body)) {
          throw new Error('error' in body && body.error ? body.error : 'Preflight failed');
        }
        setPreview(body);
        return;
      }
      if (!response.ok) {
        const body = (await response.json()) as { error?: string; preview?: CampaignBuilderPreview };
        if (body.preview !== undefined) setPreview(body.preview);
        throw new Error(body.error ?? 'Workbook export failed');
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = window.document.createElement('a');
      anchor.href = url;
      anchor.download = responseFilename(response);
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Campaign Builder failed');
    } finally {
      setBusy(null);
    }
  };

  const updateWithoutProfile = mode === 'update' && profileId === null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* Underline tabs like /settings, not primary buttons: Signal Orange is
          reserved for the one action per view (Run preflight), and a selected
          mode is a state, not a call to action. */}
      <div aria-label="Campaign builder mode" role="tablist" className="wa-tabs">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'create'}
          aria-current={mode === 'create' ? 'page' : undefined}
          className="wa-tab wa-tab--btn"
          onClick={() => selectMode('create')}
        >
          Create new
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'update'}
          aria-current={mode === 'update' ? 'page' : undefined}
          className="wa-tab wa-tab--btn"
          onClick={() => selectMode('update')}
        >
          Update existing
        </button>
      </div>

      {updateWithoutProfile ? (
        <EmptyState
          title="Choose a synced profile"
          body="UPDATE mode resolves every campaign, ad group, keyword, target, negative, and product ad against that profile's latest entity mirror."
          action={<a className="wa-btn wa-btn--sm" href="/settings/profiles">Open profiles</a>}
        />
      ) : (
        <Card
          title={mode === 'update' ? 'Desired changes JSON' : 'New campaign plan JSON'}
          subtitle={
            mode === 'update'
              ? `Diffed against ${profileLabel} (${marketplace}). IDs must come from this synced profile.`
              : 'CREATE mode keeps the existing paused-by-default campaign plan semantics.'
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
            <Field
              label="Campaign builder JSON"
              hideLabel
              htmlFor="campaign-builder-json"
              hint={
                mode === 'update'
                  ? 'Blank fields mean leave unchanged. Clearing End Date needs both clearEndDate and allowEndDateClear.'
                  : 'The pasted document uses the same shape as @wizard-ads/campaigns CREATE mode.'
              }
            >
              <Textarea
                id="campaign-builder-json"
                data-testid="campaign-builder-json"
                rows={20}
                spellCheck={false}
                value={document}
                onChange={(event) => {
                  setDocument(event.target.value);
                  setPreview(null);
                  setError(null);
                }}
                style={{ fontFamily: 'var(--wa-font-mono)', lineHeight: 1.5, width: '100%' }}
              />
            </Field>
            <div className="wa-row">
              <Button
                variant="primary"
                disabled={busy !== null}
                onClick={() => void request('preview')}
              >
                {busy === 'preview' ? 'Checking…' : 'Run preflight'}
              </Button>
              <Button
                disabled={busy !== null || preview?.exportable !== true}
                onClick={() => void request('xlsx')}
              >
                {busy === 'xlsx' ? 'Building…' : 'Download bulksheet'}
              </Button>
              <span className="wa-hint">
                File only · no Amazon API write
              </span>
            </div>
          </div>
        </Card>
      )}

      {error === null ? null : <Banner tone="bad" role="alert">{error}</Banner>}

      {preview === null ? null : (
        <Card
          title="Preflight diff"
          subtitle={`${preview.rows.length} bulksheet row(s) · every row shown below`}
          actions={
            <div className="wa-row">
              <Badge tone={preview.ready ? 'good' : 'bad'} dot>
                {preview.ready ? 'Ready' : 'Blocked'}
              </Badge>
              <Badge>{preview.counts.update} update</Badge>
              <Badge>{preview.counts.archive} archive</Badge>
              <Badge>{preview.counts.create} create</Badge>
            </div>
          }
          flush
        >
          {preview.issues.length === 0 ? null : (
            <div style={{ padding: '1rem 1rem 0' }}>
              {preview.issues.map((issue) => <Banner key={issue} tone="bad">{issue}</Banner>)}
            </div>
          )}
          {preview.rows.length === 0 ? (
            <EmptyState
              title="No effective rows"
              body="Every requested change was a no-op, cascade skip, or blocked by preflight. Nothing can be downloaded yet."
            />
          ) : (
            <TableFrame data-testid="campaign-update-rows">
              <table className="wa-table">
                <thead>
                  <tr><th>Action</th><th>Entity</th><th>Amazon / temp ID</th><th>Row fields</th></tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, index) => (
                    <tr key={`${row.Operation}-${row.Entity}-${updateRowId(row)}-${index}`}>
                      <td>
                        <Badge tone={row.Operation === 'Archive' ? 'bad' : row.Operation === 'Create' ? 'info' : 'warn'}>
                          {row.Operation}
                        </Badge>
                      </td>
                      <td>{row.Entity}</td>
                      <td><code>{updateRowId(row)}</code></td>
                      <td>{updateRowDetails(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
          )}
          {preview.review.length === 0 ? null : (
            <details style={{ margin: '1rem' }}>
              <summary>Plain-English review ({preview.review.length})</summary>
              <ul>
                {preview.review.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}
              </ul>
            </details>
          )}
        </Card>
      )}
    </div>
  );
}
