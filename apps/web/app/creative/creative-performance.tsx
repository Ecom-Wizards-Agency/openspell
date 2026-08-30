'use client';

import { useMemo, useState } from 'react';
import type { CreativePerformanceAsset, CreativePerformanceDrilldown } from '@wizard-ads/db';
import type { CreativeAttributionState } from '@wizard-ads/shared';
import { Badge, Button, EmptyState, Field, Input, Select, TableFrame, Toolbar } from '../../src/ui/primitives';
import {
  ATTRIBUTION_EXPLANATIONS,
  ATTRIBUTION_LABELS,
  attributionRowKey,
  campaignTypeOptions,
  drilldownRowKey,
  filterAndSortCreativePerformance,
  summarizeCreativePerformance,
  type CreativeSort,
} from '../../src/creative/performance';
import styles from './creative.module.css';

interface Props {
  rows: readonly CreativePerformanceAsset[];
  currencyCode: string;
}

const ATTRIBUTION_STATES: readonly CreativeAttributionState[] = [
  'mapped',
  'legacy',
  'unsupported',
  'ambiguous',
  'unmapped',
];

export function CreativePerformanceExplorer({ rows, currencyCode }: Props) {
  const [query, setQuery] = useState('');
  const [campaignType, setCampaignType] = useState('all');
  const [attributionState, setAttributionState] = useState<CreativeAttributionState | 'all'>('all');
  const [sort, setSort] = useState<CreativeSort>('spend_desc');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const summary = useMemo(() => summarizeCreativePerformance(rows), [rows]);
  const campaignTypes = useMemo(() => campaignTypeOptions(rows), [rows]);
  const visibleRows = useMemo(
    () => filterAndSortCreativePerformance(rows, { query, campaignType, attributionState, sort }),
    [attributionState, campaignType, query, rows, sort],
  );

  const resetFilters = () => {
    setQuery('');
    setCampaignType('all');
    setAttributionState('all');
    setSort('spend_desc');
  };

  const toggle = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className={styles.workspace}>
      <section className={styles.summary} aria-label="Creative performance summary">
        <SummaryMetric
          label="Mapped assets"
          value={formatInteger(summary.mappedAssets)}
          detail={summary.placementCount === 0
            ? 'Placement not reported'
            : `${formatInteger(summary.placementCount)} reported placements`}
        />
        <SummaryMetric label="Spend" value={formatMoney(summary.cost, currencyCode)} detail="Across every attribution state" />
        <SummaryMetric label="Ad sales" value={formatMoney(summary.sales, currencyCode)} detail={`${formatInteger(summary.purchases)} orders`} />
        <SummaryMetric
          label="Video completes"
          value={formatOptionalInteger(summary.videoCompleteViews)}
          detail={summary.incompleteVideoMetrics ? 'Some source rows did not report video metrics' : 'Complete source coverage'}
        />
      </section>

      <Toolbar data-testid="creative-toolbar">
        <Field label="Find creative" htmlFor="creative-query" grow>
          <Input
            id="creative-query"
            type="search"
            value={query}
            placeholder="Name or Amazon Asset ID"
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </Field>
        <Field label="Campaign type" htmlFor="creative-campaign-type">
          <Select
            id="creative-campaign-type"
            value={campaignType}
            onChange={(event) => setCampaignType(event.currentTarget.value)}
          >
            <option value="all">All campaign types</option>
            {campaignTypes.map((value) => (
              <option key={value} value={value}>{campaignTypeLabel(value)}</option>
            ))}
          </Select>
        </Field>
        <Field label="Attribution" htmlFor="creative-attribution">
          <Select
            id="creative-attribution"
            value={attributionState}
            onChange={(event) => setAttributionState(event.currentTarget.value as CreativeAttributionState | 'all')}
          >
            <option value="all">All states</option>
            {ATTRIBUTION_STATES.map((value) => (
              <option key={value} value={value}>{ATTRIBUTION_LABELS[value]}</option>
            ))}
          </Select>
        </Field>
        <Field label="Sort by" htmlFor="creative-sort">
          <Select
            id="creative-sort"
            value={sort}
            onChange={(event) => setSort(event.currentTarget.value as CreativeSort)}
          >
            <option value="spend_desc">Spend · high to low</option>
            <option value="sales_desc">Ad sales · high to low</option>
            <option value="impressions_desc">Impressions · high to low</option>
            <option value="ctr_desc">CTR · high to low</option>
            <option value="video_completes_desc">Video completes · high to low</option>
            <option value="creative_asc">Creative · A to Z</option>
            <option value="campaign_type_asc">Campaign type · A to Z</option>
          </Select>
        </Field>
        <div className={styles.resultCount} aria-live="polite">
          {formatInteger(visibleRows.length)} of {formatInteger(rows.length)} creative rows
        </div>
      </Toolbar>

      <details className={styles.attributionKey}>
        <summary>Attribution key</summary>
        <div className={styles.attributionGrid}>
          {ATTRIBUTION_STATES.map((state) => (
            <div key={state}>
              <AttributionBadge state={state} />
              <p>{ATTRIBUTION_EXPLANATIONS[state]}</p>
            </div>
          ))}
        </div>
      </details>

      {visibleRows.length === 0 ? (
        <EmptyState
          title="No creative rows match these filters"
          body="Clear the filters to return to every attribution row in this date range."
          action={<Button size="sm" onClick={resetFilters}>Clear filters</Button>}
          data-testid="creative-filter-empty"
        />
      ) : (
        <TableFrame className={styles.tableFrame} data-testid="creative-performance-table">
          <table className={`wa-table ${styles.table}`}>
            <thead>
              <tr>
                <th scope="col">Creative</th>
                <th scope="col">Attribution</th>
                <th scope="col">Coverage</th>
                <th scope="col">Traffic</th>
                <th scope="col">Video funnel</th>
                <th scope="col">Commerce</th>
                <th scope="col">Efficiency</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const key = attributionRowKey(row);
                const isExpanded = expanded.has(key);
                const detailsId = `creative-detail-${safeId(key)}`;
                return (
                  <CreativeRows
                    key={key}
                    row={row}
                    currencyCode={currencyCode}
                    isExpanded={isExpanded}
                    detailsId={detailsId}
                    onToggle={() => toggle(key)}
                  />
                );
              })}
            </tbody>
          </table>
        </TableFrame>
      )}

      <p className={styles.footnote}>
        Amazon Asset ID is the creative identity. Current mappings do not prove historical attachment;
        legacy and incomplete rows stay separate. “—” means Amazon did not report that metric. This
        view never assigns an ad-group total to one creative.
      </p>
    </div>
  );
}

function CreativeRows({
  row,
  currencyCode,
  isExpanded,
  detailsId,
  onToggle,
}: {
  row: CreativePerformanceAsset;
  currencyCode: string;
  isExpanded: boolean;
  detailsId: string;
  onToggle: () => void;
}) {
  return (
    <>
      <tr data-attribution-state={row.attributionState}>
        <td>
          <div className={styles.creativeIdentity}>
            <CreativeThumbnail row={row} />
            <div className={styles.identityText}>
              <strong>{row.name ?? attributionFallbackName(row.attributionState)}</strong>
              <code>{row.assetId ?? 'No Amazon Asset ID'}</code>
              <span>{row.assetType ?? 'Asset type unavailable'}</span>
            </div>
            <button
              type="button"
              className={styles.disclosure}
              aria-expanded={isExpanded}
              aria-controls={detailsId}
              onClick={onToggle}
            >
              <span aria-hidden="true">{isExpanded ? '−' : '+'}</span>
              {isExpanded ? 'Hide' : 'Drill down'}
            </button>
          </div>
        </td>
        <td>
          <AttributionBadge state={row.attributionState} />
          {row.mappingProvenances.includes('current_sb_ad_snapshot')
            ? <small>Observed current mapping</small>
            : null}
        </td>
        <td>
          <MetricList>
            <Metric label="Campaign types" value={row.campaignTypes.map(campaignTypeLabel).join(', ') || '—'} />
            <Metric label="Campaigns" value={formatInteger(row.campaignCount)} />
            <Metric label="Ad groups" value={formatInteger(row.adGroupCount)} />
            <Metric
              label="Reported placements"
              value={row.placementCount === 0 ? 'Placement not reported' : formatInteger(row.placementCount)}
            />
          </MetricList>
        </td>
        <td>
          <MetricList>
            <Metric label="Impressions" value={formatInteger(row.impressions)} />
            <Metric label="Clicks" value={formatInteger(row.clicks)} />
            <Metric label="CTR" value={formatPercent(row.ctr)} />
          </MetricList>
        </td>
        <td>
          <MetricList compact>
            <Metric label="25%" value={formatOptionalInteger(row.videoFirstQuartileViews)} />
            <Metric label="50%" value={formatOptionalInteger(row.videoMidpointViews)} />
            <Metric label="75%" value={formatOptionalInteger(row.videoThirdQuartileViews)} />
            <Metric label="Complete" value={formatOptionalInteger(row.videoCompleteViews)} />
          </MetricList>
        </td>
        <td>
          <MetricList>
            <Metric label="Spend" value={formatMoney(row.cost, currencyCode)} />
            <Metric label="Ad sales" value={formatMoney(row.sales, currencyCode)} />
            <Metric label="Orders" value={formatInteger(row.purchases)} />
          </MetricList>
        </td>
        <td>
          <MetricList>
            <Metric label="ACOS" value={formatPercent(row.acos)} />
            <Metric label="ROAS" value={formatMultiple(row.roas)} />
          </MetricList>
        </td>
      </tr>
      {isExpanded ? (
        <tr className={styles.detailRow}>
          <td colSpan={7} id={detailsId}>
            <CreativeDrilldown row={row} currencyCode={currencyCode} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function CreativeDrilldown({ row, currencyCode }: { row: CreativePerformanceAsset; currencyCode: string }) {
  return (
    <div className={styles.drilldown}>
      <header>
        <div>
          <h3>Ad-level rows</h3>
          <p>{formatInteger(row.drilldown.length)} exact contributing rows</p>
        </div>
        <span>Asset metrics above equal the sum of these rows.</span>
      </header>
      {row.drilldown.length === 0 ? (
        <p className={styles.muted}>No drilldown rows were returned for this attribution identity.</p>
      ) : (
        <div className={styles.detailScroll}>
          <table className={`wa-table ${styles.detailTable}`}>
            <caption className="wa-sr-only">Ad-level performance contributing to this creative</caption>
            <thead>
              <tr>
                <th scope="col">Campaign ID</th>
                <th scope="col">Ad group ID</th>
                <th scope="col">Ad ID</th>
                <th scope="col">Creative ID</th>
                <th scope="col">Creative version</th>
                <th scope="col">Mapping provenance</th>
                <th scope="col">Placement</th>
                <th scope="col" data-numeric="true">Impressions</th>
                <th scope="col" data-numeric="true">Clicks</th>
                <th scope="col" data-numeric="true">Completes</th>
                <th scope="col" data-numeric="true">Spend</th>
                <th scope="col" data-numeric="true">Sales</th>
                <th scope="col" data-numeric="true">Orders</th>
              </tr>
            </thead>
            <tbody>
              {row.drilldown.map((detail) => (
                <DrilldownRow key={drilldownRowKey(detail)} row={detail} currencyCode={currencyCode} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DrilldownRow({ row, currencyCode }: { row: CreativePerformanceDrilldown; currencyCode: string }) {
  return (
    <tr>
      <td><code>{row.campaignId}</code></td>
      <td><code>{row.adGroupId}</code></td>
      <td><code>{row.adId}</code></td>
      <td><code>{row.creativeId ?? '—'}</code></td>
      <td><code>{row.creativeVersion ?? '—'}</code></td>
      <td>{row.mappingProvenance === 'current_sb_ad_snapshot' ? 'Observed current mapping' : '—'}</td>
      <td>{placementLabel(row.placement)}</td>
      <td data-numeric="true">{formatInteger(row.impressions)}</td>
      <td data-numeric="true">{formatInteger(row.clicks)}</td>
      <td data-numeric="true">{formatOptionalInteger(row.videoCompleteViews)}</td>
      <td data-numeric="true">{formatMoney(row.cost, currencyCode)}</td>
      <td data-numeric="true">{formatMoney(row.sales, currencyCode)}</td>
      <td data-numeric="true">{formatInteger(row.purchases)}</td>
    </tr>
  );
}

function CreativeThumbnail({ row }: { row: CreativePerformanceAsset }) {
  const [failed, setFailed] = useState(false);
  if (row.thumbnailUrl === null || failed) {
    return <span className={styles.thumbnailFallback} aria-hidden="true">▶</span>;
  }
  return (
    <img
      src={row.thumbnailUrl}
      className={styles.thumbnail}
      width={72}
      height={46}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

function SummaryMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className={styles.summaryMetric}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function MetricList({ children, compact = false }: { children: React.ReactNode; compact?: boolean }) {
  return <dl className={compact ? `${styles.metrics} ${styles.metricsCompact}` : styles.metrics}>{children}</dl>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function AttributionBadge({ state }: { state: CreativeAttributionState }) {
  const tone = state === 'mapped'
    ? 'good'
    : state === 'legacy' || state === 'ambiguous'
      ? 'warn'
      : state === 'unmapped'
        ? 'bad'
        : 'neutral';
  return <Badge tone={tone} dot>{ATTRIBUTION_LABELS[state]}</Badge>;
}

function campaignTypeLabel(value: string): string {
  if (value === 'SB') return 'Sponsored Brands';
  if (value === 'SP') return 'Sponsored Products';
  if (value === 'SD') return 'Sponsored Display';
  return value;
}

function placementLabel(value: CreativePerformanceDrilldown['placement']): string {
  if (value === null) return 'Placement not reported';
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function attributionFallbackName(state: CreativeAttributionState): string {
  return state === 'mapped' ? 'Unnamed video asset' : `${ATTRIBUTION_LABELS[state]} performance`;
}

function formatInteger(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function formatOptionalInteger(value: number | null): string {
  return value === null ? '—' : formatInteger(value);
}

function formatMoney(value: number, currencyCode: string): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: currencyCode,
    maximumFractionDigits: value >= 100 ? 0 : 2,
  });
}

function formatPercent(value: number | null): string {
  return value === null ? '—' : value.toLocaleString('en-US', { style: 'percent', maximumFractionDigits: 1 });
}

function formatMultiple(value: number | null): string {
  return value === null ? '—' : `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}×`;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}
