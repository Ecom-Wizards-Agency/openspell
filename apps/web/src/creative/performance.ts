import type {
  CreativePerformanceAsset,
  CreativePerformanceDrilldown,
} from '@wizard-ads/db';
import type { CreativeAttributionState } from '@wizard-ads/shared';

export type CreativeSort =
  | 'spend_desc'
  | 'sales_desc'
  | 'impressions_desc'
  | 'ctr_desc'
  | 'video_completes_desc'
  | 'creative_asc'
  | 'campaign_type_asc';

export interface CreativePerformanceControls {
  query: string;
  campaignType: string;
  attributionState: CreativeAttributionState | 'all';
  sort: CreativeSort;
}

export interface CreativePerformanceSummary {
  mappedAssets: number;
  placementCount: number;
  cost: number;
  sales: number;
  purchases: number;
  videoCompleteViews: number | null;
  incompleteVideoMetrics: boolean;
}

export const ATTRIBUTION_LABELS: Record<CreativeAttributionState, string> = {
  mapped: 'Mapped',
  legacy: 'Legacy',
  unsupported: 'Unsupported',
  ambiguous: 'Ambiguous',
  unmapped: 'Unmapped',
};

export const ATTRIBUTION_EXPLANATIONS: Record<CreativeAttributionState, string> = {
  mapped: 'An exact ad-to-creative-to-Amazon-Asset-ID mapping supports these metrics.',
  legacy: 'The source predates authoritative asset mapping, so this row stays separate.',
  unsupported: 'The source report cannot attribute this performance to an Amazon Asset ID.',
  ambiguous: 'More than one creative mapping is possible, so Wizard Ads does not choose one.',
  unmapped: 'No authoritative Amazon Asset ID mapping is available for this ad yet.',
};

export function summarizeCreativePerformance(
  rows: readonly CreativePerformanceAsset[],
): CreativePerformanceSummary {
  const completeValues = rows.map((row) => row.videoCompleteViews);
  return {
    mappedAssets: new Set(
      rows.flatMap((row) => row.attributionState === 'mapped' && row.assetId !== null ? [row.assetId] : []),
    ).size,
    placementCount: sum(rows, (row) => row.placementCount),
    cost: sum(rows, (row) => row.cost),
    sales: sum(rows, (row) => row.sales),
    purchases: sum(rows, (row) => row.purchases),
    videoCompleteViews: completeValues.some((value) => value !== null)
      ? completeValues.reduce<number>((total, value) => total + (value ?? 0), 0)
      : null,
    incompleteVideoMetrics: completeValues.some((value) => value === null),
  };
}

export function campaignTypeOptions(rows: readonly CreativePerformanceAsset[]): string[] {
  return [...new Set(rows.flatMap((row) => row.campaignTypes))].sort((a, b) => a.localeCompare(b));
}

export function filterAndSortCreativePerformance(
  rows: readonly CreativePerformanceAsset[],
  controls: CreativePerformanceControls,
): CreativePerformanceAsset[] {
  const query = controls.query.trim().toLocaleLowerCase();
  const filtered = rows.filter((row) => {
    const matchesQuery = query === '' || [
      row.name,
      row.assetId,
      row.assetType,
      ...row.campaignTypes,
    ].some((value) => value?.toLocaleLowerCase().includes(query) === true);
    const matchesCampaign = controls.campaignType === 'all'
      || row.campaignTypes.includes(controls.campaignType);
    const matchesAttribution = controls.attributionState === 'all'
      || row.attributionState === controls.attributionState;
    return matchesQuery && matchesCampaign && matchesAttribution;
  });

  return filtered.toSorted((left, right) => compareRows(left, right, controls.sort));
}

export function attributionRowKey(row: CreativePerformanceAsset): string {
  return `${row.attributionState}:${row.assetId ?? 'no-asset-id'}`;
}

export function drilldownRowKey(row: CreativePerformanceDrilldown): string {
  return JSON.stringify([
    row.campaignId,
    row.adGroupId,
    row.adId,
    row.creativeId,
    row.placement,
  ]);
}

function compareRows(
  left: CreativePerformanceAsset,
  right: CreativePerformanceAsset,
  sort: CreativeSort,
): number {
  const fallback = creativeLabel(left).localeCompare(creativeLabel(right));
  switch (sort) {
    case 'creative_asc':
      return fallback;
    case 'campaign_type_asc': {
      const compared = left.campaignTypes.join(', ').localeCompare(right.campaignTypes.join(', '));
      return compared === 0 ? fallback : compared;
    }
    case 'sales_desc':
      return descending(left.sales, right.sales, fallback);
    case 'impressions_desc':
      return descending(left.impressions, right.impressions, fallback);
    case 'ctr_desc':
      return descending(left.ctr ?? -1, right.ctr ?? -1, fallback);
    case 'video_completes_desc':
      return descending(left.videoCompleteViews ?? -1, right.videoCompleteViews ?? -1, fallback);
    case 'spend_desc':
      return descending(left.cost, right.cost, fallback);
  }
}

function creativeLabel(row: CreativePerformanceAsset): string {
  return row.name ?? row.assetId ?? ATTRIBUTION_LABELS[row.attributionState];
}

function descending(left: number, right: number, fallback: number): number {
  const compared = right - left;
  return compared === 0 ? fallback : compared;
}

function sum(
  rows: readonly CreativePerformanceAsset[],
  value: (row: CreativePerformanceAsset) => number,
): number {
  return rows.reduce((total, row) => total + value(row), 0);
}
