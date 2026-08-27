/**
 * Runner orchestration tests. The bid engine's arithmetic belongs to
 * packages/core; these cases assert assembly, lifecycle, mapping and writes.
 */
import { describe, expect, it } from 'vitest';
import type { TenantStrategy } from '@wizard-ads/shared';
import {
  BID_REASON_TO_DATABASE,
  databaseReason,
  recommendationWindow,
  runRecommendations,
  type DateWindow,
  type RecommendationProfile,
  type RecommendationRunInputs,
  type RecommendationRunStore,
  type RunCompletion,
  type RunScope,
  type StartRunResult,
} from './recommendations-run.js';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const PROFILE_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';

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
  completed: RunCompletion[] = [];
  failed: Array<{ scope: RunScope; error: string }> = [];
  startResult: StartRunResult = { alreadySucceeded: false, proposalsCount: 0 };
  loadError: Error | null = null;

  constructor(
    readonly profile: RecommendationProfile = PROFILE,
    readonly inputs: RecommendationRunInputs = fixtureInputs(),
  ) {}

  async startRun(scope: RunScope): Promise<StartRunResult> {
    this.started.push(scope);
    return this.startResult;
  }

  async loadProfile(): Promise<RecommendationProfile> {
    return this.profile;
  }

  async loadInputs(_scope: RunScope, _window: DateWindow): Promise<RecommendationRunInputs> {
    if (this.loadError) throw this.loadError;
    return this.inputs;
  }

  async succeedRun(completion: RunCompletion): Promise<number> {
    this.completed.push(completion);
    return completion.proposals.length;
  }

  async failRun(scope: RunScope, error: string): Promise<void> {
    this.failed.push({ scope, error });
  }
}

const JOB = {
  type: 'recommendations.run' as const,
  orgId: ORG_ID,
  profileId: PROFILE_ID,
  runId: RUN_ID,
  lookbackDays: 7,
};

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

describe('recommendations runner', () => {
  it('assembles scoped facts, strategy and corridor into a persisted bid proposal', async () => {
    const store = new FakeStore();
    const result = await runRecommendations(store, JOB, new Date('2026-08-27T12:00:00Z'));

    expect(result).toEqual({
      runId: RUN_ID,
      proposals: 1,
      window: { start: '2026-08-20', end: '2026-08-26' },
      alreadySucceeded: false,
    });
    expect(store.started).toEqual([{ orgId: ORG_ID, profileId: PROFILE_ID, runId: RUN_ID }]);
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
    });
    expect(completion?.narrative.diagnostics).toMatchObject({
      targetsRead: 1,
      targetsConsidered: 1,
      proposed: 1,
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

    await runRecommendations(store, JOB, new Date('2026-08-27T12:00:00Z'));

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

  it('marks a failed run and rethrows the original input error', async () => {
    const store = new FakeStore();
    store.loadError = new Error('fixture facts unavailable');

    await expect(runRecommendations(store, JOB)).rejects.toThrow('fixture facts unavailable');
    expect(store.completed).toEqual([]);
    expect(store.failed).toEqual([
      {
        scope: { orgId: ORG_ID, profileId: PROFILE_ID, runId: RUN_ID },
        error: 'fixture facts unavailable',
      },
    ]);
  });

  it('succeeds with zero proposals when the profile has no facts', async () => {
    const store = new FakeStore(PROFILE, {
      tenantStrategy: STRATEGY,
      profileStrategy: null,
      targets: [],
      campaigns: [],
      profileFacts: [],
    });

    const result = await runRecommendations(store, JOB, new Date('2026-08-27T12:00:00Z'));
    expect(result.proposals).toBe(0);
    expect(store.completed[0]?.proposals).toEqual([]);
    expect(store.completed[0]?.narrative.qualitative.notes).toContain(
      'No AdLabs campaign/target-level rows supplied this week -- Push/Pause-Optimize lists are empty by construction, not a clean bill of health.',
    );
    expect(store.failed).toEqual([]);
  });

  it('returns a previously succeeded run without loading or writing again', async () => {
    const store = new FakeStore();
    store.startResult = { alreadySucceeded: true, proposalsCount: 4 };
    const result = await runRecommendations(store, JOB);
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
