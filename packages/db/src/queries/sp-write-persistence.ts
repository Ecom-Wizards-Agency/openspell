import { createHash } from 'node:crypto';
import {
  SpWriteAccounting,
  SpWriteAuthorizationReceipt,
  SpWriteExecutionSnapshot,
  SpWriteExecutionStatus,
  SpWriteObservation,
  SpWritePlan,
  SpWritePreDispatchDisposition,
  SpWritePredispatchObservation,
  SpWriteProviderCallIntent,
  SpWriteProviderResult,
  SpWriteProviderScope,
  SpWriteRefusalReason,
  SpWriteRouteKey,
  deriveSpWriteExecutionSnapshot,
  serializeSpWriteActionFingerprint,
  serializeSpWriteBoundedAuthorizationFingerprint,
  serializeSpWriteObservationFingerprint,
  serializeSpWritePlanFingerprint,
  serializeSpWritePredispatchObservationFingerprint,
  serializeSpWriteProviderCallIntentFingerprint,
  serializeSpWriteProviderRequestFingerprint,
  serializeSpWriteProviderResultFingerprint,
  verifySpWriteBoundedAuthorizationFingerprint,
  verifySpWriteExecutionEvidence,
  verifySpWritePlanFingerprints,
  type SpWriteExecutionEvidence,
  type SpWriteProviderScope as SpWriteProviderScopeType,
  type SpWriteRefusalReason as SpWriteRefusalReasonType,
  type SpWriteRouteKey as SpWriteRouteKeyType,
  type SpWriteSha256Hasher,
} from '@wizard-ads/shared/sp-writes';
import type { Sql } from '../client.js';
import { toDate } from './pg-time.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const sha256Hasher: SpWriteSha256Hasher = {
  algorithm: 'sha256',
  digest: (preimage) => createHash('sha256').update(preimage, 'utf8').digest('hex'),
};

export type SpWritePersistenceOperation =
  | 'create_staging_ledger'
  | 'create_runtime_ledger'
  | 'record_plan'
  | 'record_bounded_authorization'
  | 'start_execution'
  | 'acquire_dispatch_lease'
  | 'reserve_provider_call'
  | 'read_dispatch_ticket'
  | 'append_provider_result'
  | 'append_recovery_result'
  | 'append_observation'
  | 'load_verified_execution';

export type SpWritePersistenceErrorCategory =
  | 'invalid_artifact'
  | 'permission_denied'
  | 'missing_dependency'
  | 'identity_or_protocol_conflict'
  | 'authority_unavailable'
  | 'transaction_aborted'
  | 'outcome_unknown'
  | 'protocol_violation';

export type SpWriteRecoveryDirective = 'stop' | 'reload_state' | 'reconcile_only';

/** A fixed, non-authoritative error that never retains the driver error or its parameters. */
export class SpWritePersistenceError extends Error {
  readonly providerCallAllowed = false as const;

  constructor(
    readonly operation: SpWritePersistenceOperation,
    readonly category: SpWritePersistenceErrorCategory,
    readonly recovery: SpWriteRecoveryDirective,
  ) {
    super(`SP write persistence ${operation} failed: ${category}`);
    this.name = 'SpWritePersistenceError';
  }
}

export interface SpWritePersistenceHandle {
  /** A root postgres.js tag. Open transaction tags are intentionally not accepted. */
  sql: Sql;
}

export interface SpWriteBoundedProfileBinding {
  orgId: string;
  profileId: string;
  providerScope: unknown;
}

export interface RecordSpWriteBoundedAuthorizationInput {
  authorization: unknown;
  bindings: readonly SpWriteBoundedProfileBinding[];
}

export interface StartSpWriteExecutionInput {
  approvalId: string;
  planId: string;
}

export interface AcquireSpWriteDispatchLeaseInput {
  executionId: string;
  planId: string;
  generation: string;
  routeKey: SpWriteRouteKeyType;
  leaseSeconds?: number;
}

export type SpWriteDispatchLeaseOutcome =
  | Readonly<{
      kind: 'acquired';
      leaseId: string;
      acquiredAt: string;
      expiresAt: string;
    }>
  | Readonly<{ kind: 'unavailable' }>;

export interface ReserveSpWriteProviderCallInput {
  observation: unknown;
  intent: unknown;
}

const dispatchTicketBrand: unique symbol = Symbol('SpWriteDispatchTicket');

/** Only the facade can construct this value, and JSON persistence is rejected at runtime. */
export interface SpWriteDispatchTicket {
  readonly resultId: string;
  readonly intent: ReturnType<typeof SpWriteProviderCallIntent.parse>;
  readonly dispatchStartDeadline: string;
  readonly providerAttemptDeadline: string;
  readonly databaseReadAt: string;
  readonly [dispatchTicketBrand]: true;
  toJSON(): never;
}

export type SpWriteReservationOutcome =
  | Readonly<{
      kind: 'dispatch_once';
      checkedAt: string;
      ticket: SpWriteDispatchTicket;
    }>
  | Readonly<{
      kind: 'defer_and_reobserve';
      checkedAt: string;
      reason: 'busy';
    }>
  | Readonly<{
      kind: 'closed_without_dispatch';
      checkedAt: string;
      reason:
        | SpWriteRefusalReasonType
        | 'already_intended'
        | 'dispatch_window_elapsed';
    }>;

export type SpWriteResultAppendOutcome =
  | 'recorded'
  | 'already_recorded'
  | 'late_audited'
  | 'canonical_result_already_recorded';

export interface LoadVerifiedSpWriteExecutionIdentity {
  orgId: string;
  profileId: string;
  executionId: string;
  planId: string;
  approvalId: string;
  generation: string;
}

export interface SpWriteStagingLedger {
  recordPlan(rawPlan: unknown): Promise<string>;
  recordBoundedAuthorization(
    input: RecordSpWriteBoundedAuthorizationInput,
  ): Promise<string>;
}

export interface SpWriteRuntimeLedger {
  startExecution(input: StartSpWriteExecutionInput): Promise<string>;
  acquireDispatchLease(
    input: AcquireSpWriteDispatchLeaseInput,
  ): Promise<SpWriteDispatchLeaseOutcome>;
  reserveProviderCall(input: ReserveSpWriteProviderCallInput): Promise<SpWriteReservationOutcome>;
  appendProviderResult(rawResult: unknown): Promise<SpWriteResultAppendOutcome>;
  appendRecoveryResult(rawResult: unknown): Promise<SpWriteResultAppendOutcome>;
  appendObservation(rawObservation: unknown): Promise<string>;
  loadVerifiedExecution(
    identity: LoadVerifiedSpWriteExecutionIdentity,
  ): Promise<SpWriteExecutionEvidence | null>;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function mapDatabaseError(
  operation: SpWritePersistenceOperation,
  error: unknown,
): SpWritePersistenceError {
  const code = errorCode(error);
  if (code === '22023' || code === '22P02') {
    return new SpWritePersistenceError(operation, 'invalid_artifact', 'stop');
  }
  if (code === '42501') {
    return new SpWritePersistenceError(operation, 'permission_denied', 'stop');
  }
  if (code === '23503' || code === 'P0002') {
    return new SpWritePersistenceError(operation, 'missing_dependency', 'reload_state');
  }
  if (code === '23505' || code === 'P0003') {
    return new SpWritePersistenceError(
      operation,
      'identity_or_protocol_conflict',
      'reload_state',
    );
  }
  if (code === '55000') {
    return new SpWritePersistenceError(operation, 'authority_unavailable', 'reload_state');
  }
  if (code === '55P03' || code === '40001' || code === '40P01' || code === '57014') {
    return new SpWritePersistenceError(
      operation,
      'transaction_aborted',
      operation === 'reserve_provider_call' ? 'reconcile_only' : 'reload_state',
    );
  }
  if (code === undefined || code.startsWith('08') || /^57P0[1-3]$/u.test(code)) {
    return new SpWritePersistenceError(operation, 'outcome_unknown', 'reconcile_only');
  }
  return new SpWritePersistenceError(operation, 'protocol_violation', 'reconcile_only');
}

function invalidArtifact(operation: SpWritePersistenceOperation): SpWritePersistenceError {
  return new SpWritePersistenceError(operation, 'invalid_artifact', 'stop');
}

function protocolFailure(operation: SpWritePersistenceOperation): SpWritePersistenceError {
  return new SpWritePersistenceError(operation, 'protocol_violation', 'reconcile_only');
}

async function runDatabaseOperation<T>(
  operation: SpWritePersistenceOperation,
  execute: () => Promise<T>,
): Promise<T> {
  try {
    return await execute();
  } catch (error) {
    if (error instanceof SpWritePersistenceError) throw error;
    throw mapDatabaseError(operation, error);
  }
}

function parseInput<T>(operation: SpWritePersistenceOperation, parse: () => T): T {
  try {
    return parse();
  } catch {
    throw invalidArtifact(operation);
  }
}

function assertUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error('invalid UUID');
  return value;
}

function assertFingerprint(actual: string, preimage: string): void {
  if (sha256Hasher.digest(preimage) !== actual) throw new Error('fingerprint mismatch');
}

function canonicalArtifactText(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('artifact is not serializable');
  return text;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requireRootSql(
  handle: SpWritePersistenceHandle,
  operation: 'create_staging_ledger' | 'create_runtime_ledger',
): Sql {
  if (
    typeof handle !== 'object'
    || handle === null
    || typeof handle.sql !== 'function'
    || ('savepoint' in handle.sql)
    || ('prepare' in handle.sql)
    || typeof handle.sql.begin !== 'function'
  ) {
    throw protocolFailure(operation);
  }
  return handle.sql;
}

function parsePlan(rawPlan: unknown) {
  return verifySpWritePlanFingerprints(rawPlan, sha256Hasher);
}

function parseBoundedAuthorization(rawAuthorization: unknown) {
  return verifySpWriteBoundedAuthorizationFingerprint(rawAuthorization, sha256Hasher);
}

function parsePredispatchObservation(rawObservation: unknown) {
  const observation = SpWritePredispatchObservation.parse(rawObservation);
  assertFingerprint(
    observation.fingerprint,
    serializeSpWritePredispatchObservationFingerprint(observation),
  );
  return observation;
}

function parseProviderIntent(rawIntent: unknown) {
  const intent = SpWriteProviderCallIntent.parse(rawIntent);
  assertFingerprint(intent.requestFingerprint, serializeSpWriteProviderRequestFingerprint(intent));
  assertFingerprint(intent.fingerprint, serializeSpWriteProviderCallIntentFingerprint(intent));
  return intent;
}

function parseProviderResult(rawResult: unknown) {
  const result = SpWriteProviderResult.parse(rawResult);
  assertFingerprint(result.fingerprint, serializeSpWriteProviderResultFingerprint(result));
  return result;
}

function parseObservation(rawObservation: unknown) {
  const observation = SpWriteObservation.parse(rawObservation);
  assertFingerprint(observation.fingerprint, serializeSpWriteObservationFingerprint(observation));
  return observation;
}

function providerScopeKey(scope: SpWriteProviderScopeType): string {
  return canonicalArtifactText(scope);
}

function exactSingleRow<T>(
  operation: SpWritePersistenceOperation,
  rows: readonly T[],
): T {
  if (rows.length !== 1 || rows[0] === undefined) throw protocolFailure(operation);
  return rows[0];
}

function makeDispatchTicket(input: Omit<SpWriteDispatchTicket, typeof dispatchTicketBrand | 'toJSON'>) {
  const ticket: SpWriteDispatchTicket = {
    ...input,
    [dispatchTicketBrand]: true,
    toJSON(): never {
      throw new SpWritePersistenceError(
        'read_dispatch_ticket',
        'protocol_violation',
        'reconcile_only',
      );
    },
  };
  return Object.freeze(ticket);
}

class DefaultSpWriteStagingLedger implements SpWriteStagingLedger {
  constructor(private readonly sql: Sql) {}

  async recordPlan(rawPlan: unknown): Promise<string> {
    const plan = parseInput('record_plan', () => parsePlan(rawPlan));
    const artifactText = canonicalArtifactText(plan);
    const planPreimage = serializeSpWritePlanFingerprint(plan);
    const actionProofs = plan.actions.map((action) => ({
      artifactText: canonicalArtifactText(action),
      fingerprintPreimage: serializeSpWriteActionFingerprint(action),
    }));

    return runDatabaseOperation('record_plan', async () => {
      const rows = await this.sql<{ record_sp_write_plan: string }[]>`
        select app.record_sp_write_plan(
          ${artifactText},
          ${planPreimage},
          ${JSON.stringify(actionProofs)}::jsonb
        )::text
      `;
      const row = exactSingleRow('record_plan', rows);
      if (row.record_sp_write_plan !== plan.id) throw protocolFailure('record_plan');
      return row.record_sp_write_plan;
    });
  }

  async recordBoundedAuthorization(
    input: RecordSpWriteBoundedAuthorizationInput,
  ): Promise<string> {
    const prepared = parseInput('record_bounded_authorization', () => {
      const authorization = parseBoundedAuthorization(input.authorization);
      const byScope = new Map<string, { orgId: string; profileId: string }>();
      for (const binding of input.bindings) {
        const scope = SpWriteProviderScope.parse(binding.providerScope);
        const key = providerScopeKey(scope);
        if (byScope.has(key)) throw new Error('duplicate bounded binding');
        byScope.set(key, {
          orgId: assertUuid(binding.orgId),
          profileId: assertUuid(binding.profileId),
        });
      }
      const bindings = authorization.profiles.map((profile) => {
        const key = providerScopeKey(profile.providerScope);
        const binding = byScope.get(key);
        if (binding === undefined) throw new Error('missing bounded binding');
        byScope.delete(key);
        return binding;
      });
      if (byScope.size !== 0 || bindings.length !== input.bindings.length) {
        throw new Error('extra bounded binding');
      }
      return { authorization, bindings };
    });
    const artifactText = canonicalArtifactText(prepared.authorization);
    const fingerprintPreimage = serializeSpWriteBoundedAuthorizationFingerprint(
      prepared.authorization,
    );

    return runDatabaseOperation('record_bounded_authorization', async () => {
      const rows = await this.sql<{ record_sp_write_bounded_authorization: string }[]>`
        select app.record_sp_write_bounded_authorization(
          ${artifactText},
          ${fingerprintPreimage},
          ${JSON.stringify(prepared.bindings)}::jsonb
        )::text
      `;
      const row = exactSingleRow('record_bounded_authorization', rows);
      if (row.record_sp_write_bounded_authorization !== prepared.authorization.authorizationId) {
        throw protocolFailure('record_bounded_authorization');
      }
      return row.record_sp_write_bounded_authorization;
    });
  }
}

interface ReservationRow {
  decision: string;
  refusal_reason: string | null;
  checked_at: Date | string;
  result_id: string | null;
  intent_text: string | null;
}

interface DispatchReadbackRow {
  intent_id: string;
  provider_call_id: string;
  reserved_result_id: string;
  execution_id: string;
  plan_id: string;
  approval_id: string;
  generation: string;
  route_key: string;
  dispatch_lease_id: string;
  artifact_text: string;
  position_count: number;
  checked_at: Date | string;
  dispatch_start_deadline: Date | string;
  provider_attempt_deadline: Date | string;
  database_read_at: Date | string;
  dispatch_window_elapsed: boolean;
}

class DefaultSpWriteRuntimeLedger implements SpWriteRuntimeLedger {
  constructor(private readonly sql: Sql) {}

  async startExecution(input: StartSpWriteExecutionInput): Promise<string> {
    const identity = parseInput('start_execution', () => ({
      approvalId: assertUuid(input.approvalId),
      planId: assertUuid(input.planId),
    }));
    return runDatabaseOperation('start_execution', async () => {
      const rows = await this.sql<{ start_sp_write_execution: string }[]>`
        select app.start_sp_write_execution(
          ${identity.approvalId}::uuid,
          ${identity.planId}::uuid
        )::text
      `;
      const row = exactSingleRow('start_execution', rows);
      if (!UUID_PATTERN.test(row.start_sp_write_execution)) {
        throw protocolFailure('start_execution');
      }
      return row.start_sp_write_execution;
    });
  }

  async acquireDispatchLease(
    input: AcquireSpWriteDispatchLeaseInput,
  ): Promise<SpWriteDispatchLeaseOutcome> {
    const prepared = parseInput('acquire_dispatch_lease', () => {
      const leaseSeconds = input.leaseSeconds ?? 120;
      if (!Number.isInteger(leaseSeconds) || leaseSeconds < 70 || leaseSeconds > 300) {
        throw new Error('invalid lease duration');
      }
      return {
        executionId: assertUuid(input.executionId),
        planId: assertUuid(input.planId),
        generation: assertUuid(input.generation),
        routeKey: SpWriteRouteKey.parse(input.routeKey),
        leaseSeconds,
      };
    });
    try {
      const rows = await this.sql<{
        lease_id: string;
        acquired_at: Date | string;
        expires_at: Date | string;
      }[]>`
        select lease_id::text, acquired_at, expires_at
          from app.acquire_sp_write_dispatch_lease(
            ${prepared.executionId}::uuid,
            ${prepared.planId}::uuid,
            ${prepared.generation}::uuid,
            ${prepared.routeKey}::public.sp_write_route_key,
            ${prepared.leaseSeconds}
          )
      `;
      const row = exactSingleRow('acquire_dispatch_lease', rows);
      if (!UUID_PATTERN.test(row.lease_id)) throw protocolFailure('acquire_dispatch_lease');
      const acquiredAt = parseDatabaseDate('acquire_dispatch_lease', row.acquired_at);
      const expiresAt = parseDatabaseDate('acquire_dispatch_lease', row.expires_at);
      if (expiresAt.getTime() <= acquiredAt.getTime()) {
        throw protocolFailure('acquire_dispatch_lease');
      }
      return Object.freeze({
        kind: 'acquired',
        leaseId: row.lease_id,
        acquiredAt: acquiredAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
    } catch (error) {
      if (error instanceof SpWritePersistenceError) throw error;
      if (errorCode(error) === '55P03') return Object.freeze({ kind: 'unavailable' });
      throw mapDatabaseError('acquire_dispatch_lease', error);
    }
  }

  async reserveProviderCall(
    input: ReserveSpWriteProviderCallInput,
  ): Promise<SpWriteReservationOutcome> {
    const prepared = parseInput('reserve_provider_call', () => {
      const observation = parsePredispatchObservation(input.observation);
      const intent = parseProviderIntent(input.intent);
      if (
        observation.planId !== intent.planId
        || observation.planFingerprint !== intent.planFingerprint
        || observation.approvalId !== intent.approvalId
        || observation.executionId !== intent.executionId
        || observation.generation !== intent.generation
        || observation.routeKey !== intent.routeKey
        || observation.fingerprint !== intent.providerObservationFingerprint
      ) {
        throw new Error('reservation artifacts disagree');
      }
      return {
        observation,
        observationText: canonicalArtifactText(observation),
        observationPreimage: serializeSpWritePredispatchObservationFingerprint(observation),
        intent,
        intentText: canonicalArtifactText(intent),
        requestPreimage: serializeSpWriteProviderRequestFingerprint(intent),
        intentPreimage: serializeSpWriteProviderCallIntentFingerprint(intent),
      };
    });

    const reservation = await runDatabaseOperation('reserve_provider_call', async () => {
      const rows = await this.sql<ReservationRow[]>`
        select decision, refusal_reason, checked_at, result_id::text, intent_text
          from app.reserve_sp_write_provider_call(
            ${prepared.intent.executionId}::uuid,
            ${prepared.intent.planId}::uuid,
            ${prepared.intent.generation}::uuid,
            ${prepared.intent.dispatchLeaseId}::uuid,
            ${prepared.observationText},
            ${prepared.observationPreimage},
            ${prepared.intentText},
            ${prepared.requestPreimage},
            ${prepared.intentPreimage}
          )
      `;
      return exactSingleRow('reserve_provider_call', rows);
    });
    const checkedAtDate = parseDatabaseDate('reserve_provider_call', reservation.checked_at);
    const checkedAt = checkedAtDate.toISOString();

    if (reservation.decision === 'busy') {
      assertNoReservationAuthority(reservation);
      return Object.freeze({ kind: 'defer_and_reobserve', checkedAt, reason: 'busy' });
    }
    if (reservation.decision === 'already_intended') {
      assertNoReservationAuthority(reservation);
      return Object.freeze({
        kind: 'closed_without_dispatch',
        checkedAt,
        reason: 'already_intended',
      });
    }
    if (reservation.decision === 'refused') {
      if (reservation.result_id !== null || reservation.intent_text !== null) {
        throw protocolFailure('reserve_provider_call');
      }
      let reason: SpWriteRefusalReasonType;
      try {
        reason = SpWriteRefusalReason.parse(reservation.refusal_reason);
      } catch {
        throw protocolFailure('reserve_provider_call');
      }
      return Object.freeze({ kind: 'closed_without_dispatch', checkedAt, reason });
    }
    if (
      reservation.decision !== 'won'
      || reservation.refusal_reason !== null
      || reservation.result_id === null
      || !UUID_PATTERN.test(reservation.result_id)
      || reservation.intent_text !== prepared.intentText
    ) {
      throw protocolFailure('reserve_provider_call');
    }

    const readback = await runDatabaseOperation('read_dispatch_ticket', async () => {
      const rows = await this.sql<DispatchReadbackRow[]>`
        with database_clock as materialized (
          select clock_timestamp() as database_read_at
        )
        select intent.intent_id::text,
               intent.provider_call_id::text,
               intent.reserved_result_id::text,
               intent.execution_id::text,
               intent.plan_id::text,
               intent.approval_id::text,
               intent.generation::text,
               intent.route_key::text,
               intent.dispatch_lease_id::text,
               intent.artifact_text,
               (select count(*)::int
                  from public.sp_write_provider_call_positions position
                 where position.org_id = intent.org_id
                   and position.profile_id = intent.profile_id
                   and position.intent_id = intent.intent_id) as position_count,
               intent.checked_at,
               intent.dispatch_start_deadline,
               intent.provider_attempt_deadline,
               database_clock.database_read_at,
               database_clock.database_read_at >= intent.dispatch_start_deadline
                 as dispatch_window_elapsed
          from public.sp_write_provider_call_intents intent
          cross join database_clock
         where intent.intent_id = ${prepared.intent.intentId}::uuid
           and intent.provider_call_id = ${prepared.intent.providerCallId}::uuid
           and intent.reserved_result_id = ${reservation.result_id}::uuid
           and intent.execution_id = ${prepared.intent.executionId}::uuid
           and intent.plan_id = ${prepared.intent.planId}::uuid
           and intent.approval_id = ${prepared.intent.approvalId}::uuid
           and intent.generation = ${prepared.intent.generation}::uuid
           and intent.route_key = ${prepared.intent.routeKey}::public.sp_write_route_key
           and intent.dispatch_lease_id = ${prepared.intent.dispatchLeaseId}::uuid
      `;
      return exactSingleRow('read_dispatch_ticket', rows);
    });
    if (
      readback.intent_id !== prepared.intent.intentId
      || readback.provider_call_id !== prepared.intent.providerCallId
      || readback.reserved_result_id !== reservation.result_id
      || readback.execution_id !== prepared.intent.executionId
      || readback.plan_id !== prepared.intent.planId
      || readback.approval_id !== prepared.intent.approvalId
      || readback.generation !== prepared.intent.generation
      || readback.route_key !== prepared.intent.routeKey
      || readback.dispatch_lease_id !== prepared.intent.dispatchLeaseId
      || readback.artifact_text !== prepared.intentText
      || readback.position_count !== prepared.intent.positions.length
      || typeof readback.dispatch_window_elapsed !== 'boolean'
    ) {
      throw protocolFailure('read_dispatch_ticket');
    }
    const dispatchStartDeadline = parseDatabaseDate(
      'read_dispatch_ticket',
      readback.dispatch_start_deadline,
    );
    const providerAttemptDeadline = parseDatabaseDate(
      'read_dispatch_ticket',
      readback.provider_attempt_deadline,
    );
    const databaseReadAt = parseDatabaseDate('read_dispatch_ticket', readback.database_read_at);
    const persistedCheckedAt = parseDatabaseDate('read_dispatch_ticket', readback.checked_at);
    if (
      persistedCheckedAt.getTime() !== checkedAtDate.getTime()
      || databaseReadAt.getTime() < persistedCheckedAt.getTime()
      || providerAttemptDeadline.getTime() <= dispatchStartDeadline.getTime()
      || dispatchStartDeadline.getTime() <= checkedAtDate.getTime()
    ) {
      throw protocolFailure('read_dispatch_ticket');
    }
    if (
      readback.dispatch_window_elapsed
      || databaseReadAt.getTime() >= dispatchStartDeadline.getTime()
    ) {
      return Object.freeze({
        kind: 'closed_without_dispatch',
        checkedAt,
        reason: 'dispatch_window_elapsed',
      });
    }
    return Object.freeze({
      kind: 'dispatch_once',
      checkedAt,
      ticket: makeDispatchTicket({
        resultId: reservation.result_id,
        intent: deepFreeze(prepared.intent),
        dispatchStartDeadline: dispatchStartDeadline.toISOString(),
        providerAttemptDeadline: providerAttemptDeadline.toISOString(),
        databaseReadAt: databaseReadAt.toISOString(),
      }),
    });
  }

  appendProviderResult(rawResult: unknown): Promise<SpWriteResultAppendOutcome> {
    return this.appendResult(rawResult, 'provider_adapter', 'append_provider_result');
  }

  appendRecoveryResult(rawResult: unknown): Promise<SpWriteResultAppendOutcome> {
    return this.appendResult(rawResult, 'recovery_synthesized', 'append_recovery_result');
  }

  async appendObservation(rawObservation: unknown): Promise<string> {
    const observation = parseInput('append_observation', () => parseObservation(rawObservation));
    const artifactText = canonicalArtifactText(observation);
    const preimage = serializeSpWriteObservationFingerprint(observation);
    return runDatabaseOperation('append_observation', async () => {
      const rows = await this.sql<{ append_sp_write_observation: string }[]>`
        select app.append_sp_write_observation(
          ${artifactText},
          ${preimage}
        )::text
      `;
      const row = exactSingleRow('append_observation', rows);
      if (row.append_sp_write_observation !== observation.observationId) {
        throw protocolFailure('append_observation');
      }
      return row.append_sp_write_observation;
    });
  }

  async loadVerifiedExecution(
    identity: LoadVerifiedSpWriteExecutionIdentity,
  ): Promise<SpWriteExecutionEvidence | null> {
    const exactIdentity = parseInput('load_verified_execution', () => ({
      orgId: assertUuid(identity.orgId),
      profileId: assertUuid(identity.profileId),
      executionId: assertUuid(identity.executionId),
      planId: assertUuid(identity.planId),
      approvalId: assertUuid(identity.approvalId),
      generation: assertUuid(identity.generation),
    }));
    return runDatabaseOperation('load_verified_execution', async () => {
      const wrapped = await this.sql.begin(
        'isolation level repeatable read read only',
        async (sql) => ({ value: await loadExecutionSnapshot(sql, exactIdentity) }),
      );
      return wrapped.value;
    });
  }

  private async appendResult(
    rawResult: unknown,
    origin: 'provider_adapter' | 'recovery_synthesized',
    operation: 'append_provider_result' | 'append_recovery_result',
  ): Promise<SpWriteResultAppendOutcome> {
    const result = parseInput(operation, () => parseProviderResult(rawResult));
    const artifactText = canonicalArtifactText(result);
    const preimage = serializeSpWriteProviderResultFingerprint(result);
    return runDatabaseOperation(operation, async () => {
      const rows = await this.sql<{ outcome: string }[]>`
        select app.append_sp_write_provider_result(
          ${artifactText},
          ${preimage},
          ${origin}::public.sp_write_result_origin
        ) as outcome
      `;
      const row = exactSingleRow(operation, rows);
      if (!isResultAppendOutcome(row.outcome)) throw protocolFailure(operation);
      return row.outcome;
    });
  }
}

function assertNoReservationAuthority(row: ReservationRow): void {
  if (row.refusal_reason !== null || row.result_id !== null || row.intent_text !== null) {
    throw protocolFailure('reserve_provider_call');
  }
}

function parseDatabaseDate(
  operation: SpWritePersistenceOperation,
  value: Date | string,
): Date {
  try {
    return toDate(value);
  } catch {
    throw protocolFailure(operation);
  }
}

function isResultAppendOutcome(value: string): value is SpWriteResultAppendOutcome {
  return value === 'recorded'
    || value === 'already_recorded'
    || value === 'late_audited'
    || value === 'canonical_result_already_recorded';
}

interface EvidenceRootRow {
  plan_text: string;
  receipt_text: string;
  action_count: number;
}

interface ArtifactCountRow {
  artifact_text: string;
  child_count: number;
}

interface ArtifactRow {
  artifact_text: string;
}

interface AccountingRow {
  approved_rows: number | null;
  pending_dispatch: number | null;
  refused_before_dispatch: number | null;
  intent_committed: number | null;
  provider_accepted: number | null;
  provider_rejected: number | null;
  provider_ambiguous: number | null;
  observed_requested: number | null;
  observed_expected_after_ambiguous: number | null;
  observation_conflict: number | null;
  observation_missing: number | null;
  pending_observation: number | null;
  provider_calls_committed: number | null;
  provider_calls_completed: number | null;
  status: string | null;
}

type TransactionSql = Parameters<Parameters<Sql['begin']>[1]>[0];

async function loadExecutionSnapshot(
  sql: TransactionSql,
  identity: LoadVerifiedSpWriteExecutionIdentity,
): Promise<SpWriteExecutionEvidence | null> {
  const rootRows = await sql<EvidenceRootRow[]>`
    select plan.artifact_text as plan_text,
           receipt.artifact_text as receipt_text,
           (select count(*)::int
              from public.sp_write_plan_actions action
             where action.org_id = plan.org_id
               and action.profile_id = plan.profile_id
               and action.plan_id = plan.plan_id) as action_count
      from public.sp_write_cycle_plans child
      join public.sp_write_plans plan
        on plan.org_id = child.org_id
       and plan.profile_id = child.profile_id
       and plan.plan_id = child.plan_id
      join public.sp_write_authorization_receipts receipt
        on receipt.org_id = child.org_id
       and receipt.profile_id = child.profile_id
       and receipt.execution_id = child.execution_id
       and receipt.approval_id = child.approval_id
       and receipt.generation = child.generation
     where child.org_id = ${identity.orgId}::uuid
       and child.profile_id = ${identity.profileId}::uuid
       and child.execution_id = ${identity.executionId}::uuid
       and child.plan_id = ${identity.planId}::uuid
       and child.approval_id = ${identity.approvalId}::uuid
       and child.generation = ${identity.generation}::uuid
  `;
  if (rootRows.length === 0) return null;
  const root = exactSingleRow('load_verified_execution', rootRows);
  const plan = parseStoredArtifact(root.plan_text, SpWritePlan.parse);
  // Approval receipts are assembled by PostgreSQL and deliberately have no
  // fingerprint preimage. Preserve and parse those DB-owned bytes, but do not
  // impose Node's object-key order on jsonb's textual rendering.
  const receipt = parseStoredDatabaseArtifact(
    root.receipt_text,
    SpWriteAuthorizationReceipt.parse,
  );
  if (
    receipt.approvalId !== identity.approvalId
    || receipt.executionId !== identity.executionId
    || receipt.generation !== identity.generation
  ) {
    throw protocolFailure('load_verified_execution');
  }
  if (root.action_count !== plan.actions.length) throw protocolFailure('load_verified_execution');

  const actionRows = await sql<ArtifactRow[]>`
    select action.artifact_text
      from public.sp_write_plan_actions action
     where action.org_id = ${identity.orgId}::uuid
       and action.profile_id = ${identity.profileId}::uuid
       and action.plan_id = ${identity.planId}::uuid
     order by action.action_index, action.action_id
  `;
  if (
    actionRows.length !== plan.actions.length
    || actionRows.some(
      (row, index) => row.artifact_text !== canonicalArtifactText(plan.actions[index]),
    )
  ) {
    throw protocolFailure('load_verified_execution');
  }

  const [predispatchRows, dispositionRows, intentRows, resultRows, observationRows, accountingRows] =
    await Promise.all([
      sql<ArtifactCountRow[]>`
        select evidence.artifact_text,
               (select count(*)::int
                  from public.sp_write_predispatch_observation_items item
                 where item.org_id = evidence.org_id
                   and item.profile_id = evidence.profile_id
                   and item.observation_id = evidence.observation_id) as child_count
          from public.sp_write_predispatch_observations evidence
         where evidence.org_id = ${identity.orgId}::uuid
           and evidence.profile_id = ${identity.profileId}::uuid
           and evidence.execution_id = ${identity.executionId}::uuid
           and evidence.plan_id = ${identity.planId}::uuid
           and evidence.approval_id = ${identity.approvalId}::uuid
           and evidence.generation = ${identity.generation}::uuid
         order by evidence.observed_at, evidence.observation_id
      `,
      sql<ArtifactRow[]>`
        select evidence.artifact_text
          from public.sp_write_predispatch_dispositions evidence
         where evidence.org_id = ${identity.orgId}::uuid
           and evidence.profile_id = ${identity.profileId}::uuid
           and evidence.execution_id = ${identity.executionId}::uuid
           and evidence.plan_id = ${identity.planId}::uuid
           and evidence.approval_id = ${identity.approvalId}::uuid
           and evidence.generation = ${identity.generation}::uuid
         order by evidence.recorded_at, evidence.action_id
      `,
      sql<ArtifactCountRow[]>`
        select evidence.artifact_text,
               (select count(*)::int
                  from public.sp_write_provider_call_positions position
                 where position.org_id = evidence.org_id
                   and position.profile_id = evidence.profile_id
                   and position.intent_id = evidence.intent_id) as child_count
          from public.sp_write_provider_call_intents evidence
         where evidence.org_id = ${identity.orgId}::uuid
           and evidence.profile_id = ${identity.profileId}::uuid
           and evidence.execution_id = ${identity.executionId}::uuid
           and evidence.plan_id = ${identity.planId}::uuid
           and evidence.approval_id = ${identity.approvalId}::uuid
           and evidence.generation = ${identity.generation}::uuid
         order by evidence.recorded_at, evidence.intent_id
      `,
      sql<ArtifactCountRow[]>`
        select result.artifact_text,
               (select count(*)::int
                  from public.sp_write_provider_result_positions position
                 where position.org_id = result.org_id
                   and position.profile_id = result.profile_id
                   and position.result_id = result.result_id) as child_count
          from public.sp_write_provider_results result
          join public.sp_write_provider_call_intents intent
            on intent.org_id = result.org_id
           and intent.profile_id = result.profile_id
           and intent.intent_id = result.intent_id
         where intent.org_id = ${identity.orgId}::uuid
           and intent.profile_id = ${identity.profileId}::uuid
           and intent.execution_id = ${identity.executionId}::uuid
           and intent.plan_id = ${identity.planId}::uuid
           and intent.approval_id = ${identity.approvalId}::uuid
           and intent.generation = ${identity.generation}::uuid
         order by result.completed_at, result.result_id
      `,
      sql<ArtifactRow[]>`
        select evidence.artifact_text
          from public.sp_write_observations evidence
         where evidence.org_id = ${identity.orgId}::uuid
           and evidence.profile_id = ${identity.profileId}::uuid
           and evidence.execution_id = ${identity.executionId}::uuid
           and evidence.plan_id = ${identity.planId}::uuid
           and evidence.approval_id = ${identity.approvalId}::uuid
           and evidence.generation = ${identity.generation}::uuid
         order by evidence.observed_at, evidence.action_id
      `,
      sql<AccountingRow[]>`
        select approved_rows, pending_dispatch, refused_before_dispatch,
               intent_committed, provider_accepted, provider_rejected,
               provider_ambiguous, observed_requested,
               observed_expected_after_ambiguous, observation_conflict,
               observation_missing, pending_observation,
               provider_calls_committed, provider_calls_completed, status
          from public.sp_write_execution_accounting accounting
         where accounting.org_id = ${identity.orgId}::uuid
           and accounting.profile_id = ${identity.profileId}::uuid
           and accounting.execution_id = ${identity.executionId}::uuid
           and accounting.plan_id = ${identity.planId}::uuid
      `,
    ]);

  const predispatchObservations = predispatchRows.map((row) => {
    const artifact = parseStoredArtifact(row.artifact_text, SpWritePredispatchObservation.parse);
    if (row.child_count !== artifact.items.length) throw protocolFailure('load_verified_execution');
    return artifact;
  });
  const predispatchDispositions = dispositionRows.map((row) =>
    parseStoredArtifact(row.artifact_text, SpWritePreDispatchDisposition.parse));
  const providerCallIntents = intentRows.map((row) => {
    const artifact = parseStoredArtifact(row.artifact_text, SpWriteProviderCallIntent.parse);
    if (row.child_count !== artifact.positions.length) throw protocolFailure('load_verified_execution');
    return artifact;
  });
  const providerResults = resultRows.map((row) => {
    const artifact = parseStoredArtifact(row.artifact_text, SpWriteProviderResult.parse);
    if (row.child_count !== artifact.positions.length) throw protocolFailure('load_verified_execution');
    return artifact;
  });
  const observations = observationRows.map((row) =>
    parseStoredArtifact(row.artifact_text, SpWriteObservation.parse));

  let derivedSnapshot: SpWriteExecutionSnapshot;
  try {
    derivedSnapshot = deriveSpWriteExecutionSnapshot({
      plan,
      authorization: receipt,
      predispatchObservations,
      predispatchDispositions,
      providerCallIntents,
      providerResults,
      observations,
    });
  } catch {
    throw protocolFailure('load_verified_execution');
  }
  const accounting = accountingFromRow(exactSingleRow('load_verified_execution', accountingRows));
  let databaseSnapshot: SpWriteExecutionSnapshot;
  try {
    databaseSnapshot = SpWriteExecutionSnapshot.parse({
      accounting,
      status: SpWriteExecutionStatus.parse(
        exactSingleRow('load_verified_execution', accountingRows).status,
      ),
    });
  } catch {
    throw protocolFailure('load_verified_execution');
  }
  if (canonicalArtifactText(databaseSnapshot) !== canonicalArtifactText(derivedSnapshot)) {
    throw protocolFailure('load_verified_execution');
  }
  try {
    return verifySpWriteExecutionEvidence(
      {
        plan,
        authorization: receipt,
        predispatchObservations,
        predispatchDispositions,
        providerCallIntents,
        providerResults,
        observations,
        snapshot: derivedSnapshot,
      },
      sha256Hasher,
    );
  } catch {
    throw protocolFailure('load_verified_execution');
  }
}

function parseStoredArtifact<T>(text: string, parse: (value: unknown) => T): T {
  try {
    const value: unknown = JSON.parse(text);
    const artifact = parse(value);
    if (canonicalArtifactText(artifact) !== text) throw new Error('noncanonical artifact text');
    return artifact;
  } catch {
    throw protocolFailure('load_verified_execution');
  }
}

function parseStoredDatabaseArtifact<T>(text: string, parse: (value: unknown) => T): T {
  try {
    return parse(JSON.parse(text) as unknown);
  } catch {
    throw protocolFailure('load_verified_execution');
  }
}

function accountingFromRow(row: AccountingRow) {
  try {
    return SpWriteAccounting.parse({
      approvedRows: row.approved_rows,
      pendingDispatch: row.pending_dispatch,
      refusedBeforeDispatch: row.refused_before_dispatch,
      intentCommitted: row.intent_committed,
      providerAccepted: row.provider_accepted,
      providerRejected: row.provider_rejected,
      providerAmbiguous: row.provider_ambiguous,
      observedRequested: row.observed_requested,
      observedExpectedAfterAmbiguous: row.observed_expected_after_ambiguous,
      observationConflict: row.observation_conflict,
      observationMissing: row.observation_missing,
      pendingObservation: row.pending_observation,
      providerCallsCommitted: row.provider_calls_committed,
      providerCallsCompleted: row.provider_calls_completed,
    });
  } catch {
    throw protocolFailure('load_verified_execution');
  }
}

export function createSpWriteStagingLedger(
  handle: SpWritePersistenceHandle,
): SpWriteStagingLedger {
  return new DefaultSpWriteStagingLedger(requireRootSql(handle, 'create_staging_ledger'));
}

export function createSpWriteRuntimeLedger(
  handle: SpWritePersistenceHandle,
): SpWriteRuntimeLedger {
  return new DefaultSpWriteRuntimeLedger(requireRootSql(handle, 'create_runtime_ledger'));
}
