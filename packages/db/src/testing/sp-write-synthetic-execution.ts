import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import {
  SpWriteObservation, SpWritePredispatchObservation, SpWriteProviderCallIntent, SpWriteProviderResult,
  serializeSpWriteObservationFingerprint, serializeSpWritePredispatchObservationFingerprint,
  serializeSpWriteProviderCallIntentFingerprint, serializeSpWriteProviderRequestFingerprint,
  serializeSpWriteProviderResultFingerprint, type SpWriteAuthorizationReceipt, type SpWritePlan,
} from '@wizard-ads/shared/sp-writes';
import type { DbHandle } from '../client.js';
import { createSpWriteOutboxLedger, createSpWriteRuntimeLedger } from '../queries/sp-write-persistence.js';
import { reconcileSpWriteObservation } from '../queries/sp-write-mirror.js';
import { approveAndQueueSpWrite, previewSpWrite, previewSpWriteInverse, readSpWriteOperation } from '../sp-write-application.js';
import { exportAcceptedRecommendations } from '../queries/recommendations.js';
import type { SpWriteActor, SpWritePreview } from '@wizard-ads/shared/sp-write-application';
import type { TestDatabase } from './harness.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const ZERO = '0'.repeat(64);

/** Fake provider facts only, through the real claim, reservation, result and observation ledger. */
export async function executeSyntheticKeywordWrite(
  database: Pick<DbHandle, 'sql'>, plan: SpWritePlan, receipt: SpWriteAuthorizationReceipt,
  providerOutcome: 'accepted' | 'ambiguous' = 'accepted',
  mirrorMode: 'synthetic_direct' | 'native_receipt' = 'synthetic_direct',
): Promise<void> {
  const action = plan.actions[0];
  if (plan.actions.length !== 1 || action?.routeKey !== 'sp.v3.keywords.update' || action.changes.bid === undefined) {
    throw new Error('synthetic execution requires one keyword bid');
  }
  const runtime = createSpWriteRuntimeLedger(database);
  const outbox = createSpWriteOutboxLedger(database);
  const batch = await outbox.claimAvailable({ claimantId: 'synthetic-application-test', kinds: ['dispatch'], limit: 10 });
  assert.equal(batch.claimedCount, batch.claims.length);
  const claim = batch.claims.find((item) => item.planId === plan.id);
  for (const item of batch.claims) {
    if (item !== claim) assert.equal((await outbox.deferClaim(item, 'shutdown')).kind, 'deferred');
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
  assert.equal((await outbox.completeClaim(claim)).kind, 'completed');
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
  assert.equal(await runtime.appendProviderResult(result), 'recorded');
  assert.equal(await runtime.appendProviderResult(result), 'already_recorded');
  const observedBatch = await outbox.claimAvailable({ claimantId: 'synthetic-application-observer', kinds: ['observe_and_recover'], limit: 10 });
  assert.equal(observedBatch.claimedCount, observedBatch.claims.length);
  const observer = observedBatch.claims.find((item) => item.planId === plan.id);
  for (const item of observedBatch.claims) {
    if (item !== observer) assert.equal((await outbox.deferClaim(item, 'shutdown')).kind, 'deferred');
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
  assert.equal(await runtime.appendObservation(observed), observed.observationId);
  if (mirrorMode === 'native_receipt') {
    assert.equal((await reconcileSpWriteObservation(database, observed)).outcome, 'promoted');
    assert.equal((await outbox.completeClaim(observer)).kind, 'completed');
    return;
  }
  assert.equal((await outbox.completeClaim(observer)).kind, 'completed');
  // Simulate a mirror refresh explicitly. Observation alone is not sync evidence.
  await database.sql`update public.keywords set bid = ${action.changes.bid.requested.amount}::numeric
    where org_id = ${plan.orgId}::uuid and profile_id = ${plan.profileId}::uuid and amazon_id = ${action.entity.keywordId}`;
}

/** Disposable browser fixture; no provider client, credentials or runtime registration. */
export async function seedSyntheticWriteHistory(database: TestDatabase, actor: SpWriteActor, profileId: string) {
  const outbox = createSpWriteOutboxLedger(database);
  const old = await outbox.claimAvailable({ claimantId: 'synthetic-history-cleanup', kinds: ['observe_and_recover'], limit: 10 });
  assert.equal(old.claimedCount, old.claims.length);
  for (const claim of old.claims) assert.equal((await outbox.completeClaim(claim)).kind, 'completed');

  const grantVersion = randomUUID();
  const grants = await database.sql`
    insert into public.sp_write_profile_grant_versions
      (grant_id, version_id, org_id, profile_id, enabled, amazon_profile_id,
       connection_id, region, marketplace_id, currency_code, api_dialect, created_by)
    select grant_id, ${grantVersion}, org_id, profile_id, true, amazon_profile_id,
           connection_id, region, 'ATVPDKIKX0DER', currency_code, api_dialect, created_by
    from public.sp_write_profile_grant_versions where org_id = ${actor.orgId} and profile_id = ${profileId}
    returning version_id
  `;
  assert.equal(grants.length, 1);
  await database.sql`update public.sp_write_profile_grant_heads set version_id = ${grantVersion}
    where org_id = ${actor.orgId} and profile_id = ${profileId}`;
  const gate = randomUUID();
  await database.sql`insert into public.sp_write_environment_gate_versions (version_id, enabled, max_unresolved_calls)
    values (${gate}, true, 1)`;
  await database.sql`insert into public.sp_write_environment_gate_head (singleton, version_id) values (true, ${gate})`;
  const keywords = await database.sql`insert into public.keywords
    (org_id, profile_id, amazon_id, ad_product, name, state, campaign_id, ad_group_id, keyword_text, match_type, bid)
    select org_id, profile_id, 'kw-native-history', ad_product, 'Native history keyword', state,
      campaign_id, ad_group_id, 'native history keyword', match_type, bid
    from public.keywords where org_id = ${actor.orgId} and profile_id = ${profileId} and amazon_id = 'kw-1'
    returning amazon_id`;
  assert.equal(keywords.length, 1);
  const [run] = await database.sql<{ id: string }[]>`select id from public.recommendation_runs
    where org_id = ${actor.orgId} and profile_id = ${profileId} order by created_at, id limit 1`;
  assert.ok(run);
  const recommendation = randomUUID();
  await database.sql`insert into public.recommendations
    (id, run_id, org_id, profile_id, reason, entity_type, entity_id, field, current_value, proposed_value, inputs, status)
    values (${recommendation}, ${run.id}, ${actor.orgId}, ${profileId}, 'high_acos', 'keyword', 'kw-native-history',
      'bid', '0.9'::jsonb, '0.7'::jsonb, '{}'::jsonb, 'accepted')`;
  const batch = await exportAcceptedRecommendations(database, { orgId: actor.orgId, profileId, runId: run.id,
    ids: [recommendation], tag: 'synthetic-native-history', optGroup: 'synthetic', lever: 'bid-down',
    note: 'Synthetic native history fixture', actorId: actor.userId });
  const forward = await previewSpWrite(database, actor, { requestId: randomUUID(), profileId, applyBatchId: batch.batchId });
  async function observe(preview: SpWritePreview) {
    const admitted = await approveAndQueueSpWrite(database, actor, { profileId, approval: {
      approvalRequestId: randomUUID(), plan: preview.binding, approvalMode: 'manual',
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1', boundedAuthorization: null, preapprovedInversePlan: null,
    } });
    const queued = await readSpWriteOperation(database, actor, { profileId, ...admitted.operation });
    await executeSyntheticKeywordWrite(database, preview.plan, queued.receipt, 'accepted', 'native_receipt');
    const status = await readSpWriteOperation(database, actor, { profileId, ...admitted.operation });
    assert.equal(status.snapshot.status, 'succeeded');
    assert.equal(status.mirror.promoted, 1);
    return admitted.operation;
  }
  const original = await observe(forward);
  const inverse = await observe(await previewSpWriteInverse(database, actor, { requestId: randomUUID(), profileId, original }));
  const closed = randomUUID();
  await database.sql`insert into public.sp_write_environment_gate_versions (version_id, enabled, max_unresolved_calls)
    values (${closed}, false, 1)`;
  await database.sql`update public.sp_write_environment_gate_head set version_id = ${closed}`;
  return { original, inverse, sourceBatchId: batch.batchId };
}
