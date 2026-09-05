import { createHash, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import {
  SpWriteObservation, SpWritePredispatchObservation, SpWriteProviderCallIntent, SpWriteProviderResult,
  serializeSpWriteObservationFingerprint, serializeSpWritePredispatchObservationFingerprint,
  serializeSpWriteProviderCallIntentFingerprint, serializeSpWriteProviderRequestFingerprint,
  serializeSpWriteProviderResultFingerprint, type SpWriteAuthorizationReceipt, type SpWritePlan,
} from '@wizard-ads/shared/sp-writes';
import type { DbHandle } from '../client.js';
import { createSpWriteOutboxLedger, createSpWriteRuntimeLedger } from '../queries/sp-write-persistence.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const ZERO = '0'.repeat(64);

/** Fake provider facts only, through the real claim, reservation, result and observation ledger. */
export async function executeSyntheticKeywordWrite(
  database: Pick<DbHandle, 'sql'>, plan: SpWritePlan, receipt: SpWriteAuthorizationReceipt,
  providerOutcome: 'accepted' | 'ambiguous' = 'accepted',
): Promise<void> {
  const action = plan.actions[0];
  if (plan.actions.length !== 1 || action?.routeKey !== 'sp.v3.keywords.update' || action.changes.bid === undefined) {
    throw new Error('synthetic execution requires one keyword bid');
  }
  const runtime = createSpWriteRuntimeLedger(database);
  const outbox = createSpWriteOutboxLedger(database);
  const batch = await outbox.claimAvailable({ claimantId: 'synthetic-application-test', kinds: ['dispatch'], limit: 10 });
  expect(batch.claimedCount).toBe(batch.claims.length);
  const claim = batch.claims.find((item) => item.planId === plan.id);
  for (const item of batch.claims) {
    if (item !== claim) expect((await outbox.deferClaim(item, 'shutdown')).kind).toBe('deferred');
  }
  if (claim?.kind !== 'dispatch') throw new Error('synthetic dispatch missing');
  const lease = await runtime.acquireDispatchLease({ claim, routeKey: action.routeKey });
  if (lease.kind !== 'acquired') throw new Error('synthetic lease missing');
  const [clock] = await database.sql<{ now: string; until: string }[]>`
    select app.sp_write_instant(clock_timestamp()) as now,
      app.sp_write_instant(clock_timestamp() + interval '60 seconds') as until
  `;
  if (clock === undefined) throw new Error('synthetic clock missing');
  const identity = { planId: plan.id, planFingerprint: plan.fingerprint, approvalId: receipt.approvalId,
    executionId: receipt.executionId, generation: receipt.generation };
  const observedAction = { routeKey: action.routeKey, actionId: action.actionId, actionFingerprint: action.fingerprint,
    amazonEntityId: action.entity.keywordId, values: { bid: action.changes.bid.expected } };
  const observationBase = SpWritePredispatchObservation.parse({ ...identity,
    schemaVersion: 'openspell.sp-write-predispatch-observation.v1', observationId: randomUUID(),
    routeKey: action.routeKey, observedAt: clock.now, validUntil: clock.until, items: [observedAction], fingerprint: ZERO,
  });
  const observation = { ...observationBase, fingerprint: digest(serializeSpWritePredispatchObservationFingerprint(observationBase)) };
  const base = SpWriteProviderCallIntent.parse({ ...identity,
    schemaVersion: 'openspell.sp-write-provider-call-intent.v1', intentId: randomUUID(), providerCallId: randomUUID(),
    routeKey: action.routeKey, attemptNumber: 1, dispatchLeaseId: lease.leaseId,
    providerObservationFingerprint: observation.fingerprint, requestFingerprint: ZERO, recordedAt: clock.now,
    positions: [{ requestIndex: 0, actionId: action.actionId, actionFingerprint: action.fingerprint,
      amazonEntityId: action.entity.keywordId, actionRequestFingerprint: digest(JSON.stringify(action.changes)) }], fingerprint: ZERO,
  });
  base.requestFingerprint = digest(serializeSpWriteProviderRequestFingerprint(base));
  const intent = { ...base, fingerprint: digest(serializeSpWriteProviderCallIntentFingerprint(base)) };
  const reservation = await runtime.reserveProviderCall({ claim, intent, observation });
  if (reservation.kind !== 'dispatch_once') throw new Error(`synthetic reservation failed: ${reservation.kind}`);
  const ticket = reservation.ticket;
  expect((await outbox.completeClaim(claim)).kind).toBe('completed');
  const [time] = await database.sql<{ now: string }[]>`select app.sp_write_instant(clock_timestamp()) as now`;
  const result = SpWriteProviderResult.parse({
    schemaVersion: 'openspell.sp-write-provider-result.v1', resultId: ticket.resultId, intentId: intent.intentId,
    intentFingerprint: intent.fingerprint, providerCallId: intent.providerCallId, requestFingerprint: intent.requestFingerprint,
    completedAt: time!.now, positions: [{ requestIndex: 0, actionId: action.actionId,
      actionFingerprint: action.fingerprint, actionRequestFingerprint: intent.positions[0]!.actionRequestFingerprint,
      outcome: providerOutcome, providerEntityId: providerOutcome === 'accepted' ? action.entity.keywordId : null,
      code: null, message: null }], fingerprint: ZERO,
  });
  result.fingerprint = digest(serializeSpWriteProviderResultFingerprint(result));
  expect(await runtime.appendProviderResult(result)).toBe('recorded');
  expect(await runtime.appendProviderResult(result)).toBe('already_recorded');
  const observedBatch = await outbox.claimAvailable({ claimantId: 'synthetic-application-observer', kinds: ['observe_and_recover'], limit: 10 });
  expect(observedBatch.claimedCount).toBe(observedBatch.claims.length);
  const observer = observedBatch.claims.find((item) => item.planId === plan.id);
  for (const item of observedBatch.claims) {
    if (item !== observer) expect((await outbox.deferClaim(item, 'shutdown')).kind).toBe('deferred');
  }
  if (observer?.kind !== 'observe_and_recover') throw new Error('synthetic observer missing');
  const [after] = await database.sql<{ now: string }[]>`select app.sp_write_instant(clock_timestamp()) as now`;
  const observed = SpWriteObservation.parse({ ...identity,
    schemaVersion: 'openspell.sp-write-observation.v1', observationId: randomUUID(), intentId: intent.intentId,
    intentFingerprint: intent.fingerprint, providerCallId: intent.providerCallId, requestFingerprint: intent.requestFingerprint,
    actionId: action.actionId, actionFingerprint: action.fingerprint, routeKey: action.routeKey,
    sourceSyncJobId: observer.sourceSyncJobId, observedAt: after!.now, outcome: 'observed_requested',
    observed: { ...observedAction, values: { bid: action.changes.bid.requested } }, fingerprint: ZERO,
  });
  observed.fingerprint = digest(serializeSpWriteObservationFingerprint(observed));
  expect(await runtime.appendObservation(observed)).toBe(observed.observationId);
  expect((await outbox.completeClaim(observer)).kind).toBe('completed');
  // Simulate a mirror refresh explicitly. Observation alone is not sync evidence.
  await database.sql`update public.keywords set bid = ${action.changes.bid.requested.amount}::numeric
    where org_id = ${plan.orgId}::uuid and profile_id = ${plan.profileId}::uuid and amazon_id = ${action.entity.keywordId}`;
}
