/**
 * Synthetic grid rows for tests and perf work.
 *
 * Deterministic from a seed, for the same reason `supabase/seed/dev-seed.ts` is:
 * a fixture that changes under you is not a fixture, and a perf budget measured
 * against different data every run is not a budget.
 *
 * Not exported from the package index. This is test scaffolding, not product.
 */
import type { BaseTotals } from './metrics.js';
import type { GridRow } from './rows.js';

/** Deterministic pseudo-random, same LCG the dev seed uses. */
export function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const HEADS = ['blue', 'metal', 'large', 'small', 'premium', 'cheap', 'organic', 'heavy'];
const MIDS = ['widget', 'gadget', 'bracket', 'holder', 'stand', 'clip'];
const TAILS = ['for desk', 'set', 'gift', 'pack of 2', 'with case', 'replacement', ''];

export interface SearchTermFixtureOptions {
  seed?: number;
  currencyCode?: string;
  campaigns?: number;
  /** Fraction of rows that also have a comparison-period figure. */
  comparisonCoverage?: number;
}

/**
 * `count` search-term rows across a handful of campaigns and ad groups.
 *
 * Roughly one row in eight has no comparison figure, mirroring the real thing:
 * Amazon omits zero-impression rows, so an entity that did not serve last week
 * has no comparison row rather than a zeroed one.
 */
export function syntheticSearchTermRows(
  count: number,
  options: SearchTermFixtureOptions = {},
): GridRow[] {
  const random = lcg(options.seed ?? 20260814);
  const currencyCode = options.currencyCode ?? 'USD';
  const campaignCount = options.campaigns ?? 12;
  const coverage = options.comparisonCoverage ?? 0.875;
  const rows: GridRow[] = new Array<GridRow>(count);

  for (let index = 0; index < count; index += 1) {
    const campaign = index % campaignCount;
    const adGroup = index % (campaignCount * 3);
    const term = `${pick(HEADS, random)} ${pick(MIDS, random)} ${pick(TAILS, random)}`.trim();
    const totals = syntheticTotals(random);

    rows[index] = {
      id: `st-${index}`,
      dimensions: {
        search_term: `${term} ${index}`,
        targeting: `${pick(MIDS, random)} exact`,
        match_type: random() < 0.6 ? 'exact' : random() < 0.5 ? 'phrase' : 'broad',
        ad_group_name: `Ad group ${adGroup}`,
        campaign_name: `Dev | SP | ${campaign % 3 === 0 ? 'Rank' : campaign % 3 === 1 ? 'Discovery' : 'Profit'} | ${campaign}`,
        campaign_id: `c-${campaign}`,
        ad_product: 'SP',
        harvested: random() < 0.2,
      },
      totals,
      comparison: random() < coverage ? syntheticTotals(random) : null,
      currencyCode,
      tagIds: random() < 0.25 ? ['tag-brand'] : [],
    };
  }

  return rows;
}

function syntheticTotals(random: () => number): BaseTotals {
  const impressions = Math.round(50 + random() * 4000);
  const clicks = Math.round(impressions * (0.002 + random() * 0.02));
  const spend = round2(clicks * (0.25 + random() * 1.6));
  const orders = Math.round(clicks * random() * 0.2);
  const sales = round2(orders * (14 + random() * 30));
  return { impressions, clicks, spend, sales, orders, units: orders };
}

function pick<T>(values: readonly T[], random: () => number): T {
  return values[Math.floor(random() * values.length)] as T;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;
