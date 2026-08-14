import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import type {
  NewPlacementFact,
  NewProfileFact,
  NewSearchTermFact,
  NewSpTargetFact,
} from '@wizard-ads/db';
import {
  MatchType,
  Placement,
  type MatchType as MatchTypeValue,
  type Placement as PlacementValue,
  type ReportType,
} from '@wizard-ads/shared';
import type { AdsProfileContext } from './ads-api.js';

interface CommonRow { date: string; impressions: number; clicks: number; cost: number }
interface SpCampaignRow extends CommonRow { campaignId: string; purchases7d: number; sales7d: number; unitsSoldClicks7d: number }
interface SpTargetRow extends SpCampaignRow {
  adGroupId: string; targetId: string; targetKind: 'keyword' | 'target';
  matchType: ReturnType<typeof parseMatchType>; purchases1d: number; purchases14d: number;
  purchases30d: number; sales1d: number; sales14d: number; sales30d: number;
  topOfSearchImpressionShare: number | null;
}
interface SearchTermRow extends SpCampaignRow { adGroupId: string; targetId: string | null; searchTerm: string; matchType: ReturnType<typeof parseMatchType> }
interface PlacementRow extends CommonRow { campaignId: string; placementClassification: string; purchases7d: number; sales7d: number }
interface CampaignRow extends SpCampaignRow { adGroupId: string | null }

export interface CampaignFactRow {
  orgId: string;
  profileId: string;
  date: string;
  campaignId: string;
  adGroupId: string | null;
  impressions: number;
  clicks: number;
  cost: number;
  purchases7d: number;
  sales7d: number;
  unitsSold7d: number;
  metrics: Record<string, unknown>;
  reportRequestId: string;
}

/**
 * `sourceRows` is how many rows Amazon sent; `rows` is how many fact rows they
 * became. The two differ only for `spCampaigns`, which arrives per campaign and
 * lands on a per-profile grain. Keeping both means the fetch handler can assert
 * fact rows offered against fact rows written (the invariant the ledger
 * records) without losing the number an operator compares to the Amazon UI.
 */
export type ParsedFactBatch = { sourceRows: number } & (
  | { kind: 'sp_target'; rows: NewSpTargetFact[] }
  | { kind: 'search_term'; rows: NewSearchTermFact[] }
  | { kind: 'placement'; rows: NewPlacementFact[] }
  | { kind: 'profile'; rows: NewProfileFact[] }
  | { kind: 'sb'; rows: CampaignFactRow[] }
  | { kind: 'sd'; rows: CampaignFactRow[] }
);

export interface DownloadedJson {
  value: unknown;
  bytesDownloaded: number;
}

/** Stream compressed bytes through gunzip. Only the parsed JSON is retained. */
export async function gunzipJson(source: AsyncIterable<Uint8Array>): Promise<DownloadedJson> {
  let bytesDownloaded = 0;
  async function* measured(): AsyncGenerator<Uint8Array> {
    for await (const chunk of source) {
      bytesDownloaded += chunk.byteLength;
      yield chunk;
    }
  }

  const chunks: Buffer[] = [];
  const unzipped = Readable.from(measured()).pipe(createGunzip());
  for await (const chunk of unzipped) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }

  return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, bytesDownloaded };
}

function placement(value: string): PlacementValue {
  const normalized: Record<string, PlacementValue> = {
    'Placement Top': 'top_of_search',
    'Top of Search on-Amazon': 'top_of_search',
    'Placement Rest Of Search': 'rest_of_search',
    'Rest of Search on-Amazon': 'rest_of_search',
    'Placement Product Page': 'product_pages',
    'Detail Page on-Amazon': 'product_pages',
    'Off Amazon': 'off_amazon',
  };
  return normalized[value] ?? (Placement.safeParse(value).data ?? 'other');
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('report row must be an object');
  return value as Record<string, unknown>;
}

function stringField(row: Record<string, unknown>, field: string, nullable = false): string | null {
  const value = row[field];
  if (nullable && (value === null || value === undefined)) return null;
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).length === 0) throw new Error(`${field} must be a non-empty string`);
  return String(value);
}

function numberField(row: Record<string, unknown>, field: string, integer = false): number {
  const raw = row[field] ?? 0;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) throw new Error(`${field} must be a non-negative${integer ? ' integer' : ''}`);
  return value;
}

function parseCommon(value: unknown): [Record<string, unknown>, CommonRow] {
  const row = record(value);
  const date = stringField(row, 'date');
  if (date === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD');
  return [row, { date, impressions: numberField(row, 'impressions', true), clicks: numberField(row, 'clicks', true), cost: numberField(row, 'cost') }];
}

function parseMatchType(value: unknown): MatchTypeValue | null {
  if (value === null || value === undefined) return null;
  return MatchType.parse(value);
}

function parseSpCampaign(value: unknown): SpCampaignRow {
  const [row, commonRow] = parseCommon(value);
  return { ...commonRow, campaignId: stringField(row, 'campaignId') as string, purchases7d: numberField(row, 'purchases7d', true), sales7d: numberField(row, 'sales7d'), unitsSoldClicks7d: numberField(row, 'unitsSoldClicks7d', true) };
}

function parseSpTarget(value: unknown): SpTargetRow {
  const [row] = parseCommon(value);
  const base = parseSpCampaign(value);
  const share = row['topOfSearchImpressionShare'];
  const parsedShare = share === null || share === undefined ? null : Number(share);
  if (parsedShare !== null && (!Number.isFinite(parsedShare) || parsedShare < 0 || parsedShare > 1)) throw new Error('topOfSearchImpressionShare must be between 0 and 1');
  const kind = row['targetKind'] ?? 'target';
  if (kind !== 'keyword' && kind !== 'target') throw new Error('targetKind must be keyword or target');
  return { ...base, adGroupId: stringField(row, 'adGroupId') as string, targetId: stringField(row, 'targetId') as string, targetKind: kind, matchType: parseMatchType(row['matchType']), purchases1d: numberField(row, 'purchases1d', true), purchases14d: numberField(row, 'purchases14d', true), purchases30d: numberField(row, 'purchases30d', true), sales1d: numberField(row, 'sales1d'), sales14d: numberField(row, 'sales14d'), sales30d: numberField(row, 'sales30d'), topOfSearchImpressionShare: parsedShare };
}

function parseSearchTerm(value: unknown): SearchTermRow {
  const [row] = parseCommon(value);
  const base = parseSpCampaign(value);
  return { ...base, adGroupId: stringField(row, 'adGroupId') as string, targetId: stringField(row, 'targetId', true), searchTerm: stringField(row, 'searchTerm', true) ?? '', matchType: parseMatchType(row['matchType']) };
}

function parsePlacement(value: unknown): PlacementRow {
  const [row, commonRow] = parseCommon(value);
  return { ...commonRow, campaignId: stringField(row, 'campaignId') as string, placementClassification: stringField(row, 'placementClassification') as string, purchases7d: numberField(row, 'purchases7d', true), sales7d: numberField(row, 'sales7d') };
}

function parseCampaign(value: unknown): CampaignRow {
  const row = record(value);
  return { ...parseSpCampaign(value), adGroupId: stringField(row, 'adGroupId', true) };
}

function assertArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('report payload must be a JSON array');
  return value;
}

export function parseReportRows(
  reportType: ReportType,
  value: unknown,
  profile: AdsProfileContext,
  reportRequestId: string,
): ParsedFactBatch {
  const raw = assertArray(value);
  const base = { orgId: profile.orgId, profileId: profile.id, reportRequestId };

  switch (reportType) {
    case 'spTargeting':
      return {
        sourceRows: raw.length,
        kind: 'sp_target',
        rows: raw.map((item) => {
          const row = parseSpTarget(item);
          return {
            ...base,
            date: row.date,
            adProduct: 'SP' as const,
            campaignId: row.campaignId,
            adGroupId: row.adGroupId,
            targetId: row.targetId,
            targetKind: row.targetKind,
            matchType: row.matchType,
            impressions: row.impressions,
            clicks: row.clicks,
            cost: row.cost,
            purchases1d: row.purchases1d,
            purchases7d: row.purchases7d,
            purchases14d: row.purchases14d,
            purchases30d: row.purchases30d,
            sales1d: row.sales1d,
            sales7d: row.sales7d,
            sales14d: row.sales14d,
            sales30d: row.sales30d,
            unitsSold7d: row.unitsSoldClicks7d,
            topOfSearchImpressionShare: row.topOfSearchImpressionShare ?? null,
          };
        }),
      };
    case 'spSearchTerm':
      return {
        sourceRows: raw.length,
        kind: 'search_term',
        rows: raw.map((item) => {
          const row = parseSearchTerm(item);
          return {
            ...base,
            date: row.date,
            adProduct: 'SP' as const,
            campaignId: row.campaignId,
            adGroupId: row.adGroupId,
            targetId: row.targetId,
            searchTerm: row.searchTerm,
            matchType: row.matchType,
            impressions: row.impressions,
            clicks: row.clicks,
            cost: row.cost,
            purchases7d: row.purchases7d,
            sales7d: row.sales7d,
            unitsSold7d: row.unitsSoldClicks7d,
          };
        }),
      };
    case 'spPlacement':
      return {
        sourceRows: raw.length,
        kind: 'placement',
        rows: raw.map((item) => {
          const row = parsePlacement(item);
          return {
            ...base,
            date: row.date,
            adProduct: 'SP' as const,
            campaignId: row.campaignId,
            placement: placement(row.placementClassification),
            impressions: row.impressions,
            clicks: row.clicks,
            cost: row.cost,
            purchases7d: row.purchases7d,
            sales7d: row.sales7d,
          };
        }),
      };
    case 'spCampaigns': {
      // The campaign report arrives one row per campaign per day, and
      // `fact_profile_daily` is one row per profile per day. Summing here is
      // not a convenience: two campaigns on one date are two rows with the same
      // conflict target, and Postgres refuses to let one statement update the
      // same row twice. Aggregating turns that error into the number the grain
      // is supposed to hold.
      const byDate = new Map<string, Required<Pick<NewProfileFact,
        'impressions' | 'clicks' | 'cost' | 'purchases7d' | 'sales7d' | 'unitsSold7d'>>>();
      for (const item of raw) {
        const row = parseSpCampaign(item);
        const running = byDate.get(row.date);
        if (running) {
          running.impressions += row.impressions;
          running.clicks += row.clicks;
          running.cost += row.cost;
          running.purchases7d += row.purchases7d;
          running.sales7d += row.sales7d;
          running.unitsSold7d += row.unitsSoldClicks7d;
          continue;
        }
        byDate.set(row.date, {
          impressions: row.impressions,
          clicks: row.clicks,
          cost: row.cost,
          purchases7d: row.purchases7d,
          sales7d: row.sales7d,
          unitsSold7d: row.unitsSoldClicks7d,
        });
      }
      const rows = [...byDate.entries()].map(([date, totals]): NewProfileFact => ({
        ...base,
        date,
        currencyCode: profile.currencyCode,
        provisional: false,
        ...totals,
      }));
      return { sourceRows: raw.length, kind: 'profile', rows };
    }
    case 'sbCampaigns':
    case 'sdCampaigns': {
      const rows = raw.map((item): CampaignFactRow => {
        const row = parseCampaign(item);
        return {
          ...base,
          date: row.date,
          campaignId: row.campaignId,
          adGroupId: row.adGroupId,
          impressions: row.impressions,
          clicks: row.clicks,
          cost: row.cost,
          purchases7d: row.purchases7d,
          sales7d: row.sales7d,
          unitsSold7d: row.unitsSoldClicks7d,
          metrics: item as Record<string, unknown>,
        };
      });
      return { sourceRows: raw.length, kind: reportType === 'sbCampaigns' ? 'sb' : 'sd', rows };
    }
  }
}
