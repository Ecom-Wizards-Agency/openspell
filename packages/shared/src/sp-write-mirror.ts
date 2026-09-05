import { z } from 'zod';
import { AmazonId, Uuid } from './primitives.js';
import { KeywordRow } from './entities.js';
import { SpMoney, SpWriteObservationOutcome, SpWriteSha256 } from './sp-writes.js';

/** A provider observation and its mirror promotion are separate durable facts. */
export const SpWriteMirrorOutcome = z.enum(['promoted', 'already_current', 'superseded', 'missing']);
export type SpWriteMirrorOutcome = z.infer<typeof SpWriteMirrorOutcome>;

function sameMoney(left: SpMoney | null, right: SpMoney | null): boolean {
  return left === null || right === null ? left === right
    : left.amount === right.amount && left.currencyCode === right.currencyCode;
}

export const SpWriteMirrorReceipt = z.object({
  schemaVersion: z.literal('openspell.sp-write-mirror-receipt.v1'),
  orgId: Uuid,
  profileId: Uuid,
  executionId: Uuid,
  planId: Uuid,
  observationId: Uuid,
  observationFingerprint: SpWriteSha256,
  actionId: Uuid,
  amazonEntityId: AmazonId,
  changeKey: z.literal('keyword.bid'),
  observationOutcome: SpWriteObservationOutcome,
  outcome: SpWriteMirrorOutcome,
  before: SpMoney.nullable(),
  observed: SpMoney.nullable(),
  after: SpMoney.nullable(),
  /** PostgreSQL bigint stays decimal text across transports. */
  entityChangeId: z.string().regex(/^[1-9]\d*$/).nullable(),
  changeAttribution: z.enum(['write', 'observation']).nullable(),
  observedAt: z.iso.datetime(),
  reconciledAt: z.iso.datetime(),
  bidObservedAt: z.iso.datetime().nullable(),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.reconciledAt) < Date.parse(value.observedAt)
    || (value.bidObservedAt !== null && Date.parse(value.bidObservedAt) > Date.parse(value.reconciledAt))) {
    context.addIssue({ code: 'custom', message: 'mirror receipt timestamps exceed their evidence window' });
  }
  const currencies = [value.before, value.observed, value.after].flatMap((money) => money === null ? [] : [money.currencyCode]);
  if (new Set(currencies).size > 1) context.addIssue({ code: 'custom', message: 'mirror reconciliation must preserve currency' });
  if ((value.observationOutcome === 'missing') !== (value.observed === null)) {
    context.addIssue({ code: 'custom', message: 'only a missing provider observation has no observed value' });
  }
  const promoted = value.outcome === 'promoted';
  if (promoted !== (value.entityChangeId !== null) || promoted !== (value.changeAttribution !== null)) {
    context.addIssue({ code: 'custom', message: 'only an actual mirror promotion creates a linked entity diff' });
  }
  if (promoted && (value.before === null || value.observed === null || !sameMoney(value.after, value.observed)
    || sameMoney(value.before, value.after) || value.bidObservedAt !== value.observedAt)) {
    context.addIssue({ code: 'custom', message: 'promotion must change a known prior value to the observed value' });
  }
  if (value.changeAttribution === 'write' && value.observationOutcome !== 'observed_requested') {
    context.addIssue({ code: 'custom', message: 'a conflicting observation cannot be attributed to the requested write' });
  }
  if (value.outcome === 'already_current' && (value.observed === null || !sameMoney(value.before, value.observed)
    || !sameMoney(value.after, value.observed) || value.bidObservedAt === null
    || Date.parse(value.bidObservedAt) < Date.parse(value.observedAt))) {
    context.addIssue({ code: 'custom', message: 'already current requires the exact observed value and field evidence' });
  }
  if (value.outcome === 'superseded' && (value.before === null || !sameMoney(value.before, value.after))) {
    context.addIssue({ code: 'custom', message: 'superseded observation must preserve current mirror state' });
  }
  if (value.outcome === 'missing' && (value.before !== null || value.after !== null || value.bidObservedAt !== null)) {
    context.addIssue({ code: 'custom', message: 'missing mirror state cannot claim a current value' });
  }
});
export type SpWriteMirrorReceipt = z.infer<typeof SpWriteMirrorReceipt>;

const count = z.number().int().nonnegative();
export const SpWriteMirrorCounts = z.object({
  observations: count,
  /** Persisted provider observations that have no durable mirror receipt yet. */
  pending: count,
  promoted: count,
  alreadyCurrent: count,
  superseded: count,
  missing: count,
}).strict().superRefine((value, context) => {
  if (value.observations !== value.pending + value.promoted + value.alreadyCurrent + value.superseded + value.missing) {
    context.addIssue({ code: 'custom', message: 'every observation requires exactly one mirror outcome' });
  }
});
export type SpWriteMirrorCounts = z.infer<typeof SpWriteMirrorCounts>;

/** Ordinary keyword sync counts stale field inputs separately from actual row upserts. */
export const KeywordMirrorMergeRequest = z.object({
  orgId: Uuid,
  profileId: Uuid,
  adProduct: z.enum(['SP', 'SB', 'SD']).optional(),
  readStartedAt: z.iso.datetime(),
  full: z.boolean(),
  rows: z.array(KeywordRow),
}).strict().superRefine((value, context) => {
  const identities = new Set<string>();
  for (const row of value.rows) {
    if (row.profileId !== value.profileId || (value.adProduct !== undefined && row.adProduct !== value.adProduct)
      || identities.has(row.amazonId) || (row.bid !== null && row.bid < 0)) {
      context.addIssue({ code: 'custom', message: 'keyword merge requires unique rows in the requested scope' });
    }
    identities.add(row.amazonId);
  }
});
export type KeywordMirrorMergeRequest = z.infer<typeof KeywordMirrorMergeRequest>;

export const KeywordMirrorMergeCounts = z.object({
  listed: count,
  upserted: count,
  currentBidInputs: count,
  staleBidInputs: count,
  bidChanges: count,
  /** All actual keyword diffs, including initial discovery and non-bid fields. */
  changes: count,
  tombstonesOffered: count,
  tombstoned: count,
  staleTombstones: count,
}).strict().superRefine((value, context) => {
  if (value.listed !== value.upserted || value.listed !== value.currentBidInputs + value.staleBidInputs
    || value.bidChanges > value.currentBidInputs || value.changes < value.bidChanges + value.tombstoned
    || value.tombstonesOffered !== value.tombstoned + value.staleTombstones) {
    context.addIssue({ code: 'custom', message: 'keyword mirror inputs and outputs do not close' });
  }
});
export type KeywordMirrorMergeCounts = z.infer<typeof KeywordMirrorMergeCounts>;
