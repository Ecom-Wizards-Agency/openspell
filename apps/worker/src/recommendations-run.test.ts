/**
 * Runner orchestration tests. The bid engine's arithmetic belongs to
 * packages/core; these cases assert assembly, lifecycle, mapping and writes.
 */
import { describe, expect, it } from 'vitest';
import type { ClaimRef, ClaimedJob, ClaimToken } from '@wizard-ads/db';
import type { RecommendationWorkerDatabase } from '@wizard-ads/db/recommendation-worker';
import type { ScheduledOptimizationGroup, TenantStrategy } from '@wizard-ads/shared';
import {
  BID_REASON_TO_DATABASE,
  RecommendationExecutionCustodyError,
  RecommendationScopeIntegrityError,
  batchScopeFingerprint,
  databaseReason,
  FencedRecommendationRunStore,
  recommendationWindow,
  runScopeFingerprint,
  runRecommendations,
  type DateWindow,
  type RecommendationProfile,
  type RecommendationRunExecutionContext,
  type RecommendationRunInputs,
  type RecommendationRunStore,
  type RunCompletion,
  type RunScope,
  type StartRunResult,
} from './recommendations-run.js';
import {
  RecommendationClaimant,
  RecommendationClaimantCustodyError,
  type RecommendationQueuePort,
} from './recommendation-lane/claimant.js';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const PROFILE_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const GROUP_ID = '44444444-4444-4444-8444-444444444444';

const STRATEGY: TenantStrategy = {
  schema: 'wizard-ads.tenant-strategy.v1',
  pacing: {},
  opt_groups: {
    Profit: {
      target_acos: 0.3,
      max_increase: 0.25,
      max_decrease: 0.5,
      goal_lens: 'profit-maintain',
      cut_on_acos_alone: true,
    },
  },
  rank_lifecycle: {},
  staged_apply: {},
  bids: {},
  sv_bands: {},
  caps: {},
  pat_split: {},
  naming: {},
};

const PROFILE: RecommendationProfile = {
  orgId: ORG_ID,
  profileId: PROFILE_ID,
  timezone: 'UTC',
  goal: 'profit-maintain',
  monthlyBudget: null,
};

function fixtureInputs(): RecommendationRunInputs {
  return {
    tenantStrategy: STRATEGY,
    profileStrategy: null,
    targets: [
      {
        entityRef: {
          profileId: PROFILE_ID,
          entityType: 'keyword',
          entityId: 'kw-1',
          adProduct: 'SP',
          campaignId: 'c-1',
          adGroupId: 'ag-1',
          name: 'blue widget',
        },
        campaignName: 'Profit | exact | blue widget',
        adGroupName: 'exact targets',
        category: 'Profit',
        matchType: 'exact',
        entityState: 'enabled',
        campaignState: 'enabled',
        adGroupState: 'enabled',
        currentBid: 1,
        dailyBudget: 20,
        stock: { status: 'unknown', asins: ['B0TEST5101'] },
        organicRank: { status: 'unknown' },
        metrics: { impressions: 1_000, clicks: 10, cost: 10, orders: 2, sales: 20 },
        corridor: {
          date: '2026-08-26',
          low: 0.2,
          median: 0.4,
          high: 0.55,
          bid: 1,
          cpc: 1,
        },
      },
    ],
    campaigns: [
      {
        adProduct: 'SP',
        campaignId: 'c-1',
        campaignName: 'Profit | exact | blue widget',
        state: 'enabled',
        dailyBudget: 20,
        metrics: { impressions: 1_000, clicks: 10, cost: 10, orders: 2, sales: 20 },
      },
    ],
    profileFacts: [
      { date: '2026-08-26', impressions: 1_000, clicks: 10, cost: 10, orders: 2, sales: 20 },
    ],
  };
}

class FakeStore implements RecommendationRunStore {
  started: RunScope[] = [];
  expectedGroupIds: Array<string | undefined> = [];
  expectedJobIds: string[] = [];
  loadedGroupIds: Array<string | undefined> = [];
  completed: RunCompletion[] = [];
  failed: Array<{ scope: RunScope; error: string }> = [];
  startResult: StartRunResult = {
    alreadySucceeded: false,
    proposalsCount: 0,
    strategySnapshot: STRATEGY,
    strategyGoal: 'profit-maintain',
  };
  startError: Error | null = null;
  loadError: Error | null = null;
  groupSafety = {
    mayPropose: true,
    exportedRecommendations: 0,
    incompleteObservations: 0,
    holdDecisions: 0,
    revertDecisions: 0,
    reason: 'No prior exported recommendation requires observation.',
  };

  constructor(
    readonly profile: RecommendationProfile = PROFILE,
    readonly inputs: RecommendationRunInputs = fixtureInputs(),
  ) {}

  async startRun(
    scope: RunScope,
    expectedGroupId: string | undefined,
    execution: RecommendationRunExecutionContext,
  ): Promise<StartRunResult> {
    this.started.push(scope);
    this.expectedGroupIds.push(expectedGroupId);
    this.expectedJobIds.push('claim' in execution ? execution.claim.jobId : execution.jobId);
    if (this.startError !== null) throw this.startError;
    return this.startResult;
  }

  async loadProfile(): Promise<RecommendationProfile> {
    return this.profile;
  }

  async loadInputs(
    _scope: RunScope,
    _window: DateWindow,
    _execution: RecommendationRunExecutionContext,
  ): Promise<RecommendationRunInputs> {
    if (this.loadError) throw this.loadError;
    return this.inputs;
  }

  async loadGroupRecommendationSafety(
    _scope: RunScope,
    groupId: string,
  ) {
    this.loadedGroupIds.push(groupId);
    return this.groupSafety;
  }

  async succeedRun(completion: RunCompletion): Promise<number> {
    this.completed.push(completion);
    return completion.proposals.length;
  }

  async failRun(scope: RunScope, error: string) {
    this.failed.push({ scope, error });
    return { decision: 'failed' as const };
  }
}

const JOB = {
  type: 'recommendations.run' as const,
  orgId: ORG_ID,
  profileId: PROFILE_ID,
  runId: RUN_ID,
  lookbackDays: 7,
};
const EXECUTION = { jobId: '91919191-9191-4919-8919-919191919191' };

describe('recommendation window', () => {
  it('uses the last complete day in the profile timezone', () => {
    const at = new Date('2026-08-27T01:00:00Z');
    expect(recommendationWindow('America/Los_Angeles', 7, at)).toEqual({
      start: '2026-08-19',
      end: '2026-08-25',
    });
  });
});

describe('reason enum mapping', () => {
  it('is exhaustive and character-for-character with the database enum', () => {
    expect(BID_REASON_TO_DATABASE).toEqual({
      high_acos: 'high_acos',
      high_spend_no_sales: 'high_spend_no_sales',
      low_acos: 'low_acos',
      low_visibility: 'low_visibility',
    });
    expect(databaseReason('high_acos')).toBe('high_acos');
    expect(() => databaseReason('flag')).toThrow(/non-bid reason/);
  });
});

describe('recommendation scope fingerprints', () => {
  it('normalizes UUID text and sorts campaign ids by UTF-8 bytes', () => {
    const upperProfile = PROFILE_ID.toUpperCase();
    const upperGroup = GROUP_ID.toUpperCase();
    const campaigns = ['campaign-\u{10000}', 'campaign-\uE000', 'campaign-ä', 'campaign-a'];

    expect(batchScopeFingerprint(upperProfile, campaigns)).toBe(
      batchScopeFingerprint(PROFILE_ID, [...campaigns].reverse()),
    );
    expect(runScopeFingerprint(upperProfile, upperGroup, campaigns)).toBe(
      runScopeFingerprint(PROFILE_ID, GROUP_ID, [...campaigns].reverse()),
    );
  });
});

describe('recommendations runner', () => {
  it('assembles scoped facts, strategy and corridor into a persisted bid proposal', async () => {
    const store = new FakeStore();
    const result = await runRecommendations(store, JOB, EXECUTION, new Date('2026-08-27T12:00:00Z'));

    expect(result).toEqual({
      runId: RUN_ID,
      proposals: 1,
      window: { start: '2026-08-20', end: '2026-08-26' },
      alreadySucceeded: false,
    });
    expect(store.started).toEqual([{ orgId: ORG_ID, profileId: PROFILE_ID, runId: RUN_ID }]);
    expect(store.expectedJobIds).toEqual([EXECUTION.jobId]);
    const completion = store.completed[0];
    expect(completion?.strategySnapshot).toMatchObject({
      schema: STRATEGY.schema,
      opt_groups: STRATEGY.opt_groups,
    });
    expect(completion?.proposals).toHaveLength(1);
    expect(completion?.proposals[0]).toMatchObject({
      runId: RUN_ID,
      profileId: PROFILE_ID,
      reason: 'high_acos',
      field: 'bid',
      currentValue: 1,
      proposedValue: 0.55,
      status: 'proposed',
      entityRef: { entityType: 'keyword', entityId: 'kw-1', campaignId: 'c-1' },
      inputs: {
        clicks: 10,
        cvrSourceLevel: 'keyword',
        ceilingApplied: 'suggested_bid',
        capClamped: false,
        window: { start: '2026-08-20', end: '2026-08-26' },
      },
      preconditionNotes: [
        { code: 'stock_unknown' },
        { code: 'rank_unknown' },
      ],
    });
    expect(completion?.narrative.diagnostics).toMatchObject({
      targetsRead: 1,
      targetsConsidered: 1,
      proposed: 1,
      blockedOutOfStock: 0,
      preconditionNotes: 2,
      corridorsAvailable: 1,
      corridorsMissing: 0,
    });
    expect(completion?.narrative.qualitative).toHaveProperty('push');
    expect(store.failed).toEqual([]);
  });

  it('proposes without a bid corridor and records its absence in the run narrative', async () => {
    const inputs = fixtureInputs();
    const target = inputs.targets[0];
    if (!target) throw new Error('fixture target missing');
    target.corridor = null;
    const store = new FakeStore(PROFILE, inputs);

    await runRecommendations(store, JOB, EXECUTION, new Date('2026-08-27T12:00:00Z'));

    expect(store.completed[0]?.proposals).toHaveLength(1);
    expect(store.completed[0]?.proposals[0]?.inputs).toMatchObject({
      ceilingApplied: null,
      floorApplied: null,
    });
    expect(store.completed[0]?.narrative.diagnostics).toMatchObject({
      corridorsAvailable: 0,
      corridorsMissing: 1,
      proposed: 1,
    });
  });

  it('uses one immutable group context and records a legal non-mechanical bid', async () => {
    const group: ScheduledOptimizationGroup = {
      version: 2,
      id: GROUP_ID,
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      name: 'Profit evidence',
      role: 'profit',
      targetAcos: 0.3,
      bidFloor: 0.2,
      bidCeiling: 0.55,
      bidIncreaseCap: 0.25,
      bidDecreaseCap: 0.5,
      placementIncreaseCap: 0.2,
      placementDecreaseCap: 0.2,
      exclusions: [],
      reviewSchedule: { version: 2, weekdays: ['thursday'] },
      prioritization: 'efficiency_first',
      enabled: true,
    };
    const inputs = fixtureInputs();
    inputs.tenantStrategy = {
      ...STRATEGY,
      bids: { mechanical_bid_step: 0.05 },
    };
    const store = new FakeStore(PROFILE, inputs);
    store.startResult = {
      alreadySucceeded: false,
      proposalsCount: 0,
      strategySnapshot: { ...STRATEGY, bids: { mechanical_bid_step: 0.05 } },
      strategyGoal: 'profit-maintain',
      groupRun: {
        group,
        dueAt: '2026-08-27T00:00:00.000Z',
        scheduleContext: {
          version: 2,
          trigger: 'scheduled',
          profileTimezone: 'UTC',
          weekdays: ['thursday'],
          localHour: 4,
          dueAt: '2026-08-27T00:00:00.000Z',
          evaluatedAt: '2026-08-27T00:00:01.000Z',
        },
      },
    };

    await runRecommendations(
      store,
      { ...JOB, groupId: GROUP_ID },
      EXECUTION,
      new Date('2026-08-27T12:00:00Z'),
    );

    expect(store.expectedGroupIds).toEqual([GROUP_ID]);
    expect(store.loadedGroupIds).toEqual([GROUP_ID]);
    expect(store.completed[0]?.proposals[0]).toMatchObject({
      currentValue: 1,
      proposedValue: 0.54,
      inputs: {
        directionalAdjustment: {
          requestedValue: 0.55,
          constrainedValue: 0.55,
          finalValue: 0.54,
          direction: 'decrease',
          adjustmentKind: 'one_cent',
          hardBoundPreventedAdjustment: false,
        },
      },
    });
  });

  it('holds every group proposal while an exported recommendation is awaiting evidence', async () => {
    const group: ScheduledOptimizationGroup = {
      version: 2,
      id: GROUP_ID,
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      name: 'Profit evidence',
      role: 'profit',
      targetAcos: 0.3,
      bidFloor: 0.2,
      bidCeiling: 0.55,
      bidIncreaseCap: 0.25,
      bidDecreaseCap: 0.5,
      placementIncreaseCap: 0.2,
      placementDecreaseCap: 0.2,
      exclusions: [],
      reviewSchedule: { version: 2, weekdays: ['thursday'] },
      prioritization: 'efficiency_first',
      enabled: true,
    };
    const store = new FakeStore();
    store.startResult = {
      alreadySucceeded: false,
      proposalsCount: 0,
      strategySnapshot: STRATEGY,
      strategyGoal: 'profit-maintain',
      groupRun: {
        group,
        dueAt: '2026-08-27T00:00:00.000Z',
        scheduleContext: {
          version: 2,
          trigger: 'scheduled',
          profileTimezone: 'UTC',
          weekdays: ['thursday'],
          localHour: 4,
          dueAt: '2026-08-27T00:00:00.000Z',
          evaluatedAt: '2026-08-27T00:00:01.000Z',
        },
      },
    };
    store.groupSafety = {
      mayPropose: false,
      exportedRecommendations: 1,
      incompleteObservations: 1,
      holdDecisions: 0,
      revertDecisions: 0,
      reason: '1 exported recommendation is awaiting complete synchronized evidence; hold and do not compound',
    };

    const result = await runRecommendations(
      store,
      { ...JOB, groupId: GROUP_ID },
      EXECUTION,
      new Date('2026-08-27T12:00:00Z'),
    );

    expect(result.proposals).toBe(0);
    expect(store.completed[0]?.proposals).toEqual([]);
    expect(store.completed[0]?.narrative.groupSafety).toEqual(store.groupSafety);
    expect(store.completed[0]?.narrative.diagnostics).toMatchObject({ proposed: 0, suppressed: 1 });
    expect(store.completed[0]?.narrative.qualitative.notes.at(-1)).toContain('do not compound');
  });

  it('blocks an out-of-stock target before composing a bid proposal', async () => {
    const inputs = fixtureInputs();
    const target = inputs.targets[0];
    if (!target) throw new Error('fixture target missing');
    target.stock = { status: 'out_of_stock', asins: target.stock.asins, source: 'fixture' };
    const store = new FakeStore(PROFILE, inputs);

    await runRecommendations(store, JOB, EXECUTION, new Date('2026-08-27T12:00:00Z'));

    expect(store.completed[0]?.proposals).toEqual([]);
    expect(store.completed[0]?.narrative.diagnostics).toMatchObject({
      proposed: 0,
      blockedOutOfStock: 1,
    });
    expect(store.completed[0]?.narrative.diagnostics.examples).toContainEqual(
      expect.objectContaining({ outcome: 'blocked', detail: expect.stringContaining('out of stock') }),
    );
  });

  it('suppresses a cut while the keyword organic rank is improving', async () => {
    const inputs = fixtureInputs();
    const target = inputs.targets[0];
    if (!target) throw new Error('fixture target missing');
    target.stock = { status: 'in_stock', asins: target.stock.asins, source: 'fixture' };
    target.organicRank = { status: 'known', currentRank: 8, previousRank: 12, asin: 'B0TEST5101' };
    const store = new FakeStore(PROFILE, inputs);

    await runRecommendations(store, JOB, EXECUTION, new Date('2026-08-27T12:00:00Z'));

    expect(store.completed[0]?.proposals).toEqual([]);
    expect(store.completed[0]?.narrative.diagnostics).toMatchObject({ proposed: 0, suppressed: 1 });
    expect(store.completed[0]?.narrative.diagnostics.examples).toContainEqual(
      expect.objectContaining({ outcome: 'suppressed', detail: expect.stringContaining('rank is improving') }),
    );
  });

  it('marks a failed run and rethrows the original input error', async () => {
    const store = new FakeStore();
    store.loadError = new Error('fixture facts unavailable');

    await expect(runRecommendations(store, JOB, EXECUTION)).rejects.toThrow('fixture facts unavailable');
    expect(store.completed).toEqual([]);
    expect(store.failed).toEqual([
      {
        scope: { orgId: ORG_ID, profileId: PROFILE_ID, runId: RUN_ID },
        error: 'fixture facts unavailable',
      },
    ]);
  });

  it('does not poison the legitimate run when the executing job lacks custody', async () => {
    const store = new FakeStore();
    store.startError = new RecommendationExecutionCustodyError();

    await expect(runRecommendations(store, JOB, EXECUTION))
      .rejects.toBeInstanceOf(RecommendationExecutionCustodyError);
    expect(store.failed).toEqual([]);
  });

  it('fails persisted run evidence that cannot pass its integrity check', async () => {
    const store = new FakeStore();
    store.startError = new RecommendationScopeIntegrityError();

    await expect(runRecommendations(store, JOB, EXECUTION))
      .rejects.toBeInstanceOf(RecommendationScopeIntegrityError);
    expect(store.failed).toEqual([{
      scope: { orgId: ORG_ID, profileId: PROFILE_ID, runId: RUN_ID },
      error: 'Recommendation preview evidence failed its integrity check.',
    }]);
  });

  it('succeeds with zero proposals when the profile has no facts', async () => {
    const store = new FakeStore(PROFILE, {
      tenantStrategy: STRATEGY,
      profileStrategy: null,
      targets: [],
      campaigns: [],
      profileFacts: [],
    });

    const result = await runRecommendations(store, JOB, EXECUTION, new Date('2026-08-27T12:00:00Z'));
    expect(result.proposals).toBe(0);
    expect(store.completed[0]?.proposals).toEqual([]);
    expect(store.completed[0]?.narrative.qualitative.notes).toContain(
      'No AdLabs campaign/target-level rows supplied this week -- Push/Pause-Optimize lists are empty by construction, not a clean bill of health.',
    );
    expect(store.failed).toEqual([]);
  });

  it('returns a previously succeeded run without loading or writing again', async () => {
    const store = new FakeStore();
    store.startResult = {
      alreadySucceeded: true,
      proposalsCount: 4,
      strategySnapshot: STRATEGY,
      strategyGoal: 'profit-maintain',
    };
    const result = await runRecommendations(store, JOB, EXECUTION);
    expect(result).toEqual({
      runId: RUN_ID,
      proposals: 4,
      window: null,
      alreadySucceeded: true,
    });
    expect(store.completed).toEqual([]);
    expect(store.failed).toEqual([]);
  });
});

describe('fenced recommendation run store', () => {
  const claim: ClaimRef = {
    jobId: EXECUTION.jobId,
    workerId: 'recommendation-store-fixture',
    token: '92929292-9292-4929-8929-929292929292' as ClaimToken,
  };
  const scope = { orgId: ORG_ID, profileId: PROFILE_ID, runId: RUN_ID };

  class FakeFencedDatabase {
    calls: Array<{ operation: string; claim: ClaimRef; scope?: unknown }> = [];

    async start(received: ClaimRef, receivedScope: unknown) {
      this.calls.push({ operation: 'start', claim: received, scope: receivedScope });
      return {
        decision: 'started' as const,
        runData: {
          proposalsCount: 0,
          lookbackDays: 7,
          groupId: null,
          groupRole: null,
          groupSnapshot: null,
          dueAt: null,
          scheduleContext: null,
          strategySnapshot: STRATEGY,
          strategyGoal: 'profit-maintain',
        },
        profileData: {
          orgId: ORG_ID,
          profileId: PROFILE_ID,
          timezone: 'UTC',
          goal: 'profit-maintain',
          monthlyBudget: null,
        },
      };
    }

    async readInputs(received: ClaimRef, receivedScope: unknown) {
      this.calls.push({ operation: 'read', claim: received, scope: receivedScope });
      return {
        inputs: { targets: [], campaigns: [], profileFacts: [] },
        groupSafety: null,
      };
    }

    async succeed(received: ClaimRef, receivedScope: unknown) {
      this.calls.push({ operation: 'succeed', claim: received, scope: receivedScope });
      return { decision: 'succeeded' as const, proposalsCount: 0 };
    }

    async fail(received: ClaimRef, receivedScope: unknown): Promise<{
      decision: 'failed' | 'already_succeeded';
      proposalsCount: number;
    }> {
      this.calls.push({ operation: 'fail', claim: received, scope: receivedScope });
      return { decision: 'failed' as const, proposalsCount: 0 };
    }
  }

  it('presents the exact immutable claim on every start, read, and success RPC', async () => {
    const database = new FakeFencedDatabase();
    const store = new FencedRecommendationRunStore(
      database as unknown as RecommendationWorkerDatabase,
    );
    const execution = { claim } as const;
    await expect(store.startRun(scope, undefined, execution)).resolves.toMatchObject({
      alreadySucceeded: false,
      proposalsCount: 0,
      strategyGoal: 'profit-maintain',
    });
    await expect(store.loadProfile(scope, execution)).resolves.toEqual(PROFILE);
    await expect(store.loadInputs(
      scope,
      { start: '2026-08-20', end: '2026-08-26' },
      execution,
    )).resolves.toEqual({
      tenantStrategy: null,
      profileStrategy: null,
      targets: [],
      campaigns: [],
      profileFacts: [],
    });
    const completion: RunCompletion = {
      ...scope,
      lookbackDays: 7,
      window: { start: '2026-08-20', end: '2026-08-26' },
      strategySnapshot: STRATEGY,
      proposals: [],
      narrative: {} as RunCompletion['narrative'],
    };
    await expect(store.succeedRun(completion, execution)).resolves.toBe(0);
    expect(database.calls.map((call) => call.operation)).toEqual(['start', 'read', 'succeed']);
    expect(database.calls.every((call) => call.claim === claim)).toBe(true);
    expect(database.calls.map((call) => call.scope)).toEqual([
      { ...scope, groupId: undefined },
      { ...scope, groupId: undefined },
      { ...scope, groupId: undefined },
    ]);
    await expect(store.loadProfile(scope, execution))
      .rejects.toBeInstanceOf(RecommendationExecutionCustodyError);
  });

  it('rejects a substituted claim locally and maps database custody refusal', async () => {
    const database = new FakeFencedDatabase();
    const store = new FencedRecommendationRunStore(
      database as unknown as RecommendationWorkerDatabase,
    );
    const execution = { claim } as const;
    await store.startRun(scope, undefined, execution);
    await expect(store.loadProfile(scope, {
      claim: {
        ...claim,
        token: '93939393-9393-4939-8939-939393939393' as ClaimToken,
      },
    })).rejects.toBeInstanceOf(RecommendationExecutionCustodyError);

    database.fail = async () => {
      throw Object.assign(new Error('database detail must not define classification'), { code: '55000' });
    };
    await expect(store.failRun(scope, 'synthetic failure', execution))
      .rejects.toBeInstanceOf(RecommendationExecutionCustodyError);
  });

  it('settles success when the success commit response is lost but exact-claim readback closes', async () => {
    const database = new FakeFencedDatabase();
    database.succeed = async (received: ClaimRef, receivedScope: unknown) => {
      database.calls.push({ operation: 'succeed', claim: received, scope: receivedScope });
      throw new Error('synthetic response loss after commit');
    };
    database.fail = async (received: ClaimRef, receivedScope: unknown) => {
      database.calls.push({ operation: 'fail', claim: received, scope: receivedScope });
      return { decision: 'already_succeeded' as const, proposalsCount: 0 };
    };
    const store = new FencedRecommendationRunStore(
      database as unknown as RecommendationWorkerDatabase,
    );
    const job: ClaimedJob = {
      id: claim.jobId,
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      jobType: 'recommendations.run',
      payload: JOB,
      attempts: 5,
      maxAttempts: 5,
      dedupeKey: null,
      claimedBy: claim.workerId,
      claim,
    };
    const settlements: Array<{ outcome: string; result: unknown }> = [];
    let claimed = false;
    const queue: RecommendationQueuePort = {
      async resumeOwned() { return []; },
      async claim() {
        if (claimed) return [];
        claimed = true;
        return [job];
      },
      async finish(_claim, outcome, options) {
        settlements.push({ outcome, result: options?.result });
        return { decision: 'settled' };
      },
      async defer() { return { decision: 'settled' }; },
    };
    const claimant = new RecommendationClaimant({
      identity: { workerId: claim.workerId, revision: 'a'.repeat(40) },
      queue,
      execute: (payload, execution) => runRecommendations(
        store,
        payload,
        execution,
        new Date('2026-08-27T12:00:00Z'),
      ),
      pollIntervalMs: 10,
      shutdownDrainMs: 10,
    });

    await expect(claimant.drainOnce()).resolves.toBe(1);
    expect(database.calls.map((call) => call.operation)).toEqual([
      'start', 'read', 'succeed', 'fail',
    ]);
    expect(settlements).toEqual([{
      outcome: 'succeeded',
      result: {
        runId: RUN_ID,
        proposals: 0,
        window: { start: '2026-08-20', end: '2026-08-26' },
        alreadySucceeded: true,
      },
    }]);
  });

  it('fails the run before a final-attempt dead letter when the start response is lost', async () => {
    const database = new FakeFencedDatabase();
    database.start = async (received: ClaimRef, receivedScope: unknown) => {
      database.calls.push({ operation: 'start', claim: received, scope: receivedScope });
      throw new Error('synthetic start response loss after commit');
    };
    const store = new FencedRecommendationRunStore(
      database as unknown as RecommendationWorkerDatabase,
    );
    const job: ClaimedJob = {
      id: claim.jobId,
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      jobType: 'recommendations.run',
      payload: JOB,
      attempts: 5,
      maxAttempts: 5,
      dedupeKey: null,
      claimedBy: claim.workerId,
      claim,
    };
    const settlements: Array<{ outcome: string; error: string | undefined }> = [];
    let claimed = false;
    const queue: RecommendationQueuePort = {
      async resumeOwned() { return []; },
      async claim() {
        if (claimed) return [];
        claimed = true;
        return [job];
      },
      async finish(_claim, outcome, options) {
        settlements.push({ outcome, error: options?.error });
        return { decision: 'settled' };
      },
      async defer() { return { decision: 'settled' }; },
    };
    const claimant = new RecommendationClaimant({
      identity: { workerId: claim.workerId, revision: 'a'.repeat(40) },
      queue,
      execute: (payload, execution) => runRecommendations(store, payload, execution),
      pollIntervalMs: 10,
      shutdownDrainMs: 10,
    });

    await expect(claimant.drainOnce()).resolves.toBe(1);
    expect(database.calls.map((call) => call.operation)).toEqual(['start', 'fail']);
    expect(settlements).toEqual([{
      outcome: 'dead', error: 'recommendation retry budget exhausted',
    }]);
  });

  it.each(['start', 'success'] as const)(
    'retains final-attempt custody when %s response loss cannot be reconciled',
    async (stage) => {
      const database = new FakeFencedDatabase();
      if (stage === 'start') {
        database.start = async (received: ClaimRef, receivedScope: unknown) => {
          database.calls.push({ operation: 'start', claim: received, scope: receivedScope });
          throw new Error('synthetic start response loss');
        };
      } else {
        database.succeed = async (received: ClaimRef, receivedScope: unknown) => {
          database.calls.push({ operation: 'succeed', claim: received, scope: receivedScope });
          throw new Error('synthetic success response loss');
        };
      }
      database.fail = async (received: ClaimRef, receivedScope: unknown) => {
        database.calls.push({ operation: 'fail', claim: received, scope: receivedScope });
        throw new Error('synthetic failure readback loss');
      };
      const store = new FencedRecommendationRunStore(
        database as unknown as RecommendationWorkerDatabase,
      );
      const job: ClaimedJob = {
        id: claim.jobId,
        orgId: ORG_ID,
        profileId: PROFILE_ID,
        jobType: 'recommendations.run',
        payload: JOB,
        attempts: 5,
        maxAttempts: 5,
        dedupeKey: null,
        claimedBy: claim.workerId,
        claim,
      };
      const settlements: string[] = [];
      let claimed = false;
      const queue: RecommendationQueuePort = {
        async resumeOwned() { return []; },
        async claim() {
          if (claimed) return [];
          claimed = true;
          return [job];
        },
        async finish(_claim, outcome) {
          settlements.push(outcome);
          return { decision: 'settled' };
        },
        async defer() { return { decision: 'settled' }; },
      };
      const claimant = new RecommendationClaimant({
        identity: { workerId: claim.workerId, revision: 'a'.repeat(40) },
        queue,
        execute: (payload, execution) => runRecommendations(store, payload, execution),
        pollIntervalMs: 10,
        shutdownDrainMs: 10,
      });

      const failure = await claimant.drainOnce().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(RecommendationClaimantCustodyError);
      expect(failure).toMatchObject({ kind: 'settlement_ambiguous' });
      expect(settlements).toEqual([]);
      expect(claimant.status()).toMatchObject({
        phase: 'failed', inFlight: 0, settlementFailure: 'settlement_ambiguous',
      });
      await expect(claimant.shutdown()).resolves.toEqual({ released: 0, unresolved: 1 });
    },
  );
});
