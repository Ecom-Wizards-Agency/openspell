/**
 * Reporting v3 request shapes.
 *
 * The flow itself (create, poll, download the S3 url, gunzip, parse) is ported
 * from `SPAdsApiDataSource`, live-verified through report creation and PENDING
 * polling on 2026-08-13. What is added here is the report-type table: one
 * `ReportType` from the contract maps to Amazon's `reportTypeId`, ad product,
 * grouping and column list, and none of those four can be derived from the
 * others.
 *
 * Two mappings in the table are worth reading twice:
 *
 *  - `spPlacement` is not an Amazon report type. Placement is a *grouping* on
 *    `spCampaigns` (`groupBy: ["campaign", "campaignPlacement"]`), which is why
 *    a placement report cannot also ask for `topOfSearchImpressionShare`.
 *  - `spCampaigns` is campaign grain and `spTargeting` is target grain. The
 *    spine of the product is the target grain; the campaign report exists for
 *    the profile rollup and for budget context.
 *
 * Column lists for Sponsored Brands and Sponsored Display are taken from
 * Amazon's documentation and are NOT live-verified. Every call accepts a
 * `columns` override so an operator can correct a rejected column set without
 * a code change.
 */
import type { WorkerReportType } from '@wizard-ads/shared';
import { AdsApiConfigError } from './errors.js';

export type AmazonAdProduct = 'SPONSORED_PRODUCTS' | 'SPONSORED_BRANDS' | 'SPONSORED_DISPLAY';

export interface ReportSpec {
  reportTypeId: string;
  adProduct: AmazonAdProduct;
  groupBy: readonly string[];
  columns: readonly string[];
  timeUnit: 'DAILY' | 'SUMMARY';
}

/** Metrics every Sponsored Products grain carries. */
const SP_CORE = ['impressions', 'clicks', 'cost'] as const;

const SP_ATTRIBUTION = [
  'purchases1d',
  'purchases7d',
  'purchases14d',
  'purchases30d',
  'sales1d',
  'sales7d',
  'sales14d',
  'sales30d',
  'unitsSoldClicks7d',
] as const;

export const REPORT_SPECS: Readonly<Record<WorkerReportType, ReportSpec>> = {
  spCampaigns: {
    reportTypeId: 'spCampaigns',
    adProduct: 'SPONSORED_PRODUCTS',
    groupBy: ['campaign'],
    columns: [
      'date',
      'campaignId',
      'campaignName',
      'campaignStatus',
      'campaignBudgetAmount',
      'campaignBudgetType',
      'campaignBudgetCurrencyCode',
      ...SP_CORE,
      ...SP_ATTRIBUTION,
      'topOfSearchImpressionShare',
    ],
    timeUnit: 'DAILY',
  },
  spTargeting: {
    reportTypeId: 'spTargeting',
    adProduct: 'SPONSORED_PRODUCTS',
    groupBy: ['targeting'],
    columns: [
      'date',
      'campaignId',
      'campaignName',
      'adGroupId',
      'adGroupName',
      'keywordId',
      'keyword',
      'keywordType',
      'matchType',
      'targeting',
      'adKeywordStatus',
      ...SP_CORE,
      ...SP_ATTRIBUTION,
    ],
    timeUnit: 'DAILY',
  },
  spSearchTerm: {
    reportTypeId: 'spSearchTerm',
    adProduct: 'SPONSORED_PRODUCTS',
    groupBy: ['searchTerm'],
    columns: [
      'date',
      'campaignId',
      'campaignName',
      'adGroupId',
      'adGroupName',
      'keywordId',
      'keyword',
      'keywordType',
      'matchType',
      'searchTerm',
      ...SP_CORE,
      'purchases7d',
      'sales7d',
      'unitsSoldClicks7d',
    ],
    timeUnit: 'DAILY',
  },
  spPlacement: {
    reportTypeId: 'spCampaigns',
    adProduct: 'SPONSORED_PRODUCTS',
    groupBy: ['campaign', 'campaignPlacement'],
    columns: [
      'date',
      'campaignId',
      'campaignName',
      'placementClassification',
      ...SP_CORE,
      'purchases7d',
      'sales7d',
    ],
    timeUnit: 'DAILY',
  },
  sbCampaigns: {
    reportTypeId: 'sbCampaigns',
    adProduct: 'SPONSORED_BRANDS',
    groupBy: ['campaign'],
    columns: [
      'date',
      'campaignId',
      'campaignName',
      'campaignStatus',
      ...SP_CORE,
      'purchases',
      'sales',
      'unitsSold',
      'newToBrandPurchases',
      'newToBrandSales',
    ],
    timeUnit: 'DAILY',
  },
  sbAds: {
    reportTypeId: 'sbAds',
    adProduct: 'SPONSORED_BRANDS',
    groupBy: ['ads'],
    columns: [
      'date',
      'campaignId',
      'adGroupId',
      'adId',
      ...SP_CORE,
      'purchases',
      'sales',
      'unitsSold',
      'videoFirstQuartileViews',
      'videoMidpointViews',
      'videoThirdQuartileViews',
      'videoCompleteViews',
      'viewableImpressions',
    ],
    timeUnit: 'DAILY',
  },
  sdCampaigns: {
    reportTypeId: 'sdCampaigns',
    adProduct: 'SPONSORED_DISPLAY',
    groupBy: ['campaign'],
    columns: [
      'date',
      'campaignId',
      'campaignName',
      'campaignStatus',
      ...SP_CORE,
      'purchases',
      'sales',
      'unitsSold',
      'newToBrandPurchases',
      'newToBrandSales',
    ],
    timeUnit: 'DAILY',
  },
};

/**
 * The widest `startDate`..`endDate` span Reporting v3 accepts, in days of
 * difference (so an inclusive window of 32 calendar days).
 *
 * Live-verified 2026-08-14 against all three ad products: a 34-day difference
 * is refused with HTTP 400 `startDate to endDate range (34 days) must not
 * exceed maximum range (31 days)`, while 31 is accepted. This is the limit that
 * failed every weekly restatement job in the first live sync — for Sponsored
 * Products exactly as much as for Brands and Display.
 */
export const MAX_REPORT_RANGE_DAYS = 31;

const MS_PER_DAY = 86_400_000;

/** Difference in days between two `YYYY-MM-DD` dates, or null if either is unparseable. */
export function reportRangeDays(startDate: string, endDate: string): number | null {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.round((end - start) / MS_PER_DAY);
}

/** Amazon's own status vocabulary. `CANCELLED` is terminal like `FAILURE`. */
export type ReportStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILURE' | 'CANCELLED';

const TERMINAL_FAILURES: readonly string[] = ['FAILURE', 'CANCELLED'];

export function isTerminalFailure(status: string): boolean {
  return TERMINAL_FAILURES.includes(status);
}

export function isReportComplete(status: string): boolean {
  return status === 'COMPLETED';
}

export interface ReportMetadata {
  reportId: string;
  status: ReportStatus | string;
  /** Pre-signed S3 URL, present only once `status` is COMPLETED. */
  url: string | null;
  urlExpiresAt: string | null;
  failureReason: string | null;
  fileSize: number | null;
  name: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CreateReportInput {
  reportType: WorkerReportType;
  startDate: string;
  endDate: string;
  /** Defaults to a deterministic name derived from the type and window. */
  name?: string;
  /** Replaces the table's column list wholesale. */
  columns?: readonly string[];
  /** Amazon's `filters` array, passed through untouched. */
  filters?: readonly Record<string, unknown>[];
  timeUnit?: 'DAILY' | 'SUMMARY';
}

/**
 * A stable, human-readable report name.
 *
 * Deterministic on purpose: an identical re-request is what makes Amazon answer
 * 425 with the in-flight report instead of generating a second copy of the
 * same data.
 */
export function defaultReportName(input: CreateReportInput): string {
  return `wizard-ads ${input.reportType} ${input.startDate}..${input.endDate}`;
}

export function buildReportRequestBody(input: CreateReportInput): Record<string, unknown> {
  const spec = REPORT_SPECS[input.reportType];
  // Refuse an over-wide window here rather than spending an Amazon round trip
  // to be told the same thing in a 400. This is a caller/config error, so it is
  // named as one instead of surfacing as an opaque HTTP failure.
  const days = reportRangeDays(input.startDate, input.endDate);
  if (days !== null && days > MAX_REPORT_RANGE_DAYS) {
    throw new AdsApiConfigError(
      `report window ${input.startDate}..${input.endDate} spans ${days} days; ` +
        `Amazon Reporting v3 allows at most ${MAX_REPORT_RANGE_DAYS}`,
    );
  }
  const configuration: Record<string, unknown> = {
    adProduct: spec.adProduct,
    groupBy: [...spec.groupBy],
    columns: [...(input.columns ?? spec.columns)],
    reportTypeId: spec.reportTypeId,
    timeUnit: input.timeUnit ?? spec.timeUnit,
    format: 'GZIP_JSON',
  };
  if (input.filters !== undefined && input.filters.length > 0) {
    configuration['filters'] = input.filters.map((filter) => ({ ...filter }));
  }
  return {
    name: input.name ?? defaultReportName(input),
    startDate: input.startDate,
    endDate: input.endDate,
    configuration,
  };
}

/** The versioned media type the create call must send. */
export const CREATE_REPORT_CONTENT_TYPE = 'application/vnd.createasyncreportrequest.v3+json';
