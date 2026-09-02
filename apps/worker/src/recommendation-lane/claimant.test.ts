import type { ClaimRef, ClaimedJob } from '@wizard-ads/db';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_RECOMMENDATION_RESULT_BYTES,
  RecommendationClaimant,
  RecommendationClaimantCustodyError,
  type RecommendationFinishOptions,
  type RecommendationExecute,
  type RecommendationQueuePort,
  type RecommendationSettlementDecision,
  type RecommendationWorkerIdentity,
} from './claimant.js';

const identity: RecommendationWorkerIdentity = Object.freeze({
  workerId: 'recommendation-worker-1',
  revision: 'a'.repeat(40),
});

const ids = {
  job: '11111111-1111-4111-8111-111111111111',
  org: '22222222-2222-4222-8222-222222222222',
  profile: '33333333-3333-4333-8333-333333333333',
  run: '44444444-4444-4444-8444-444444444444',
  token: '55555555-5555-4555-8555-555555555555',
};

function claimedJob(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  const id = overrides.id ?? ids.job;
  const claimedBy = overrides.claimedBy === undefined ? identity.workerId : overrides.claimedBy;
  const claim = overrides.claim === undefined
    ? Object.freeze({
      jobId: id,
      workerId: identity.workerId,
      token: ids.token as ClaimRef['token'],
    })
    : overrides.claim;
  return {
    id,
    orgId: ids.org,
    profileId: ids.profile,
    jobType: 'recommendations.run',
    payload: {
      type: 'recommendations.run',
      orgId: ids.org,
      profileId: ids.profile,
      runId: ids.run,
      lookbackDays: 30,
    },
    attempts: 1,
    maxAttempts: 5,
    dedupeKey: null,
    claimedBy,
    claim,
    ...overrides,
  };
}

class FakeQueue implements RecommendationQueuePort {
  readonly calls: string[] = [];
  readonly settlements: Array<{
    kind: 'finish' | 'defer';
    claim: ClaimRef;
    outcome?: 'succeeded' | 'failed' | 'dead';
    options?: RecommendationFinishOptions;
    retryIn?: string;
  }> = [];
  resumeBatches: Array<readonly ClaimedJob[]> = [[]];
  claimBatches: Array<readonly ClaimedJob[]> = [];
  claimGate: Promise<readonly ClaimedJob[]> | null = null;
  settlementDecision: RecommendationSettlementDecision = { decision: 'settled' };
  settlementError: Error | null = null;

  async resumeOwned(input: RecommendationWorkerIdentity): Promise<readonly ClaimedJob[]> {
    expect(input).toEqual(identity);
    this.calls.push('resume');
    return this.resumeBatches.shift() ?? [];
  }

  async claim(
    input: RecommendationWorkerIdentity,
    limit: 1,
  ): Promise<readonly ClaimedJob[]> {
    expect(input).toEqual(identity);
    expect(limit).toBe(1);
    this.calls.push('claim');
    if (this.claimGate) return this.claimGate;
    return this.claimBatches.shift() ?? [];
  }

  async finish(
    claim: ClaimRef,
    outcome: 'succeeded' | 'failed' | 'dead',
    options?: RecommendationFinishOptions,
  ): Promise<RecommendationSettlementDecision> {
    this.calls.push('finish');
    this.settlements.push({ kind: 'finish', claim, outcome, options });
    if (this.settlementError) throw this.settlementError;
    return this.settlementDecision;
  }

  async defer(
    claim: ClaimRef,
    retryIn: string,
  ): Promise<RecommendationSettlementDecision> {
    this.calls.push('defer');
    this.settlements.push({ kind: 'defer', claim, retryIn });
    if (this.settlementError) throw this.settlementError;
    return this.settlementDecision;
  }
}

function claimant<Result>(
  queue: FakeQueue,
  execute: RecommendationExecute<Result>,
  overrides: Partial<Pick<ConstructorParameters<typeof RecommendationClaimant<Result>>[0], 'pollIntervalMs' | 'shutdownDrainMs'>> = {},
): RecommendationClaimant<Result> {
  return new RecommendationClaimant({
    identity,
    queue,
    execute,
    pollIntervalMs: overrides.pollIntervalMs ?? 10,
    shutdownDrainMs: overrides.shutdownDrainMs ?? 10,
  });
}

describe('RecommendationClaimant', () => {
  it('becomes ready and remains idle when resume and fenced claim both return no work', async () => {
    const queue = new FakeQueue();
    const execute = vi.fn(async () => ({ ok: true }));
    const worker = claimant(queue, execute);

    await expect(worker.drainOnce()).resolves.toBe(0);

    expect(queue.calls).toEqual(['resume', 'claim']);
    expect(execute).not.toHaveBeenCalled();
    expect(worker.status()).toMatchObject({
      phase: 'idle', ready: true, inFlight: 0, resumeComplete: true,
    });
  });

  it('resumes same-identity custody before making any fresh claim', async () => {
    const queue = new FakeQueue();
    const resumed = claimedJob();
    const fresh = claimedJob({
      id: '66666666-6666-4666-8666-666666666666',
      claim: Object.freeze({
        jobId: '66666666-6666-4666-8666-666666666666',
        workerId: identity.workerId,
        token: '77777777-7777-4777-8777-777777777777' as ClaimRef['token'],
      }),
    });
    queue.resumeBatches = [[resumed], []];
    queue.claimBatches = [[fresh]];
    const execute = vi.fn(async () => ({ ok: true }));
    const worker = claimant(queue, execute);

    await expect(worker.drainOnce()).resolves.toBe(1);
    expect(queue.calls).toEqual(['resume', 'finish']);
    expect(worker.status().resumeComplete).toBe(false);

    await expect(worker.drainOnce()).resolves.toBe(1);
    expect(queue.calls).toEqual(['resume', 'finish', 'resume', 'claim', 'finish']);
    expect(worker.status()).toMatchObject({ ready: true, inFlight: 0, resumeComplete: true });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('passes the exact opaque claim to the runner and stores only a bounded result', async () => {
    const queue = new FakeQueue();
    const job = claimedJob();
    queue.claimBatches = [[job]];
    const execute = vi.fn(async () => ({
      runId: ids.run,
      proposals: 3,
      window: null,
      alreadySucceeded: false,
    }));
    const worker = claimant(queue, execute);

    await expect(worker.drainOnce()).resolves.toBe(1);

    expect(execute).toHaveBeenCalledWith(job.payload, { claim: job.claim });
    expect(queue.settlements).toEqual([{
      kind: 'finish',
      claim: job.claim,
      outcome: 'succeeded',
      options: { result: await execute.mock.results[0]!.value },
    }]);
  });

  it('keeps claim and execution single-flight under concurrent drains', async () => {
    const queue = new FakeQueue();
    queue.claimBatches = [[claimedJob()], [claimedJob()]];
    const execution = deferred<{ ok: true }>();
    const execute = vi.fn(() => execution.promise);
    const worker = claimant(queue, execute);

    const first = worker.drainOnce();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await expect(worker.drainOnce()).resolves.toBe(0);
    expect(queue.calls.filter((call) => call === 'claim')).toHaveLength(1);
    expect(worker.status().inFlight).toBe(1);

    execution.resolve({ ok: true });
    await expect(first).resolves.toBe(1);
    expect(worker.status().inFlight).toBe(0);
  });

  it('consumes retry attempts with a bounded interval and dead-letters the final attempt', async () => {
    const retryQueue = new FakeQueue();
    retryQueue.claimBatches = [
      [claimedJob({ attempts: 1, maxAttempts: 3 })],
      [claimedJob({ attempts: 2, maxAttempts: 3 })],
      [claimedJob({ attempts: 3, maxAttempts: 3 })],
    ];
    const retryError = Object.assign(new Error('provider detail must not persist'), {
      name: 'RetryableJobError',
      retryAfterSeconds: Number.MAX_SAFE_INTEGER,
    });
    const retryClaimant = claimant(retryQueue, async () => { throw retryError; });
    await retryClaimant.drainOnce();
    await retryClaimant.drainOnce();
    await retryClaimant.drainOnce();
    expect(retryQueue.settlements).toEqual([
      expect.objectContaining({
        kind: 'finish', outcome: 'failed',
        options: {
          error: 'retryable recommendation execution failure', retryIn: '86400 seconds',
        },
      }),
      expect.objectContaining({
        kind: 'finish', outcome: 'failed',
        options: {
          error: 'retryable recommendation execution failure', retryIn: '86400 seconds',
        },
      }),
      expect.objectContaining({
        kind: 'finish', outcome: 'dead',
        options: { error: 'recommendation retry budget exhausted' },
      }),
    ]);

    const integrityQueue = new FakeQueue();
    integrityQueue.claimBatches = [[claimedJob({ attempts: 1, maxAttempts: 5 })]];
    const integrityError = Object.assign(new Error('internal detail'), {
      name: 'RecommendationScopeIntegrityError',
    });
    await claimant(integrityQueue, async () => { throw integrityError; }).drainOnce();
    expect(integrityQueue.settlements).toEqual([expect.objectContaining({
      kind: 'finish',
      outcome: 'dead',
      options: { error: 'recommendation scope integrity failure' },
    })]);
  });

  it('terminally settles malformed payloads and oversized results without raw detail', async () => {
    const malformedQueue = new FakeQueue();
    malformedQueue.claimBatches = [[claimedJob({
      payload: { type: 'recommendations.run' } as ClaimedJob['payload'],
    })]];
    const execute = vi.fn(async () => ({ ok: true }));
    await claimant(malformedQueue, execute).drainOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(malformedQueue.settlements[0]).toMatchObject({
      outcome: 'dead',
      options: { error: 'invalid recommendation job payload' },
    });

    const oversizedQueue = new FakeQueue();
    oversizedQueue.claimBatches = [[claimedJob()]];
    await claimant(oversizedQueue, async () => 'x'.repeat(MAX_RECOMMENDATION_RESULT_BYTES + 1))
      .drainOnce();
    expect(oversizedQueue.settlements[0]).toMatchObject({
      outcome: 'dead',
      options: { error: 'invalid recommendation result' },
    });
  });

  it.each([
    ['stale response', { decision: 'stale_claim' } as const, null, 'custody_lost'],
    ['lost response', { decision: 'settled' } as const, new Error('transport detail'), 'settlement_ambiguous'],
  ])('latches closed after %s and never claims again', async (_case, decision, error, expectedKind) => {
    const queue = new FakeQueue();
    queue.claimBatches = [[claimedJob()], [claimedJob()]];
    queue.settlementDecision = decision;
    queue.settlementError = error;
    const worker = claimant(queue, async () => ({ ok: true }));

    await expect(worker.drainOnce()).rejects.toMatchObject({
      name: 'RecommendationClaimantCustodyError',
      kind: expectedKind,
    });
    expect(worker.status()).toMatchObject({
      ready: false,
      settlementFailure: expectedKind,
    });
    await expect(worker.drainOnce()).rejects.toBeInstanceOf(RecommendationClaimantCustodyError);
    expect(queue.calls.filter((call) => call === 'claim')).toHaveLength(1);
    await expect(worker.shutdown()).resolves.toEqual({ released: 0, unresolved: 1 });
  });

  it('treats execution custody loss and malformed claim responses as unresolved custody', async () => {
    const executionQueue = new FakeQueue();
    executionQueue.claimBatches = [[claimedJob()]];
    const custodyError = Object.assign(new Error('must be hidden'), {
      name: 'RecommendationExecutionCustodyError',
    });
    const executionWorker = claimant(executionQueue, async () => { throw custodyError; });
    await expect(executionWorker.drainOnce()).rejects.toMatchObject({ kind: 'custody_lost' });
    expect(executionQueue.settlements).toHaveLength(0);
    await expect(executionWorker.shutdown()).resolves.toEqual({ released: 0, unresolved: 1 });

    const malformedQueue = new FakeQueue();
    malformedQueue.claimBatches = [[claimedJob({ claimedBy: 'somebody-else' })]];
    const malformedWorker = claimant(malformedQueue, async () => ({ ok: true }));
    await expect(malformedWorker.drainOnce()).rejects.toMatchObject({ kind: 'invalid_custody' });
    expect(malformedQueue.settlements).toHaveLength(0);
    await expect(malformedWorker.shutdown()).resolves.toEqual({ released: 0, unresolved: 1 });
  });

  it('never releases an active claim when bounded shutdown drain expires', async () => {
    const queue = new FakeQueue();
    queue.claimBatches = [[claimedJob()]];
    const execution = deferred<{ ok: true }>();
    const worker = claimant(queue, () => execution.promise, { shutdownDrainMs: 1 });
    const active = worker.drainOnce();
    await vi.waitFor(() => expect(worker.status().inFlight).toBe(1));

    await expect(worker.shutdown()).resolves.toEqual({ released: 0, unresolved: 1 });
    expect(queue).not.toHaveProperty('release');

    execution.resolve({ ok: true });
    await active;
  });

  it('conservatively reports unresolved custody when an in-flight claim response misses shutdown', async () => {
    const queue = new FakeQueue();
    const claimResponse = deferred<readonly ClaimedJob[]>();
    queue.claimGate = claimResponse.promise;
    const execute = vi.fn(async () => ({ ok: true }));
    const worker = claimant(queue, execute, { shutdownDrainMs: 1 });
    const active = worker.drainOnce();
    await vi.waitFor(() => expect(queue.calls).toEqual(['resume', 'claim']));

    await expect(worker.shutdown()).resolves.toEqual({ released: 0, unresolved: 1 });

    claimResponse.resolve([]);
    await expect(active).resolves.toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a multi-row response rather than silently abandoning custody', async () => {
    const queue = new FakeQueue();
    queue.resumeBatches = [[claimedJob(), claimedJob({
      id: '88888888-8888-4888-8888-888888888888',
    })]];
    const worker = claimant(queue, async () => ({ ok: true }));

    await expect(worker.drainOnce()).rejects.toMatchObject({ kind: 'invalid_custody' });
    await expect(worker.shutdown()).resolves.toEqual({ released: 0, unresolved: 2 });
    expect(queue.calls).toEqual(['resume']);
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}
