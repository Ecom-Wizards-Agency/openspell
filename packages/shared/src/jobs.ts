/**
 * `JobPayload`: what one row in the `sync_jobs` queue carries.
 *
 * Reporting v3 is async, so it is three separate jobs and not one long one:
 * `report.request` mints the report, `report.poll` waits (5 to 30 minute
 * intervals, hours not seconds), `report.fetch` streams the GZIP down and
 * counts parsed rows against loaded rows. Splitting them is what makes a killed
 * worker resumable instead of a lost report.
 */
import { z } from 'zod';
import { AdProduct, AmazonId, IsoDate, Uuid } from './primitives.js';

export const JobType = z.enum([
  'entity.sync',
  'report.request',
  'report.poll',
  'report.fetch',
  'crosscheck.ingest',
  'recommendations.run',
]);
export type JobType = z.infer<typeof JobType>;

/** v1 report types. Names follow Amazon's Reporting v3 report type ids. */
export const ReportType = z.enum([
  'spCampaigns',
  'spTargeting',
  'spSearchTerm',
  'spPlacement',
  'sbCampaigns',
  'sdCampaigns',
]);
export type ReportType = z.infer<typeof ReportType>;

/** Every job is scoped to one org and one profile. RLS depends on it. */
const jobBase = {
  orgId: Uuid,
  profileId: Uuid,
};

export const EntitySyncJob = z.object({
  ...jobBase,
  type: z.literal(JobType.enum['entity.sync']),
  adProduct: AdProduct.optional(),
  /** A full pass re-lists everything; the default pass diffs against the mirror. */
  full: z.boolean().default(false),
});

export const ReportRequestJob = z.object({
  ...jobBase,
  type: z.literal(JobType.enum['report.request']),
  reportType: ReportType,
  startDate: IsoDate,
  endDate: IsoDate,
});

export const ReportPollJob = z.object({
  ...jobBase,
  type: z.literal(JobType.enum['report.poll']),
  /** Our `report_requests` row. */
  reportRequestId: Uuid,
  /** Amazon's report id, known once the request succeeded. */
  amazonReportId: AmazonId,
  attempt: z.number().int().nonnegative(),
});

export const ReportFetchJob = z.object({
  ...jobBase,
  type: z.literal(JobType.enum['report.fetch']),
  reportRequestId: Uuid,
  amazonReportId: AmazonId,
  /** Amazon's pre-signed URL. Short-lived, so a stale fetch re-polls. */
  downloadUrl: z.url(),
});

export const CrosscheckIngestJob = z.object({
  ...jobBase,
  type: z.literal(JobType.enum['crosscheck.ingest']),
  /** The day being compared. Same-day is provisional and never crosschecked. */
  date: IsoDate,
  /** Where the AdLabs export landed. */
  sourcePath: z.string().min(1),
});

export const RecommendationsRunJob = z.object({
  ...jobBase,
  type: z.literal(JobType.enum['recommendations.run']),
  runId: Uuid,
  lookbackDays: z.number().int().positive(),
});

export const JobPayload = z.discriminatedUnion('type', [
  EntitySyncJob,
  ReportRequestJob,
  ReportPollJob,
  ReportFetchJob,
  CrosscheckIngestJob,
  RecommendationsRunJob,
]);
export type JobPayload = z.infer<typeof JobPayload>;

export type EntitySyncJob = z.infer<typeof EntitySyncJob>;
export type ReportRequestJob = z.infer<typeof ReportRequestJob>;
export type ReportPollJob = z.infer<typeof ReportPollJob>;
export type ReportFetchJob = z.infer<typeof ReportFetchJob>;
export type CrosscheckIngestJob = z.infer<typeof CrosscheckIngestJob>;
export type RecommendationsRunJob = z.infer<typeof RecommendationsRunJob>;
