import { z } from 'zod';
import { Uuid } from './primitives.js';
import { SpWriteOperationDetail, SpWriteOperationId } from './sp-write-application.js';
import { SpWriteMirrorCounts, SpWriteMirrorReceipt } from './sp-write-mirror.js';
import {
  SpMoney, SpWriteChangeSource, SpWriteExecutionSnapshot, SpWriteObservation, SpWriteRefusalReason,
} from './sp-writes.js';

/** Exact PostgreSQL precision, canonical UTC, suitable for a stable keyset cursor. */
export const TimeMachineInstant = z.iso.datetime()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/)
  .refine((value) => !value.startsWith('0000-'), 'year zero is not supported')
  .transform((value) => {
    const [seconds, fraction = ''] = value.slice(0, -1).split('.');
    return `${seconds}.${fraction.padEnd(6, '0')}Z`;
  });
export type TimeMachineInstant = z.infer<typeof TimeMachineInstant>;

const uuidPattern = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
export const TimeMachineEntryId = z.string().regex(new RegExp(
  `^(?:change:[1-9][0-9]*|apply:${uuidPattern}|write:${uuidPattern}:${uuidPattern}:keyword\\.bid)$`, 'i',
)).transform((value) => value.toLowerCase());
export const TimeMachineCursor = z.object({ observedAt: TimeMachineInstant, id: TimeMachineEntryId }).strict();
export type TimeMachineCursor = z.infer<typeof TimeMachineCursor>;

/** Matches explicit PostgreSQL C collation without discarding fractional time. */
export function compareTimeMachineCursors(left: TimeMachineCursor, right: TimeMachineCursor): number {
  const a = TimeMachineCursor.parse(left);
  const b = TimeMachineCursor.parse(right);
  return a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// WP-217 adds the key actor together with its delegated authorization receipt.
export const TimeMachineWriteActor = z.object({ kind: z.literal('operator'), userId: Uuid }).strict();
export type TimeMachineWriteActor = z.infer<typeof TimeMachineWriteActor>;

export const TimeMachineWritePhase = z.enum([
  'queued', 'refused', 'awaiting_result', 'rejected', 'awaiting_observation', 'ambiguous',
  'observed_requested', 'observed_expected_after_ambiguous', 'conflict', 'missing',
]);
export type TimeMachineWritePhase = z.infer<typeof TimeMachineWritePhase>;

const inverseSummary = z.object({
  operation: SpWriteOperationId,
  snapshot: SpWriteExecutionSnapshot,
  mirror: SpWriteMirrorCounts,
}).strict().superRefine((value, context) => {
  const a = value.snapshot.accounting;
  if (value.mirror.observations !== a.observedRequested + a.observedExpectedAfterAmbiguous + a.observationConflict + a.observationMissing) {
    context.addIssue({ code: 'custom', message: 'inverse mirror counts differ from its provider observations' });
  }
});

/** Metadata of one approved native keyword-bid entry in the common timeline. */
export const TimeMachineNativeWrite = z.object({
  execution: SpWriteOperationDetail,
  actor: TimeMachineWriteActor,
  actionId: Uuid,
  direction: z.enum(['forward', 'inverse']),
  change: z.object({ key: z.literal('keyword.bid'), expected: SpMoney, requested: SpMoney }).strict(),
  provenance: SpWriteChangeSource,
  phase: TimeMachineWritePhase,
  refusal: SpWriteRefusalReason.nullable(),
  observation: SpWriteObservation.nullable(),
  mirrorReceipt: SpWriteMirrorReceipt.nullable(),
  inverseSummaries: z.array(inverseSummary),
}).strict().superRefine((value, context) => {
  const operation = value.execution.operation;
  const inverse = value.direction === 'inverse';
  if (inverse !== (value.execution.original !== null) || inverse !== (value.provenance.kind === 'inverse_action')
    || value.provenance.changeKey !== value.change.key
    || value.change.expected.currencyCode !== value.change.requested.currencyCode
    || value.change.expected.amount === value.change.requested.amount) {
    context.addIssue({ code: 'custom', message: 'history change or provenance differs from its operation' });
  }
  if (value.actor.userId !== value.execution.receipt.approvedBy) {
    context.addIssue({ code: 'custom', message: 'history actor differs from the recorded approver' });
  }
  if ((value.phase === 'refused') !== (value.refusal !== null)) {
    context.addIssue({ code: 'custom', message: 'only a refused action carries a refusal reason' });
  }
  const observedPhase = ['observed_requested', 'observed_expected_after_ambiguous', 'conflict', 'missing'].includes(value.phase);
  if (observedPhase !== (value.observation !== null) || (value.observation !== null && (
    value.phase !== value.observation.outcome || value.actionId !== value.observation.actionId
    || operation.executionId !== value.observation.executionId || operation.planId !== value.observation.planId
  ))) context.addIssue({ code: 'custom', message: 'history phase differs from the exact action observation' });
  const receipt = value.mirrorReceipt;
  if (receipt !== null && (value.observation === null || receipt.observationId !== value.observation.observationId
    || receipt.observationFingerprint !== value.observation.fingerprint || receipt.actionId !== value.actionId
    || receipt.planId !== operation.planId || receipt.executionId !== operation.executionId
    || receipt.orgId !== value.execution.receipt.plan.orgId || receipt.profileId !== value.execution.receipt.plan.profileId)) {
    context.addIssue({ code: 'custom', message: 'history mirror link differs from the exact observation' });
  }
  const expected = value.execution.inverses.map((item) => `${item.executionId}:${item.planId}`).sort();
  const summaries = value.inverseSummaries.map((item) => `${item.operation.executionId}:${item.operation.planId}`).sort();
  if (JSON.stringify(expected) !== JSON.stringify(summaries)) {
    context.addIssue({ code: 'custom', message: 'history inverse summaries do not close the recorded operation links' });
  }
});
export type TimeMachineNativeWrite = z.infer<typeof TimeMachineNativeWrite>;
