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
  'keepa.sync',
  'rank.sync',
  'economics.sync',
  'sqp.categorize',
  'creative.sync',
  'sqp.request',
  'history.bootstrap',
  'report.promote',
  'marketing_stream.normalize',
  'report.unified.advance',
]);
export type JobType = z.infer<typeof JobType>;

/** The feature subset, retained for consumers that only enumerate this wave. */
export const FeatureJobType = z.enum([
  'creative.sync',
  'sqp.request',
  'history.bootstrap',
  'report.promote',
  'marketing_stream.normalize',
  'report.unified.advance',
]);
export type FeatureJobType = z.infer<typeof FeatureJobType>;

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

/** Additive report surfaces not yet implemented by the legacy Ads API client. */
export const FeatureReportType = z.enum(['sbAds']);
export type FeatureReportType = z.infer<typeof FeatureReportType>;
export const WorkerReportType = z.enum([
  ...ReportType.options,
  ...FeatureReportType.options,
]);
export type WorkerReportType = z.infer<typeof WorkerReportType>;
const reportCount = z.number().int().nonnegative();

/** Truthful source-to-canonical accounting for attribution-aware reports. */
export const WorkerReportAccounting = z.object({
  sourceRows: reportCount,
  parsedRows: reportCount,
  refusedRows: reportCount,
  promotedRows: reportCount,
  unpromotedRows: reportCount,
  canonicalRows: reportCount,
}).superRefine((counts, context) => {
  if (counts.sourceRows !== counts.parsedRows + counts.refusedRows) {
    context.addIssue({ code: 'custom', message: 'source rows must equal parsed plus refused rows' });
  }
  if (counts.parsedRows !== counts.promotedRows + counts.unpromotedRows) {
    context.addIssue({ code: 'custom', message: 'parsed rows must equal promoted plus unpromoted rows' });
  }
  if (counts.promotedRows !== counts.canonicalRows) {
    context.addIssue({ code: 'custom', message: 'promoted rows must equal canonical rows' });
  }
});
export type WorkerReportAccounting = z.infer<typeof WorkerReportAccounting>;

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
  reportType: WorkerReportType,
  startDate: IsoDate,
  endDate: IsoDate,
  /** Required by the runtime for sbAds; forbidden there for base reports. */
  creativeSyncSnapshotId: Uuid.nullable().optional(),
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
  /** When present, the run evaluates only this due group and carries its snapshot. */
  groupId: Uuid.optional(),
});

export const KeepaSyncJob = z.object({
  ...jobBase,
  type: z.literal(JobType.enum['keepa.sync']),
  asins: z.array(z.string()).optional(),
  includeCompetitors: z.boolean(),
});

export const RankSyncJob = z.object({
  ...jobBase,
  type: z.literal(JobType.enum['rank.sync']),
  radarIds: z.array(z.string()).optional(),
});

export const EconomicsSyncJob = z.object({
  ...jobBase,
  type: z.literal(JobType.enum['economics.sync']),
});

export const SqpCategorizeJob = z.object({
  ...jobBase,
  type: z.literal(JobType.enum['sqp.categorize']),
  weekStart: IsoDate,
});

export const CreativeSyncJob = z.object({
  ...jobBase,
  type: z.literal(FeatureJobType.enum['creative.sync']),
  startDate: IsoDate,
  endDate: IsoDate,
  adProduct: z.literal('SB'),
  /**
   * Off by default. When enabled, only a single report day may be joined to
   * this current observation, and the stored provenance remains explicitly
   * non-historical.
   */
  allowObservedAttributionFacts: z.boolean().optional(),
});

/** Durable report-ledger shape shared by the worker and database adapter. */
export const WorkerReportLedger = z.object({
  id: Uuid,
  orgId: Uuid,
  profileId: Uuid,
  reportType: WorkerReportType,
  startDate: IsoDate,
  endDate: IsoDate,
  source: z.string().min(1),
  amazonReportId: AmazonId.nullable(),
  requestedAt: z.iso.datetime(),
  pollAttempts: z.number().int().nonnegative(),
  creativeSyncSnapshotId: Uuid.nullable(),
});
export type WorkerReportLedger = z.infer<typeof WorkerReportLedger>;

export const SqpRequestJob = z.object({
  ...jobBase,
  type: z.literal(FeatureJobType.enum['sqp.request']),
  marketplaceId: AmazonId,
  asins: z.array(AmazonId).min(1),
  weekStart: IsoDate,
  weekEnd: IsoDate,
});

export const HistoryBootstrapJob = z.object({
  ...jobBase,
  type: z.literal(FeatureJobType.enum['history.bootstrap']),
  reportType: WorkerReportType,
  source: z.enum(['amazon_reporting_v3', 'amazon_unified_reporting']),
  cursorDate: IsoDate.nullable(),
});

export const ReportPromoteJob = z.object({
  ...jobBase,
  type: z.literal(FeatureJobType.enum['report.promote']),
  reportRequestId: Uuid,
  reportType: WorkerReportType,
  date: IsoDate,
});

export const MarketingStreamNormalizeJob = z.object({
  ...jobBase,
  type: z.literal(FeatureJobType.enum['marketing_stream.normalize']),
  messageIds: z.array(z.string().min(1)),
  /** Explicit operator or continuation recovery of durable blocked scopes. */
  replayBlockedProfile: z.boolean().optional(),
  /** Bounded policy-configuration retry generation; absent on normal ingestion jobs. */
  configurationRetryAttempt: z.number().int().min(1).max(24).optional(),
}).superRefine((job, context) => {
  if (job.messageIds.length === 0 && job.replayBlockedProfile !== true) {
    context.addIssue({ code: 'custom', path: ['messageIds'], message: 'normalization requires messages or blocked-profile replay' });
  }
});

/** One durable Unified Reporting sidecar operation; provider input stays off the queue. */
export const UnifiedReportAdvanceJob = z.object({
  ...jobBase,
  type: z.literal(FeatureJobType.enum['report.unified.advance']),
  runId: Uuid,
  operationId: Uuid,
});

export const JobPayload = z.discriminatedUnion('type', [
  EntitySyncJob,
  ReportRequestJob,
  ReportPollJob,
  ReportFetchJob,
  CrosscheckIngestJob,
  RecommendationsRunJob,
  KeepaSyncJob,
  RankSyncJob,
  EconomicsSyncJob,
  SqpCategorizeJob,
  CreativeSyncJob,
  SqpRequestJob,
  HistoryBootstrapJob,
  ReportPromoteJob,
  MarketingStreamNormalizeJob,
  UnifiedReportAdvanceJob,
]);
export type JobPayload = z.infer<typeof JobPayload>;

export const FeatureJobPayload = z.discriminatedUnion('type', [
  CreativeSyncJob,
  SqpRequestJob,
  HistoryBootstrapJob,
  ReportPromoteJob,
  MarketingStreamNormalizeJob,
  UnifiedReportAdvanceJob,
]);
export type FeatureJobPayload = z.infer<typeof FeatureJobPayload>;

export type EntitySyncJob = z.infer<typeof EntitySyncJob>;
export type ReportRequestJob = z.infer<typeof ReportRequestJob>;
export type ReportPollJob = z.infer<typeof ReportPollJob>;
export type ReportFetchJob = z.infer<typeof ReportFetchJob>;
export type CrosscheckIngestJob = z.infer<typeof CrosscheckIngestJob>;
export type RecommendationsRunJob = z.infer<typeof RecommendationsRunJob>;
export type KeepaSyncJob = z.infer<typeof KeepaSyncJob>;
export type RankSyncJob = z.infer<typeof RankSyncJob>;
export type EconomicsSyncJob = z.infer<typeof EconomicsSyncJob>;
export type SqpCategorizeJob = z.infer<typeof SqpCategorizeJob>;
export type CreativeSyncJob = z.infer<typeof CreativeSyncJob>;
export type SqpRequestJob = z.infer<typeof SqpRequestJob>;
export type HistoryBootstrapJob = z.infer<typeof HistoryBootstrapJob>;
export type ReportPromoteJob = z.infer<typeof ReportPromoteJob>;
export type MarketingStreamNormalizeJob = z.infer<typeof MarketingStreamNormalizeJob>;
export type UnifiedReportAdvanceJob = z.infer<typeof UnifiedReportAdvanceJob>;
