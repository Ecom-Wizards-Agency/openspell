import { createHash, randomUUID } from 'node:crypto';
import {
  SpWriteObservation, SpWriteObservedAction, SpWritePredispatchObservation, SpWriteProviderCallIntent,
  serializeSpWriteObservationFingerprint, serializeSpWritePredispatchObservationFingerprint,
  serializeSpWriteProviderCallIntentFingerprint, serializeSpWriteProviderRequestFingerprint,
  type SpWriteExecutionEvidence, type SpWritePlan, type SpWriteProviderResult,
} from '@wizard-ads/shared/sp-writes';
import type { SpWritePreparedCall } from '@wizard-ads/ads-api/sp-write-adapter';
import type { SpWriteDispatchTicket, SpWriteObserveAndRecoverOutboxClaim } from '@wizard-ads/db/sp-write-persistence';

export const hasher = { algorithm: 'sha256' as const, digest: (text: string) => createHash('sha256').update(text).digest('hex') };
const ZERO = '0'.repeat(64);

export function providerKey(plan: SpWritePlan): string {
  return JSON.stringify([plan.orgId, plan.profileId, plan.providerScope]);
}

function identity(evidence: SpWriteExecutionEvidence) {
  return { planId: evidence.plan.id, planFingerprint: evidence.plan.fingerprint,
    approvalId: evidence.authorization.approvalId, executionId: evidence.authorization.executionId,
    generation: evidence.authorization.generation };
}

export function makeReservationArtifacts(
  evidence: SpWriteExecutionEvidence, call: SpWritePreparedCall, leaseId: string,
  items: readonly SpWriteObservedAction[], observedAt: string,
): { observation: SpWritePredispatchObservation; intent: SpWriteProviderCallIntent } {
  const observation = SpWritePredispatchObservation.parse({ ...identity(evidence),
    schemaVersion: 'openspell.sp-write-predispatch-observation.v1', observationId: randomUUID(),
    routeKey: call.routeKey, observedAt, validUntil: new Date(Date.parse(observedAt) + 60_000).toISOString(),
    items, fingerprint: ZERO,
  });
  observation.fingerprint = hasher.digest(serializeSpWritePredispatchObservationFingerprint(observation));
  const intent = SpWriteProviderCallIntent.parse({ ...identity(evidence),
    schemaVersion: 'openspell.sp-write-provider-call-intent.v1', intentId: randomUUID(), providerCallId: randomUUID(),
    routeKey: call.routeKey, attemptNumber: 1, dispatchLeaseId: leaseId,
    providerObservationFingerprint: observation.fingerprint, requestFingerprint: ZERO, recordedAt: observedAt,
    positions: call.positions, fingerprint: ZERO,
  });
  intent.requestFingerprint = hasher.digest(serializeSpWriteProviderRequestFingerprint(intent));
  intent.fingerprint = hasher.digest(serializeSpWriteProviderCallIntentFingerprint(intent));
  return { observation, intent };
}

/** Subtract the entire reservation round trip; never add time from a local wall clock. */
export function remainingAttemptMs(ticket: SpWriteDispatchTicket, elapsedMs: number): number {
  const start = Date.parse(ticket.dispatchStartDeadline) - Date.parse(ticket.databaseReadAt) - elapsedMs;
  const attempt = Date.parse(ticket.providerAttemptDeadline) - Date.parse(ticket.databaseReadAt) - elapsedMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || !Number.isFinite(start) || !Number.isFinite(attempt) || start <= 0) return 0;
  return Math.max(0, Math.floor(attempt));
}

export function unresolvedActionIds(evidence: SpWriteExecutionEvidence): string[] {
  const resolved = new Set([
    ...evidence.predispatchDispositions.map((row) => row.actionId),
    ...evidence.providerCallIntents.flatMap((intent) => intent.positions.map((row) => row.actionId)),
  ]);
  return evidence.plan.actions.filter((action) => !resolved.has(action.actionId)).map((action) => action.actionId);
}

/** A successful complete read is required; failed reads never fabricate a missing entity. */
export function makeObservations(
  evidence: SpWriteExecutionEvidence, claim: SpWriteObserveAndRecoverOutboxClaim,
  intent: SpWriteProviderCallIntent, result: SpWriteProviderResult, items: readonly SpWriteObservedAction[],
  observedAt: string, settleMs: number,
): { observations: SpWriteObservation[]; pending: number } {
  const observations: SpWriteObservation[] = [];
  const parsedItems = items.map((item) => SpWriteObservedAction.parse(item));
  const byAction = new Map(parsedItems.map((item) => [item.actionId, item]));
  if (byAction.size !== items.length || items.length !== intent.positions.length
    || intent.positions.some((position) => !byAction.has(position.actionId))) throw new Error('SP write observation count mismatch');
  let pending = 0;
  for (const position of result.positions) {
    if (position.outcome === 'authoritative_rejected'
      || evidence.observations.some((row) => row.intentId === intent.intentId && row.actionId === position.actionId)) continue;
    const action = evidence.plan.actions.find((row) => row.actionId === position.actionId);
    const observed = byAction.get(position.actionId)!;
    if (action?.routeKey !== 'sp.v3.keywords.update' || action.changes.bid === undefined || action.changes.state !== undefined
      || observed.routeKey !== action.routeKey || observed.actionFingerprint !== action.fingerprint
      || observed.amazonEntityId !== action.entity.keywordId || observed.values.bid === undefined || observed.values.state !== undefined) {
      throw new Error('SP write observation identity or action unsupported');
    }
    const matches = (side: 'expected' | 'requested') => observed.values.bid?.amount === action.changes.bid?.[side].amount
      && observed.values.bid?.currencyCode === action.changes.bid?.[side].currencyCode;
    const requested = matches('requested');
    if (!requested && Date.parse(observedAt) < Date.parse(result.completedAt) + settleMs) { pending += 1; continue; }
    const observation = SpWriteObservation.parse({ ...identity(evidence),
      schemaVersion: 'openspell.sp-write-observation.v1', observationId: randomUUID(),
      intentId: intent.intentId, intentFingerprint: intent.fingerprint, providerCallId: intent.providerCallId,
      requestFingerprint: intent.requestFingerprint, actionId: action.actionId, actionFingerprint: action.fingerprint,
      routeKey: action.routeKey, sourceSyncJobId: claim.sourceSyncJobId, observedAt,
      outcome: requested ? 'observed_requested'
        : position.outcome === 'ambiguous' && matches('expected') ? 'observed_expected_after_ambiguous' : 'conflict',
      observed, fingerprint: ZERO,
    });
    observation.fingerprint = hasher.digest(serializeSpWriteObservationFingerprint(observation));
    observations.push(observation);
  }
  return { observations, pending };
}
