/** Pure SUPA P1/P2/P3/O1/O2/E1 evaluation. All doctrine values are inputs. */

export type SupaRule = 'P1' | 'P2' | 'P3' | 'O1' | 'O2' | 'E1';
export type SupaKind = 'problem' | 'opportunity' | 'efficiency_gain';

export interface SupaThresholds {
  minimumSearchVolume: number;
  opportunitySearchVolume: number;
  conversionOpportunitySearchVolume: number;
  minimumPreviousSpend: number;
  minimumProblemSpend: number;
  /** Absolute share delta on the 0..1 ratio scale. */
  clickShareDropPoints: number;
  clickShareDropRelative: number;
  /** Absolute share delta on the 0..1 ratio scale. */
  heldShareLossPoints: number;
  spendDropRelative: number;
  spendHeldRatio: number;
  acosProblemMultiple: number;
  purchaseShareFlatTolerance: number;
  lowShare: number;
  /** Absolute share delta on the 0..1 ratio scale. */
  conversionEdgePoints: number;
  stockDaysTrigger: number;
  /** CVR gap in percentage points, matching `conversionGapPoints`. */
  belowMarketConversionGapPoints: number;
  organicOwnershipRank: number;
}

export interface SupaWeekEvidence {
  weekStart: string;
  searchVolume: number;
  clickShare: number;
  purchaseShare: number;
  spend: number;
  sales: number;
  acos: number | null;
  organicRank: number | null;
  outOfStockDays: number | null;
  conversionGapPoints: number | null;
}

export type SupaDecision =
  | 'restore_spend'
  | 'restore_after_stock'
  | 'urgent_restore_for_rank'
  | 'investigate_non_spend'
  | 'fix_supply'
  | 'fix_offer'
  | 'cut_or_isolate'
  | 'hold_rank_investment'
  | 'hold_for_stock_recovery'
  | 'fund_demand'
  | 'do_not_fund_stock'
  | 'do_not_fund_conversion'
  | 'hold_organic_ownership'
  | 'buy_more_traffic'
  | 'protect_winner';

export interface SupaSignal {
  rule: SupaRule;
  kind: SupaKind;
  decision: SupaDecision;
  score: number;
  evidence: {
    clickShareDelta: number | null;
    purchaseShareDelta: number | null;
    spendDelta: number | null;
    rankDelta: number | null;
    stockBlocked: boolean;
  };
}

export interface EvaluateSupaInput {
  previous: SupaWeekEvidence | null;
  current: SupaWeekEvidence;
  targetAcos: number;
  thresholds: SupaThresholds;
}

function relativeDrop(previous: number, current: number): number {
  return previous > 0 ? (previous - current) / previous : 0;
}

function rankDelta(previous: SupaWeekEvidence | null, current: SupaWeekEvidence): number | null {
  if (previous?.organicRank === null || current.organicRank === null) return null;
  if (previous?.organicRank === undefined) return null;
  return current.organicRank - previous.organicRank;
}

function baseEvidence(
  previous: SupaWeekEvidence | null,
  current: SupaWeekEvidence,
  stockBlocked: boolean,
): SupaSignal['evidence'] {
  return {
    clickShareDelta: previous ? current.clickShare - previous.clickShare : null,
    purchaseShareDelta: previous ? current.purchaseShare - previous.purchaseShare : null,
    spendDelta: previous ? current.spend - previous.spend : null,
    rankDelta: rankDelta(previous, current),
    stockBlocked,
  };
}

/** Evaluate one query/ASIN on equal Sunday-Saturday weekly evidence. */
export function evaluateSupaSignals(input: EvaluateSupaInput): SupaSignal[] {
  const { previous, current, targetAcos, thresholds } = input;
  if (current.searchVolume < thresholds.minimumSearchVolume) return [];

  const signals: SupaSignal[] = [];
  const stockBlocked =
    current.outOfStockDays !== null &&
    current.outOfStockDays >= thresholds.stockDaysTrigger;
  const context = baseEvidence(previous, current, stockBlocked);
  const rankMove = context.rankDelta;
  const conversionWeak =
    current.conversionGapPoints !== null &&
    current.conversionGapPoints <= -thresholds.belowMarketConversionGapPoints;

  if (previous) {
    const clickShareDrop = previous.clickShare - current.clickShare;
    const clickShareDown =
      clickShareDrop >= thresholds.clickShareDropPoints ||
      relativeDrop(previous.clickShare, current.clickShare) >= thresholds.clickShareDropRelative;
    const spendCut =
      previous.spend >= thresholds.minimumPreviousSpend &&
      current.spend <= previous.spend * (1 - thresholds.spendDropRelative);
    const spendHeld = current.spend >= previous.spend * thresholds.spendHeldRatio;

    if (clickShareDown && clickShareDrop > 0 && spendCut) {
      signals.push({
        rule: 'P1',
        kind: 'problem',
        decision: stockBlocked
          ? 'restore_after_stock'
          : rankMove !== null && rankMove > 0
            ? 'urgent_restore_for_rank'
            : 'restore_spend',
        score: current.searchVolume * clickShareDrop,
        evidence: context,
      });
    } else if (clickShareDrop >= thresholds.heldShareLossPoints && spendHeld) {
      signals.push({
        rule: 'P2',
        kind: 'problem',
        decision: stockBlocked ? 'fix_supply' : conversionWeak ? 'fix_offer' : 'investigate_non_spend',
        score: current.searchVolume * clickShareDrop,
        evidence: context,
      });
    }

    const purchaseShareFlat =
      current.purchaseShare <= previous.purchaseShare + thresholds.purchaseShareFlatTolerance;
    const inefficient =
      current.sales === 0 ||
      (current.acos !== null && current.acos > thresholds.acosProblemMultiple * targetAcos);
    if (current.spend >= thresholds.minimumProblemSpend && inefficient && purchaseShareFlat) {
      const rankImproving = rankMove !== null && rankMove < 0;
      const rankSlipping = rankMove !== null && rankMove > 0;
      signals.push({
        rule: 'P3',
        kind: rankImproving ? 'opportunity' : 'problem',
        decision: stockBlocked
          ? 'hold_for_stock_recovery'
          : rankImproving
            ? 'hold_rank_investment'
            : rankSlipping && conversionWeak
              ? 'fix_offer'
              : 'cut_or_isolate',
        score: current.spend,
        evidence: context,
      });
    }

    if (
      current.clickShare > previous.clickShare &&
      current.purchaseShare > previous.purchaseShare &&
      current.spend >= thresholds.minimumPreviousSpend &&
      current.acos !== null &&
      current.acos <= targetAcos
    ) {
      signals.push({
        rule: 'E1',
        kind: 'efficiency_gain',
        decision: 'protect_winner',
        score: current.sales,
        evidence: context,
      });
    }
  }

  if (
    current.searchVolume >= thresholds.opportunitySearchVolume &&
    current.clickShare < thresholds.lowShare &&
    current.purchaseShare < thresholds.lowShare &&
    current.spend < thresholds.minimumPreviousSpend
  ) {
    const ownsOrganic =
      current.organicRank !== null && current.organicRank <= thresholds.organicOwnershipRank;
    signals.push({
      rule: 'O1',
      kind: 'opportunity',
      decision: stockBlocked
        ? 'do_not_fund_stock'
        : conversionWeak
          ? 'do_not_fund_conversion'
          : ownsOrganic
            ? 'hold_organic_ownership'
            : 'fund_demand',
      score: current.searchVolume * (thresholds.lowShare - current.clickShare),
      evidence: context,
    });
  }

  if (
    current.searchVolume >= thresholds.conversionOpportunitySearchVolume &&
    current.purchaseShare - current.clickShare >= thresholds.conversionEdgePoints
  ) {
    signals.push({
      rule: 'O2',
      kind: 'opportunity',
      decision: 'buy_more_traffic',
      score: current.searchVolume * (current.purchaseShare - current.clickShare),
      evidence: context,
    });
  }

  return signals;
}
