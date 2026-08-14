'use client';

/**
 * The n-gram explorer's interactive half.
 *
 * Aggregation runs here, in `@wizard-ads/core`, over the search-term rows the
 * server shipped once. That is what makes the uni/bi/tri toggle, the scope
 * selector and the click floor instant: they re-run a pure function over rows
 * already in memory rather than asking the server the same question again.
 *
 * The grid is WP-06's `DataGrid`, consumed as-is. An n-gram set is exactly what
 * that component is for — sort by spend, scan, narrow — and a second table
 * would be a second set of bugs.
 *
 * "Propose as negative" opens the terms behind a gram rather than negating the
 * gram itself, because you cannot negate a gram: you negate the terms that
 * contain it, in the ad groups they ran in. And it proposes. It never writes.
 */
import { useCallback, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { aggregateNgrams, tokenize } from '@wizard-ads/core';
import type { SearchTermRow } from '@wizard-ads/core';
import { DataGrid } from '@wizard-ads/ui';
import type { GridRow, SortRule } from '@wizard-ads/ui';
import { buildGridModelSafely } from '@wizard-ads/ui';
import { DEFAULT_NGRAM_COLUMNS, GRAM_SIZES, GRAM_SIZE_LABELS, ngramColumns, toGridRows } from '../../src/ngrams/rows';
import type { GramSize } from '../../src/ngrams/rows';
import type { ScopeOption } from '../../src/ngrams/data';

export interface NgramExplorerProps {
  rows: readonly SearchTermRow[];
  scopes: { campaigns: ScopeOption[]; tags: ScopeOption[] };
  profileId: string;
  currencyCode: string;
  period: { start: string; end: string };
}

const MATCH_TYPES = [
  { value: 'negative_exact', label: 'Negative exact' },
  { value: 'negative_phrase', label: 'Negative phrase' },
];

export function NgramExplorer(props: NgramExplorerProps): ReactNode {
  const [size, setSize] = useState<GramSize>(2);
  const [minClicks, setMinClicks] = useState(0);
  const [scopeId, setScopeId] = useState('profile');
  const [sort, setSort] = useState<SortRule[]>([{ columnId: 'spend', direction: 'desc' }]);
  const [gram, setGram] = useState<string | null>(null);
  const [selectedTerms, setSelectedTerms] = useState<ReadonlySet<string>>(new Set());
  const [matchType, setMatchType] = useState('negative_exact');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scopeCampaigns = useMemo(() => {
    if (scopeId === 'profile') return null;
    const [kind, id] = scopeId.split(':') as [string, string];
    const source = kind === 'tag' ? props.scopes.tags : props.scopes.campaigns;
    return source.find((scope) => scope.id === id)?.campaignIds ?? [];
  }, [props.scopes, scopeId]);

  const scopedRows = useMemo(() => {
    if (scopeCampaigns === null) return props.rows;
    const allowed = new Set(scopeCampaigns);
    return props.rows.filter((row) => row.campaignId !== undefined && allowed.has(row.campaignId));
  }, [props.rows, scopeCampaigns]);

  const ngrams = useMemo(
    () => aggregateNgrams([...scopedRows], { sizes: [size], minClicks }),
    [minClicks, scopedRows, size],
  );

  const gridRows = useMemo(() => toGridRows(ngrams, props.currencyCode), [ngrams, props.currencyCode]);
  const columns = useMemo(() => {
    const all = ngramColumns();
    const byId = new Map(all.map((column) => [column.id, column]));
    return DEFAULT_NGRAM_COLUMNS.map((id) => byId.get(id)).filter(
      (column): column is NonNullable<typeof column> => column !== undefined,
    );
  }, []);

  const { model } = useMemo(
    () => buildGridModelSafely(gridRows, { filter: { groups: [] }, sort, groupBy: [] }),
    [gridRows, sort],
  );

  /** The terms behind the selected gram, in the current scope. */
  const terms = useMemo(() => {
    if (gram === null) return [];
    const wanted = gram.split(' ');
    return scopedRows
      .filter((row) => {
        const tokens = tokenize(row.searchTerm);
        for (let i = 0; i + wanted.length <= tokens.length; i += 1) {
          if (wanted.every((token, offset) => tokens[i + offset] === token)) return true;
        }
        return false;
      })
      .sort((a, b) => b.cost - a.cost);
  }, [gram, scopedRows]);

  const termKey = useCallback(
    (row: SearchTermRow) => `${row.campaignId ?? ''}|${row.adGroupId ?? ''}|${row.searchTerm}`,
    [],
  );

  const propose = useCallback(async () => {
    setError(null);
    setMessage(null);
    const chosen = terms.filter((row) => selectedTerms.has(termKey(row)));
    if (chosen.length === 0) {
      setError('Select at least one search term.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/ngrams/negatives', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profileId: props.profileId,
          window: props.period,
          proposals: chosen.map((row) => ({
            searchTerm: row.searchTerm,
            campaignId: row.campaignId,
            adGroupId: row.adGroupId ?? null,
            matchType,
            clicks: row.clicks,
            rpc: row.clicks > 0 ? row.sales7d / row.clicks : null,
          })),
        }),
      });
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(payload['error'] ?? response.statusText));
      setMessage(
        `Proposed ${String(payload['created'])} of ${String(payload['offered'])} negatives. They are ` +
          'proposals: review and export them from the recommendations screen. Nothing was negated.',
      );
      setSelectedTerms(new Set());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Proposal failed');
    } finally {
      setBusy(false);
    }
  }, [matchType, props.period, props.profileId, selectedTerms, termKey, terms]);

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <fieldset style={panel}>
        <legend style={legend}>Grams</legend>
        <div role="group" aria-label="Gram size" style={{ display: 'flex', gap: '0.375rem' }}>
          {GRAM_SIZES.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={size === value}
              onClick={() => {
                setSize(value);
                setGram(null);
              }}
              style={{ fontWeight: size === value ? 600 : 400 }}
            >
              {GRAM_SIZE_LABELS[value]}
            </button>
          ))}
        </div>
        <label style={label}>
          Scope
          <select
            value={scopeId}
            onChange={(event) => {
              setScopeId(event.target.value);
              setGram(null);
            }}
          >
            <option value="profile">Whole profile</option>
            {props.scopes.campaigns.length > 0 ? (
              <optgroup label="Campaigns">
                {props.scopes.campaigns.map((scope) => (
                  <option key={scope.id} value={`campaign:${scope.id}`}>
                    {scope.label}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {props.scopes.tags.length > 0 ? (
              <optgroup label="Tags">
                {props.scopes.tags.map((scope) => (
                  <option key={scope.id} value={`tag:${scope.id}`}>
                    {scope.label} ({scope.campaignIds.length})
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </label>
        <label style={label}>
          Minimum clicks
          <input
            type="number"
            min={0}
            value={minClicks}
            onChange={(event) => setMinClicks(Math.max(0, Number(event.target.value) || 0))}
            style={{ width: '5rem' }}
          />
        </label>
        <span style={muted} data-testid="gram-count">
          {ngrams.length} grams over {scopedRows.length} search terms
        </span>
      </fieldset>

      <DataGrid
        model={model}
        columns={columns}
        currencyCode={props.currencyCode}
        sort={sort}
        onSortChange={setSort}
        onRowClick={(row: GridRow) => {
          const value = row.dimensions['gram'];
          setGram(typeof value === 'string' ? value : null);
          setSelectedTerms(new Set());
        }}
        height={420}
        emptyMessage="No gram clears this click floor."
        noDataMessage="No search-term data in this period."
      />

      {gram === null ? (
        <p style={muted}>Select a gram to see the search terms behind it and propose negatives.</p>
      ) : (
        <section data-testid="gram-terms">
          <h2 style={{ fontSize: '1rem', margin: '0.5rem 0' }}>
            Search terms containing “{gram}” · {terms.length}
          </h2>
          <fieldset style={panel}>
            <legend style={legend}>Propose as negative</legend>
            <label style={label}>
              Match type
              <select value={matchType} onChange={(event) => setMatchType(event.target.value)}>
                {MATCH_TYPES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => setSelectedTerms(new Set(terms.map(termKey)))}
              disabled={busy}
            >
              Select all {terms.length}
            </button>
            <button type="button" onClick={() => void propose()} disabled={busy}>
              Propose selected as negatives
            </button>
            <span style={muted}>
              This creates proposals for review. v1 writes nothing to Amazon.
            </span>
          </fieldset>

          {error === null ? null : (
            <p role="alert" style={warning}>
              {error}
            </p>
          )}
          {message === null ? null : (
            <p role="status" style={notice} data-testid="propose-result">
              {message}
            </p>
          )}

          <table style={table}>
            <thead>
              <tr>
                <th style={th} scope="col">
                  <span aria-hidden="true">✓</span>
                </th>
                <th style={th} scope="col">Search term</th>
                <th style={thRight} scope="col">Clicks</th>
                <th style={thRight} scope="col">Spend</th>
                <th style={thRight} scope="col">Orders</th>
                <th style={thRight} scope="col">Sales</th>
              </tr>
            </thead>
            <tbody>
              {terms.map((row) => {
                const key = termKey(row);
                return (
                  <tr key={key}>
                    <td style={td}>
                      <input
                        type="checkbox"
                        checked={selectedTerms.has(key)}
                        aria-label={`Select ${row.searchTerm}`}
                        onChange={() =>
                          setSelectedTerms((current) => {
                            const next = new Set(current);
                            if (next.has(key)) next.delete(key);
                            else next.add(key);
                            return next;
                          })
                        }
                      />
                    </td>
                    <td style={td}>{row.searchTerm}</td>
                    <td style={tdRight}>{row.clicks}</td>
                    <td style={tdRight}>{row.cost.toFixed(2)}</td>
                    <td style={tdRight}>{row.purchases7d}</td>
                    <td style={tdRight}>{row.sales7d.toFixed(2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </section>
  );
}

const panel: CSSProperties = {
  alignItems: 'flex-end',
  border: '1px solid #e5e7eb',
  borderRadius: '0.5rem',
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.75rem',
  padding: '0.75rem',
};
const legend: CSSProperties = { fontSize: '0.8125rem', fontWeight: 600, padding: '0 0.25rem' };
const label: CSSProperties = { display: 'flex', flexDirection: 'column', fontSize: '0.8125rem', gap: '0.25rem' };
const muted: CSSProperties = { color: '#6b7280', fontSize: '0.8125rem' };
const table: CSSProperties = { borderCollapse: 'collapse', fontSize: '0.8125rem', width: '100%' };
const th: CSSProperties = {
  borderBottom: '1px solid #d1d5db',
  padding: '0.25rem 0.5rem',
  textAlign: 'left',
};
const thRight: CSSProperties = { ...th, textAlign: 'right' };
const td: CSSProperties = { borderBottom: '1px solid #f3f4f6', padding: '0.25rem 0.5rem' };
const tdRight: CSSProperties = { ...td, textAlign: 'right' };
const warning: CSSProperties = {
  background: '#fef2f2',
  border: '1px solid #fecaca',
  borderRadius: '0.375rem',
  color: '#991b1b',
  padding: '0.5rem 0.75rem',
};
const notice: CSSProperties = {
  background: '#f0fdf4',
  border: '1px solid #bbf7d0',
  borderRadius: '0.375rem',
  color: '#166534',
  padding: '0.5rem 0.75rem',
};
