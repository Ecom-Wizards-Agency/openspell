/** Search Query Performance, vocabulary, and review-only negative contracts. */
import { z } from 'zod';
import { AmazonId, IsoDate, Uuid } from './primitives.js';

const count = z.number().int().nonnegative();
const ratio = z.number().min(0).max(1);

export const QueryCategory = z.enum([
  'own_brand',
  'competitor',
  'core',
  'head',
  'excluded',
  'unreviewed',
]);
export type QueryCategory = z.infer<typeof QueryCategory>;

export const QueryVocabularyKind = z.enum([
  'own_brand_term',
  'own_brand_alias',
  'competitor_brand',
  'competitor_asin',
  'core_term',
  'exclusion',
]);
export type QueryVocabularyKind = z.infer<typeof QueryVocabularyKind>;

export const QueryVocabularySource = z.enum(['operator', 'import', 'ai_suggestion']);
export type QueryVocabularySource = z.infer<typeof QueryVocabularySource>;

export const QueryVocabularyEntry = z.object({
  id: Uuid.optional(),
  orgId: Uuid,
  marketplaceId: AmazonId,
  kind: QueryVocabularyKind,
  value: z.string().trim().min(1),
  normalizedValue: z.string().trim().min(1),
  source: QueryVocabularySource,
  approved: z.boolean(),
  reviewedAt: z.iso.datetime().nullable(),
});
export type QueryVocabularyEntry = z.infer<typeof QueryVocabularyEntry>;

export const SqpWeeklyFact = z.object({
  profileId: Uuid,
  marketplaceId: AmazonId,
  asin: AmazonId,
  weekStart: IsoDate,
  weekEnd: IsoDate,
  searchQuery: z.string().min(1),
  normalizedQuery: z.string().min(1),
  category: QueryCategory,
  searchQueryScore: z.number().nonnegative().nullable(),
  searchQueryVolume: count,
  totalImpressions: count,
  asinImpressions: count,
  asinImpressionShare: ratio,
  totalClicks: count,
  asinClicks: count,
  asinClickShare: ratio,
  totalCartAdds: count,
  asinCartAdds: count,
  asinCartAddShare: ratio,
  totalPurchases: count,
  asinPurchases: count,
  asinPurchaseShare: ratio,
});
export type SqpWeeklyFact = z.infer<typeof SqpWeeklyFact>;

export const QueryJoinAttribution = z.enum([
  'asin_exact',
  'profile_only',
  'ambiguous',
  'unmatched',
]);
export type QueryJoinAttribution = z.infer<typeof QueryJoinAttribution>;

export const ContextualNegativeProposal = z.object({
  id: Uuid.optional(),
  profileId: Uuid,
  marketplaceId: AmazonId,
  campaignId: AmazonId,
  adGroupId: AmazonId,
  searchTerm: z.string().min(1),
  normalizedQuery: z.string().min(1),
  category: QueryCategory,
  sourceGroupRole: z.enum(['rank', 'discovery', 'profit', 'shield']),
  matchType: z.enum(['negative_exact', 'negative_phrase']),
  reason: z.string().min(1),
  status: z.enum(['proposed', 'accepted', 'dismissed', 'exported']),
});
export type ContextualNegativeProposal = z.infer<typeof ContextualNegativeProposal>;

export const SqpIngestionCounts = z.object({
  sourceAsins: count,
  sourceRows: count,
  parsedRows: count,
  deduplicatedRows: count,
  refusedRows: count,
  upserts: count,
});
export type SqpIngestionCounts = z.infer<typeof SqpIngestionCounts>;
