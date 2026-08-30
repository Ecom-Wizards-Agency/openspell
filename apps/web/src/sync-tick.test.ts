/**
 * The cron tick, against a real migrated database with fake work.
 *
 * Three properties, each of which was a real defect:
 *
 *  - the overlong-lookback repair runs on every tick, not only when a profile
 *    happens to have no schedules at all (in which case it never ran at all in
 *    a deployment where every profile was already provisioned);
 *  - two ticks cannot drain at once — the second sees the advisory lock and
 *    returns immediately rather than doubling the Amazon concurrency;
 *  - the bid-corridor sync runs from the cron tick, which is the only thing
 *    that runs in this deployment, and only when the budget can afford it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import {
  CRON_SYNC_JOB_TYPES,
  creativeSyncPilotFromEnv,
  cronSyncJobTypesFromEnv,
  runSyncTick,
  SYNC_TICK_LOCK_KEY,
} from './server/sync-tick';
import type { SyncTickStore, SyncTickWorker } from './server/sync-tick';

const available = await databaseAvailable();
const PROFILE_ONE = '11111111-2222-4333-8444-555555555555';

describe('cron claim filter', () => {
  it('enumerates Amazon jobs and recommendations, excluding integration work', () => {
    expect(CRON_SYNC_JOB_TYPES).toEqual([
      'entity.sync',
      'report.request',
      'report.poll',
      'report.fetch',
      'recommendations.run',
    ]);
  });

  it('transfers only report ownership after an explicit deployment handoff', () => {
    expect(cronSyncJobTypesFromEnv({ OPENSPELL_EVO_REPORT_LANE_READY: '1' })).toEqual([
      'entity.sync',
      'recommendations.run',
    ]);
  });

  it('fails closed for a malformed deployment handoff', () => {
    expect(() => cronSyncJobTypesFromEnv({ OPENSPELL_EVO_REPORT_LANE_READY: 'true' }))
      .toThrow(/OPENSPELL_EVO_REPORT_LANE_READY/);
  });

  it('keeps the Creative producer inert until both exact activation flags are set', () => {
    expect(creativeSyncPilotFromEnv({})).toEqual({ enabled: false, profileIds: [] });
    expect(creativeSyncPilotFromEnv({
      OPENSPELL_EVO_REPORT_LANE_READY: '1',
      OPENSPELL_CREATIVE_SYNC_PRODUCER_READY: '0',
      OPENSPELL_CREATIVE_SYNC_PROFILE_ALLOWLIST: 'malformed-but-ignored',
    })).toEqual({ enabled: false, profileIds: [] });
    expect(creativeSyncPilotFromEnv({
      OPENSPELL_EVO_REPORT_LANE_READY: '1',
      OPENSPELL_CREATIVE_SYNC_PRODUCER_READY: '1',
      OPENSPELL_CREATIVE_SYNC_PROFILE_ALLOWLIST: PROFILE_ONE,
    })).toEqual({ enabled: true, profileIds: [PROFILE_ONE] });
  });

  it('refuses malformed or premature Creative producer activation', () => {
    expect(() => creativeSyncPilotFromEnv({
      OPENSPELL_EVO_REPORT_LANE_READY: '1',
      OPENSPELL_CREATIVE_SYNC_PRODUCER_READY: 'true',
    })).toThrow(/OPENSPELL_CREATIVE_SYNC_PRODUCER_READY/);
    expect(() => creativeSyncPilotFromEnv({
      OPENSPELL_EVO_REPORT_LANE_READY: '0',
      OPENSPELL_CREATIVE_SYNC_PRODUCER_READY: '1',
    })).toThrow(/exclusive Evo report lane/);
    expect(() => creativeSyncPilotFromEnv({
      OPENSPELL_EVO_REPORT_LANE_READY: '1',
      OPENSPELL_CREATIVE_SYNC_PRODUCER_READY: '1',
    })).toThrow(/OPENSPELL_CREATIVE_SYNC_PROFILE_ALLOWLIST/);
  });
});

class FakeStore implements SyncTickStore {
  repairs = 0;
  integrationPasses = 0;
  provisioned: string[] = [];
  released: string[] = [];
  unscheduled: { orgId: string; profileId: string }[] = [];
  async unscheduledProfiles(): Promise<{ orgId: string; profileId: string }[]> {
    return this.unscheduled;
  }
  async provisionSchedules(_orgId: string, profileId: string): Promise<number> {
    this.provisioned.push(profileId);
    return 2;
  }
  async repairOverlongLookbacks(): Promise<number> {
    this.repairs += 1;
    return 1;
  }
  async ensureIntegrationSchedules(): Promise<number> {
    this.integrationPasses += 1;
    return 4;
  }
  async release(workerId: string): Promise<number> {
    this.released.push(workerId);
    return 0;
  }
}

class FakeWorker implements SyncTickWorker {
  readonly workerId = 'test-cron-worker';
  drains = 0;
  async drainOnce(): Promise<number> {
    this.drains += 1;
    return 0;
  }
}

describe.skipIf(!available)('runSyncTick', () => {
  let database: TestDatabase;

  /**
   * Is the tick lock free? Asked on one reserved connection, because an
   * advisory lock belongs to the session that took it — taking it on one
   * pooled connection and unlocking on another leaves it held forever.
   */
  async function lockIsFree(): Promise<boolean> {
    const connection = await database.sql.reserve();
    try {
      const [row] = await connection<{ locked: boolean }[]>`
        select pg_try_advisory_lock(${SYNC_TICK_LOCK_KEY}::bigint) as locked
      `;
      if (row?.locked) await connection`select pg_advisory_unlock(${SYNC_TICK_LOCK_KEY}::bigint)`;
      return row?.locked ?? false;
    } finally {
      connection.release();
    }
  }

  beforeAll(async () => {
    database = await createTestDatabase('web_cron_tick');
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('repairs, provisions, drains, syncs the corridor and releases', async () => {
    const store = new FakeStore();
    store.unscheduled = [{ orgId: 'org', profileId: 'profile' }];
    const worker = new FakeWorker();
    let bidSeriesRuns = 0;
    let recommendationScheduleRuns = 0;
    let creativeScheduleRuns = 0;

    const result = await runSyncTick({
      sql: database.sql,
      store,
      worker,
      recommendationSchedules: async () => {
        recommendationScheduleRuns += 1;
        return 3;
      },
      creativeSyncSchedules: async () => {
        creativeScheduleRuns += 1;
        return {
          requestedProfiles: 4,
          eligibleProfiles: 2,
          ineligibleProfiles: 1,
          deferredPendingProfiles: 1,
          enqueuedJobs: 1,
          deduplicatedJobs: 1,
          observations: [
            {
              orgId: '22222222-3333-4444-8555-666666666666',
              profileId: PROFILE_ONE,
              localDate: '2026-08-30',
              dedupeKey: ['creative.sync', 'SB', PROFILE_ONE, '2026-08-30'].join(':'),
              jobId: '77777777-8888-4999-8aaa-bbbbbbbbbbbb',
              enqueued: true,
            },
            {
              orgId: '22222222-3333-4444-8555-666666666666',
              profileId: 'cccccccc-dddd-4eee-8fff-111111111111',
              localDate: '2026-08-30',
              dedupeKey: ['creative.sync', 'SB', 'synthetic-second', '2026-08-30'].join(':'),
              jobId: '33333333-4444-4555-8666-777777777777',
              enqueued: false,
            },
          ],
        };
      },
      bidSeries: async () => {
        bidSeriesRuns += 1;
        return { profiles: 1, written: 7 };
      },
    });

    expect(result.ok).toBe(true);
    // The repair is unconditional: it ran even though the only unscheduled
    // profile is the one `provisionSchedules` would have repaired anyway.
    expect(store.repairs).toBe(1);
    expect(result.repaired).toBe(1);
    expect(store.integrationPasses).toBe(1);
    expect(result.integrationSchedules).toBe(4);
    expect(store.provisioned).toEqual(['profile']);
    expect(result.provisioned).toBe(2);
    expect(recommendationScheduleRuns).toBe(1);
    expect(creativeScheduleRuns).toBe(1);
    expect(result.creativeSync).toEqual({
      requestedProfiles: 4,
      eligibleProfiles: 2,
      ineligibleProfiles: 1,
      deferredPendingProfiles: 1,
      enqueuedJobs: 1,
      deduplicatedJobs: 1,
    });
    const publicResult = JSON.stringify(result);
    expect(publicResult).not.toContain(PROFILE_ONE);
    expect(publicResult).not.toContain('creative.sync:SB:');
    expect(result.enqueued).toBeGreaterThanOrEqual(3);
    expect(worker.drains).toBe(1);
    expect(bidSeriesRuns).toBe(1);
    expect(result.bidSeries).toEqual({ profiles: 1, written: 7 });
    expect(store.released).toEqual([worker.workerId]);

    // The lock is a lock, not a leak: it is free again for the next tick.
    expect(await lockIsFree()).toBe(true);
  });

  it('skips a tick whose predecessor is still running', async () => {
    // A slow tick, represented by the lock it would be holding on its own
    // session.
    const holder = await database.sql.reserve();
    const [taken] = await holder<{ locked: boolean }[]>`
      select pg_try_advisory_lock(${SYNC_TICK_LOCK_KEY}::bigint) as locked
    `;
    expect(taken?.locked).toBe(true);

    const store = new FakeStore();
    const worker = new FakeWorker();
    try {
      const result = await runSyncTick({ sql: database.sql, store, worker, bidSeries: async () => ({ ran: 1 }) });
      expect(result).toMatchObject({ ok: true, skipped: 'overlap', drained: 0 });
      // Nothing was touched: not the schedules, not the queue, not Amazon.
      expect(store.repairs).toBe(0);
      expect(store.integrationPasses).toBe(0);
      expect(worker.drains).toBe(0);
      expect(store.released).toEqual([]);
    } finally {
      await holder`select pg_advisory_unlock(${SYNC_TICK_LOCK_KEY}::bigint)`;
      holder.release();
    }
  });

  it('leaves the corridor sync for the next tick when the budget is spent', async () => {
    const store = new FakeStore();
    const worker = new FakeWorker();
    let bidSeriesRuns = 0;
    // A clock that jumps past the budget as soon as the drain is done.
    let calls = 0;
    const start = Date.now();

    const result = await runSyncTick({
      sql: database.sql,
      store,
      worker,
      budgetMs: 120_000,
      bidSeries: async () => {
        bidSeriesRuns += 1;
        return { ran: 1 };
      },
      // Time enough to claim and drain, and 1s left when the drain is done —
      // less than the corridor sync's reserve, so it waits for the next tick.
      now: () => {
        calls += 1;
        return calls <= 2 ? start : start + 119_000;
      },
    });

    expect(result.ok).toBe(true);
    expect(bidSeriesRuns).toBe(0);
    expect(result.bidSeries).toBeUndefined();
    // The drain still happened; only the optional step was skipped.
    expect(worker.drains).toBeGreaterThan(0);
  });

  it('does not start integration schedule reconciliation after the deadline', async () => {
    const store = new FakeStore();
    const worker = new FakeWorker();
    let calls = 0;
    const start = Date.now();

    const result = await runSyncTick({
      sql: database.sql,
      store,
      worker,
      budgetMs: 1,
      now: () => (calls += 1) === 1 ? start : start + 1,
    });

    expect(result.budgetHit).toBe(true);
    expect(store.integrationPasses).toBe(0);
    expect(result.integrationSchedules).toBe(0);
    expect(worker.drains).toBe(0);
  });

  it('releases and reports when a step throws', async () => {
    const store = new (class extends FakeStore {
      override async repairOverlongLookbacks(): Promise<number> {
        throw new Error('the database went away');
      }
    })();
    const worker = new FakeWorker();

    const result = await runSyncTick({ sql: database.sql, store, worker });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('the database went away');
    expect(store.released).toEqual([worker.workerId]);
    // Failure releases the lock too, or the next tick would skip forever.
    expect(await lockIsFree()).toBe(true);
  });
});
