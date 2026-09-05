import { TimeMachineCursor, type TimeMachineNativeWrite, type TimeMachineWritePhase } from '@wizard-ads/shared/time-machine-writes';
import { SpWriteOperationId } from '@wizard-ads/shared/sp-write-application';

type Query = Record<string, string | string[] | undefined>;
export function timelineCursor(query: Query): TimeMachineCursor | null {
  const parsed = TimeMachineCursor.safeParse({ observedAt: query['before_at'], id: query['before_id'] });
  return parsed.success ? parsed.data : null;
}

export function timelineOperation(query: Query): SpWriteOperationId | null {
  const parsed = SpWriteOperationId.safeParse({ executionId: query['execution'], planId: query['plan'] });
  return parsed.success ? parsed.data : null;
}

export function operationHistoryHref(profileId: string, operation: SpWriteOperationId): string {
  return '/time-machine?' + new URLSearchParams({ profile: profileId, execution: operation.executionId, plan: operation.planId }).toString();
}

const PHASE_LABELS: Record<TimeMachineWritePhase, string> = {
  queued: 'Queued for Amazon', refused: 'Refused before applying', awaiting_result: 'Awaiting Amazon response',
  rejected: 'Rejected by Amazon', awaiting_observation: 'Accepted by Amazon', ambiguous: 'Amazon response uncertain',
  observed_requested: 'Observed in Amazon', observed_expected_after_ambiguous: 'Original value observed',
  conflict: 'Conflicting Amazon value', missing: 'Entity missing from Amazon',
};
export function nativeWriteLabel(write: TimeMachineNativeWrite): string {
  const status = write.execution.admission === 'approved_pending_start' ? 'Approved, waiting to queue' : PHASE_LABELS[write.phase];
  return write.direction === 'inverse' ? `Reversion · ${status}` : status;
}

export function nativeMirrorLabel(write: TimeMachineNativeWrite): string | null {
  if (write.observation === null) return null;
  switch (write.mirrorReceipt?.outcome) {
    case 'promoted': case 'already_current': return 'Local copy updated';
    case 'superseded': return 'Newer local value retained';
    case 'missing': return 'Local entity unavailable';
    default: return 'Local update pending';
  }
}

export function inverseHistoryLabel(inverse: TimeMachineNativeWrite['inverseSummaries'][number]): string {
  switch (inverse.snapshot.status) {
    case 'succeeded': case 'observed_after_ambiguous': return 'Reversion observed in Amazon';
    case 'refused': return 'Reversion refused';
    case 'failed': return 'Reversion failed';
    case 'conflict': return 'Reversion conflict';
    case 'ambiguous': return 'Reversion outcome uncertain';
    default: return 'Reversion pending';
  }
}
