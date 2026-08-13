/**
 * Scalars and enums every other contract is built from.
 *
 * Convention: enum *values* are snake_case so a contract value can travel from
 * TypeScript to Postgres to JSON without a translation table. The one exception
 * is the Amazon-facing vocabulary that Amazon itself capitalises (`SP`, `NA`).
 */
import { z } from 'zod';

/** Internal primary key (Supabase generates these). */
export const Uuid = z.uuid();
export type Uuid = z.infer<typeof Uuid>;

/** An identifier minted by Amazon. Always a string: some are numeric, some are not. */
export const AmazonId = z.string().min(1);
export type AmazonId = z.infer<typeof AmazonId>;

/** Calendar day in the profile's own timezone, never a timestamp. */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export type IsoDate = z.infer<typeof IsoDate>;

/** ISO 4217. Profiles span currencies, so no fact is comparable without one. */
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, 'expected an ISO 4217 code');
export type CurrencyCode = z.infer<typeof CurrencyCode>;

/** Amazon Ads API regional host groups. Separate hosts, separate token buckets. */
export const Region = z.enum(['NA', 'EU', 'FE']);
export type Region = z.infer<typeof Region>;

/** Advertising product line. */
export const AdProduct = z.enum(['SP', 'SB', 'SD']);
export type AdProduct = z.infer<typeof AdProduct>;

/** Every entity kind the mirror stores. */
export const EntityType = z.enum([
  'portfolio',
  'campaign',
  'ad_group',
  'product_ad',
  'keyword',
  'target',
  'negative',
]);
export type EntityType = z.infer<typeof EntityType>;

/**
 * Canonical match / targeting vocabulary. WP-02 maps Amazon's per-endpoint
 * spellings (`EXACT`, `NEGATIVE_EXACT`, `asinSameAs`, ...) onto these.
 */
export const MatchType = z.enum([
  'exact',
  'phrase',
  'broad',
  'negative_exact',
  'negative_phrase',
  'asin_same_as',
  'asin_expanded_from',
  'asin_brand_same_as',
  'asin_category_same_as',
  'close_match',
  'loose_match',
  'substitutes',
  'complements',
]);
export type MatchType = z.infer<typeof MatchType>;

/** Mirror state. Amazon's transient states (`enabling`) collapse into these three. */
export const EntityState = z.enum(['enabled', 'paused', 'archived']);
export type EntityState = z.infer<typeof EntityState>;

/**
 * Placement grain. `off_amazon` is the seam for the off-Amazon SP leakage
 * report; it is a real placement in the report, not a synthetic bucket.
 */
export const Placement = z.enum([
  'top_of_search',
  'rest_of_search',
  'product_pages',
  'off_amazon',
  'other',
]);
export type Placement = z.infer<typeof Placement>;

/** A pointer to one mirrored entity, resolvable without a join. */
export const EntityRef = z.object({
  profileId: Uuid,
  entityType: EntityType,
  entityId: AmazonId,
  adProduct: AdProduct.optional(),
  campaignId: AmazonId.optional(),
  adGroupId: AmazonId.optional(),
  name: z.string().nullable().optional(),
});
export type EntityRef = z.infer<typeof EntityRef>;
