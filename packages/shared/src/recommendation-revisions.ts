import { z } from 'zod';
import { CurrencyCode, Uuid } from './primitives.js';
import { SpKeywordBidDecimal } from './sp-writes.js';
import { SpWriteActor } from './sp-write-application.js';

const id = Uuid.transform((value) => value.toLowerCase());

/** Positive, canonical bid text representable by the keyword mirror without rounding. */
export const RecommendationBidDecimal = SpKeywordBidDecimal;
export type RecommendationBidDecimal = z.infer<typeof RecommendationBidDecimal>;

/** Accept ordinary entered decimal text; normalize with string operations only. */
const enteredBid = z.string().trim().min(1).max(32).regex(/^\d+(?:\.\d+)?$/).transform((value) => {
  const [integer, fraction = ''] = value.split('.');
  const whole = integer!.replace(/^0+(?=\d)/, '');
  const fractional = fraction.replace(/0+$/, '');
  return fractional.length === 0 ? whole : `${whole}.${fractional}`;
}).pipe(RecommendationBidDecimal);

export const RecommendationRevisionRef = z.object({
  recommendationId: id,
  /** Null identifies the unchanged engine proposal. */
  revisionId: id.nullable(),
}).strict();
export type RecommendationRevisionRef = z.infer<typeof RecommendationRevisionRef>;

export const RecommendationRevisionSelection = z.array(RecommendationRevisionRef).min(1).max(20_000)
  .refine((rows) => new Set(rows.map((row) => row.recommendationId)).size === rows.length, {
    message: 'a recommendation can appear only once in a reviewed selection',
  });
export type RecommendationRevisionSelection = z.infer<typeof RecommendationRevisionSelection>;

/** Every refused ID is retained, including an unavailable or stale reviewed row. */
export const RecommendationDecisionResult = z.object({
  updated: z.number().int().nonnegative().max(20_000),
  refused: z.array(z.object({
    id,
    status: z.enum(['proposed', 'accepted', 'dismissed', 'exported', 'applied', 'superseded', 'unavailable', 'revision_changed']),
  }).strict()).max(20_000),
}).strict().refine((value) => value.updated + value.refused.length <= 20_000
  && new Set(value.refused.map((row) => row.id)).size === value.refused.length, {
  message: 'decision counts and refused identities must reconcile',
});
export type RecommendationDecisionResult = z.infer<typeof RecommendationDecisionResult>;

export const RecommendationRevisionRequest = z.object({
  requestId: id,
  profileId: id,
  recommendationId: id,
  expectedRevisionId: id.nullable(),
  proposedValue: enteredBid,
  note: z.string().trim().min(1).max(1_000),
}).strict();
export type RecommendationRevisionRequest = z.infer<typeof RecommendationRevisionRequest>;

/** Immutable edit receipt. Its recorded status does not claim the current review state. */
export const RecommendationRevisionReceipt = z.object({
  schemaVersion: z.literal('openspell.recommendation-revision.v1'),
  requestId: id,
  profileId: id,
  recommendationId: id,
  revisionId: id,
  previousRevisionId: id.nullable(),
  actor: SpWriteActor,
  currencyCode: CurrencyCode,
  priorProposedValue: RecommendationBidDecimal,
  proposedValue: RecommendationBidDecimal,
  note: z.string().trim().min(1).max(1_000),
  recordedStatus: z.literal('proposed'),
  recordedAt: z.iso.datetime(),
}).strict().superRefine((value, context) => {
  if (value.previousRevisionId === value.revisionId || value.priorProposedValue === value.proposedValue) {
    context.addIssue({ code: 'custom', message: 'a revision must record a distinct successor and changed proposal' });
  }
});
export type RecommendationRevisionReceipt = z.infer<typeof RecommendationRevisionReceipt>;

/** Legacy cap validation requires numeric JSON; refuse any decimal round-trip loss. */
export function recommendationBidNumber(raw: RecommendationBidDecimal): number {
  const decimal = RecommendationBidDecimal.parse(raw);
  const number = Number(decimal);
  if (!Number.isFinite(number) || JSON.stringify(number) !== decimal) {
    throw new Error('bid cannot be represented as exact decimal JSON');
  }
  return number;
}
