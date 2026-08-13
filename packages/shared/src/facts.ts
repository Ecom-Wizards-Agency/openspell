/**
 * Fact grains. Every fact is one profile, one day, one entity grain.
 *
 * Two properties of Amazon reporting are baked into these shapes on purpose:
 * zero-impression rows are omitted by the API (so absence is not zero, and
 * freshness is read from the report ledger, never inferred from facts), and
 * sales restate for 14+ days (so each attribution window is its own column
 * rather than a single "sales" number).
 */
import { z } from 'zod';
import {
  AdProduct,
  AmazonId,
  CurrencyCode,
  IsoDate,
  MatchType,
  Placement,
  Uuid,
} from './primitives.js';

const count = z.number().int().nonnegative();
const money = z.number().nonnegative();

/** Present on every fact grain. */
const factBase = {
  profileId: Uuid,
  date: IsoDate,
  impressions: count,
  clicks: count,
  cost: money,
};

/**
 * Target-grain daily fact: the spine of the whole product. "Target" here means
 * a keyword or a product target, whichever the ad group uses.
 */
export const DailyFact = z.object({
  ...factBase,
  adProduct: AdProduct,
  campaignId: AmazonId,
  adGroupId: AmazonId,
  targetId: AmazonId,
  targetKind: z.enum(['keyword', 'target']),
  matchType: MatchType.nullable(),
  purchases1d: count,
  purchases7d: count,
  purchases14d: count,
  purchases30d: count,
  sales1d: money,
  sales7d: money,
  sales14d: money,
  sales30d: money,
  unitsSold7d: count,
  /** Only reported for some grains and windows, hence optional and nullable. */
  topOfSearchImpressionShare: z.number().min(0).max(1).nullable().optional(),
});
export type DailyFact = z.infer<typeof DailyFact>;

/** Search-term grain. Feeds the n-gram explorer and negative candidates. */
export const SearchTermFact = z.object({
  ...factBase,
  adProduct: AdProduct,
  campaignId: AmazonId,
  adGroupId: AmazonId,
  targetId: AmazonId.nullable(),
  searchTerm: z.string(),
  matchType: MatchType.nullable(),
  purchases7d: count,
  sales7d: money,
  unitsSold7d: count,
});
export type SearchTermFact = z.infer<typeof SearchTermFact>;

/** Placement grain. The seam for placement adjustments and off-Amazon leakage. */
export const PlacementFact = z.object({
  ...factBase,
  adProduct: AdProduct,
  campaignId: AmazonId,
  placement: Placement,
  purchases7d: count,
  sales7d: money,
});
export type PlacementFact = z.infer<typeof PlacementFact>;

/** Profile-grain rollup. Currency and timezone live here, not on the leaf rows. */
export const ProfileFact = z.object({
  ...factBase,
  currencyCode: CurrencyCode,
  purchases7d: count,
  sales7d: money,
  unitsSold7d: count,
  /**
   * Same-day data is provisional (sales still attributing). The crosscheck
   * excludes provisional days rather than explaining away the variance.
   */
  provisional: z.boolean(),
});
export type ProfileFact = z.infer<typeof ProfileFact>;
