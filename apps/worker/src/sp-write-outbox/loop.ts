import { performance } from 'node:perf_hooks';
import { Uuid } from '@wizard-ads/shared';
import type { SpWriteExecutionEvidence, SpWriteObservation, SpWritePlan } from '@wizard-ads/shared/sp-writes';
import type { SpWriteAdapter } from '@wizard-ads/ads-api/sp-write-adapter';
import type { DbHandle } from '@wizard-ads/db';
import {
  createSpWriteOutboxLedger, createSpWriteRuntimeLedger,
  type SpWriteOutboxClaim, type SpWriteDispatchOutboxClaim, type SpWriteObserveAndRecoverOutboxClaim,
} from '@wizard-ads/db/sp-write-persistence';
import {
  isSpWriteDispatchCurrent, listSpWriteProviderPlans, readSpWriteDatabaseTime, readSpWriteRecoveryResult,
} from '@wizard-ads/db/sp-write-worker';
import { makeObservations, makeReservationArtifacts, unresolvedActionIds, providerKey, remainingAttemptMs } from './artifacts.js';

interface Policy {
  dispatchEnabled: boolean;
  reconcileEnabled: boolean;
  profileIds: readonly string[];
}

interface Dependencies {
  database: Pick<DbHandle, 'sql'>;
  claimantId: string;
  policy(): Policy;
  prepareProviders(plans: readonly SpWritePlan[], signal: AbortSignal): Promise<ReadonlyMap<string, SpWriteAdapter>>;
  /** True only after durable mirror reconciliation (or an exact replay) for this observation. */
  reconcileObservation(observation: SpWriteObservation): Promise<boolean>;
}

export type SpWriteTickResult = Readonly<{
  kind: 'disabled' | 'idle' | 'busy' | 'completed' | 'deferred' | 'stale' | 'fault';
  attemptedCalls: number;
}>;

const OBSERVATION_TIMEOUT_MS = 30_000;
const OBSERVATION_SETTLE_MS = 120_000;

/** Inert and single-flight: importing or constructing the loop never starts it. */
export function createSpWriteOutboxLoop(dependencies: Dependencies) {
  const { database } = dependencies;
  const runtime = createSpWriteRuntimeLedger(database);
  const outbox = createSpWriteOutboxLedger(database);
  const shutdown = new AbortController();
  let running = false;

  const allowed = (claim: SpWriteOutboxClaim, policy: Policy) => policy.profileIds.includes(claim.profileId)
    && (claim.kind === 'dispatch' ? policy.dispatchEnabled : policy.reconcileEnabled);
  const currentPolicy = (): Policy => {
    const policy = dependencies.policy();
    return { dispatchEnabled: policy.dispatchEnabled === true, reconcileEnabled: policy.reconcileEnabled === true,
      profileIds: [...new Set(policy.profileIds.map((id) => Uuid.parse(id)))] };
  };

  async function evidenceFor(claim: SpWriteOutboxClaim): Promise<SpWriteExecutionEvidence> {
    const evidence = await runtime.loadVerifiedExecution(claim);
    if (evidence === null) throw new Error('SP write execution unavailable');
    if (evidence.plan.actions.some((action) => action.routeKey !== 'sp.v3.keywords.update'
      || action.changes.bid === undefined || action.changes.state !== undefined)) throw new Error('SP write action unsupported by worker');
    return evidence;
  }

  async function settleClaim(claim: SpWriteOutboxClaim, attemptedCalls: number): Promise<SpWriteTickResult> {
    const completion = await outbox.completeClaim(claim);
    if (completion.kind === 'completed' || completion.kind === 'already_completed') return { kind: 'completed', attemptedCalls };
    if (completion.kind === 'stale_claim') return { kind: 'stale', attemptedCalls };
    const deferred = await outbox.deferClaim(claim, claim.kind === 'dispatch' ? 'reservation_busy' : 'observation_pending');
    return { kind: deferred.kind === 'stale_claim' ? 'stale' : 'deferred', attemptedCalls };
  }

  async function dispatch(
    claim: SpWriteDispatchOutboxClaim, initial: SpWriteExecutionEvidence,
    adapter: SpWriteAdapter, signal: AbortSignal, markAttempt: () => void,
  ): Promise<SpWriteTickResult> {
    let evidence = initial;
    let attemptedCalls = 0;
    let lease: { leaseId: string; expiresAt: string } | undefined;
    // Each pass must resolve at least one row. There can be no more passes than approved rows.
    for (let pass = 0; pass < initial.plan.actions.length; pass += 1) {
      if (evidence.authorization.approvalMode === 'delegated_mcp') {
        const settlement = await outbox.settleDelegatedAuthority(claim);
        if (settlement.kind === 'stale_claim') return { kind: 'stale', attemptedCalls };
        if (settlement.kind === 'refused') return settleClaim(claim, attemptedCalls);
      }
      const remaining = unresolvedActionIds(evidence);
      const call = adapter.preparePlan(evidence.plan, remaining)[0];
      if (call === undefined) return settleClaim(claim, attemptedCalls);
      signal.throwIfAborted();
      if (!allowed(claim, currentPolicy()) || !await isSpWriteDispatchCurrent(database, claim)) {
        await outbox.deferClaim(claim, 'shutdown');
        return { kind: 'deferred', attemptedCalls };
      }
      if (lease === undefined) {
        const acquired = await runtime.acquireDispatchLease({ claim, routeKey: call.routeKey, leaseSeconds: 120 });
        if (acquired.kind !== 'acquired') return settleClaim(claim, attemptedCalls);
        lease = acquired;
      }
      const beforeRead = await readSpWriteDatabaseTime(database);
      if (Date.parse(lease.expiresAt) - Date.parse(beforeRead) <= 70_000) return settleClaim(claim, attemptedCalls);
      const items = await adapter.observeCurrent({ plan: evidence.plan, call }, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(OBSERVATION_TIMEOUT_MS)]), timeoutMs: OBSERVATION_TIMEOUT_MS,
      });
      const observedAt = await readSpWriteDatabaseTime(database);
      // An exhausted lease is a scheduling condition, not a terminal refusal of approved rows.
      if (Date.parse(lease.expiresAt) - Date.parse(observedAt) <= 70_000) return settleClaim(claim, attemptedCalls);
      const artifacts = makeReservationArtifacts(evidence, call, lease.leaseId, items, observedAt);
      signal.throwIfAborted();
      if (!allowed(claim, currentPolicy())) {
        await outbox.deferClaim(claim, 'shutdown');
        return { kind: 'deferred', attemptedCalls };
      }
      const started = performance.now();
      const reservation = await runtime.reserveProviderCall({ claim, ...artifacts });
      if (reservation.kind === 'defer_and_reobserve') return settleClaim(claim, attemptedCalls);
      if (reservation.kind === 'dispatch_once') {
        const { ticket } = reservation;
        const timeoutMs = remainingAttemptMs(ticket, performance.now() - started);
        // No ticket replay: a missed deadline or cancellation leaves recovery to the durable wake.
        if (timeoutMs <= 0 || signal.aborted || !allowed(claim, currentPolicy())) return settleClaim(claim, attemptedCalls);
        attemptedCalls += 1;
        markAttempt();
        const result = await adapter.executeOneAttempt({ plan: evidence.plan, intent: ticket.intent, resultId: ticket.resultId }, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]), timeoutMs,
        });
        await runtime.appendProviderResult(result);
      }
      evidence = await evidenceFor(claim);
      if (unresolvedActionIds(evidence).length >= remaining.length) return settleClaim(claim, attemptedCalls);
    }
    return settleClaim(claim, attemptedCalls);
  }

  async function observe(
    claim: SpWriteObserveAndRecoverOutboxClaim, initial: SpWriteExecutionEvidence,
    adapter: SpWriteAdapter | undefined, signal: AbortSignal,
  ): Promise<SpWriteTickResult> {
    let evidence = initial;
    const intent = evidence.providerCallIntents.find((row) => row.intentId === claim.intentId && row.providerCallId === claim.providerCallId);
    if (intent === undefined) throw new Error('SP write observation intent unavailable');
    let result = evidence.providerResults.find((row) => row.intentId === intent.intentId);
    if (result === undefined) {
      const recovery = await readSpWriteRecoveryResult(database, intent);
      if (recovery === null) {
        await outbox.deferClaim(claim, 'recovery_pending');
        return { kind: 'deferred', attemptedCalls: 0 };
      }
      await runtime.appendRecoveryResult(recovery);
      evidence = await evidenceFor(claim);
      result = evidence.providerResults.find((row) => row.intentId === intent.intentId);
      if (result === undefined) throw new Error('SP write recovery result unavailable');
    }
    const pending = result.positions.filter((position) => position.outcome !== 'authoritative_rejected'
      && !evidence.observations.some((row) => row.intentId === intent.intentId && row.actionId === position.actionId));
    if (pending.length > 0) {
      if (adapter === undefined) throw new Error('SP write observation provider unavailable');
      const call = adapter.preparePlan(evidence.plan, intent.positions.map((position) => position.actionId)).find((candidate) => candidate.routeKey === intent.routeKey
        && JSON.stringify(candidate.positions) === JSON.stringify(intent.positions));
      if (call === undefined) throw new Error('SP write observation call mismatch');
      const items = await adapter.observeCurrent({ plan: evidence.plan, call }, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(OBSERVATION_TIMEOUT_MS)]), timeoutMs: OBSERVATION_TIMEOUT_MS,
      });
      const observedAt = await readSpWriteDatabaseTime(database);
      const built = makeObservations(evidence, claim, intent, result, items, observedAt, OBSERVATION_SETTLE_MS);
      if (built.observations.length + built.pending !== pending.length) throw new Error('SP write observation outputs do not close');
      for (const observation of built.observations) await runtime.appendObservation(observation);
      evidence = await evidenceFor(claim);
    }
    // Never complete the delivery wake before every persisted observation has mirror evidence.
    const observations = evidence.observations.filter((row) => row.intentId === intent.intentId);
    let reconciled = 0;
    for (const observation of observations) {
      if (await dependencies.reconcileObservation(observation)) reconciled += 1;
    }
    if (reconciled !== observations.length) {
      await outbox.deferClaim(claim, 'observation_pending');
      return { kind: 'deferred', attemptedCalls: 0 };
    }
    return settleClaim(claim, 0);
  }

  return {
    stop(): void { shutdown.abort(); },
    async tick(options: { signal?: AbortSignal } = {}): Promise<SpWriteTickResult> {
      if (running) return { kind: 'busy', attemptedCalls: 0 };
      if (shutdown.signal.aborted) return { kind: 'disabled', attemptedCalls: 0 };
      running = true;
      let claim: SpWriteOutboxClaim | undefined;
      let attemptedCalls = 0;
      try {
        const signal = AbortSignal.any([shutdown.signal, ...(options.signal === undefined ? [] : [options.signal])]);
        signal.throwIfAborted();
        const policy = currentPolicy();
        if ((!policy.dispatchEnabled && !policy.reconcileEnabled) || policy.profileIds.length === 0) return { kind: 'disabled', attemptedCalls: 0 };
        const plans = await listSpWriteProviderPlans(database, policy.profileIds, policy.dispatchEnabled, policy.reconcileEnabled);
        let providers: ReadonlyMap<string, SpWriteAdapter>;
        try { providers = await dependencies.prepareProviders(plans, signal); }
        catch {
          signal.throwIfAborted();
          // Recovery can durably close a missing result even when credentials are unavailable.
          // Fresh dispatch and actual provider observation still require a prepared adapter.
          providers = new Map();
        }
        signal.throwIfAborted();
        // Reconciliation has priority, including a durable intent whose dispatch process disappeared.
        const kinds = policy.reconcileEnabled ? ['observe_and_recover', ...(policy.dispatchEnabled ? ['dispatch'] : [])] as const : ['dispatch'] as const;
        for (const kind of kinds) {
          const batch = await outbox.claimAvailable({ claimantId: dependencies.claimantId, kinds: [kind], limit: 1, leaseSeconds: 120 });
          if (batch.claimedCount !== batch.claims.length || batch.claimedCount > 1) throw new Error('SP write claim counts do not close');
          claim = batch.claims[0];
          if (claim !== undefined) break;
        }
        if (claim === undefined) return { kind: 'idle', attemptedCalls: 0 };
        if (!allowed(claim, currentPolicy())) {
          await outbox.deferClaim(claim, 'shutdown');
          return { kind: 'deferred', attemptedCalls: 0 };
        }
        const evidence = await evidenceFor(claim);
        const adapter = providers.get(providerKey(evidence.plan));
        if (claim.kind === 'observe_and_recover') return await observe(claim, evidence, adapter, signal);
        if (evidence.snapshot.accounting.pendingDispatch === 0) return await settleClaim(claim, 0);
        if (evidence.authorization.approvalMode === 'delegated_mcp') {
          const settlement = await outbox.settleDelegatedAuthority(claim);
          if (settlement.kind === 'stale_claim') return { kind: 'stale', attemptedCalls: 0 };
          if (settlement.kind === 'refused') return await settleClaim(claim, 0);
        }
        if (adapter === undefined || !await isSpWriteDispatchCurrent(database, claim)) {
          await outbox.deferClaim(claim, 'shutdown');
          return { kind: 'deferred', attemptedCalls: 0 };
        }
        return await dispatch(claim, evidence, adapter, signal, () => { attemptedCalls += 1; });
      } catch {
        if (claim !== undefined) {
          try { await outbox.deferClaim(claim, claim.kind === 'dispatch' ? 'reservation_busy' : 'recovery_pending'); } catch { /* Custody expires; immutable attempts remain recoverable. */ }
        }
        // Raw database/provider errors can contain SQL, credentials or account data.
        return { kind: 'fault', attemptedCalls };
      } finally { running = false; }
    },
  };
}
