import { describe, expect, it } from 'vitest';
import {
  ClaimLoopController,
  claimRetryDelay,
  isContainedClaimFailure,
  type ClaimLoopRuntime,
} from './claim-loop.js';

describe('claim failure classification', () => {
  it('contains only a direct 57014 code', () => {
    const postgresError = Object.assign(new Error('private database detail'), { code: '57014' });
    expect(isContainedClaimFailure(postgresError)).toBe(true);
    expect(isContainedClaimFailure({ code: '57014' })).toBe(true);

    for (const error of [
      { code: 57014 },
      { code: '42501' },
      { code: '40P01' },
      { code: '08006' },
      { message: 'canceling statement due to statement timeout' },
      { cause: { code: '57014' } },
      null,
      '57014',
    ]) expect(isContainedClaimFailure(error)).toBe(false);
  });
});

describe('claim retry delay', () => {
  it('uses bounded equal jitter with exact integer endpoints', () => {
    expect(claimRetryDelay(1, 1_000, 0)).toBe(500);
    expect(claimRetryDelay(1, 1_000, 1)).toBe(1_000);
    expect(claimRetryDelay(2, 1_000, 0)).toBe(1_000);
    expect(claimRetryDelay(2, 1_000, 1)).toBe(2_000);
    expect(claimRetryDelay(6, 1_000, 0)).toBe(15_000);
    expect(claimRetryDelay(6, 1_000, 1)).toBe(30_000);
    expect(claimRetryDelay(Number.POSITIVE_INFINITY, 1_000, 1)).toBe(30_000);
  });

  it('normalizes invalid intervals, failure counts and random values', () => {
    expect(claimRetryDelay(Number.NaN, Number.NaN, Number.NaN)).toBe(750);
    expect(claimRetryDelay(-10, -1, Number.NEGATIVE_INFINITY)).toBe(750);
    expect(claimRetryDelay(1.9, 60_000, -5)).toBe(15_000);
    expect(claimRetryDelay(1, 1_001.4, 5)).toBe(1_001);
  });
});

describe('claim-loop controller', () => {
  it('returns fresh frozen snapshots and makes readiness reflect every terminal phase', () => {
    const controller = new ClaimLoopController(1_000, () => new Date('2026-09-02T00:00:00Z'));
    const first = controller.status();
    const second = controller.status();
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).toMatchObject({ phase: 'not_started', ready: false, consecutiveFailures: 0 });

    controller.beginStart();
    expect(controller.status()).toMatchObject({ phase: 'claiming', ready: true });
    controller.recordFatalFailure();
    expect(controller.status()).toMatchObject({ phase: 'failed', ready: false });
    expect(() => controller.beginStart()).toThrow('may only be called once');
  });

  it('degrades on failure three and resets only after an actual RPC success', () => {
    const timestamps = [
      new Date('2026-09-02T00:00:01Z'),
      new Date('2026-09-02T00:00:02Z'),
      new Date('2026-09-02T00:00:03Z'),
      new Date('2026-09-02T00:00:04Z'),
    ];
    const runtime: ClaimLoopRuntime = {
      sleep: async () => {},
      random: () => 0,
    };
    const controller = new ClaimLoopController(1_000, () => timestamps.shift()!, runtime);
    controller.beginStart();

    controller.recordContainedFailure();
    controller.beginClaim();
    controller.recordContainedFailure();
    expect(controller.status()).toMatchObject({ consecutiveFailures: 2, ready: true });
    controller.beginClaim();
    controller.recordContainedFailure();
    expect(controller.status()).toMatchObject({
      phase: 'backing_off',
      consecutiveFailures: 3,
      ready: false,
      failureKind: 'postgres_query_cancelled',
      lastFailureAt: '2026-09-02T00:00:03.000Z',
    });

    controller.beginClaim();
    controller.recordNoCapacity();
    expect(controller.status()).toMatchObject({
      phase: 'idle_wait',
      consecutiveFailures: 3,
      ready: false,
      lastFailureAt: '2026-09-02T00:00:03.000Z',
    });

    controller.beginClaim();
    controller.recordSuccess(false);
    expect(controller.status()).toMatchObject({
      phase: 'idle_wait',
      consecutiveFailures: 0,
      ready: true,
      lastSuccessAt: '2026-09-02T00:00:04.000Z',
      lastFailureAt: null,
      failureKind: null,
      retryInMs: null,
    });
  });

  it('aborts an active wait and cannot be resurrected after shutdown', async () => {
    let finishSleep = () => {};
    let observedSignal: AbortSignal | undefined;
    const runtime: ClaimLoopRuntime = {
      sleep: (_milliseconds, signal) => new Promise<void>((resolve) => {
        observedSignal = signal;
        finishSleep = resolve;
      }),
      random: () => 0,
    };
    const controller = new ClaimLoopController(1_000, () => new Date(), runtime);
    controller.beginStart();
    controller.recordNoCapacity();
    const waiting = controller.wait(1_000);
    controller.beginShutdown();
    expect(observedSignal?.aborted).toBe(true);
    expect(controller.status()).toMatchObject({ phase: 'stopping', ready: false });
    finishSleep();
    await expect(waiting).resolves.toBe(false);
    controller.finishShutdown();
    expect(controller.status()).toMatchObject({ phase: 'stopped', ready: false });
    expect(controller.beginClaim()).toBe(false);
    expect(() => controller.beginStart()).toThrow('may only be called once');
  });
});
