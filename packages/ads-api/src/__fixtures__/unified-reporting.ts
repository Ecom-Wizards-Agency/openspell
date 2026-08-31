/** Synthetic Unified Reporting protocol fixtures. */
import type { UnifiedReportDefinition } from '../unified-reporting.js';

export const UNIFIED_ACCOUNT_IDS = ['synthetic-advertiser-account'] as const;
export const UNIFIED_REPORT_IDS = [
  'synthetic-report-one',
  'synthetic-report-two',
] as const;

export const UNIFIED_DEFINITION: UnifiedReportDefinition = {
  format: 'CSV',
  periods: [{ startDate: '2026-08-01', endDate: '2026-08-07' }],
  fields: ['advertiserAccount.id', 'campaign.id', 'metric.impressions'],
  filter: { includeZeroImpressions: false },
};

export function unifiedReportMetadata(
  reportId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    completedDateTime: null,
    completedReportParts: null,
    creationDateTime: '2026-08-08T00:00:00Z',
    currencyOfView: null,
    failureCode: null,
    failureReason: null,
    format: 'CSV',
    formatOptions: null,
    lastUpdatedDateTime: '2026-08-08T00:00:01Z',
    linkedAccounts: [{ advertiserAccountId: UNIFIED_ACCOUNT_IDS[0] }],
    locale: null,
    periods: [{ datePeriod: { startDate: '2026-08-01', endDate: '2026-08-07' } }],
    query: {
      fields: ['advertiserAccount.id', 'campaign.id', 'metric.impressions'],
      filter: { includeZeroImpressions: false },
    },
    reportId,
    status: 'PENDING',
    timeZoneMode: null,
    ...overrides,
  };
}

export const UNIFIED_MIXED_RESPONSE = {
  success: [{ index: 1, report: unifiedReportMetadata(UNIFIED_REPORT_IDS[1]) }],
  error: [{ index: 0, errors: [{ code: 'QUERY_INVALID', message: 'synthetic refusal' }] }],
} as const;
