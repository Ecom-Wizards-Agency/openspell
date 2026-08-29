/** Historical coverage, safe promotion, and attribution revision contracts. */
import { z } from 'zod';
import { AdProduct, IsoDate, Uuid } from './primitives.js';

const count = z.number().int().nonnegative();
const metric = z.number().nonnegative();

export const ReportDataSource = z.enum([
  'amazon_reporting_v3',
  'amazon_unified_reporting',
  'amazon_marketing_stream',
  'secondary_import',
]);
export type ReportDataSource = z.infer<typeof ReportDataSource>;

export const HistoricalBootstrapStatus = z.enum([
  'pending',
  'loading',
  'complete',
  'partial',
  'unavailable',
  'failed',
]);
export type HistoricalBootstrapStatus = z.infer<typeof HistoricalBootstrapStatus>;

export const ReportCoverage = z.object({
  profileId: Uuid,
  reportType: z.string().min(1),
  grain: z.string().min(1),
  source: ReportDataSource,
  status: HistoricalBootstrapStatus,
  earliestRequestedDate: IsoDate.nullable(),
  earliestReturnedDate: IsoDate.nullable(),
  latestLoadedDate: IsoDate.nullable(),
  latestSettledDate: IsoDate.nullable(),
  availabilityStartDate: IsoDate.nullable(),
  missingDates: z.array(IsoDate),
  updatedAt: z.iso.datetime(),
});
export type ReportCoverage = z.infer<typeof ReportCoverage>;

export const ReportPromotionWatermark = z.object({
  profileId: Uuid,
  reportType: z.string().min(1),
  date: IsoDate,
  source: ReportDataSource,
  reportRequestId: Uuid,
  requestedAt: z.iso.datetime(),
  promotedAt: z.iso.datetime(),
  sourceRows: count,
  parsedRows: count,
  refusedRows: count,
  promotedRows: count,
  canonicalRows: count,
});
export type ReportPromotionWatermark = z.infer<typeof ReportPromotionWatermark>;

export const AttributionObservation = z.object({
  id: Uuid.optional(),
  profileId: Uuid,
  date: IsoDate,
  adProduct: AdProduct,
  reportType: z.string().min(1),
  source: ReportDataSource,
  observedAt: z.iso.datetime(),
  attributionWindowDays: z.number().int().positive(),
  eventDateAgeDays: z.number().int().nonnegative(),
  impressions: count,
  clicks: count,
  cost: metric,
  purchases: count,
  sales: metric,
  supersededAt: z.iso.datetime().nullable(),
});
export type AttributionObservation = z.infer<typeof AttributionObservation>;
