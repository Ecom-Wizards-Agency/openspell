/**
 * White Box bidding tests.
 *
 * Two halves. The first reproduces every worked example the public AdLabs
 * articles publish, number for number, so a change to the engine that quietly
 * stops agreeing with the published method fails here. The second is property
 * tests over pseudo-random inputs for the three invariants that must hold for
 * every input, not only the interesting ones: a cap always clamps, a ceiling is
 * never exceeded unless a cap held the value back, and a Sponsored Display bid
 * never passes half the daily budget.
 */
import { describe, expect, it } from 'vitest';
import type { EntityRef } from '@wizard-ads/shared';

import { proposeBid, type BidOutcome } from './bid.js';
import {
  applyCeilings,
  applyChangeCap,
  applyFloors,
  budgetShareCeilingFor,
  ceilingCandidates,
  floorCandidates,
  roundBid,
} from './ceilings.js';
import { resolveConfidence } from './confidence.js';
import { breakEvenAcos, targetCpa } from './economics.js';
import { maxPotentialCpc, proposePlacementAdjustment } from './placement.js';
import type { BidRequest, ChangeCaps, ConfidenceLevels } from './types.js';
import { CATEGORY_PROFIT, CATEGORY_RANK } from '../types.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const PROFILE_ID = '22222222-2222-4222-8222-222222222222';

const ENTITY: EntityRef = {
  profileId: PROFILE_ID,
  entityType: 'keyword',
  entityId: 'kw-1',
  adProduct: 'SP',
  campaignId: 'c-1',
  adGroupId: 'ag-1',
  name: 'synthetic keyword',
};

const WINDOW = { start: '2026-06-01', end: '2026-06-30' };

const WIDE_CAPS: ChangeCaps = {
  maxIncrease: 1.0,
  maxDecrease: 1.0,
  maxPlacementIncrease: null,
  maxPlacementDecrease: null,
};

function request(overrides: Partial<BidRequest> & Pick<BidRequest, 'metrics' | 'levels' | 'targetAcos'>): BidRequest {
  return {
    runId: RUN_ID,
    profileId: PROFILE_ID,
    entityRef: ENTITY,
    adProduct: 'SP',
    window: WINDOW,
    currentBid: null,
    caps: WIDE_CAPS,
    ...overrides,
  };
}

function proposal(outcome: BidOutcome) {
  expect(outcome.kind).toBe('proposal');
  if (outcome.kind !== 'proposal') throw new Error('not a proposal');
  return outcome.recommendation;
}

describe('worked examples: the RPC formula', () => {
  it('article 001: RPC $5 at a 30% target gives a $1.50 bid', () => {
    // 100 clicks, $500 sales -> RPC $5. $200 spend -> 40% ACOS, over target.
    const outcome = proposeBid(
      request({
        currentBid: 2.0,
        metrics: { clicks: 100, orders: 20, sales: 500, cost: 200 },
        levels: { profile: { clicks: 1000, orders: 100, sales: 4000 } },
        targetAcos: 0.3,
      }),
    );
    const rec = proposal(outcome);
    expect(rec.reason).toBe('high_acos');
    expect(rec.proposedValue).toBe(1.5);
    expect(rec.inputs.rpc).toBe(5);
    expect(rec.inputs.capClamped).toBe(false);
  });

  it('article 003: CPC $2, RPC $10, 20% ACOS, 10% target gives a $1.00 bid', () => {
    const outcome = proposeBid(
      request({
        currentBid: 2.0,
        metrics: { clicks: 100, orders: 20, sales: 1000, cost: 200 },
        levels: { profile: { clicks: 1000, orders: 200, sales: 9000 } },
        targetAcos: 0.1,
      }),
    );
    expect(proposal(outcome).proposedValue).toBe(1.0);
  });

  it('article 004: $100 sales over 10 clicks at a 30% target ceilings at $3.00', () => {
    const confidence = resolveConfidence({ profile: { clicks: 10, orders: 1, sales: 100 } });
    const candidates = ceilingCandidates({
      targetAcos: 0.3,
      entityRpc: 10,
      confidence,
      adProduct: 'SP',
    });
    const maxAffordable = candidates.find((c) => c.name === 'max_affordable_cpc');
    expect(maxAffordable?.value).toBeCloseTo(3.0, 10);
  });
});

describe('worked examples: non-converting keywords', () => {
  it('article 001 simple model: $20 AOV over 10 clicks at 30% gives $0.60', () => {
    const outcome = proposeBid(
      request({
        currentBid: 1.0,
        // Spend $7 is past the $6 target CPA (30% x $20 AOV).
        metrics: { clicks: 10, orders: 0, sales: 0, cost: 7 },
        levels: { campaign: { clicks: 100, orders: 10, sales: 200 }, profile: { clicks: 500, orders: 40, sales: 800 } },
        targetAcos: 0.3,
        settings: { nonConvertingModel: 'simple' },
      }),
    );
    const rec = proposal(outcome);
    expect(rec.reason).toBe('high_spend_no_sales');
    expect(rec.proposedValue).toBe(0.6);
    expect(rec.inputs.cvrSourceLevel).toBe('campaign');
  });

  it('article 004 projected model: $30 AOV, 10 clicks-to-conversion, 15 clicks gives $0.36', () => {
    const outcome = proposeBid(
      request({
        currentBid: 1.0,
        metrics: { clicks: 15, orders: 0, sales: 0, cost: 10 },
        levels: { campaign: { clicks: 100, orders: 10, sales: 300 }, profile: { clicks: 900, orders: 80, sales: 2400 } },
        targetAcos: 0.3,
      }),
    );
    expect(proposal(outcome).proposedValue).toBe(0.36);
  });

  it('the same keyword steps itself down to $0.30 after five more empty clicks', () => {
    const outcome = proposeBid(
      request({
        currentBid: 1.0,
        metrics: { clicks: 20, orders: 0, sales: 0, cost: 12 },
        levels: { campaign: { clicks: 100, orders: 10, sales: 300 }, profile: { clicks: 900, orders: 80, sales: 2400 } },
        targetAcos: 0.3,
      }),
    );
    expect(proposal(outcome).proposedValue).toBe(0.3);
  });

  it('below the target CPA threshold there is no non-converting proposal', () => {
    const outcome = proposeBid(
      request({
        currentBid: 1.0,
        // $5 spend is under the $9 target CPA, and 30 clicks is past the
        // low-visibility threshold, so nothing should fire at all.
        metrics: { clicks: 30, orders: 0, sales: 0, cost: 5 },
        levels: { campaign: { clicks: 100, orders: 10, sales: 300 }, profile: { clicks: 900, orders: 80, sales: 2400 } },
        targetAcos: 0.3,
      }),
    );
    expect(outcome.kind).toBe('none');
  });

  it('target CPA is AOV x target ACOS', () => {
    expect(targetCpa(0.3, 30)).toBeCloseTo(9, 10);
    expect(targetCpa(0.3, 20)).toBeCloseTo(6, 10);
  });
});

describe('worked examples: increases', () => {
  const lowAcosLevels: ConfidenceLevels = {
    keyword: { clicks: 100, orders: 20, sales: 1000 },
    profile: { clicks: 1000, orders: 100, sales: 8000 },
  };

  it('article 001: a keyword at 20% ACOS against a 30% target steps up 10%', () => {
    const outcome = proposeBid(
      request({
        currentBid: 1.0,
        metrics: { clicks: 100, orders: 20, sales: 1000, cost: 200 },
        levels: lowAcosLevels,
        targetAcos: 0.3,
      }),
    );
    const rec = proposal(outcome);
    expect(rec.reason).toBe('low_acos');
    expect(rec.proposedValue).toBe(1.1);
  });

  it('a keyword at 29% against a 30% target is inside the buffer and is left alone', () => {
    const outcome = proposeBid(
      request({
        currentBid: 1.0,
        metrics: { clicks: 100, orders: 20, sales: 1000, cost: 290 },
        levels: lowAcosLevels,
        targetAcos: 0.3,
      }),
    );
    expect(outcome.kind).toBe('none');
    if (outcome.kind === 'none') expect(outcome.reason).toBe('on_target');
  });

  it('article 001: fewer than 9 clicks against a 10-click conversion norm steps up 5%', () => {
    const outcome = proposeBid(
      request({
        currentBid: 0.4,
        metrics: { clicks: 5, orders: 1, sales: 50, cost: 15 },
        levels: {
          keyword: { clicks: 5, orders: 1, sales: 50 },
          campaign: { clicks: 200, orders: 20, sales: 4000 },
          profile: { clicks: 900, orders: 80, sales: 16000 },
        },
        targetAcos: 0.3,
        // Two orders before a level counts, so the campaign supplies the norm.
        settings: { minOrdersForConfidence: 2 },
      }),
    );
    const rec = proposal(outcome);
    expect(rec.reason).toBe('low_visibility');
    expect(rec.proposedValue).toBe(0.42);
    expect(rec.inputs.cvrSourceLevel).toBe('campaign');
  });

  it('at the 9-click threshold itself the low-visibility rule does not fire', () => {
    const outcome = proposeBid(
      request({
        currentBid: 0.4,
        metrics: { clicks: 9, orders: 1, sales: 90, cost: 27 },
        levels: {
          keyword: { clicks: 9, orders: 1, sales: 90 },
          campaign: { clicks: 200, orders: 20, sales: 4000 },
          profile: { clicks: 900, orders: 80, sales: 16000 },
        },
        targetAcos: 0.3,
        settings: { minOrdersForConfidence: 2 },
      }),
    );
    expect(outcome.kind).toBe('none');
  });

  it('low ACOS trumps low visibility when a keyword is both', () => {
    const outcome = proposeBid(
      request({
        currentBid: 0.4,
        // One click, one sale: low ACOS and far under the click norm.
        metrics: { clicks: 1, orders: 1, sales: 20, cost: 0.2 },
        levels: {
          keyword: { clicks: 1, orders: 1, sales: 20 },
          campaign: { clicks: 200, orders: 20, sales: 4000 },
          profile: { clicks: 900, orders: 80, sales: 16000 },
        },
        targetAcos: 0.3,
        settings: { minOrdersForConfidence: 2 },
      }),
    );
    expect(proposal(outcome).reason).toBe('low_acos');
  });
});

describe('worked examples: placements and economics', () => {
  const placementBase = {
    runId: RUN_ID,
    profileId: PROFILE_ID,
    entityRef: { ...ENTITY, entityType: 'campaign' as const, entityId: 'c-1' },
    window: { start: '2026-05-01', end: '2026-06-30', days: 60 },
    caps: { maxPlacementIncrease: null, maxPlacementDecrease: null },
  };

  it('article 002: a 30% target against a 45% top-of-search ACOS is -33%', () => {
    const outcome = proposePlacementAdjustment({
      ...placementBase,
      placement: 'top_of_search',
      currentModifierPct: 100,
      clicks: 500,
      cost: 450,
      sales: 1000,
      targetAcos: 0.3,
    });
    expect(outcome.kind).toBe('proposal');
    if (outcome.kind !== 'proposal') return;
    expect(outcome.adjustment).toBeCloseTo(-0.3333333333, 8);
    // The multiplier moves 2.0 -> 1.3333, i.e. a 100% modifier becomes 33.33%.
    expect(outcome.recommendation.proposedValue).toBeCloseTo(33.33, 2);
    expect(outcome.recommendation.reason).toBe('high_acos');
  });

  it('article 002: a 30% target against a 20% product-pages ACOS is +50%', () => {
    const outcome = proposePlacementAdjustment({
      ...placementBase,
      placement: 'product_pages',
      currentModifierPct: 0,
      clicks: 300,
      cost: 200,
      sales: 1000,
      targetAcos: 0.3,
    });
    expect(outcome.kind).toBe('proposal');
    if (outcome.kind !== 'proposal') return;
    expect(outcome.adjustment).toBeCloseTo(0.5, 10);
    expect(outcome.recommendation.proposedValue).toBeCloseTo(50, 6);
    expect(outcome.recommendation.reason).toBe('low_acos');
  });

  it('a window under 30 days produces no placement proposal at all', () => {
    const outcome = proposePlacementAdjustment({
      ...placementBase,
      window: { start: '2026-06-15', end: '2026-06-28', days: 14 },
      placement: 'top_of_search',
      currentModifierPct: 100,
      clicks: 500,
      cost: 450,
      sales: 1000,
      targetAcos: 0.3,
    });
    expect(outcome).toEqual({ kind: 'none', reason: 'window_too_short' });
  });

  it('a placement increase is capped at +33% of the current multiplier', () => {
    const outcome = proposePlacementAdjustment({
      ...placementBase,
      caps: { maxPlacementIncrease: 0.33, maxPlacementDecrease: null },
      placement: 'product_pages',
      currentModifierPct: 0,
      clicks: 300,
      cost: 200,
      sales: 1000,
      targetAcos: 0.3,
    });
    expect(outcome.kind).toBe('proposal');
    if (outcome.kind !== 'proposal') return;
    expect(outcome.recommendation.proposedValue).toBeCloseTo(33, 6);
    expect(outcome.recommendation.inputs.capClamped).toBe(true);
  });

  it('article 003: break-even ACOS on a $50 / $20 / $10 unit is 40%', () => {
    expect(breakEvenAcos({ salePrice: 50, costOfGoods: 20, amazonFees: 10 })).toBeCloseTo(0.4, 10);
  });
});

describe('ceilings, caps and provenance', () => {
  it('a Sponsored Display bid is ceilinged at half the daily budget', () => {
    expect(budgetShareCeilingFor('SD')).toBe(0.5);
    expect(budgetShareCeilingFor('SP')).toBe(1.0);

    const outcome = proposeBid(
      request({
        adProduct: 'SD',
        currentBid: 20.0,
        // RPC $40 at a 30% target wants $12; the $10 budget allows $5.
        metrics: { clicks: 10, orders: 5, sales: 400, cost: 200 },
        levels: { profile: { clicks: 100, orders: 40, sales: 4000 } },
        targetAcos: 0.3,
        ceilings: { dailyBudget: 10 },
      }),
    );
    const rec = proposal(outcome);
    expect(rec.proposedValue).toBe(5);
    expect(rec.inputs.ceilingApplied).toBe('budget');
  });

  it('a manual maximum bid wins when it is the lowest ceiling', () => {
    const outcome = proposeBid(
      request({
        currentBid: 3.0,
        metrics: { clicks: 100, orders: 20, sales: 1000, cost: 500 },
        levels: { profile: { clicks: 500, orders: 80, sales: 5000 } },
        targetAcos: 0.3,
        ceilings: { manualMaxBid: 1.25, dailyBudget: 50 },
      }),
    );
    const rec = proposal(outcome);
    expect(rec.proposedValue).toBe(1.25);
    expect(rec.inputs.ceilingApplied).toBe('manual_max_bid');
  });

  it('a change cap clamps the step and says so, without becoming the target', () => {
    const outcome = proposeBid(
      request({
        currentBid: 4.0,
        // The formula wants $0.30; a 25% maximum decrease allows only $3.00.
        metrics: { clicks: 100, orders: 5, sales: 100, cost: 400 },
        levels: { profile: { clicks: 500, orders: 40, sales: 2000 } },
        targetAcos: 0.3,
        caps: { maxIncrease: 0.25, maxDecrease: 0.25 },
      }),
    );
    const rec = proposal(outcome);
    expect(rec.proposedValue).toBe(3.0);
    expect(rec.inputs.capClamped).toBe(true);
    // Still above its ceiling: the cap governs the step, not the destination.
    expect(rec.inputs.ceilingApplied).toBeNull();
  });

  it('every proposal carries the level that supplied the benchmark', () => {
    const outcome = proposeBid(
      request({
        currentBid: 1.0,
        metrics: { clicks: 40, orders: 0, sales: 0, cost: 20 },
        levels: {
          adGroup: { clicks: 300, orders: 30, sales: 900 },
          campaign: { clicks: 1000, orders: 90, sales: 2700 },
          profile: { clicks: 5000, orders: 400, sales: 12000 },
        },
        targetAcos: 0.3,
      }),
    );
    const rec = proposal(outcome);
    expect(rec.inputs.cvrSourceLevel).toBe('ad_group');
    expect(rec.inputs.clicks).toBe(40);
    expect(rec.inputs.window).toEqual(WINDOW);
    expect(rec.runId).toBe(RUN_ID);
    expect(rec.field).toBe('bid');
    expect(rec.status).toBe('proposed');
  });

  it('the confidence hierarchy falls through to the profile and says which level it used', () => {
    const levels: ConfidenceLevels = {
      keyword: { clicks: 3, orders: 0, sales: 0 },
      adGroup: { clicks: 20, orders: 0, sales: 0 },
      campaign: { clicks: 40, orders: 0, sales: 0 },
      profile: { clicks: 4000, orders: 200, sales: 6000 },
    };
    expect(resolveConfidence(levels).level).toBe('profile');
    expect(resolveConfidence({ ...levels, campaign: { clicks: 40, orders: 4, sales: 120 } }).level).toBe('campaign');
    expect(resolveConfidence({ ...levels, keyword: { clicks: 3, orders: 1, sales: 30 } }).level).toBe('keyword');
  });
});

describe('suggested-bid ceiling', () => {
  it('a supplied Amazon suggested bid becomes a suggested_bid candidate', () => {
    const confidence = resolveConfidence({ profile: { clicks: 1000, orders: 100, sales: 4000 } });
    const candidates = ceilingCandidates({
      targetAcos: 0.3,
      entityRpc: 10,
      confidence,
      adProduct: 'SP',
      config: { suggestedBid: 1.75 },
    });
    expect(candidates.find((c) => c.name === 'suggested_bid')?.value).toBe(1.75);
  });

  it('no suggested bid means no suggested_bid candidate — today\'s behaviour', () => {
    const confidence = resolveConfidence({ profile: { clicks: 1000, orders: 100, sales: 4000 } });
    const candidates = ceilingCandidates({ targetAcos: 0.3, entityRpc: 10, confidence, adProduct: 'SP' });
    expect(candidates.some((c) => c.name === 'suggested_bid')).toBe(false);
  });

  it('the engine produces ceilingApplied "suggested_bid" when it is the lowest ceiling', () => {
    const outcome = proposeBid(
      request({
        currentBid: 3.0,
        // RPC $5 at 30% wants $1.50; a $1.00 suggested bid is lower and binds.
        metrics: { clicks: 100, orders: 20, sales: 500, cost: 200 },
        levels: { profile: { clicks: 1000, orders: 100, sales: 4000 } },
        targetAcos: 0.3,
        ceilings: { suggestedBid: 1.0 },
      }),
    );
    const rec = proposal(outcome);
    expect(rec.reason).toBe('high_acos');
    expect(rec.proposedValue).toBe(1.0);
    expect(rec.inputs.ceilingApplied).toBe('suggested_bid');
  });
});

describe('symmetric floor', () => {
  it('applyFloors lifts to the highest floor and names it', () => {
    const out = applyFloors(0.15, [
      { name: 'amazon_min_bid', value: 0.02 },
      { name: 'suggested_bid_low', value: 0.2 },
      { name: 'manual_min_bid', value: 0.25 },
    ]);
    expect(out.value).toBe(0.25);
    expect(out.floorApplied).toBe('manual_min_bid');
  });

  it('applyFloors leaves a value above every floor untouched', () => {
    const out = applyFloors(0.9, [
      { name: 'amazon_min_bid', value: 0.02 },
      { name: 'manual_min_bid', value: 0.25 },
    ]);
    expect(out.floorApplied).toBeNull();
    expect(out.value).toBe(0.9);
  });

  it('a dynamic floor share applies to the affordable CPC, over the same hierarchy', () => {
    const confidence = resolveConfidence({ profile: { clicks: 1000, orders: 100, sales: 4000 } });
    const floors = floorCandidates({
      minBid: 0.02,
      targetAcos: 0.3,
      entityRpc: 10, // affordable CPC = 10 x 0.3 = 3.0
      confidence,
      config: { dynamicFloorShare: 0.2, suggestedBidLow: 0.4 },
    });
    expect(floors.find((f) => f.name === 'amazon_min_bid')?.value).toBe(0.02);
    expect(floors.find((f) => f.name === 'suggested_bid_low')?.value).toBe(0.4);
    expect(floors.find((f) => f.name === 'data_based_floor')?.value).toBeCloseTo(0.6, 10);
  });

  it('a manual floor lifts the proposal and reports floorApplied', () => {
    const outcome = proposeBid(
      request({
        currentBid: 2.0,
        // RPC $1 at 30% wants $0.30; a $0.50 manual floor lifts it.
        metrics: { clicks: 100, orders: 20, sales: 100, cost: 200 },
        levels: { profile: { clicks: 1000, orders: 100, sales: 1000 } },
        targetAcos: 0.3,
        floors: { manualMinBid: 0.5 },
      }),
    );
    const rec = proposal(outcome);
    expect(rec.reason).toBe('high_acos');
    expect(rec.proposedValue).toBe(0.5);
    expect(rec.inputs.floorApplied).toBe('manual_min_bid');
    // The floor lifting the bid is not a ceiling binding it.
    expect(rec.inputs.ceilingApplied).toBeNull();
  });

  it('a proposal that clears every floor reports floorApplied null', () => {
    const outcome = proposeBid(
      request({
        currentBid: 2.0,
        metrics: { clicks: 100, orders: 20, sales: 500, cost: 200 },
        levels: { profile: { clicks: 1000, orders: 100, sales: 4000 } },
        targetAcos: 0.3,
      }),
    );
    const rec = proposal(outcome);
    expect(rec.proposedValue).toBe(1.5);
    expect(rec.inputs.floorApplied).toBeNull();
  });
});

describe('worked examples: max potential CPC', () => {
  it('composes base bid x binding placement x stacked modifiers', () => {
    const result = maxPotentialCpc({
      baseBid: 1.0,
      placementModifiers: [
        { name: 'top_of_search', pct: 50 },
        { name: 'product_pages', pct: 20 },
      ],
      otherModifiers: [
        { name: 'dayparting', pct: 10 },
        { name: 'audience', pct: 25 },
      ],
    });
    // top_of_search (50%) is the binding placement; 1.5 x 1.10 x 1.25 = 2.0625.
    expect(result.multiplier).toBeCloseTo(2.0625, 10);
    expect(result.value).toBeCloseTo(2.0625, 10);
    expect(result.components.map((c) => c.name)).toEqual(['top_of_search', 'dayparting', 'audience']);
  });

  it('a bid with no modifiers has a max potential CPC equal to itself', () => {
    const result = maxPotentialCpc({ baseBid: 0.75 });
    expect(result.value).toBe(0.75);
    expect(result.multiplier).toBe(1);
    expect(result.components).toEqual([]);
  });
});

describe('doctrine overlays', () => {
  it('a Rank target is never proposed for an ACOS-driven cut', () => {
    const outcome = proposeBid(
      request({
        category: CATEGORY_RANK,
        currentBid: 2.0,
        metrics: { clicks: 100, orders: 5, sales: 200, cost: 300 },
        levels: { profile: { clicks: 1000, orders: 60, sales: 3000 } },
        targetAcos: 0.3,
      }),
    );
    expect(outcome.kind).toBe('suppressed');
    if (outcome.kind !== 'suppressed') return;
    // The formula result is still shown in full, so the operator can decide.
    expect(outcome.recommendation.proposedValue).toBeCloseTo(0.6, 10);
    expect(outcome.suppressedReason).toContain('never cut on ACOS alone');
  });

  it('tenant config cannot opt a Rank target into ACOS-only cuts', () => {
    const outcome = proposeBid(
      request({
        category: CATEGORY_RANK,
        cutOnAcosAlone: true,
        currentBid: 2.0,
        metrics: { clicks: 100, orders: 5, sales: 200, cost: 300 },
        levels: { profile: { clicks: 1000, orders: 60, sales: 3000 } },
        targetAcos: 0.3,
      }),
    );
    expect(outcome.kind).toBe('suppressed');
    if (outcome.kind !== 'suppressed') return;
    expect(outcome.suppressedReason).toContain('never cut on ACOS alone');
  });

  it('never cuts a keyword whose organic rank is improving', () => {
    const outcome = proposeBid(
      request({
        category: CATEGORY_PROFIT,
        currentBid: 2.0,
        metrics: { clicks: 100, orders: 5, sales: 200, cost: 300 },
        levels: { profile: { clicks: 1000, orders: 60, sales: 3000 } },
        targetAcos: 0.3,
        organicRank: { status: 'known', currentRank: 8, previousRank: 12, asin: 'B0TEST5101' },
      }),
    );
    expect(outcome.kind).toBe('suppressed');
    if (outcome.kind !== 'suppressed') return;
    expect(outcome.suppressedReason).toContain('Organic rank is improving (12 -> 8');
  });

  it('marks a keyword proposal made without rank visibility', () => {
    const outcome = proposeBid(
      request({
        category: CATEGORY_PROFIT,
        stock: { status: 'in_stock', asins: ['B0TEST5101'] },
        organicRank: { status: 'unknown' },
        currentBid: 1.0,
        metrics: { clicks: 100, orders: 20, sales: 1000, cost: 150 },
        levels: { profile: { clicks: 1000, orders: 100, sales: 8000 } },
        targetAcos: 0.3,
      }),
    );
    expect(outcome.kind).toBe('proposal');
    if (outcome.kind !== 'proposal') return;
    expect(outcome.notes).toContainEqual(expect.objectContaining({ code: 'rank_unknown' }));
    expect(outcome.notes.find((note) => note.code === 'rank_unknown')?.message).toContain(
      'without rank visibility',
    );
  });

  it('a Rank increase is not suppressed: only cuts are', () => {
    const outcome = proposeBid(
      request({
        category: CATEGORY_RANK,
        currentBid: 1.0,
        metrics: { clicks: 100, orders: 20, sales: 1000, cost: 150 },
        levels: { profile: { clicks: 1000, orders: 100, sales: 8000 } },
        targetAcos: 0.3,
      }),
    );
    expect(outcome.kind).toBe('proposal');
    if (outcome.kind !== 'proposal') return;
    expect(outcome.recommendation.reason).toBe('low_acos');
  });

  it('the rank-launch goal steps increases harder than the neutral default', () => {
    const base = {
      category: CATEGORY_PROFIT,
      currentBid: 1.0,
      metrics: { clicks: 100, orders: 20, sales: 1000, cost: 150 },
      levels: { profile: { clicks: 1000, orders: 100, sales: 8000 } },
      targetAcos: 0.3,
    };
    const neutral = proposal(proposeBid(request(base)));
    const launch = proposal(proposeBid(request({ ...base, goal: 'rank-launch' })));
    expect(neutral.proposedValue).toBe(1.1);
    expect(launch.proposedValue).toBe(1.25);
  });
});

describe('stock gate', () => {
  const proposable = {
    category: CATEGORY_PROFIT,
    currentBid: 1.0,
    metrics: { clicks: 100, orders: 20, sales: 1000, cost: 150 },
    levels: { profile: { clicks: 1000, orders: 100, sales: 8000 } },
    targetAcos: 0.3,
    organicRank: { status: 'not_applicable' } as const,
  };

  it('allows an in-stock target through to bid optimization', () => {
    const outcome = proposeBid(
      request({ ...proposable, stock: { status: 'in_stock', asins: ['B0TEST5101'], source: 'fixture' } }),
    );
    expect(outcome.kind).toBe('proposal');
    if (outcome.kind !== 'proposal') return;
    expect(outcome.notes.some((note) => note.code === 'stock_unknown')).toBe(false);
  });

  it('blocks an out-of-stock target before bid optimization', () => {
    const outcome = proposeBid(
      request({ ...proposable, stock: { status: 'out_of_stock', asins: ['B0TEST5101'], source: 'fixture' } }),
    );
    expect(outcome).toEqual({
      kind: 'blocked',
      blockedReason: 'out_of_stock',
      note: 'B0TEST5101 is out of stock per fixture; bid optimization was blocked.',
    });
  });

  it('fails open for unknown stock and emits the required note', () => {
    const outcome = proposeBid(
      request({ ...proposable, stock: { status: 'unknown', asins: ['B0TEST5101'] } }),
    );
    expect(outcome.kind).toBe('proposal');
    if (outcome.kind !== 'proposal') return;
    const note = outcome.notes.find((candidate) => candidate.code === 'stock_unknown');
    expect(note?.message).toContain('stock unknown');
    expect(note?.message).toContain('failed open');
  });
});

// ---------------------------------------------------------------------------
// Property tests. A tiny deterministic PRNG keeps them reproducible: a
// property test that fails only on some seeds is a flake, not a test.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('properties', () => {
  it('a change cap always clamps into the allowed band', () => {
    const rand = mulberry32(20260813);
    for (let i = 0; i < 2000; i += 1) {
      const current = rand() * 20;
      const proposed = rand() * 60 - 10;
      const maxIncrease = rand();
      const maxDecrease = rand();
      const { value, capClamped } = applyChangeCap(current, proposed, { maxIncrease, maxDecrease });
      const upper = current * (1 + maxIncrease);
      const lower = current * (1 - maxDecrease);
      expect(value).toBeGreaterThanOrEqual(lower - 1e-9);
      expect(value).toBeLessThanOrEqual(upper + 1e-9);
      expect(capClamped).toBe(proposed > upper || proposed < lower);
    }
  });

  it('a ceiling is never exceeded', () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 2000; i += 1) {
      const candidates = [
        { name: 'manual_max_bid' as const, value: rand() * 10 },
        { name: 'budget' as const, value: rand() * 10 },
        { name: 'max_affordable_cpc' as const, value: rand() * 10 },
      ];
      const value = rand() * 12;
      const outcome = applyCeilings(value, candidates);
      const lowest = Math.min(...candidates.map((c) => c.value));
      expect(outcome.value).toBeLessThanOrEqual(lowest + 1e-12);
      expect(outcome.ceilingApplied === null).toBe(value <= lowest);
    }
  });

  it('a Sponsored Display bid never passes half the daily budget', () => {
    const rand = mulberry32(99);
    for (let i = 0; i < 1000; i += 1) {
      const dailyBudget = 1 + rand() * 100;
      const clicks = 1 + Math.floor(rand() * 200);
      const orders = Math.floor(rand() * 20);
      const sales = orders * (5 + rand() * 200);
      const cost = rand() * 400;
      const outcome = proposeBid(
        request({
          adProduct: 'SD',
          currentBid: rand() * 30,
          metrics: { clicks, orders, sales, cost },
          levels: { profile: { clicks: 5000, orders: 300, sales: 9000 } },
          targetAcos: 0.05 + rand() * 0.5,
          ceilings: { dailyBudget },
          caps: WIDE_CAPS,
        }),
      );
      if (outcome.kind === 'none' || outcome.kind === 'blocked') continue;
      const proposed = outcome.recommendation.proposedValue as number;
      expect(proposed).toBeLessThanOrEqual(dailyBudget * 0.5 + 1e-9);
    }
  });

  it('a proposal never lands below the bid floor', () => {
    const rand = mulberry32(4242);
    for (let i = 0; i < 1000; i += 1) {
      const outcome = proposeBid(
        request({
          currentBid: 0.02 + rand() * 5,
          metrics: { clicks: 1 + Math.floor(rand() * 100), orders: 0, sales: 0, cost: 5 + rand() * 100 },
          levels: { profile: { clicks: 4000, orders: 100, sales: 2000 } },
          targetAcos: 0.05 + rand() * 0.4,
        }),
      );
      if (outcome.kind === 'none' || outcome.kind === 'blocked') continue;
      expect(outcome.recommendation.proposedValue as number).toBeGreaterThanOrEqual(0.02);
    }
  });

  it('floor <= value <= ceiling for a well-formed corridor (primitive composition)', () => {
    const rand = mulberry32(20260814);
    for (let i = 0; i < 2000; i += 1) {
      // A well-formed corridor: floor never exceeds ceiling.
      const floorMax = 0.02 + rand() * 5;
      const ceilMin = floorMax + rand() * 5;
      const ceilings = [
        { name: 'manual_max_bid' as const, value: ceilMin + rand() * 3 },
        { name: 'budget' as const, value: ceilMin },
      ];
      const floors = [
        { name: 'amazon_min_bid' as const, value: 0.02 },
        { name: 'manual_min_bid' as const, value: floorMax },
      ];
      const raw = rand() * 12 - 1;
      const afterCeiling = applyCeilings(raw, ceilings);
      const afterFloor = applyFloors(afterCeiling.value, floors);
      expect(afterFloor.value).toBeGreaterThanOrEqual(floorMax - 1e-9);
      expect(afterFloor.value).toBeLessThanOrEqual(ceilMin + 1e-9);
    }
  });

  it('proposeBid keeps a proposal inside a configured floor/ceiling corridor', () => {
    const rand = mulberry32(31337);
    // A rounded bid can sit up to half a cent outside a bound; allow it.
    const CENT = 0.005 + 1e-9;
    for (let i = 0; i < 1000; i += 1) {
      const floor = roundBid(0.05 + rand() * 1.5, 2);
      const ceiling = roundBid(floor + 0.1 + rand() * 3, 2);
      const outcome = proposeBid(
        request({
          currentBid: rand() * 5,
          metrics: {
            clicks: 1 + Math.floor(rand() * 200),
            orders: Math.floor(rand() * 20),
            sales: rand() * 400,
            cost: rand() * 400,
          },
          levels: { profile: { clicks: 5000, orders: 300, sales: 9000 } },
          targetAcos: 0.05 + rand() * 0.5,
          ceilings: { manualMaxBid: ceiling },
          floors: { manualMinBid: floor },
          caps: WIDE_CAPS,
        }),
      );
      if (outcome.kind === 'none' || outcome.kind === 'blocked') continue;
      const proposed = outcome.recommendation.proposedValue as number;
      expect(proposed).toBeGreaterThanOrEqual(floor - CENT);
      expect(proposed).toBeLessThanOrEqual(ceiling + CENT);
    }
  });
});
