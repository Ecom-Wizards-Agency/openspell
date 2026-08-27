import { IsoDate } from '@wizard-ads/shared';
import { DataDiveParseError } from './errors.js';
import type {
  DataDiveQuota,
  QuotaFeature,
  RankKeyword,
  RankPoint,
  RankRadar,
  RankRadarData,
} from './types.js';

type JsonRecord = Record<string, unknown>;

function record(value: unknown, path: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DataDiveParseError(`${path} must be an object`);
  }
  return value as JsonRecord;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new DataDiveParseError(`${path} must be an array`);
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DataDiveParseError(`${path} must be a non-empty string`);
  }
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new DataDiveParseError(`${path} must be a boolean`);
  return value;
}

function number(value: unknown, path: string, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    throw new DataDiveParseError(`${path} must be a finite${integer ? ' integer' : ''} number`);
  }
  return value;
}

function nullableNumber(value: unknown, path: string, integer = false): number | null {
  return value === null ? null : number(value, path, integer);
}

function details(source: JsonRecord, known: readonly string[]): JsonRecord {
  const omitted = new Set(known);
  return Object.fromEntries(Object.entries(source).filter(([key]) => !omitted.has(key)));
}

function parseRadar(value: unknown, path: string): RankRadar {
  const row = record(value, path);
  const asin = record(row['asin'], `${path}.asin`);
  return {
    id: string(row['id'], `${path}.id`),
    asin: string(asin['asin'], `${path}.asin.asin`),
    marketplace: string(row['marketplace'], `${path}.marketplace`),
    keywordCount: number(row['keywordCount'], `${path}.keywordCount`, true),
    title: string(row['title'], `${path}.title`),
    imageUrl: string(row['imageUrl'], `${path}.imageUrl`),
    details: {
      ...details(row, ['id', 'asin', 'marketplace', 'keywordCount', 'title', 'imageUrl']),
      asin: details(asin, ['asin']),
    },
  };
}

export interface ParsedRankRadarPage {
  currentPage: number;
  pageSize: number;
  hasNext: boolean;
  total: number;
  items: RankRadar[];
}

export function parseRankRadarPage(value: unknown): ParsedRankRadarPage {
  const body = record(value, 'rank radar list');
  return {
    currentPage: number(body['currentPage'], 'rank radar list.currentPage', true),
    pageSize: number(body['pageSize'], 'rank radar list.pageSize', true),
    hasNext: boolean(body['hasNext'], 'rank radar list.hasNext'),
    total: number(body['total'], 'rank radar list.total', true),
    items: array(body['data'], 'rank radar list.data').map((item, index) =>
      parseRadar(item, `rank radar list.data[${index}]`),
    ),
  };
}

function parseRankPoint(value: unknown, path: string): RankPoint {
  const row = record(value, path);
  const date = string(row['date'], `${path}.date`);
  if (!IsoDate.safeParse(date).success) throw new DataDiveParseError(`${path}.date must be yyyy-mm-dd`);
  const organicRank = nullableNumber(row['organicRank'], `${path}.organicRank`, true);
  if (organicRank !== null && organicRank < 0) {
    throw new DataDiveParseError(`${path}.organicRank must be non-negative`);
  }
  return {
    date,
    organicRank,
    details: details(row, ['date', 'organicRank']),
  };
}

function parseKeyword(value: unknown, path: string): RankKeyword {
  const row = record(value, path);
  const searchVolume = nullableNumber(row['searchVolume'], `${path}.searchVolume`, true);
  if (searchVolume !== null && searchVolume < 0) {
    throw new DataDiveParseError(`${path}.searchVolume must be non-negative`);
  }
  return {
    id: string(row['id'], `${path}.id`),
    keyword: string(row['keyword'], `${path}.keyword`),
    searchVolume,
    ranks: array(row['ranks'], `${path}.ranks`).map((rank, index) =>
      parseRankPoint(rank, `${path}.ranks[${index}]`),
    ),
    details: details(row, ['id', 'keyword', 'searchVolume', 'ranks']),
  };
}

export function parseRankRadarData(value: unknown): RankRadarData {
  const body = record(value, 'rank radar data');
  return {
    keywords: array(body['data'], 'rank radar data.data').map((item, index) =>
      parseKeyword(item, `rank radar data.data[${index}]`),
    ),
    details: details(body, ['data']),
  };
}

function parseQuotaFeature(value: unknown, path: string): QuotaFeature {
  const feature = record(value, path);
  const used = nullableNumber(feature['used'], `${path}.used`, true);
  const capacity = nullableNumber(feature['capacity'], `${path}.capacity`, true);
  if (used !== null && used < 0) throw new DataDiveParseError(`${path}.used must be non-negative`);
  if (capacity !== null && capacity < 0) {
    throw new DataDiveParseError(`${path}.capacity must be non-negative`);
  }
  return { used, capacity, details: details(feature, ['used', 'capacity']) };
}

export function parseQuota(value: unknown): DataDiveQuota {
  const body = record(value, 'quota');
  const rawFeatures = record(body['features'], 'quota.features');
  const parsedFeatures: Record<string, QuotaFeature> = {};
  for (const [name, feature] of Object.entries(rawFeatures)) {
    parsedFeatures[name] = parseQuotaFeature(feature, `quota.features.${name}`);
  }
  const rankRadar = parsedFeatures['RANK_RADAR_KEYWORDS'];
  if (!rankRadar) throw new DataDiveParseError('quota.features.RANK_RADAR_KEYWORDS is required');

  const rawRefresh = body['nextRefreshDate'];
  let nextRefreshDate: string | null;
  if (rawRefresh === null) {
    nextRefreshDate = null;
  } else {
    nextRefreshDate = string(rawRefresh, 'quota.nextRefreshDate');
    if (Number.isNaN(Date.parse(nextRefreshDate))) {
      throw new DataDiveParseError('quota.nextRefreshDate must be an ISO timestamp or null');
    }
  }
  return {
    nextRefreshDate,
    features: Object.assign(parsedFeatures, { RANK_RADAR_KEYWORDS: rankRadar }),
    details: details(body, ['nextRefreshDate', 'features']),
  };
}
