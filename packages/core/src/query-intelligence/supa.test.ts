import { describe, expect, it } from 'vitest';
import {
  evaluateSupaSignals,
  type SupaThresholds,
  type SupaWeekEvidence,
} from './supa.js';

/** Synthetic test values only; production doctrine always arrives as tenant data. */
const THRESHOLDS: SupaThresholds = {
  minimumSearchVolume: 10,
  opportunitySearchVolume: 20,
  conversionOpportunitySearchVolume: 20,
  minimumPreviousSpend: 2,
  minimumProblemSpend: 3,
  clickShareDropPoints: 0.02,
  clickShareDropRelative: 0.2,
  heldShareLossPoints: 0.03,
  spendDropRelative: 0.25,
  spendHeldRatio: 0.8,
  acosProblemMultiple: 2,
  purchaseShareFlatTolerance: 0.005,
  lowShare: 0.1,
  conversionEdgePoints: 0.03,
  stockDaysTrigger: 2,
  belowMarketConversionGapPoints: 2,
  organicOwnershipRank: 5,
};

function week(over: Partial<SupaWeekEvidence> = {}): SupaWeekEvidence {
  return {
    weekStart: '2026-01-11',
    searchVolume: 100,
    clickShare: 0.15,
    purchaseShare: 0.15,
    spend: 10,
    sales: 20,
    acos: 0.5,
    organicRank: null,
    outOfStockDays: 0,
    conversionGapPoints: 0,
    ...over,
  };
}

function rules(previous: SupaWeekEvidence | null, current: SupaWeekEvidence) {
  return evaluateSupaSignals({
    previous,
    current,
    targetAcos: 0.2,
    thresholds: THRESHOLDS,
  });
}

describe('SUPA synthetic parity', () => {
  it('emits P1 for spend-driven share loss and makes a concurrent rank loss urgent', () => {
    const result = rules(
      week({ weekStart: '2026-01-04', clickShare: 0.2, spend: 12, organicRank: 8 }),
      week({ clickShare: 0.1, spend: 5, organicRank: 14, sales: 20, acos: 0.25 }),
    );
    expect(result.find((signal) => signal.rule === 'P1')).toMatchObject({
      kind: 'problem',
      decision: 'urgent_restore_for_rank',
    });
  });

  it('emits P2 when share falls while spend holds and lets stock override the diagnosis', () => {
    const result = rules(
      week({ weekStart: '2026-01-04', clickShare: 0.2, spend: 10 }),
      week({ clickShare: 0.15, spend: 9, outOfStockDays: 3 }),
    );
    expect(result.find((signal) => signal.rule === 'P2')).toMatchObject({
      decision: 'fix_supply',
      evidence: { stockBlocked: true },
    });
  });

  it('emits P3 for spend over target without traction but protects improving rank', () => {
    const result = rules(
      week({ weekStart: '2026-01-04', purchaseShare: 0.12, organicRank: 18 }),
      week({ purchaseShare: 0.12, spend: 15, sales: 10, acos: 1.5, organicRank: 11 }),
    );
    expect(result.find((signal) => signal.rule === 'P3')).toMatchObject({
      kind: 'opportunity',
      decision: 'hold_rank_investment',
    });
  });

  it('routes P3 to offer work when rank slips and conversion trails market', () => {
    const result = rules(
      week({ weekStart: '2026-01-04', purchaseShare: 0.12, organicRank: 7 }),
      week({
        purchaseShare: 0.12,
        spend: 15,
        sales: 10,
        acos: 1.5,
        organicRank: 13,
        conversionGapPoints: -4,
      }),
    );
    expect(result.find((signal) => signal.rule === 'P3')?.decision).toBe('fix_offer');
  });

  it('emits O1 for unfunded demand but will not buy traffic organic already owns', () => {
    const result = rules(
      null,
      week({ clickShare: 0.02, purchaseShare: 0.01, spend: 0, organicRank: 3 }),
    );
    expect(result.find((signal) => signal.rule === 'O1')).toMatchObject({
      decision: 'hold_organic_ownership',
    });
  });

  it('emits O2 when purchase share exceeds click share by the configured edge', () => {
    const result = rules(
      null,
      week({ clickShare: 0.11, purchaseShare: 0.18, spend: 2 }),
    );
    expect(result.find((signal) => signal.rule === 'O2')).toMatchObject({
      decision: 'buy_more_traffic',
    });
  });

  it('emits E1 when both shares grow at or below target ACOS', () => {
    const result = rules(
      week({ weekStart: '2026-01-04', clickShare: 0.1, purchaseShare: 0.11 }),
      week({ clickShare: 0.14, purchaseShare: 0.16, spend: 8, sales: 50, acos: 0.16 }),
    );
    expect(result.find((signal) => signal.rule === 'E1')).toMatchObject({
      kind: 'efficiency_gain',
      decision: 'protect_winner',
    });
  });

  it('covers every reference rule code with synthetic evidence', () => {
    const cases = [
      rules(week({ clickShare: 0.2, spend: 12 }), week({ clickShare: 0.1, spend: 5 })),
      rules(week({ clickShare: 0.2, spend: 10 }), week({ clickShare: 0.15, spend: 9 })),
      rules(
        week({ purchaseShare: 0.12 }),
        week({ purchaseShare: 0.12, spend: 15, sales: 10, acos: 1.5 }),
      ),
      rules(null, week({ clickShare: 0.02, purchaseShare: 0.01, spend: 0 })),
      rules(null, week({ clickShare: 0.11, purchaseShare: 0.18, spend: 2 })),
      rules(
        week({ clickShare: 0.1, purchaseShare: 0.11 }),
        week({ clickShare: 0.14, purchaseShare: 0.16, spend: 8, sales: 50, acos: 0.16 }),
      ),
    ];
    const covered = new Set(cases.flatMap((signals) => signals.map((signal) => signal.rule)));
    expect([...covered].sort()).toEqual(['E1', 'O1', 'O2', 'P1', 'P2', 'P3']);
    expect(cases).toHaveLength(6);
  });

  it('uses only caller-provided thresholds', () => {
    const stricter = { ...THRESHOLDS, minimumSearchVolume: 101 };
    expect(
      evaluateSupaSignals({
        previous: week({ weekStart: '2026-01-04', clickShare: 0.2, spend: 12 }),
        current: week({ clickShare: 0.1, spend: 5 }),
        targetAcos: 0.2,
        thresholds: stricter,
      }),
    ).toEqual([]);
  });
});
