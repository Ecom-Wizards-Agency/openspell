import type { ClaimedJob } from '@wizard-ads/db';
import { JobPayload, type Region } from '@wizard-ads/shared';
import { isPermanentCrosscheckError, type CrosscheckIngest } from './crosscheck.js';
import {
  AdsApiRetryableError,
  DownloadUrlExpiredError,
  type AdsApiClient,
  type AdsProfileContext,
} from './ads-api.js';
import { runBidSeriesSync, type BidSeriesSyncDeps } from './bid-series.js';
import { gunzipJson, parseReportRows } from './parsers.js';
import {
  defaultRegionTokenBuckets,
  type RegionTokenBuckets,
} from './region-token-buckets.js';
import type { WorkerStore } from './store.js';

const MINUTE_MS = 60_000;
const FOUR_HOURS_MS = 4 * 60 * MINUTE_MS;
const POLL_DELAYS_MINUTES = [5, 10, 20, 30] as const;

/** A failure retrying cannot fix. Goes straight to `dead` with its attempts unspent. */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

export interface WorkerLogger {
  info(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

const consoleLogger: WorkerLogger = {
  info: (message, details) => console.info(message, details ?? {}),
  error: (message, details) => console.error(message, details ?? {}),
};

export interface SyncWorkerOptions {
  workerId: string;
  store: WorkerStore;
  adsApi: AdsApiClient;
  /** WP-10's handler, bound to a database handle. Absent, the job dead-letters. */
  crosscheckIngest?: CrosscheckIngest;
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
  private readonly adsApi: AdsApiClient;
  private readonly crosscheckIngest: CrosscheckIngest | undefined;
  private readonly buckets: RegionTokenBuckets;
  private readonly claimBatchSize: number;
  private readonly maxConcurrentJobs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;
  private readonly logger: WorkerLogger;
  private readonly running = new Map<string, Promise<void>>();
  private stopping = false;

  constructor(options: SyncWorkerOptions) {
    this.workerId = options.workerId;
    this.store = options.store;
    this.adsApi = options.adsApi;
    this.crosscheckIngest = options.crosscheckIngest;
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
    await Promise.allSettled(this.running.values());
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
      .map(([, promise]) => promise);
    await Promise.allSettled(batch);
    return claimed;
  }

  async shutdown(releaseAfterMs = 25_000): Promise<{ released: number }> {
    this.stopping = true;
    if (this.running.size === 0) return { released: 0 };

    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(this.running.values()),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => { timedOut = true; resolve(); }, releaseAfterMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    return { released: timedOut ? await this.store.release(this.workerId) : 0 };
  }

  async runAuthHealthcheck(): Promise<{ ok: Region[]; failed: Region[] }> {
    const regions: Region[] = ['NA', 'EU', 'FE'];
    const ok: Region[] = [];
    const failed: Region[] = [];
    await Promise.all(regions.map(async (region) => {
      try {
        await this.buckets.run(region, () => this.adsApi.listProfiles(region));
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
    const jobs = await this.store.claim(this.workerId, batchSize);
    for (const job of jobs) {
      const task = this.runClaimed(job).finally(() => this.running.delete(job.id));
      this.running.set(job.id, task);
    }
    return jobs.length;
  }

  private async runClaimed(job: ClaimedJob): Promise<void> {
    try {
      const result = await this.execute(job);
      await this.store.finish(job.id, 'succeeded', { result });
    } catch (error) {
      if (error instanceof PermanentJobError || isPermanentCrosscheckError(error)) {
        await this.store.deadLetter(job.id, errorMessage(error).slice(0, 4_000));
        this.logger.error('sync job dead-lettered', {
          jobId: job.id, type: job.jobType, error: errorMessage(error),
        });
        return;
      }
      const retrySeconds = error instanceof AdsApiRetryableError && error.retryAfterSeconds !== undefined
        ? error.retryAfterSeconds
        : Math.min(60 * 2 ** Math.max(job.attempts - 1, 0), 30 * 60);
      await this.store.finish(job.id, 'failed', {
        error: errorMessage(error).slice(0, 4_000),
        retryIn: `${retrySeconds} seconds`,
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
      case 'entity.sync': {
        const entities = await this.buckets.run(profile.region, () => this.adsApi.listEntities(profile, payload.full));
        const counts = await this.store.syncEntities(profile, entities, {
          adProduct: payload.adProduct,
          full: payload.full,
        });
        // Program rule 4: the artifact, not the exit code. A listing that
        // upserted fewer rows than it listed lost some, and a sync that lost
        // rows must fail loudly rather than report success.
        if (counts.listed !== counts.upserted) throw new Error(`listed ${counts.listed}, upserted ${counts.upserted}`);
        this.logger.info('entity sync', { profileId: profile.id, ...counts });
        return { ...counts };
      }
      case 'report.request':
        return this.requestReport(job.id, profile, payload);
      case 'report.poll':
        return this.pollReport(profile, payload);
      case 'report.fetch':
        return this.fetchReport(profile, payload);
      case 'recommendations.run':
        return { stub: true, handler: 'recommendations.run', runId: payload.runId };
      case 'crosscheck.ingest':
        return this.ingestCrosscheck(payload);
    }
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
    const ledger = await this.store.ensureReportRequest(jobId, payload);
    let amazonReportId = ledger.amazonReportId;
    if (!amazonReportId) {
      const created = await this.buckets.run(profile.region, () => this.adsApi.createReport({
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
    const ledger = await this.store.getReportRequest(payload.reportRequestId);
    const status = await this.buckets.run(profile.region, () => this.adsApi.getReport(profile, payload.amazonReportId));
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
    const enqueued = await this.store.enqueue(fetchPayload, this.now(), `report.fetch:${ledger.id}`);
    return { status: 'COMPLETED', fetchEnqueued: enqueued };
  }

  private async fetchReport(
    profile: AdsProfileContext,
    payload: Extract<JobPayload, { type: 'report.fetch' }>,
  ): Promise<Record<string, unknown>> {
    const ledger = await this.store.getReportRequest(payload.reportRequestId);
    let downloaded;
    try {
      const source = await this.adsApi.downloadReport(payload.downloadUrl);
      downloaded = await gunzipJson(source);
    } catch (error) {
      if (!(error instanceof DownloadUrlExpiredError)) throw error;
      const attempt = ledger.pollAttempts;
      const pollPayload: Extract<JobPayload, { type: 'report.poll' }> = {
        type: 'report.poll', orgId: payload.orgId, profileId: payload.profileId,
        reportRequestId: ledger.id, amazonReportId: payload.amazonReportId, attempt,
      };
      await this.store.enqueue(pollPayload, this.now(), `report.repoll:${ledger.id}:${attempt}`);
      return { downloadExpired: true, repollEnqueued: true };
    }
    const batch = parseReportRows(ledger.reportType, downloaded.value, profile, ledger.id);
    const parsed = batch.rows.length;
    const loaded = await this.store.loadFacts(batch);
    // Program rule 4 again: `completeReport` throws on a mismatch, so a fetch
    // that silently dropped rows fails the job instead of reporting success.
    await this.store.completeReport(ledger.id, { parsed, loaded, bytesDownloaded: downloaded.bytesDownloaded });
    this.logger.info('report fetched', {
      reportRequestId: ledger.id, reportType: ledger.reportType,
      reportRows: batch.sourceRows, parsed, loaded,
    });
    return { reportRows: batch.sourceRows, parsed, loaded, bytesDownloaded: downloaded.bytesDownloaded };
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
 * Gives a newly connected profile the default cadences.
 *
 * A profile with no schedules syncs nothing, and an always-on worker noticing
 * that is better than an onboarding step somebody forgets. It only ever fills
 * an empty set — a profile whose schedules an operator pruned stays pruned.
 */
export class ScheduleProvisioner extends PeriodicPass {
  constructor(
    private readonly store: WorkerStore,
    intervalMs = 15 * MINUTE_MS,
    private readonly provisionLogger: WorkerLogger = consoleLogger,
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
    if (written > 0) {
      this.provisionLogger.info('provisioned default schedules', { profiles: profiles.length, schedules: written });
    }
    return written;
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

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MINUTE_MS);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
