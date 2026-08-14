import type { EntityRow, Region, ReportType } from '@wizard-ads/shared';

/** The profile routing information every Amazon call needs. */
export interface AdsProfileContext {
  id: string;
  orgId: string;
  amazonProfileId: string;
  region: Region;
  currencyCode: string;
  timezone: string;
}

export interface CreateReportInput {
  profile: AdsProfileContext;
  reportType: ReportType;
  startDate: string;
  endDate: string;
}

export interface AdsReportStatus {
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILURE' | 'CANCELLED';
  downloadUrl?: string;
  downloadExpiresAt?: Date;
  failureReason?: string;
}

/**
 * Narrow worker-owned boundary for WP-02. Tests implement this interface; the
 * production adapter will be a mechanical mapping onto the final client.
 */
export interface AdsApiClient {
  listEntities(profile: AdsProfileContext, full: boolean): Promise<readonly EntityRow[]>;
  createReport(input: CreateReportInput): Promise<{ reportId: string }>;
  getReport(profile: AdsProfileContext, reportId: string): Promise<AdsReportStatus>;
  downloadReport(url: string): Promise<AsyncIterable<Uint8Array>>;
  listProfiles(region: Region): Promise<readonly string[]>;
}

export class AdsApiRetryableError extends Error {
  constructor(message: string, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = 'AdsApiRetryableError';
  }
}

export class DownloadUrlExpiredError extends AdsApiRetryableError {
  constructor(message = 'report download URL expired') {
    super(message);
    this.name = 'DownloadUrlExpiredError';
  }
}

// INTEGRATE(WP-02): construct the final @wizard-ads/ads-api client here and
// map its entity/report/profile methods onto AdsApiClient.
export function createAdsApiClientFromEnv(_env: NodeJS.ProcessEnv = process.env): AdsApiClient {
  throw new Error('WP-02 ads-api adapter is not integrated yet');
}
