import type { SkippedReportRow } from '@wizard-ads/ads-api';
import {
  DuplicateFactGrain,
  InvalidReportDatePromotion,
  type ClaimedJob,
} from '@wizard-ads/db';
import {
  JobPayload,
  type EconomicsSyncJob,
  type AmazonApplyJob,
  type AmazonObserveJob,
  type CreativeSyncJob,
  type HistoryBootstrapJob,
  type JobType,
  type KeepaSyncJob,
  type MarketingStreamNormalizeJob,
  type RankSyncJob,
  type Region,
  type ReportType,
  type ReportPromoteJob,
  type SqpRequestJob,
  type SqpCategorizeJob,
} from '@wizard-ads/shared';
import { SpApiAuthError, SpApiError, SpApiParseError } from '@wizard-ads/sp-api';
import { isPermanentCrosscheckError, type CrosscheckIngest } from './crosscheck.js';
import {
  AdsApiRetryableError,
  DownloadUrlExpiredError,
  type AdProductCode,
  type AdsApiClient,
  type AdsProfileContext,
  type EntityListFailure,
} from './ads-api.js';
import { runBidSeriesSync, type BidSeriesSyncDeps } from './bid-series.js';
import type {
  RecommendationScheduleStore,
  RecommendationsRun,
} from './recommendations-run.js';
import { SKIP_FAILURE_RATIO, gunzipJson, parseReportRows } from './parsers.js';
import {
  UnsafeSponsoredProductsReport,
  prepareSponsoredProductsReportDates,
} from './report-promotion.js';
import {
  defaultRegionTokenBuckets,
  type RegionTokenBuckets,
} from './region-token-buckets.js';
import type { ReportRequestState, WorkerStore } from './store.js';
import type { SbVideoIngestionRuntime } from './sb-video-ingestion.js';
import {
  SqpWorkflowPendingError,
  SqpWorkflowPermanentError,
  type SqpQueuedJobContext,
} from './sqp.js';
import type { WeeklySqpScheduleProducer } from './sqp-scheduler.js';
import type { GuardedAmazonWriteRuntime } from './amazon-writes.js';
import { SpWriteRetryableError } from './ads-api.js';

const MINUTE_MS = 60_000;
const FOUR_HOURS_MS = 4 * 60 * MINUTE_MS;
const POLL_DELAYS_MINUTES = [5, 10, 20, 30] as const;
const SP_REPORT_TYPES = new Set(['spCampaigns', 'spTargeting', 'spSearchTerm', 'spPlacement']);
type BaseReportRequestState = Omit<ReportRequestState, 'reportType'> & { reportType: ReportType };

/** A failure retrying cannot fix. Goes straight to `dead` with its attempts unspent. */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

/** A provider failure that should return to the queue after a known delay. */
export class RetryableJobError extends Error {
  constructor(message: string, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = 'RetryableJobError';
  }
}

export interface WorkerLogger {
  info(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export interface IntegrationHandlers {
  keepaSync?: (payload: KeepaSyncJob) => Promise<Record<string, unknown>>;
  rankSync?: (payload: RankSyncJob) => Promise<Record<string, unknown>>;
  economicsSync?: (payload: EconomicsSyncJob) => Promise<Record<string, unknown>>;
  sqpCategorize?: (payload: SqpCategorizeJob) => Promise<Record<string, unknown>>;
  creativeSync?: (payload: CreativeSyncJob) => Promise<Record<string, unknown>>;
  sqpRequest?: (
    payload: SqpRequestJob,
    context: SqpQueuedJobContext,
  ) => Promise<Record<string, unknown>>;
  historyBootstrap?: (payload: HistoryBootstrapJob) => Promise<Record<string, unknown>>;
  reportPromote?: (payload: ReportPromoteJob) => Promise<Record<string, unknown>>;
  marketingStreamNormalize?: (payload: MarketingStreamNormalizeJob) => Promise<Record<string, unknown>>;
}

const consoleLogger: WorkerLogger = {
  info: (message, details) => console.info(message, details ?? {}),
  error: (message, details) => console.error(message, details ?? {}),
};

export interface SyncWorkerOptions {
  workerId: string;
  store: WorkerStore;
  /** Optional so an integration-only runtime needs no Amazon credentials. */
  adsApi?: AdsApiClient;
  /** Job types this runtime may atomically claim. Undefined means all. */
  jobTypes?: readonly JobType[];
  /** Provider handlers deployed in this runtime. Missing handlers dead-letter. */
  integrations?: IntegrationHandlers;
  /** WP-10's handler, bound to a database handle. Absent, the job dead-letters. */
  crosscheckIngest?: CrosscheckIngest;
  /** WP-33's preview-only recommendations runner. Absent, the job dead-letters. */
  recommendationsRun?: RecommendationsRun;
  /** Read-only current-snapshot SB Video ingestion and sbAds promotion. */
  sbVideo?: SbVideoIngestionRuntime;
  /** Guarded worker-only Amazon mutation and observation runtime. */
  amazonWrites?: GuardedAmazonWriteRuntime;
  buckets?: RegionTokenBuckets;
  claimBatchSize?: number;
  maxConcurrentJobs?: number;
  pollIntervalMs?: number;
  now?: () => Date;
  logger?: WorkerLogger;
}

export class SyncWorker {
  readonly workerId: string;
  private readonly store: WorkerStore;
  private readonly adsApi: AdsApiClient | undefined;
  private readonly jobTypes: readonly JobType[] | undefined;
  private readonly integrations: IntegrationHandlers;
  private readonly crosscheckIngest: CrosscheckIngest | undefined;
  private readonly recommendationsRun: RecommendationsRun | undefined;
  private readonly sbVideo: SbVideoIngestionRuntime | undefined;
  private readonly amazonWrites: GuardedAmazonWriteRuntime | undefined;
  private readonly buckets: RegionTokenBuckets;
  private readonly claimBatchSize: number;
  private readonly maxConcurrentJobs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;
  private readonly logger: WorkerLogger;
  private readonly running = new Map<string, { job: ClaimedJob; promise: Promise<void> }>();
  private stopping = false;

  constructor(options: SyncWorkerOptions) {
    this.workerId = options.workerId;
    this.store = options.store;
    this.adsApi = options.adsApi;
    this.jobTypes = options.jobTypes;
    this.integrations = options.integrations ?? {};
    this.crosscheckIngest = options.crosscheckIngest;
    this.recommendationsRun = options.recommendationsRun;
    this.sbVideo = options.sbVideo;
    this.amazonWrites = options.amazonWrites;
    this.buckets = options.buckets ?? defaultRegionTokenBuckets;
    this.claimBatchSize = options.claimBatchSize ?? 10;
    this.maxConcurrentJobs = options.maxConcurrentJobs ?? 10;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? consoleLogger;
  }

  status(): { workerId: string; stopping: boolean; running: number } {
    return { workerId: this.workerId, stopping: this.stopping, running: this.running.size };
  }

  async start(): Promise<void> {
    this.stopping = false;
    while (!this.stopping) {
      const claimed = await this.claimAvailable();
      if (claimed === 0) await delay(this.pollIntervalMs);
    }
    await Promise.allSettled([...this.running.values()].map(({ promise }) => promise));
  }

  /**
   * Claim one batch and wait until this batch finishes. Used by tests and by
   * the one-shot drivers (the Vercel-cron route) that run the worker without its
   * always-on `start()` loop.
   *
   * `maxJobs` caps how many this batch claims (defaults to the configured claim
   * batch size). `deadlineMs` is an absolute `Date.now()` budget: past it this
   * returns 0 without claiming, so a caller looping `drainOnce` under a wall
   * clock stops taking new work rather than starting a job it cannot see
   * through before the platform kills the request.
   */
  async drainOnce(maxJobs?: number, deadlineMs?: number): Promise<number> {
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) return 0;
    const before = new Set(this.running.keys());
    const claimed = await this.claimAvailable(maxJobs);
    const batch = [...this.running.entries()]
      .filter(([id]) => !before.has(id))
      .map(([, { promise }]) => promise);
    await Promise.allSettled(batch);
    return claimed;
  }

  async shutdown(releaseAfterMs = 25_000): Promise<{ released: number }> {
    this.stopping = true;
    if (this.running.size === 0) return { released: 0 };

    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.running.values()].map(({ promise }) => promise)),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => { timedOut = true; resolve(); }, releaseAfterMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    return {
      released: timedOut ? await this.store.release(
        this.workerId,
        [...this.running.values()].map(({ job }) => ({
          jobId: job.id,
          claimToken: job.claimToken ?? null,
        })),
      ) : 0,
    };
  }

  async runAuthHealthcheck(): Promise<{ ok: Region[]; failed: Region[] }> {
    const adsApi = this.requireAdsApi();
    const regions: Region[] = ['NA', 'EU', 'FE'];
    const ok: Region[] = [];
    const failed: Region[] = [];
    await Promise.all(regions.map(async (region) => {
      try {
        await this.buckets.run(region, () => adsApi.listProfiles(region));
        ok.push(region);
      } catch (error) {
        failed.push(region);
        this.logger.error('Amazon auth healthcheck failed', { region, error: errorMessage(error) });
      }
    }));
    return { ok, failed };
  }

  private async claimAvailable(maxJobs?: number): Promise<number> {
    if (this.stopping) return 0;
    const capacity = this.maxConcurrentJobs - this.running.size;
    if (capacity <= 0) return 0;
    const batchSize = Math.min(maxJobs ?? this.claimBatchSize, capacity);
    const jobs = await this.store.claim(this.workerId, batchSize, this.jobTypes);
    for (const job of jobs) {
      const claimKey = `${job.id}:${job.claimToken ?? 'legacy'}`;
      const task = this.runClaimed(job).finally(() => this.running.delete(claimKey));
      this.running.set(claimKey, { job, promise: task });
    }
    return jobs.length;
  }

  private async runClaimed(job: ClaimedJob): Promise<void> {
    try {
      const result = await this.execute(job);
      await this.store.finish(job.id, 'succeeded', { result, claimToken: job.claimToken });
    } catch (error) {
      if (error instanceof SqpWorkflowPendingError || error instanceof SpWriteRetryableError) {
        const retryIn = `${error.retryAfterSeconds} seconds`;
        if (this.store.defer) {
          await this.store.defer(job.id, retryIn, job.claimToken);
        } else {
          // Adapter/test stores predating queue deferral retain the safe legacy
          // behavior. The production Postgres store never takes this branch.
          await this.store.finish(job.id, 'failed', {
            error: errorMessage(error).slice(0, 4_000),
            retryIn,
            claimToken: job.claimToken,
          });
        }
        this.logger.info('sync job deferred for provider processing', {
          jobId: job.id,
          type: job.jobType,
          retryAfterSeconds: error.retryAfterSeconds,
        });
        return;
      }
      if (
        error instanceof PermanentJobError ||
        error instanceof SqpWorkflowPermanentError ||
        error instanceof SpApiParseError ||
        (error instanceof SpApiAuthError && !error.retryable) ||
        (error instanceof SpApiError && !error.retryable) ||
        isPermanentCrosscheckError(error)
      ) {
        await this.store.deadLetter(
          job.id,
          errorMessage(error).slice(0, 4_000),
          job.claimToken,
        );
        this.logger.error('sync job dead-lettered', {
          jobId: job.id, type: job.jobType, error: errorMessage(error),
        });
        return;
      }
      const explicitRetry = error instanceof AdsApiRetryableError || error instanceof RetryableJobError || error instanceof SpWriteRetryableError
        ? error.retryAfterSeconds
        : undefined;
      const retrySeconds = explicitRetry !== undefined
        ? explicitRetry
        : Math.min(60 * 2 ** Math.max(job.attempts - 1, 0), 30 * 60);
      await this.store.finish(job.id, 'failed', {
        error: errorMessage(error).slice(0, 4_000),
        retryIn: `${retrySeconds} seconds`,
        claimToken: job.claimToken,
      });
      this.logger.error('sync job failed', { jobId: job.id, type: job.jobType, error: errorMessage(error) });
    }
  }

  private async execute(job: ClaimedJob): Promise<Record<string, unknown>> {
    const payload = JobPayload.parse(job.payload);
    if (payload.orgId !== job.orgId || payload.profileId !== job.profileId || payload.type !== job.jobType) {
      throw new Error(`job ${job.id} queue columns do not match its payload`);
    }
    const profile = await this.store.profile(payload.profileId);
    if (profile.orgId !== payload.orgId) throw new Error(`job ${job.id} profile belongs to another org`);

    switch (payload.type) {
      case 'entity.sync':
        return this.syncEntities(profile, payload);
      case 'report.request':
        return this.requestReport(job.id, profile, payload);
      case 'report.poll':
        return this.pollReport(profile, payload);
      case 'report.fetch':
        return this.fetchReport(profile, payload);
      case 'recommendations.run':
        if (!this.recommendationsRun) {
          throw new PermanentJobError('recommendations runner is not configured on this worker');
        }
        return { ...(await this.recommendationsRun(payload)) };
      case 'crosscheck.ingest':
        return this.ingestCrosscheck(payload);
      case 'keepa.sync':
        return this.runIntegration(payload.type, this.integrations.keepaSync, payload);
      case 'rank.sync':
        return this.runIntegration(payload.type, this.integrations.rankSync, payload);
      case 'economics.sync':
        return this.runIntegration(payload.type, this.integrations.economicsSync, payload);
      case 'sqp.categorize':
        return this.runIntegration(payload.type, this.integrations.sqpCategorize, payload);
      case 'creative.sync': {
        const sbVideo = this.sbVideo;
        if (sbVideo) {
          return this.buckets.run(profile.region, () => sbVideo.syncSnapshot({
            jobId: job.id,
            profile,
            payload,
          }));
        }
        return this.runIntegration(payload.type, this.integrations.creativeSync, payload);
      }
      case 'sqp.request':
        if (!this.integrations.sqpRequest) {
          throw new PermanentJobError(`${payload.type} handler not deployed in this runtime`);
        }
        return this.integrations.sqpRequest(payload, { jobId: job.id });
      case 'history.bootstrap':
        return this.runIntegration(payload.type, this.integrations.historyBootstrap, payload);
      case 'report.promote':
        return this.runIntegration(payload.type, this.integrations.reportPromote, payload);
      case 'marketing_stream.normalize':
        return this.runIntegration(payload.type, this.integrations.marketingStreamNormalize, payload);
      case 'amazon.apply':
        return this.runAmazonApply(profile, payload);
      case 'amazon.observe':
        return this.runAmazonObserve(profile, payload);
    }
  }

  private runAmazonApply(
    profile: AdsProfileContext,
    payload: AmazonApplyJob,
  ): Promise<Record<string, unknown>> {
    if (!this.amazonWrites) throw new PermanentJobError('Amazon write runtime is not configured');
    return this.buckets.run(profile.region, () => this.amazonWrites!.apply(payload, profile));
  }

  private runAmazonObserve(
    profile: AdsProfileContext,
    payload: AmazonObserveJob,
  ): Promise<Record<string, unknown>> {
    if (!this.amazonWrites) throw new PermanentJobError('Amazon write runtime is not configured');
    return this.buckets.run(profile.region, () => this.amazonWrites!.observe(payload, profile));
  }

  private async runIntegration<TPayload extends JobPayload>(
    type: TPayload['type'],
    handler: ((payload: TPayload) => Promise<Record<string, unknown>>) | undefined,
    payload: TPayload,
  ): Promise<Record<string, unknown>> {
    if (!handler) throw new PermanentJobError(`${type} handler not deployed in this runtime`);
    return handler(payload);
  }

  /**
   * List and mirror entities with per-ad-product isolation.
   *
   * The first live sync lost every product's campaigns to a single Sponsored
   * Brands 400: one throw aborted the whole job before anything was committed.
   * Now each ad product is listed and mirrored on its own. A product that
   * listed cleanly is committed regardless of what the others did; a product
   * that failed leaves its mirror untouched (so a `full` pass never tombstones
   * a product it could not see).
   *
   * **A partial failure still fails the job**, after the winners are committed.
   * Reporting success would leave one product's mirror silently stale — the
   * grid would show yesterday's Sponsored Brands campaigns with nothing saying
   * so, which is worse than a retry. The re-thrown error is the most retryable
   * of the failures, so a 429 requeues on Amazon's own `Retry-After` rather
   * than on a sibling 400's flat backoff, and the re-run redoing the products
   * that already committed is harmless: every write here is an upsert.
   */
  private async syncEntities(
    profile: AdsProfileContext,
    payload: Extract<JobPayload, { type: 'entity.sync' }>,
  ): Promise<Record<string, unknown>> {
    const adsApi = this.requireAdsApi();
    const listingObservedAt = new Date();
    const listing = await this.buckets.run(profile.region, () => adsApi.listEntities(profile, payload.full));

    // A product-scoped job cares only about its own product; an unscoped job
    // covers all three.
    const requested: readonly AdProductCode[] = payload.adProduct
      ? [payload.adProduct]
      : ['SP', 'SB', 'SD'];
    const succeeded = requested.filter((product) => listing.succeeded.includes(product));
    const failures = listing.failures.filter((failure) => requested.includes(failure.adProduct));

    // Everything asked for failed: nothing to commit, so fail loudly and let
    // the retry policy see the real error type.
    if (succeeded.length === 0) {
      const worst = mostRetryable(failures);
      if (worst) throw worst.error instanceof Error ? worst.error : new Error(worst.message);
      throw new Error(`entity sync listed nothing for ${requested.join(', ')}`);
    }

    const totals = { listed: 0, upserted: 0, duplicates: 0, changes: 0, tombstoned: 0 };
    for (const product of succeeded) {
      const productRows = listing.rows.filter((row) => row.adProduct === product);
      // Scope the mirror to this product so tombstoning stays within it and a
      // sibling product that failed to list is never touched.
      const counts = await this.store.syncEntities(profile, productRows, {
        adProduct: product,
        full: payload.full,
        observedAt: listingObservedAt,
      });
      // Program rule 4: the artifact, not the exit code. A listing that
      // upserted fewer rows than it listed lost some — unless the shortfall is
      // exactly the rows another row in the same listing already carried (the
      // negatives mirror merges three Amazon endpoints onto one key).
      if (counts.listed !== counts.upserted + (counts.superseded ?? 0) + counts.duplicates) {
        throw new Error(
          `${product}: listed ${counts.listed}, upserted ${counts.upserted}, `
          + `superseded ${counts.superseded ?? 0}, duplicates ${counts.duplicates}`,
        );
      }
      totals.listed += counts.listed;
      totals.upserted += counts.upserted;
      totals.duplicates += counts.duplicates;
      totals.changes += counts.changes;
      totals.tombstoned += counts.tombstoned;
    }

    const failureSummary = failures.map((failure) => ({ adProduct: failure.adProduct, error: failure.message }));
    if (failureSummary.length > 0) {
      this.logger.error('entity sync partial failure', {
        profileId: profile.id,
        succeeded,
        failed: failureSummary,
        ...totals,
      });
      // Committed above, thrown here: the products that listed are in the
      // mirror, and the job goes back on the queue because one is not.
      throw partialSyncError(succeeded, failures);
    }
    this.logger.info('entity sync', { profileId: profile.id, succeeded, ...totals });
    return { ...totals, succeeded, failures: failureSummary };
  }

  /**
   * WP-10's handler, run under this worker's claim loop and retry policy.
   *
   * A `mismatch` headline is the product, not a failure: the job succeeds and
   * the verdict is the result. Only a throw fails it, and only the two
   * permanent errors skip the retries.
   */
  private async ingestCrosscheck(
    payload: Extract<JobPayload, { type: 'crosscheck.ingest' }>,
  ): Promise<Record<string, unknown>> {
    if (!this.crosscheckIngest) {
      throw new PermanentJobError('crosscheck ingest is not configured on this worker');
    }
    const result = await this.crosscheckIngest(payload);
    // Program rule 4: rows offered against rows kept, verdicts against rows
    // written. `rowsParsed > rowsKept` is normal — the incumbent's export
    // carries every profile the team can see.
    this.logger.info('crosscheck ingest', {
      profileId: payload.profileId,
      date: payload.date,
      filesParsed: result.filesParsed,
      rowsParsed: result.rowsParsed,
      rowsKept: result.rowsKept,
      findings: result.findings.length,
      written: result.written,
      headline: result.summary.headline,
    });
    return {
      headline: result.summary.headline,
      filesParsed: result.filesParsed,
      rowsParsed: result.rowsParsed,
      rowsKept: result.rowsKept,
      findings: result.findings.length,
      written: result.written,
    };
  }

  private async requestReport(
    jobId: string,
    profile: AdsProfileContext,
    payload: Extract<JobPayload, { type: 'report.request' }>,
  ): Promise<Record<string, unknown>> {
    const adsApi = this.requireAdsApi();
    if (payload.reportType === 'sbAds' && payload.creativeSyncSnapshotId == null) {
      throw new PermanentJobError('sbAds report request is missing creative snapshot provenance');
    }
    if (payload.reportType !== 'sbAds' && payload.creativeSyncSnapshotId != null) {
      throw new PermanentJobError('base report request must not carry creative snapshot provenance');
    }
    const ledger = await this.store.ensureReportRequest(jobId, payload);
    let amazonReportId = ledger.amazonReportId;
    if (!amazonReportId) {
      const created = await this.buckets.run(profile.region, () => adsApi.createReport({
        profile,
        reportType: payload.reportType,
        startDate: payload.startDate,
        endDate: payload.endDate,
      }));
      amazonReportId = created.reportId;
      await this.store.setReportCreated(ledger.id, amazonReportId, addMinutes(this.now(), 5));
    }
    const pollPayload: Extract<JobPayload, { type: 'report.poll' }> = {
      type: 'report.poll', orgId: payload.orgId, profileId: payload.profileId,
      reportRequestId: ledger.id, amazonReportId, attempt: 0,
    };
    const enqueued = await this.store.enqueue(pollPayload, addMinutes(this.now(), 5), `report.poll:${ledger.id}:0`);
    return { reportRequestId: ledger.id, amazonReportId, pollEnqueued: enqueued };
  }

  private async pollReport(
    profile: AdsProfileContext,
    payload: Extract<JobPayload, { type: 'report.poll' }>,
  ): Promise<Record<string, unknown>> {
    const adsApi = this.requireAdsApi();
    const ledger = await this.store.getReportRequest(
      payload.reportRequestId,
      payload.orgId,
      payload.profileId,
    );
    assertAmazonReportId(ledger, payload.amazonReportId);
    const status = await this.buckets.run(profile.region, () => adsApi.getReport(profile, payload.amazonReportId));
    if (status.status === 'PENDING' || status.status === 'PROCESSING') {
      if (this.now().getTime() - ledger.requestedAt.getTime() >= FOUR_HOURS_MS) {
        await this.store.updateReportPoll(ledger.id, { status: 'expired', error: 'report did not complete within 4 hours' });
        return { status: 'expired', pollAttempts: payload.attempt + 1 };
      }
      const nextAttempt = payload.attempt + 1;
      const delayMinutes = POLL_DELAYS_MINUTES[Math.min(nextAttempt, POLL_DELAYS_MINUTES.length - 1)] ?? 30;
      const runAt = addMinutes(this.now(), delayMinutes);
      await this.store.updateReportPoll(ledger.id, { status: status.status === 'PENDING' ? 'pending' : 'processing', nextPollAt: runAt });
      const enqueued = await this.store.enqueue(
        { ...payload, attempt: nextAttempt }, runAt, `report.poll:${ledger.id}:${nextAttempt}`,
      );
      return { status: status.status, nextAttempt, delayMinutes, enqueued };
    }
    if (status.status === 'FAILURE' || status.status === 'CANCELLED') {
      const dbStatus = status.status === 'FAILURE' ? 'failed' : 'cancelled';
      await this.store.updateReportPoll(ledger.id, { status: dbStatus, error: status.failureReason ?? status.status });
      return { status: dbStatus, error: status.failureReason ?? null };
    }
    if (!status.downloadUrl) throw new Error(`completed report ${payload.amazonReportId} has no download URL`);
    await this.store.updateReportPoll(ledger.id, {
      status: 'processing', nextPollAt: null, downloadUrl: status.downloadUrl,
      downloadExpiresAt: status.downloadExpiresAt ?? null,
    });
    const fetchPayload: Extract<JobPayload, { type: 'report.fetch' }> = {
      type: 'report.fetch', orgId: payload.orgId, profileId: payload.profileId,
      reportRequestId: ledger.id, amazonReportId: payload.amazonReportId,
      downloadUrl: status.downloadUrl,
    };
    const enqueued = await this.store.enqueue(
      fetchPayload,
      this.now(),
      `report.fetch:${ledger.id}:${payload.attempt}`,
    );
    return { status: 'COMPLETED', fetchEnqueued: enqueued };
  }

  private async fetchReport(
    profile: AdsProfileContext,
    payload: Extract<JobPayload, { type: 'report.fetch' }>,
  ): Promise<Record<string, unknown>> {
    const adsApi = this.requireAdsApi();
    const ledger = await this.store.getReportRequest(
      payload.reportRequestId,
      payload.orgId,
      payload.profileId,
    );
    assertAmazonReportId(ledger, payload.amazonReportId);
    let downloaded;
    try {
      const source = await adsApi.downloadReport(payload.downloadUrl);
      downloaded = await gunzipJson(source);
    } catch (error) {
      if (!(error instanceof DownloadUrlExpiredError)) throw error;
      if (this.now().getTime() - ledger.requestedAt.getTime() >= FOUR_HOURS_MS) {
        const detail = 'report download URL remained expired beyond the 4-hour request horizon';
        await this.store.failReport(ledger.id, detail);
        throw new PermanentJobError(detail);
      }
      const attempt = ledger.pollAttempts;
      const pollPayload: Extract<JobPayload, { type: 'report.poll' }> = {
        type: 'report.poll', orgId: payload.orgId, profileId: payload.profileId,
        reportRequestId: ledger.id, amazonReportId: payload.amazonReportId, attempt,
      };
      const enqueued = await this.store.enqueue(
        pollPayload,
        this.now(),
        `report.repoll:${ledger.id}:${attempt}`,
      );
      return { downloadExpired: true, repollEnqueued: enqueued };
    }
    if (!Array.isArray(downloaded.value)) {
      const detail = 'report payload must be a JSON array';
      await this.store.failReport(ledger.id, detail);
      throw new PermanentJobError(detail);
    }
    if (ledger.reportType === 'sbAds') {
      if (!this.sbVideo) {
        const detail = 'sbAds ingestion runtime is not configured on this worker';
        await this.store.failReport(ledger.id, detail);
        throw new PermanentJobError(detail);
      }
      const creativeSyncSnapshotId = ledger.creativeSyncSnapshotId;
      if (creativeSyncSnapshotId == null) {
        const detail = 'sbAds report ledger is missing creative snapshot provenance';
        await this.store.failReport(ledger.id, detail);
        throw new PermanentJobError(detail);
      }
      const result = await this.sbVideo.ingestReport({
        profile,
        ledger: { ...ledger, creativeSyncSnapshotId },
        rawRows: downloaded.value,
      });
      const accounting = {
        sourceRows: result.reportSourceRows,
        parsedRows: result.reportParsedRows,
        refusedRows: result.reportRefusedRows,
        promotedRows: result.mappedFactRows,
        unpromotedRows: result.unpromotedReportRows,
        canonicalRows: result.factsReadBack,
      };
      if (result.blocked) {
        const detail = `sbAds promotion blocked: ${result.reasons.join(', ') || 'contract incomplete'}`;
        await this.store.finishAttributedReport(ledger.id, accounting, {
          status: 'failed',
          bytesDownloaded: downloaded.bytesDownloaded,
          error: detail,
        });
        throw new PermanentJobError(detail);
      }
      await this.store.finishAttributedReport(ledger.id, accounting, {
        status: 'completed',
        bytesDownloaded: downloaded.bytesDownloaded,
      });
      this.logger.info('Sponsored Brands Video report ingested', {
        reportRequestId: ledger.id,
        reportType: ledger.reportType,
        ...result,
      });
      return { ...result, bytesDownloaded: downloaded.bytesDownloaded };
    }
    const baseLedger: BaseReportRequestState = { ...ledger, reportType: ledger.reportType };
    const batch = parseReportRows(baseLedger.reportType, downloaded.value, profile, ledger.id);
    if (SP_REPORT_TYPES.has(baseLedger.reportType)) {
      return this.promoteSponsoredProductsReport(
        profile,
        baseLedger,
        downloaded.value,
        downloaded.bytesDownloaded,
        batch,
      );
    }
    const parsed = batch.rows.length;
    const skipped = batch.skipped.length;
    const reasons = skipReasons(batch.skipped);
    // Rows Amazon sent must be accounted for: kept plus refused. Asserted for
    // the two delegated grains, where the parser reports both numbers and the
    // fact row grain is the report row grain. `spCampaigns` aggregates onto the
    // profile grain by design, so the identity does not hold there.
    const accounted = batch.kind === 'sp_target' || batch.kind === 'search_term';
    if (accounted && batch.sourceRows !== parsed + skipped) {
      throw new Error(
        `report ${ledger.id}: ${batch.sourceRows} source rows but ${parsed} parsed + ${skipped} skipped`,
      );
    }
    // Deterministic schema drift, not bad luck: a parser that refused
    // everything (or nearly everything) will refuse it again on all five
    // attempts, and each retry leaves another stuck-processing ledger row. Fail
    // the ledger honestly and dead-letter instead.
    if (batch.sourceRows > 0 && (parsed === 0 || skipped / batch.sourceRows > SKIP_FAILURE_RATIO)) {
      const detail = `parser refused ${skipped} of ${batch.sourceRows} rows: ${formatReasons(reasons)}`;
      await this.store.updateReportPoll(ledger.id, { status: 'failed', error: detail });
      throw new PermanentJobError(`${ledger.reportType} ${detail}`);
    }
    const loaded = await this.store.loadFacts(batch);
    // Program rule 4 again: `completeReport` throws on a mismatch, so a fetch
    // that silently dropped rows fails the job instead of reporting success.
    await this.store.completeReport(ledger.id, { parsed, loaded, bytesDownloaded: downloaded.bytesDownloaded });
    this.logger.info('report fetched', {
      reportRequestId: ledger.id, reportType: ledger.reportType,
      reportRows: batch.sourceRows, parsed, loaded, skipped, skipReasons: reasons,
    });
    return {
      reportRows: batch.sourceRows, parsed, loaded, skipped, skipReasons: reasons,
      bytesDownloaded: downloaded.bytesDownloaded,
    };
  }

  private async promoteSponsoredProductsReport(
    profile: AdsProfileContext,
    ledger: BaseReportRequestState,
    rawRows: readonly unknown[],
    bytesDownloaded: number,
    batch: ReturnType<typeof parseReportRows>,
  ): Promise<Record<string, unknown>> {
    const skipped = batch.skipped.length;
    const reasons = skipReasons(batch.skipped);
    if (batch.sourceRows !== rawRows.length) {
      const detail = `${batch.sourceRows} parser source rows do not match ${rawRows.length} payload rows`;
      await this.store.failReport(ledger.id, detail);
      throw new PermanentJobError(`${ledger.reportType} ${detail}`);
    }
    if (skipped > 0) {
      const detail = `replacement parser refused ${skipped} of ${batch.sourceRows} rows: ${formatReasons(reasons)}`;
      await this.store.failReport(ledger.id, detail);
      throw new PermanentJobError(`${ledger.reportType} ${detail}`);
    }

    const observedAt = this.now();
    let staged;
    try {
      staged = prepareSponsoredProductsReportDates({
        orgId: profile.orgId,
        profileId: profile.id,
        reportType: ledger.reportType,
        source: 'amazon_reporting_v3',
        reportRequestId: ledger.id,
        requestedAt: ledger.requestedAt,
        observedAt,
        attributionWindowDays: 7,
        batch,
        rawRows,
        startDate: ledger.startDate,
        endDate: ledger.endDate,
        profileTimeZone: profile.timezone,
      });
    } catch (error) {
      if (
        !(error instanceof UnsafeSponsoredProductsReport) &&
        !(error instanceof InvalidReportDatePromotion) &&
        !(error instanceof DuplicateFactGrain)
      ) throw error;
      const detail = errorMessage(error).slice(0, 4_000);
      await this.store.failReport(ledger.id, detail);
      throw new PermanentJobError(`${ledger.reportType} ${detail}`);
    }

    const partitions = await this.store.ensureReportPartitions(
      ledger.reportType,
      ledger.startDate,
      ledger.endDate,
    );
    if (partitions.expectedMonths !== partitions.matchedMonths) {
      const detail = `prepared ${partitions.matchedMonths} of ${partitions.expectedMonths} partition months`;
      await this.store.failReport(ledger.id, detail);
      throw new PermanentJobError(`${ledger.reportType} ${detail}`);
    }
    const sourceRows = staged.reduce((total, date) => total + date.sourceRows, 0);
    const parsedSourceRows = staged.reduce((total, date) => total + date.parsedRows, 0);
    const refusedRows = staged.reduce((total, date) => total + date.refusedRows, 0);
    const factRows = staged.reduce((total, date) => total + date.promotedRows, 0);
    if (sourceRows !== batch.sourceRows || sourceRows !== parsedSourceRows + refusedRows) {
      throw new Error(
        `report ${ledger.id} source accounting drifted: ${sourceRows} source, ` +
        `${parsedSourceRows} parsed, ${refusedRows} refused`,
      );
    }

    let promotedDates = 0;
    let alreadyPromotedDates = 0;
    let supersededDates = 0;
    let acceptedFactRows = 0;
    let supersededFactRows = 0;
    let canonicalRows = 0;
    let deletedRows = 0;
    let observationRows = 0;
    try {
      for (const date of staged) {
        const result = await this.store.promoteReportDate(date);
        assertPromotionResult(ledger, date, result);
        deletedRows += result.deletedRows;
        observationRows += result.observationRows;
        if (result.status === 'superseded') {
          supersededDates += 1;
          supersededFactRows += date.promotedRows;
          continue;
        }
        if (result.status === 'promoted') promotedDates += 1;
        else alreadyPromotedDates += 1;
        acceptedFactRows += date.promotedRows;
        canonicalRows += result.watermark.canonicalRows;
      }
    } catch (error) {
      if (!(error instanceof InvalidReportDatePromotion) && !(error instanceof DuplicateFactGrain)) {
        throw error;
      }
      const detail = errorMessage(error).slice(0, 4_000);
      await this.store.failReport(ledger.id, detail);
      throw new PermanentJobError(`${ledger.reportType} ${detail}`);
    }

    if (staged.length !== promotedDates + alreadyPromotedDates + supersededDates) {
      throw new Error('report date outcomes do not reconcile');
    }
    if (factRows !== acceptedFactRows + supersededFactRows) {
      throw new Error('report fact outcomes do not reconcile');
    }
    if (acceptedFactRows !== canonicalRows) {
      throw new Error(
        `accepted ${acceptedFactRows} fact rows but verified ${canonicalRows} canonical rows`,
      );
    }

    await this.store.completeReport(ledger.id, {
      parsed: acceptedFactRows,
      loaded: canonicalRows,
      bytesDownloaded,
    });
    const result = {
      reportRows: sourceRows,
      parsedSourceRows,
      refusedRows,
      factRows,
      acceptedFactRows,
      supersededFactRows,
      canonicalRows,
      reportDates: staged.length,
      promotedDates,
      alreadyPromotedDates,
      supersededDates,
      deletedRows,
      observationRows,
      partitionMonths: partitions.expectedMonths,
      partitionsCreated: partitions.createdMonths,
      bytesDownloaded,
    };
    this.logger.info('Sponsored Products report promoted', {
      reportRequestId: ledger.id,
      reportType: ledger.reportType,
      ...result,
    });
    return result;
  }

  private requireAdsApi(): AdsApiClient {
    if (!this.adsApi) throw new PermanentJobError('Amazon Ads API not deployed in this runtime');
    return this.adsApi;
  }
}

function assertAmazonReportId(ledger: ReportRequestState, amazonReportId: string): void {
  if (ledger.source !== 'amazon_api') {
    throw new PermanentJobError('Reporting v3 job references a non-Amazon report request');
  }
  if (ledger.amazonReportId !== amazonReportId) {
    throw new PermanentJobError('job Amazon report id does not match its report request ledger');
  }
}

function assertPromotionResult(
  ledger: ReportRequestState,
  staged: ReturnType<typeof prepareSponsoredProductsReportDates>[number],
  result: Awaited<ReturnType<WorkerStore['promoteReportDate']>>,
): void {
  const watermark = result.watermark;
  if (
    watermark.profileId !== ledger.profileId ||
    watermark.reportType !== ledger.reportType ||
    watermark.date !== staged.reportDate
  ) {
    throw new InvalidReportDatePromotion('promotion result watermark is outside the report scope');
  }
  if (result.status === 'superseded') {
    if (result.deletedRows !== 0 || result.insertedRows !== 0 || result.observationRows !== 0) {
      throw new InvalidReportDatePromotion('a superseded promotion must not mutate canonical facts');
    }
    const watermarkRequestedAt = Date.parse(watermark.requestedAt);
    if (
      !Number.isFinite(watermarkRequestedAt) ||
      watermarkRequestedAt <= ledger.requestedAt.getTime()
    ) {
      throw new InvalidReportDatePromotion('a superseded promotion did not return newer evidence');
    }
    return;
  }
  if (
    watermark.reportRequestId !== ledger.id ||
    watermark.source !== staged.source ||
    watermark.sourceRows !== staged.sourceRows ||
    watermark.parsedRows !== staged.parsedRows ||
    watermark.refusedRows !== staged.refusedRows ||
    watermark.promotedRows !== staged.promotedRows ||
    watermark.canonicalRows !== staged.promotedRows
  ) {
    throw new InvalidReportDatePromotion('accepted promotion counts do not match the staged date');
  }
  if (result.status === 'promoted') {
    if (result.insertedRows !== staged.promotedRows || result.observationRows !== 1) {
      throw new InvalidReportDatePromotion('promoted date write counts do not match the staged date');
    }
    return;
  }
  if (result.deletedRows !== 0 || result.insertedRows !== 0 || result.observationRows !== 0) {
    throw new InvalidReportDatePromotion('an idempotent promotion retry must not mutate canonical facts');
  }
}

/** A timer that runs one async pass and never lets a rejection reach the loop. */
abstract class PeriodicPass {
  private timer: NodeJS.Timeout | undefined;
  protected constructor(private readonly intervalMs: number, private readonly logger: WorkerLogger) {}
  protected abstract pass(): Promise<unknown>;
  protected abstract get name(): string;

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private tick(): void {
    void this.pass().catch((error: unknown) => {
      this.logger.error(`${this.name} failed`, { error: errorMessage(error) });
    });
  }
}

/**
 * The hourly `/v2/profiles` probe per region.
 *
 * **Deliberately not a queue job**, and the manager accepted it as such. A
 * queued `auth.healthcheck` cannot answer the question the probe exists to
 * answer: if the queue is the thing that is broken, the check that would have
 * told you never runs. It also needs no per-profile scope, no dedupe slot and
 * no retry policy — it is a liveness probe, and a liveness probe that depends
 * on the subsystem it monitors is decoration. It runs in-process, on its own
 * timer, and logs failure loudly. See `apps/worker/README.md`.
 */
export class AuthHealthMonitor extends PeriodicPass {
  constructor(
    private readonly worker: SyncWorker,
    intervalMs = 60 * MINUTE_MS,
    logger: WorkerLogger = consoleLogger,
  ) {
    super(intervalMs, logger);
  }
  protected get name(): string { return 'auth healthcheck'; }
  protected pass(): Promise<unknown> { return this.worker.runAuthHealthcheck(); }
}

/**
 * Gives a newly connected profile the default cadences, and repairs the ones
 * every profile already has.
 *
 * A profile with no schedules syncs nothing, and an always-on worker noticing
 * that is better than an onboarding step somebody forgets. It only ever fills
 * an empty set — a profile whose schedules an operator pruned stays pruned.
 *
 * The lookback repair runs unconditionally, on every profile, every tick. It
 * used to run inside `provisionSchedules`, which only ever visits profiles that
 * have no schedules — so the profiles carrying an illegal lookback, all of
 * which are provisioned by definition, were the exact set it never reached.
 */
export class ScheduleProvisioner extends PeriodicPass {
  constructor(
    private readonly store: WorkerStore,
    intervalMs = 15 * MINUTE_MS,
    private readonly provisionLogger: WorkerLogger = consoleLogger,
    private readonly recommendationSchedules?: RecommendationScheduleStore,
    private readonly sqpSchedules?: WeeklySqpScheduleProducer,
  ) {
    super(intervalMs, provisionLogger);
  }
  protected get name(): string { return 'schedule provisioning'; }
  protected async pass(): Promise<unknown> {
    const profiles = await this.store.unscheduledProfiles();
    let written = 0;
    for (const profile of profiles) {
      written += await this.store.provisionSchedules(profile.orgId, profile.profileId);
    }
    // Operator rule (2026-08-27): no automation without approval. Scheduled
    // weekly recommendation runs stay off until explicitly opted in; the
    // on-demand "Run now" path is unaffected.
    const weeklyRunsApproved = process.env['WIZARD_ADS_WEEKLY_RECOMMENDATION_RUNS'] === '1';
    const recommendations = weeklyRunsApproved
      ? ((await this.recommendationSchedules?.enqueueDueRecommendationRuns()) ?? 0)
      : 0;
    const repaired = await this.store.repairOverlongLookbacks();
    const integrations = await this.store.ensureIntegrationSchedules();
    const sqp = await this.sqpSchedules?.enqueueDueSqpRequests();
    if (written > 0) {
      this.provisionLogger.info('provisioned default schedules', { profiles: profiles.length, schedules: written });
    }
    if (repaired > 0) {
      this.provisionLogger.info('clamped overlong report lookbacks', { schedules: repaired });
    }
    if (recommendations > 0) {
      this.provisionLogger.info('enqueued weekly recommendation runs', { jobs: recommendations });
    }
    if (integrations > 0) {
      this.provisionLogger.info('reconciled integration schedules', { schedules: integrations });
    }
    if (sqp && sqp.enqueuedJobs > 0) {
      this.provisionLogger.info('enqueued weekly SQP requests', {
        jobs: sqp.enqueuedJobs,
        scopes: sqp.scopes,
        sourceAsinRows: sqp.sourceAsinRows,
        uniqueAsins: sqp.uniqueAsins,
        refusedAsinRows: sqp.refusedAsinRows,
      });
    }
    return { written, repaired, recommendations, integrations, sqp };
  }
}

/**
 * Sweeps jobs whose worker died mid-claim back onto the queue. Without it a
 * SIGKILL loses the job permanently: `claim_sync_jobs` only ever sees `queued`.
 */
export class StaleClaimReaper extends PeriodicPass {
  constructor(
    private readonly store: WorkerStore,
    private readonly olderThan = '30 minutes',
    intervalMs = 5 * MINUTE_MS,
    private readonly reaperLogger: WorkerLogger = consoleLogger,
  ) {
    super(intervalMs, reaperLogger);
  }
  protected get name(): string { return 'stale claim sweep'; }
  protected async pass(): Promise<unknown> {
    const requeued = await this.store.requeueStale(this.olderThan);
    if (requeued > 0) this.reaperLogger.info('requeued stale jobs', { requeued, olderThan: this.olderThan });
    return requeued;
  }
}

/**
 * Repairs guarded-write outbox gaps independently of any one profile's queue
 * row. The mutation gate is global, so this pass must also be global: a
 * completed cycle in one profile cannot be the only producer capable of
 * waking a queued execution in another profile.
 */
export class AmazonWriteRecoveryPass extends PeriodicPass {
  constructor(
    private readonly store: WorkerStore,
    intervalMs = MINUTE_MS,
    private readonly recoveryLogger: WorkerLogger = consoleLogger,
  ) {
    super(intervalMs, recoveryLogger);
  }
  protected get name(): string { return 'Amazon write outbox recovery'; }
  protected async pass(): Promise<unknown> {
    const counts = await this.store.recoverAmazonWrites();
    if (counts.applyJobs + counts.observationJobs > 0) {
      this.recoveryLogger.info('repaired Amazon write outbox', counts);
    }
    return counts;
  }
}

/**
 * Syncs the per-target bid corridor once a day (WP-28).
 *
 * A `PeriodicPass` rather than a queue job, and deliberately so: the `sync_jobs`
 * queue is driven by `@wizard-ads/shared`'s `JobPayload`, which this WP does not
 * own, so a queue job would need a cross-package contract change (see
 * `bid-series.ts`). The corridor is market evidence retrieved daily on the same
 * footing as spend and clicks — a daily in-process pass is exactly the shape,
 * and it sits beside the auth healthcheck and the reaper for the same reason.
 */
export class BidSeriesSyncPass extends PeriodicPass {
  constructor(
    private readonly deps: BidSeriesSyncDeps,
    intervalMs = 24 * 60 * MINUTE_MS,
    private readonly passLogger: WorkerLogger = consoleLogger,
  ) {
    super(intervalMs, passLogger);
  }
  protected get name(): string { return 'bid series sync'; }
  protected async pass(): Promise<unknown> {
    const counts = await runBidSeriesSync({ logger: this.passLogger, ...this.deps });
    if (counts.written > 0) {
      this.passLogger.info('bid series sync pass', { ...counts });
    }
    return counts;
  }
}

/**
 * The failure a retry should be scheduled from: a throttle or 5xx if one is
 * there, otherwise the first. A 429 next to a 400 must not be retried on the
 * 400's flat backoff — Amazon told us when to come back.
 */
function mostRetryable(
  failures: readonly EntityListFailure[],
): EntityListFailure | undefined {
  return failures.find((failure) => failure.error instanceof AdsApiRetryableError) ?? failures[0];
}

/**
 * The error a partially-failed entity sync throws, once the products that did
 * list are committed. Retryable typing is preserved so `runClaimed` still backs
 * off on Amazon's own interval.
 */
function partialSyncError(
  succeeded: readonly AdProductCode[],
  failures: readonly EntityListFailure[],
): Error {
  const worst = mostRetryable(failures);
  const detail =
    `entity sync committed ${succeeded.join('+')} but ` +
    `${failures.map((failure) => failure.adProduct).join('+')} failed: ` +
    `${worst?.message ?? 'unknown error'}`;
  if (worst?.error instanceof AdsApiRetryableError) {
    return new AdsApiRetryableError(detail, worst.error.retryAfterSeconds);
  }
  return new Error(detail, worst?.error instanceof Error ? { cause: worst.error } : undefined);
}

/** How many distinct skip reasons a log line or job result carries. */
const MAX_SKIP_REASONS = 5;

/**
 * A bounded histogram of why rows were refused.
 *
 * Bounded because this lands in `sync_jobs.result` and in a log line: a report
 * that refused sixty thousand rows must not write sixty thousand reasons, and
 * the first few distinct ones already say which column Amazon stopped sending.
 */
function skipReasons(skipped: readonly SkippedReportRow[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const row of skipped) counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1);
  return Object.fromEntries(
    [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_SKIP_REASONS),
  );
}

function formatReasons(reasons: Record<string, number>): string {
  const entries = Object.entries(reasons);
  if (entries.length === 0) return 'no reason recorded';
  return entries.map(([reason, count]) => `${reason} (${count})`).join(', ');
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MINUTE_MS);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
