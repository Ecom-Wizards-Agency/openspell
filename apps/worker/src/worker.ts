import type { ClaimedJob } from '@wizard-ads/db';
import { JobPayload, type Region } from '@wizard-ads/shared';
import {
  AdsApiRetryableError,
  DownloadUrlExpiredError,
  type AdsApiClient,
  type AdsProfileContext,
} from './ads-api.js';
import { gunzipJson, parseReportRows } from './parsers.js';
import {
  defaultRegionTokenBuckets,
  type RegionTokenBuckets,
} from './region-token-buckets.js';
import type { WorkerStore } from './store.js';

const MINUTE_MS = 60_000;
const FOUR_HOURS_MS = 4 * 60 * MINUTE_MS;
const POLL_DELAYS_MINUTES = [5, 10, 20, 30] as const;

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

  /** Claim one batch and wait until this batch finishes. Used by tests and one-shot operations. */
  async drainOnce(): Promise<number> {
    const before = new Set(this.running.keys());
    const claimed = await this.claimAvailable();
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

  private async claimAvailable(): Promise<number> {
    if (this.stopping) return 0;
    const capacity = this.maxConcurrentJobs - this.running.size;
    if (capacity <= 0) return 0;
    const jobs = await this.store.claim(this.workerId, Math.min(this.claimBatchSize, capacity));
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
        const counts = await this.store.syncEntities(profile, entities, payload.adProduct);
        if (counts.listed !== counts.upserted) throw new Error(`listed ${counts.listed}, upserted ${counts.upserted}`);
        return counts;
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
        return { stub: true, handler: 'crosscheck.ingest', sourcePath: payload.sourcePath };
    }
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
    await this.store.completeReport(ledger.id, { parsed, loaded, bytesDownloaded: downloaded.bytesDownloaded });
    return { parsed, loaded, bytesDownloaded: downloaded.bytesDownloaded };
  }
}

export class AuthHealthMonitor {
  private timer: NodeJS.Timeout | undefined;
  constructor(private readonly worker: SyncWorker, private readonly intervalMs = 60 * MINUTE_MS) {}
  start(): void {
    if (this.timer) return;
    void this.worker.runAuthHealthcheck();
    this.timer = setInterval(() => void this.worker.runAuthHealthcheck(), this.intervalMs);
    this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
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
