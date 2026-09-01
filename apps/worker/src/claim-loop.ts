export const CLAIM_FAILURE_HEALTH_THRESHOLD = 3;
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

export type ClaimFailureKind = 'postgres_query_cancelled';

export type ClaimLoopPhase =
  | 'not_started'
  | 'claiming'
  | 'idle_wait'
  | 'backing_off'
  | 'stopping'
  | 'stopped'
  | 'failed';

export type ClaimLoopState = Readonly<{
  phase: ClaimLoopPhase;
  ready: boolean;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  failureKind: ClaimFailureKind | null;
  retryInMs: number | null;
}>;

export interface ClaimLoopRuntime {
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
  random(): number;
}

interface MutableClaimLoopState {
  phase: ClaimLoopPhase;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  failureKind: ClaimFailureKind | null;
  retryInMs: number | null;
}

const defaultRuntime: ClaimLoopRuntime = {
  sleep: abortableSleep,
  random: () => Math.random(),
};

export function isContainedClaimFailure(error: unknown): error is { code: '57014' } {
  return typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === '57014';
}

export function claimRetryDelay(
  consecutiveFailures: number,
  pollIntervalMs: number,
  randomValue: number,
): number {
  const failureCount = Number.isNaN(consecutiveFailures)
    ? 1
    : Math.max(1, Math.trunc(consecutiveFailures));
  const finitePollInterval = Number.isFinite(pollIntervalMs) && pollIntervalMs > 0
    ? Math.round(pollIntervalMs)
    : MIN_RETRY_MS;
  const base = Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, finitePollInterval));
  const window = Math.min(MAX_RETRY_MS, base * 2 ** (failureCount - 1));
  const lower = Math.ceil(window / 2);
  const normalizedRandom = Number.isFinite(randomValue)
    ? Math.min(1, Math.max(0, randomValue))
    : 0.5;
  return lower + Math.round((window - lower) * normalizedRandom);
}

/** Worker-private claim-loop lifecycle and sanitized observation state. */
export class ClaimLoopController {
  private readonly abortController = new AbortController();
  private readonly runtime: ClaimLoopRuntime;
  private readonly state: MutableClaimLoopState = {
    phase: 'not_started',
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    failureKind: null,
    retryInMs: null,
  };

  constructor(
    private readonly pollIntervalMs: number,
    private readonly now: () => Date,
    runtime: ClaimLoopRuntime = defaultRuntime,
  ) {
    this.runtime = runtime;
  }

  status(): ClaimLoopState {
    const ready = (
      this.state.phase === 'claiming'
      || this.state.phase === 'idle_wait'
      || this.state.phase === 'backing_off'
    ) && this.state.consecutiveFailures < CLAIM_FAILURE_HEALTH_THRESHOLD;
    return Object.freeze({ ...this.state, ready });
  }

  beginStart(): void {
    if (this.state.phase !== 'not_started') {
      throw new Error('SyncWorker.start() may only be called once');
    }
    this.state.phase = 'claiming';
    this.state.retryInMs = null;
  }

  beginClaim(): boolean {
    if (
      this.state.phase === 'stopping'
      || this.state.phase === 'stopped'
      || this.state.phase === 'failed'
    ) return false;
    this.state.phase = 'claiming';
    this.state.retryInMs = null;
    return true;
  }

  recordSuccess(hasJobs: boolean): void {
    this.state.consecutiveFailures = 0;
    this.state.lastSuccessAt = this.now().toISOString();
    this.state.lastFailureAt = null;
    this.state.failureKind = null;
    this.state.retryInMs = null;
    if (!this.isStopping()) this.state.phase = hasJobs ? 'claiming' : 'idle_wait';
  }

  recordNoCapacity(): void {
    this.state.retryInMs = null;
    if (!this.isStopping()) this.state.phase = 'idle_wait';
  }

  recordContainedFailure(): { failureKind: ClaimFailureKind; consecutiveFailures: number; retryInMs: number | null } {
    this.state.consecutiveFailures += 1;
    this.state.lastFailureAt = this.now().toISOString();
    this.state.failureKind = 'postgres_query_cancelled';
    if (this.isStopping()) {
      this.state.retryInMs = null;
    } else {
      const retryInMs = claimRetryDelay(
        this.state.consecutiveFailures,
        this.pollIntervalMs,
        this.runtime.random(),
      );
      this.state.phase = 'backing_off';
      this.state.retryInMs = retryInMs;
    }
    return {
      failureKind: 'postgres_query_cancelled',
      consecutiveFailures: this.state.consecutiveFailures,
      retryInMs: this.state.retryInMs,
    };
  }

  recordFatalFailure(): void {
    this.state.retryInMs = null;
    if (!this.isStopping()) this.state.phase = 'failed';
  }

  beginShutdown(): void {
    if (this.state.phase === 'stopped') return;
    this.state.phase = 'stopping';
    this.state.retryInMs = null;
    this.abortController.abort();
  }

  finishShutdown(): void {
    this.state.phase = 'stopped';
    this.state.retryInMs = null;
  }

  async wait(milliseconds: number): Promise<boolean> {
    await this.runtime.sleep(milliseconds, this.abortController.signal);
    return !this.abortController.signal.aborted;
  }

  private isStopping(): boolean {
    return this.state.phase === 'stopping' || this.state.phase === 'stopped';
  }
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });

    function done(): void {
      clearTimeout(timeout);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
