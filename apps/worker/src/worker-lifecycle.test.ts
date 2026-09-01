import type { ClaimedJob } from '@wizard-ads/db';
import type { JobType } from '@wizard-ads/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdsProfileContext } from './ads-api.js';
import type { WorkerStore } from './store.js';
import { SyncWorker, type WorkerLogger } from './worker.js';

const orgId = '11111111-1111-4111-8111-111111111111';
const profileId = '22222222-2222-4222-8222-222222222222';
const jobId = '33333333-3333-4333-8333-333333333333';
const keepaJob: ClaimedJob = {
  id: jobId,
  orgId,
  profileId,
  jobType: 'keepa.sync',
  payload: { type: 'keepa.sync', orgId, profileId, includeCompetitors: false },
  attempts: 1,
  maxAttempts: 5,
  dedupeKey: 'worker-lifecycle',
  claimedBy: 'resilient-worker',
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('long-lived worker claim resilience', () => {
  it('contains direct 57014, retries with the same capability, and resets after empty success', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const privateError = Object.assign(new Error('statement and connection are private'), {
      code: '57014',
    });
    const claim = vi.fn<WorkerStore['claim']>()
      .mockRejectedValueOnce(privateError)
      .mockResolvedValue([]);
    const logs: { message: string; details?: Record<string, unknown> }[] = [];
    const worker = makeWorker(claim, {
      workerId: 'resilient-worker',
      jobTypes: ['keepa.sync', 'rank.sync'],
      logger: captureLogger(logs),
    });

    const started = worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.status().claimLoop).toMatchObject({
      phase: 'backing_off',
      ready: true,
      consecutiveFailures: 1,
      failureKind: 'postgres_query_cancelled',
      retryInMs: 500,
    });
    expect(claim).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(claim).toHaveBeenCalledTimes(2);
    expect(claim.mock.calls).toEqual([
      ['resilient-worker', 10, ['keepa.sync', 'rank.sync']],
      ['resilient-worker', 10, ['keepa.sync', 'rank.sync']],
    ]);
    expect(worker.status().claimLoop).toMatchObject({
      phase: 'idle_wait',
      ready: true,
      consecutiveFailures: 0,
      failureKind: null,
      lastFailureAt: null,
      retryInMs: null,
    });
    expect(JSON.stringify(logs)).not.toContain(privateError.message);
    expect(logs).toEqual([{
      message: 'sync job claim temporarily unavailable',
      details: {
        failureKind: 'postgres_query_cancelled',
        consecutiveFailures: 1,
        retryInMs: 500,
      },
    }]);

    await expect(worker.shutdown()).resolves.toEqual({ released: 0 });
    await expect(started).resolves.toBeUndefined();
    expect(worker.status().claimLoop).toMatchObject({ phase: 'stopped', ready: false });
  });

  it.each([
    ['nested', { cause: { code: '57014' } }],
    ['message-only', new Error('statement timeout 57014')],
    ['permission', { code: '42501' }],
    ['deadlock', { code: '40P01' }],
    ['connection', { code: '08006' }],
  ])('preserves a %s claim error as the exact fatal rejection', async (_label, error) => {
    const claim = vi.fn<WorkerStore['claim']>().mockRejectedValue(error);
    const worker = makeWorker(claim);
    await expect(worker.start()).rejects.toBe(error);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(worker.status().claimLoop).toMatchObject({ phase: 'failed', ready: false });
  });

  it('keeps drainOnce fail-fast and schedules no retry', async () => {
    vi.useFakeTimers();
    const error = { code: '57014' };
    const claim = vi.fn<WorkerStore['claim']>().mockRejectedValue(error);
    const worker = makeWorker(claim);
    await expect(worker.drainOnce()).rejects.toBe(error);
    await vi.runAllTimersAsync();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(worker.status().claimLoop).toMatchObject({ phase: 'not_started', ready: false });
  });

  it('does not contain a 57014-shaped post-RPC registration failure', async () => {
    const error = { code: '57014', private: 'registration detail' };
    const jobs = new Proxy([] as ClaimedJob[], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) throw error;
        return Reflect.get(target, property, receiver);
      },
    });
    const claim = vi.fn<WorkerStore['claim']>().mockResolvedValue(jobs);
    const worker = makeWorker(claim);
    await expect(worker.start()).rejects.toBe(error);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(worker.status().claimLoop).toMatchObject({ phase: 'failed', ready: false });
  });

  it('waits without an RPC or spin when current capacity is zero', async () => {
    vi.useFakeTimers();
    const claim = vi.fn<WorkerStore['claim']>().mockResolvedValue([]);
    const worker = makeWorker(claim, { maxConcurrentJobs: 0, pollIntervalMs: 1_000 });
    const started = worker.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(claim).not.toHaveBeenCalled();
    expect(worker.status().claimLoop).toMatchObject({
      phase: 'idle_wait',
      consecutiveFailures: 0,
      lastSuccessAt: null,
    });
    await worker.shutdown();
    await started;
  });

  it('leaves an existing handler owned while a later claim times out', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const handler = deferred<Record<string, unknown>>();
    const timeout = { code: '57014', message: 'private claim detail' };
    const claim = vi.fn<WorkerStore['claim']>()
      .mockResolvedValueOnce([keepaJob])
      .mockRejectedValueOnce(timeout)
      .mockResolvedValue([]);
    const finish = vi.fn<WorkerStore['finish']>().mockResolvedValue();
    const release = vi.fn<WorkerStore['release']>().mockResolvedValue(0);
    const worker = makeWorker(claim, {
      maxConcurrentJobs: 2,
      integrations: { keepaSync: () => handler.promise },
      storeOverrides: { finish, release },
    });
    const started = worker.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(claim.mock.calls.map((call) => call[1])).toEqual([2, 1]);
    expect(worker.status()).toMatchObject({ running: 1 });
    expect(worker.status().claimLoop).toMatchObject({ consecutiveFailures: 1 });
    expect(finish).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(claim.mock.calls.map((call) => call[1])).toEqual([2, 1, 1]);
    expect(worker.status()).toMatchObject({ running: 1 });
    handler.resolve({ completed: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();

    await worker.shutdown();
    await started;
  });

  it('interrupts an active backoff and starts no later claim', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const claim = vi.fn<WorkerStore['claim']>().mockRejectedValue({ code: '57014' });
    const worker = makeWorker(claim);
    const started = worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.status().claimLoop).toMatchObject({
      phase: 'backing_off',
      retryInMs: 1_000,
    });
    await expect(worker.shutdown()).resolves.toEqual({ released: 0 });
    await expect(started).resolves.toBeUndefined();
    expect(claim).toHaveBeenCalledTimes(1);
  });
});

describe('active claim shutdown', () => {
  it('waits for an empty active claim and starts no later claim', async () => {
    const pending = deferred<ClaimedJob[]>();
    const claim = vi.fn<WorkerStore['claim']>().mockReturnValue(pending.promise);
    const worker = makeWorker(claim);
    const started = worker.start();
    await claimsStarted(claim);
    const shuttingDown = worker.shutdown();
    expect(worker.status().claimLoop).toMatchObject({ phase: 'stopping', ready: false });
    pending.resolve([]);
    await expect(shuttingDown).resolves.toEqual({ released: 0 });
    await expect(started).resolves.toBeUndefined();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(worker.status().claimLoop).toMatchObject({ phase: 'stopped', ready: false });
  });

  it('registers jobs returned by an active claim exactly once before draining', async () => {
    const pending = deferred<ClaimedJob[]>();
    const handlerResult = deferred<Record<string, unknown>>();
    const claim = vi.fn<WorkerStore['claim']>().mockReturnValue(pending.promise);
    const finish = vi.fn<WorkerStore['finish']>().mockResolvedValue();
    const handler = vi.fn().mockReturnValue(handlerResult.promise);
    const worker = makeWorker(claim, {
      integrations: { keepaSync: handler },
      storeOverrides: { finish },
    });
    const started = worker.start();
    await claimsStarted(claim);
    const shuttingDown = worker.shutdown();
    let shutdownSettled = false;
    void shuttingDown.then(() => { shutdownSettled = true; });
    pending.resolve([keepaJob]);
    await Promise.resolve();
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(shutdownSettled).toBe(false);
    handlerResult.resolve({ completed: true });
    await expect(shuttingDown).resolves.toEqual({ released: 0 });
    await expect(started).resolves.toBeUndefined();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it('contains a direct 57014 from an active claim without scheduling another pass', async () => {
    const pending = deferred<ClaimedJob[]>();
    const claim = vi.fn<WorkerStore['claim']>().mockReturnValue(pending.promise);
    const logs: { message: string; details?: Record<string, unknown> }[] = [];
    const worker = makeWorker(claim, { logger: captureLogger(logs) });
    const started = worker.start();
    await claimsStarted(claim);
    const shuttingDown = worker.shutdown();
    pending.reject({ code: '57014', message: 'private timeout detail' });
    await expect(shuttingDown).resolves.toEqual({ released: 0 });
    await expect(started).resolves.toBeUndefined();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(logs[0]?.details).toMatchObject({
      failureKind: 'postgres_query_cancelled',
      consecutiveFailures: 1,
      retryInMs: null,
    });
    expect(JSON.stringify(logs)).not.toContain('private timeout detail');
  });

  it('preserves a fatal active-claim rejection while shutdown still settles', async () => {
    const pending = deferred<ClaimedJob[]>();
    const fatal = { code: '42501', private: 'permission detail' };
    const claim = vi.fn<WorkerStore['claim']>().mockReturnValue(pending.promise);
    const worker = makeWorker(claim);
    const started = worker.start();
    const startOutcome = started.then(() => undefined, (error: unknown) => error);
    await claimsStarted(claim);
    const shuttingDown = worker.shutdown();
    pending.reject(fatal);
    await expect(shuttingDown).resolves.toEqual({ released: 0 });
    await expect(startOutcome).resolves.toBe(fatal);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(worker.status().claimLoop).toMatchObject({ phase: 'stopped', ready: false });
  });
});

describe('one-shot worker lifecycle', () => {
  it('cannot start after shutdown-before-start', async () => {
    const claim = vi.fn<WorkerStore['claim']>().mockResolvedValue([]);
    const worker = makeWorker(claim);
    await expect(worker.shutdown()).resolves.toEqual({ released: 0 });
    await expect(worker.start()).rejects.toThrow('may only be called once');
    expect(claim).not.toHaveBeenCalled();
  });

  it('rejects a concurrent or later second start without disturbing the first', async () => {
    const pending = deferred<ClaimedJob[]>();
    const claim = vi.fn<WorkerStore['claim']>().mockReturnValue(pending.promise);
    const worker = makeWorker(claim);
    const first = worker.start();
    await claimsStarted(claim);
    await expect(worker.start()).rejects.toThrow('may only be called once');
    const shuttingDown = worker.shutdown();
    pending.resolve([]);
    await shuttingDown;
    await first;
    await expect(worker.start()).rejects.toThrow('may only be called once');
    expect(claim).toHaveBeenCalledTimes(1);
  });
});

interface WorkerOverrides {
  workerId?: string;
  jobTypes?: readonly JobType[];
  maxConcurrentJobs?: number;
  pollIntervalMs?: number;
  logger?: WorkerLogger;
  integrations?: ConstructorParameters<typeof SyncWorker>[0]['integrations'];
  storeOverrides?: Partial<WorkerStore>;
}

function makeWorker(claim: WorkerStore['claim'], overrides: WorkerOverrides = {}): SyncWorker {
  return new SyncWorker({
    workerId: overrides.workerId ?? 'resilient-worker',
    store: { ...stubStore(), ...overrides.storeOverrides, claim },
    jobTypes: overrides.jobTypes,
    maxConcurrentJobs: overrides.maxConcurrentJobs,
    pollIntervalMs: overrides.pollIntervalMs ?? 1_000,
    logger: overrides.logger ?? { info: () => {}, error: () => {} },
    integrations: overrides.integrations,
  });
}

function captureLogger(logs: { message: string; details?: Record<string, unknown> }[]): WorkerLogger {
  return {
    info: () => {},
    error: (message, details) => logs.push({ message, details }),
  };
}

async function claimsStarted(claim: ReturnType<typeof vi.fn<WorkerStore['claim']>>): Promise<void> {
  for (let attempt = 0; attempt < 10 && claim.mock.calls.length === 0; attempt += 1) {
    await Promise.resolve();
  }
  expect(claim).toHaveBeenCalledTimes(1);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve = (_value: T) => {};
  let reject = (_error: unknown) => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function profile(): AdsProfileContext {
  return {
    id: profileId,
    orgId,
    amazonProfileId: 'profile-1',
    region: 'NA',
    currencyCode: 'USD',
    timezone: 'UTC',
  };
}

function stubStore(): WorkerStore {
  return {
    claim: async () => [],
    finish: async () => {},
    deadLetter: async () => {},
    release: async () => 0,
    requeueStale: async () => 0,
    profile: async () => profile(),
    syncEntities: async () => ({
      listed: 0,
      upserted: 0,
      duplicates: 0,
      changes: 0,
      tombstoned: 0,
    }),
    provisionSchedules: async () => 0,
    unscheduledProfiles: async () => [],
    repairOverlongLookbacks: async () => 0,
    ensureIntegrationSchedules: async () => 0,
    ensureReportRequest: async () => { throw new Error('unused'); },
    setReportCreated: async () => {},
    getReportRequest: async () => { throw new Error('unused'); },
    updateReportPoll: async () => {},
    enqueue: async () => true,
    ensureReportPartitions: async () => ({
      expectedMonths: 0,
      matchedMonths: 0,
      createdMonths: 0,
    }),
    promoteReportDate: async () => { throw new Error('unused'); },
    failReport: async () => {},
    failTerminalReport: async () => false,
    loadFacts: async () => 0,
    completeReport: async () => {},
    finishAttributedReport: async () => {},
  };
}
