import { IsoDate } from '@wizard-ads/shared';
import { z } from 'zod';
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

const NonEmptyString = z.string().trim().min(1);
const NonnegativeInteger = z.number().finite().int().nonnegative();
const NullableNonnegativeInteger = NonnegativeInteger.nullable();

const RankRadarSchema = z.object({
  id: NonEmptyString,
  asin: z.object({
    asin: NonEmptyString,
  }).passthrough(),
  marketplace: NonEmptyString,
  keywordCount: NonnegativeInteger,
  title: NonEmptyString,
  imageUrl: NonEmptyString,
}).passthrough();

const RankRadarPageSchema = z.object({
  currentPage: NonnegativeInteger,
  pageSize: NonnegativeInteger,
  hasNext: z.boolean(),
  hasPrev: z.boolean(),
  lastPage: NonnegativeInteger,
  total: NonnegativeInteger,
  data: z.array(RankRadarSchema),
}).passthrough();

const RankPointSchema = z.object({
  date: IsoDate,
  organicRank: NullableNonnegativeInteger,
}).passthrough();

const RankKeywordSchema = z.object({
  id: NonEmptyString,
  keyword: NonEmptyString,
  searchVolume: NullableNonnegativeInteger,
  ranks: z.array(RankPointSchema),
}).passthrough();

const RankRadarDataSchema = z.object({
  data: z.array(RankKeywordSchema),
}).passthrough();

const QuotaFeatureSchema = z.object({
  used: NullableNonnegativeInteger,
  capacity: NullableNonnegativeInteger,
}).passthrough();

const QuotaSchema = z.object({
  // Live smoke 2026-08-27: the real endpoint omits the field entirely for some
  // accounts. Absent and null both mean "no scheduled refresh known".
  nextRefreshDate: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)))
    .nullish()
    .transform((value) => value ?? null),
  features: z.record(z.string(), QuotaFeatureSchema),
}).passthrough();

function parse<T>(schema: z.ZodType<T>, value: unknown, path: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const leaf = issue?.path.length ? `.${issue.path.join('.')}` : '';
    throw new DataDiveParseError(`${path}${leaf} ${issue?.message ?? 'is invalid'}`);
  }
  return result.data;
}

function details(source: JsonRecord, known: readonly string[]): JsonRecord {
  const omitted = new Set(known);
  return Object.fromEntries(Object.entries(source).filter(([key]) => !omitted.has(key)));
}

function parseRadar(value: unknown, path: string): RankRadar {
  const row = parse(RankRadarSchema, value, path);
  const asin = row.asin;
  return {
    id: row.id,
    asin: asin.asin,
    marketplace: row.marketplace,
    keywordCount: row.keywordCount,
    title: row.title,
    imageUrl: row.imageUrl,
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
  const body = parse(RankRadarPageSchema, value, 'rank radar list');
  return {
    currentPage: body.currentPage,
    pageSize: body.pageSize,
    hasNext: body.hasNext,
    total: body.total,
    items: body.data.map((item, index) =>
      parseRadar(item, `rank radar list.data[${index}]`),
    ),
  };
}

function parseRankPoint(value: unknown, path: string): RankPoint {
  const row = parse(RankPointSchema, value, path);
  return {
    date: row.date,
    organicRank: row.organicRank,
    details: details(row, ['date', 'organicRank']),
  };
}

function parseKeyword(value: unknown, path: string): RankKeyword {
  const row = parse(RankKeywordSchema, value, path);
  return {
    id: row.id,
    keyword: row.keyword,
    searchVolume: row.searchVolume,
    ranks: row.ranks.map((rank, index) =>
      parseRankPoint(rank, `${path}.ranks[${index}]`),
    ),
    details: details(row, ['id', 'keyword', 'searchVolume', 'ranks']),
  };
}

export function parseRankRadarData(value: unknown): RankRadarData {
  const body = parse(RankRadarDataSchema, value, 'rank radar data');
  return {
    keywords: body.data.map((item, index) =>
      parseKeyword(item, `rank radar data.data[${index}]`),
    ),
    details: details(body, ['data']),
  };
}

function parseQuotaFeature(value: unknown, path: string): QuotaFeature {
  const feature = parse(QuotaFeatureSchema, value, path);
  return {
    used: feature.used,
    capacity: feature.capacity,
    details: details(feature, ['used', 'capacity']),
  };
}

export function parseQuota(value: unknown): DataDiveQuota {
  // Live smoke 2026-08-27: /v1/quota wraps its payload in the same `data`
  // envelope as the list endpoints. Accept both, preferring the envelope.
  const unwrapped =
    typeof value === 'object' && value !== null && 'data' in value && !('features' in value)
      ? (value as { data: unknown }).data
      : value;
  const body = parse(QuotaSchema, unwrapped, 'quota');
  const parsedFeatures: Record<string, QuotaFeature> = {};
  for (const [name, feature] of Object.entries(body.features)) {
    parsedFeatures[name] = parseQuotaFeature(feature, `quota.features.${name}`);
  }
  const rankRadar = parsedFeatures['RANK_RADAR_KEYWORDS'];
  if (!rankRadar) throw new DataDiveParseError('quota.features.RANK_RADAR_KEYWORDS is required');

  return {
    nextRefreshDate: body.nextRefreshDate,
    features: Object.assign(parsedFeatures, { RANK_RADAR_KEYWORDS: rankRadar }),
    details: details(body, ['nextRefreshDate', 'features']),
  };
}
