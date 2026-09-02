import { Buffer } from 'node:buffer';
import type { ClaimRef, ClaimedJob } from '@wizard-ads/db';
import {
  RecommendationsRunJob,
  type RecommendationsRunJob as RecommendationsRunPayload,
} from '@wizard-ads/shared';
import { RECOMMENDATION_LANE_JOB_TYPE } from './config.js';

const RETRY_DELAYS_SECONDS = [5 * 60, 10 * 60, 20 * 60, 30 * 60] as const;
const MAX_RETRY_DELAY_SECONDS = 24 * 60 * 60;
export const MAX_RECOMMENDATION_RESULT_BYTES = 16 * 1024;

export interface RecommendationWorkerIdentity {
  workerId: string;
  revision: string;
}

export type RecommendationSettlementDecision =
  | Readonly<{ decision: 'settled' }>
  | Readonly<{ decision: 'stale_claim' }>;

export interface RecommendationFinishOptions {
  error?: string;
  result?: unknown;
  retryIn?: string;
}

/** Narrow queue surface. The implementation is expected to call only recommendation RPCs. */
export interface RecommendationQueuePort {
  resumeOwned(identity: RecommendationWorkerIdentity): Promise<readonly ClaimedJob[]>;
  claim(
    identity: RecommendationWorkerIdentity,
    limit: 1,
  ): Promise<readonly ClaimedJob[]>;
  finish(
    claim: ClaimRef,
    outcome: 'succeeded' | 'failed' | 'dead',
    options?: RecommendationFinishOptions,
  ): Promise<RecommendationSettlementDecision>;
  defer(claim: ClaimRef, retryIn: string): Promise<RecommendationSettlementDecision>;
}

export type RecommendationExecutablePayload = Omit<RecommendationsRunPayload, 'lookbackDays'> & {
  lookbackDays?: number;
};

/** This is intentionally the same caller shape consumed by createRecommendationsRunner. */
export type RecommendationExecute<Result = unknown> = (
  payload: RecommendationExecutablePayload,
  execution: Readonly<{ claim: ClaimRef }>,
) => Promise<Result>;

export type RecommendationClaimantFailureKind =
  | 'custody_lost'
  | 'invalid_custody'
  | 'settlement_ambiguous';

/** Fixed-category failure: never includes a queue id, token, or underlying error text. */
export class RecommendationClaimantCustodyError extends Error {
  override readonly name = 'RecommendationClaimantCustodyError';

  constructor(readonly kind: RecommendationClaimantFailureKind) {
    super(`recommendation queue custody ${kind}`);
  }
}

export interface RecommendationClaimantStatus {
  phase:
    | 'not_started'
    | 'resuming'
    | 'claiming'
    | 'executing'
    | 'idle'
    | 'stopping'
    | 'stopped'
    | 'failed';
  ready: boolean;
  inFlight: 0 | 1;
  resumeComplete: boolean;
  settlementFailure: RecommendationClaimantFailureKind | null;
}

export interface RecommendationShutdownEvidence {
  released: 0;
  /** Claims are deliberately retained in PostgreSQL for same-identity resume or attended recovery. */
  unresolved: number;
}

export interface RecommendationClaimantOptions<Result> {
  identity: RecommendationWorkerIdentity;
  queue: RecommendationQueuePort;
  execute: RecommendationExecute<Result>;
  pollIntervalMs: number;
  shutdownDrainMs: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Single-flight recommendation claimant.
 *
 * The claimant exhausts same-identity unresolved custody before asking the
 * database for a fresh job. It never expires or releases a fenced claim. Once
 * settlement is ambiguous, or custody is disproved, the instance is latched
 * closed and no later poll may acquire work.
 */
export class RecommendationClaimant<Result = unknown> {
  private readonly identity: RecommendationWorkerIdentity;
  private readonly queue: RecommendationQueuePort;
  private readonly execute: RecommendationExecute<Result>;
  private readonly pollIntervalMs: number;
  private readonly shutdownDrainMs: number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly stopSignal = new AbortController();
  private phase: RecommendationClaimantStatus['phase'] = 'not_started';
  private resumeComplete = false;
  private stopping = false;
  private startCalled = false;
  private activePass: Promise<number> | null = null;
  private shutdownPromise: Promise<RecommendationShutdownEvidence> | null = null;
  private settlementFailure: RecommendationClaimantCustodyError | null = null;
  private unresolvedCustody = 0;

  constructor(options: RecommendationClaimantOptions<Result>) {
    this.identity = Object.freeze({ ...options.identity });
    this.queue = options.queue;
    this.execute = options.execute;
    this.pollIntervalMs = positiveInteger(options.pollIntervalMs, 'pollIntervalMs');
    this.shutdownDrainMs = positiveInteger(options.shutdownDrainMs, 'shutdownDrainMs');
    this.sleep = options.sleep ?? abortableSleep;
  }

  status(): RecommendationClaimantStatus {
    return Object.freeze({
      phase: this.phase,
      ready: this.resumeComplete && !this.stopping && this.settlementFailure === null,
      inFlight: this.unresolvedCustody >= 1 && this.activePass !== null ? 1 : 0,
      resumeComplete: this.resumeComplete,
      settlementFailure: this.settlementFailure?.kind ?? null,
    });
  }

  async start(): Promise<void> {
    if (this.startCalled) throw new Error('recommendation claimant can only be started once');
    this.startCalled = true;
    try {
      while (!this.stopping) {
        const processed = await this.drainOnce();
        if (processed === 0 && !this.stopping) {
          await this.sleep(this.pollIntervalMs, this.stopSignal.signal);
        }
      }
      if (this.phase !== 'failed') this.phase = 'stopped';
    } catch (error) {
      if (this.stopping && isAbortError(error)) {
        this.phase = 'stopped';
        return;
      }
      this.phase = 'failed';
      throw error;
    }
  }

  /** Process at most one resumed or newly claimed job. Concurrent calls never widen capacity. */
  async drainOnce(): Promise<0 | 1> {
    if (this.settlementFailure) throw this.settlementFailure;
    if (this.stopping || this.activePass !== null) return 0;

    const pass = this.performPass();
    this.activePass = pass;
    try {
      return await pass;
    } finally {
      if (this.activePass === pass) this.activePass = null;
      if (!this.stopping && this.settlementFailure === null && this.phase !== 'failed') {
        this.phase = 'idle';
      }
    }
  }

  shutdown(): Promise<RecommendationShutdownEvidence> {
    this.shutdownPromise ??= this.performShutdown();
    return this.shutdownPromise;
  }

  private async performPass(): Promise<0 | 1> {
    let jobs: readonly ClaimedJob[];
    if (!this.resumeComplete) {
      this.phase = 'resuming';
      jobs = await this.queue.resumeOwned(this.identity);
      this.assertSingleResult(jobs);
      if (jobs.length === 0) {
        this.resumeComplete = true;
      } else {
        await this.executeClaimed(jobs[0]!);
        return 1;
      }
    }

    if (this.stopping || this.settlementFailure) return 0;
    this.phase = 'claiming';
    jobs = await this.queue.claim(this.identity, 1);
    this.assertSingleResult(jobs);
    if (jobs.length === 0) return 0;
    await this.executeClaimed(jobs[0]!);
    return 1;
  }

  private assertSingleResult(jobs: readonly ClaimedJob[]): void {
    if (jobs.length <= 1) return;
    this.unresolvedCustody = Math.max(this.unresolvedCustody, jobs.length);
    throw this.latchCustodyFailure('invalid_custody');
  }

  private async executeClaimed(job: ClaimedJob): Promise<void> {
    this.unresolvedCustody = Math.max(this.unresolvedCustody, 1);
    const claim = validClaim(job, this.identity);
    if (claim === null) throw this.latchCustodyFailure('invalid_custody');

    const parsed = RecommendationsRunJob.safeParse(job.payload);
    if (!parsed.success || parsed.data.orgId !== job.orgId || parsed.data.profileId !== job.profileId) {
      await this.settle(() => this.queue.finish(claim, 'dead', {
        error: 'invalid recommendation job payload',
      }));
      return;
    }

    this.phase = 'executing';
    try {
      const result = await this.execute(parsed.data, { claim });
      if (!isBoundedResult(result)) {
        await this.settle(() => this.queue.finish(claim, 'dead', {
          error: 'invalid recommendation result',
        }));
        return;
      }
      await this.settle(() => this.queue.finish(claim, 'succeeded', { result }));
    } catch (error) {
      if (error instanceof RecommendationClaimantCustodyError) {
        throw this.latchCustodyFailure(error.kind);
      }
      if (isExecutionSettlementAmbiguousError(error)) {
        throw this.latchCustodyFailure('settlement_ambiguous');
      }
      if (isExecutionCustodyError(error)) {
        throw this.latchCustodyFailure('custody_lost');
      }
      if (isPermanentExecutionError(error)) {
        await this.settle(() => this.queue.finish(claim, 'dead', {
          error: fixedExecutionError(error),
        }));
        return;
      }
      if (job.attempts >= job.maxAttempts) {
        await this.settle(() => this.queue.finish(claim, 'dead', {
          error: 'recommendation retry budget exhausted',
        }));
        return;
      }
      await this.settle(() => this.queue.finish(claim, 'failed', {
        error: 'retryable recommendation execution failure',
        retryIn: retryInterval(error, job.attempts),
      }));
    }
  }

  private async settle(
    operation: () => Promise<RecommendationSettlementDecision>,
  ): Promise<void> {
    let decision: unknown;
    try {
      decision = await operation();
    } catch {
      throw this.latchCustodyFailure('settlement_ambiguous');
    }
    if (!isSettlementDecision(decision)) {
      throw this.latchCustodyFailure('settlement_ambiguous');
    }
    if (decision.decision === 'stale_claim') {
      throw this.latchCustodyFailure('custody_lost');
    }
    this.unresolvedCustody = 0;
  }

  private latchCustodyFailure(
    kind: RecommendationClaimantFailureKind,
  ): RecommendationClaimantCustodyError {
    this.settlementFailure ??= new RecommendationClaimantCustodyError(kind);
    this.phase = 'failed';
    return this.settlementFailure;
  }

  private async performShutdown(): Promise<RecommendationShutdownEvidence> {
    this.stopping = true;
    this.phase = 'stopping';
    this.stopSignal.abort();
    const active = this.activePass;
    if (active !== null) {
      let completed = false;
      let timeout: NodeJS.Timeout | undefined;
      await Promise.race([
        active.catch(() => undefined).then(() => { completed = true; }),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, this.shutdownDrainMs);
        }),
      ]);
      if (timeout !== undefined) clearTimeout(timeout);
      // A timed-out claim RPC may have committed even when its response never
      // reached this process. Report one unresolved custody slot rather than
      // claiming that the database is empty without proof.
      if (!completed) this.unresolvedCustody = Math.max(this.unresolvedCustody, 1);
    }
    this.phase = this.settlementFailure === null ? 'stopped' : 'failed';
    return Object.freeze({ released: 0, unresolved: this.unresolvedCustody });
  }
}

function validClaim(
  job: ClaimedJob,
  identity: RecommendationWorkerIdentity,
): ClaimRef | null {
  if (
    job.jobType !== RECOMMENDATION_LANE_JOB_TYPE
    || job.claim === null
    || job.claim.jobId !== job.id
    || job.claim.workerId !== identity.workerId
    || job.claimedBy !== identity.workerId
    || !Number.isSafeInteger(job.attempts)
    || job.attempts < 1
    || !Number.isSafeInteger(job.maxAttempts)
    || job.maxAttempts < 1
  ) return null;
  return job.claim;
}

function isExecutionCustodyError(error: unknown): boolean {
  return error instanceof Error && error.name === 'RecommendationExecutionCustodyError';
}

function isExecutionSettlementAmbiguousError(error: unknown): boolean {
  return error instanceof Error
    && error.name === 'RecommendationExecutionSettlementAmbiguousError';
}

function isPermanentExecutionError(error: unknown): boolean {
  return error instanceof Error
    && (error.name === 'RecommendationScopeIntegrityError' || error.name === 'PermanentJobError');
}

function fixedExecutionError(error: unknown): string {
  if (error instanceof Error && error.name === 'RecommendationScopeIntegrityError') {
    return 'recommendation scope integrity failure';
  }
  return 'permanent recommendation execution failure';
}

function retryInterval(error: unknown, attempts: number): string {
  const suggested = retryAfterSeconds(error);
  const fallback = RETRY_DELAYS_SECONDS[
    Math.min(Math.max(attempts - 1, 0), RETRY_DELAYS_SECONDS.length - 1)
  ]!;
  const seconds = suggested ?? fallback;
  return `${seconds} seconds`;
}

function retryAfterSeconds(error: unknown): number | null {
  if (!(error instanceof Error) || error.name !== 'RetryableJobError') return null;
  if (!('retryAfterSeconds' in error)) return null;
  try {
    const value = error.retryAfterSeconds;
    return Number.isSafeInteger(value) && typeof value === 'number' && value > 0
      ? Math.min(value, MAX_RETRY_DELAY_SECONDS)
      : null;
  } catch {
    return null;
  }
}

function isSettlementDecision(value: unknown): value is RecommendationSettlementDecision {
  if (typeof value !== 'object' || value === null || !('decision' in value)) return false;
  return value.decision === 'settled' || value.decision === 'stale_claim';
}

function isBoundedResult(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    return serialized !== undefined
      && Buffer.byteLength(serialized, 'utf8') <= MAX_RECOMMENDATION_RESULT_BYTES;
  } catch {
    return false;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
