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
const BIGINT_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/u;
const CLAIMANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const OUTBOX_KINDS = new Set<SpWriteOutboxKind>(['dispatch', 'observe_and_recover']);
const DEFER_REASONS = new Set<SpWriteDeferReason>([
  'reservation_busy',
  'observation_pending',
  'recovery_pending',
  'shutdown',
]);

/** Raw delivery credentials are retained only against exact in-process claim objects. */
const spWriteOutboxClaimTokens = new WeakMap<SpWriteOutboxClaim, string>();

const sha256Hasher: SpWriteSha256Hasher = {
  algorithm: 'sha256',
  digest: (preimage) => createHash('sha256').update(preimage, 'utf8').digest('hex'),
};

export type SpWritePersistenceOperation =
  | 'create_staging_ledger'
  | 'create_runtime_ledger'
  | 'create_outbox_ledger'
  | 'record_plan'
  | 'record_bounded_authorization'
  | 'start_execution'
  | 'claim_outbox'
  | 'renew_outbox_claim'
  | 'defer_outbox_claim'
  | 'complete_outbox_claim'
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

export type SpWriteOutboxKind = 'dispatch' | 'observe_and_recover';

export type SpWriteOutboxClaimBase = Readonly<{
  outboxId: string;
  orgId: string;
  profileId: string;
  executionId: string;
  planId: string;
  approvalId: string;
  generation: string;
  claimEpoch: string;
  claimedAt: string;
  expiresAt: string;
  toJSON(): never;
}>;

export type SpWriteDispatchOutboxClaim = SpWriteOutboxClaimBase & Readonly<{
  kind: 'dispatch';
  providerCallId?: never;
  intentId?: never;
  sourceSyncJobId?: never;
}>;

export type SpWriteObserveAndRecoverOutboxClaim = SpWriteOutboxClaimBase & Readonly<{
  kind: 'observe_and_recover';
  providerCallId: string;
  intentId: string;
  sourceSyncJobId: string;
}>;

export type SpWriteOutboxClaim =
  | SpWriteDispatchOutboxClaim
  | SpWriteObserveAndRecoverOutboxClaim;

export interface ClaimSpWriteOutboxInput {
  claimantId: string;
  kinds: readonly SpWriteOutboxKind[];
  limit: number;
  leaseSeconds?: number;
}

export type SpWriteOutboxClaimBatch = Readonly<{
  offeredCount: number;
  claimedCount: number;
  claims: readonly SpWriteOutboxClaim[];
}>;

export type SpWriteRenewOutcome =
  | Readonly<{ kind: 'renewed'; expiresAt: string }>
  | Readonly<{ kind: 'renewal_limit_reached'; expiresAt: string }>
  | Readonly<{ kind: 'stale_claim' }>;

export type SpWriteDeferReason =
  | 'reservation_busy'
  | 'observation_pending'
  | 'recovery_pending'
  | 'shutdown';

export type SpWriteDeferOutcome =
  | Readonly<{
      kind: 'deferred' | 'already_deferred';
      reason: SpWriteDeferReason;
      availableAt: string;
    }>
  | Readonly<{ kind: 'stale_claim' }>;

export type SpWriteCompleteOutcome =
  | Readonly<{ kind: 'completed' | 'already_completed'; completedAt: string }>
  | Readonly<{ kind: 'not_complete' | 'stale_claim' }>;

export interface AcquireSpWriteDispatchLeaseInput {
  claim: SpWriteDispatchOutboxClaim;
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
  claim: SpWriteDispatchOutboxClaim;
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
        | 'claim_unavailable'
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

export interface SpWriteOutboxLedger {
  claimAvailable(input: unknown): Promise<SpWriteOutboxClaimBatch>;
  renewClaim(
    claim: SpWriteOutboxClaim,
    leaseSeconds: number,
  ): Promise<SpWriteRenewOutcome>;
  deferClaim(
    claim: SpWriteOutboxClaim,
    reason: SpWriteDeferReason,
  ): Promise<SpWriteDeferOutcome>;
  completeClaim(claim: SpWriteOutboxClaim): Promise<SpWriteCompleteOutcome>;
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
  const claimBoundRecovery = operation === 'acquire_dispatch_lease'
    || operation === 'reserve_provider_call'
    || operation === 'read_dispatch_ticket';
  if (code === '22023' || code === '22P02') {
    return new SpWritePersistenceError(
      operation,
      'invalid_artifact',
      claimBoundRecovery ? 'reconcile_only' : 'stop',
    );
  }
  if (code === '42501') {
    return new SpWritePersistenceError(
      operation,
      'permission_denied',
      claimBoundRecovery ? 'reconcile_only' : 'stop',
    );
  }
  if (code === '23503' || code === 'P0002') {
    return new SpWritePersistenceError(
      operation,
      'missing_dependency',
      claimBoundRecovery ? 'reconcile_only' : 'reload_state',
    );
  }
  if (code === '23505' || code === 'P0003') {
    return new SpWritePersistenceError(
      operation,
      'identity_or_protocol_conflict',
      claimBoundRecovery ? 'reconcile_only' : 'reload_state',
    );
  }
  if (code === '55000') {
    return new SpWritePersistenceError(
      operation,
      'authority_unavailable',
      claimBoundRecovery ? 'reconcile_only' : 'reload_state',
    );
  }
  if (code === '55P03' || code === '40001' || code === '40P01' || code === '57014') {
    return new SpWritePersistenceError(
      operation,
      'transaction_aborted',
      claimBoundRecovery ? 'reconcile_only' : 'reload_state',
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

function assertClaimEpoch(value: string): string {
  if (!BIGINT_DECIMAL_PATTERN.test(value) || BigInt(value) < 1n) {
    throw new Error('invalid claim epoch');
  }
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
  operation: 'create_staging_ledger' | 'create_runtime_ledger' | 'create_outbox_ledger',
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

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function assertLeaseSeconds(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 70 || (value as number) > 300) {
    throw new Error('invalid lease duration');
  }
  return value as number;
}

function claimToken(
  operation: SpWritePersistenceOperation,
  claim: SpWriteOutboxClaim,
  expectedKind?: SpWriteOutboxKind,
): string {
  const token = spWriteOutboxClaimTokens.get(claim);
  if (token === undefined || (expectedKind !== undefined && claim.kind !== expectedKind)) {
    throw invalidArtifact(operation);
  }
  return token;
}

interface OutboxClaimRow {
  offered_count: number;
  claimed_count: number;
  claim_ordinal: number | null;
  outbox_id: string | null;
  org_id: string | null;
  profile_id: string | null;
  execution_id: string | null;
  plan_id: string | null;
  approval_id: string | null;
  generation: string | null;
  kind: string | null;
  provider_call_id: string | null;
  intent_id: string | null;
  source_sync_job_id: string | null;
  claim_epoch: string | null;
  claimed_at: Date | string | null;
  lease_expires_at: Date | string | null;
  claim_token: string | null;
}

const OUTBOX_CLAIM_ROW_KEYS = [
  'offered_count',
  'claimed_count',
  'claim_ordinal',
  'outbox_id',
  'org_id',
  'profile_id',
  'execution_id',
  'plan_id',
  'approval_id',
  'generation',
  'kind',
  'provider_call_id',
  'intent_id',
  'source_sync_job_id',
  'claim_epoch',
  'claimed_at',
  'lease_expires_at',
  'claim_token',
] as const;

function parseClaimBatch(
  rows: readonly OutboxClaimRow[],
  expectedKinds: readonly SpWriteOutboxKind[],
  expectedLimit: number,
  expectedLeaseSeconds: number,
): SpWriteOutboxClaimBatch {
  if (rows.length === 0 || rows.some((row) => !hasExactKeys(row, OUTBOX_CLAIM_ROW_KEYS))) {
    throw protocolFailure('claim_outbox');
  }
  const header = rows[0];
  if (
    header === undefined
    || !Number.isInteger(header.offered_count)
    || !Number.isInteger(header.claimed_count)
    || header.offered_count < 0
    || header.offered_count > 10
    || header.offered_count > expectedLimit
    || header.claimed_count < 0
    || header.claimed_count > header.offered_count
  ) {
    throw protocolFailure('claim_outbox');
  }
  if (header.claimed_count === 0) {
    if (
      rows.length !== 1
      || header.offered_count !== 0
      || OUTBOX_CLAIM_ROW_KEYS.slice(2).some((key) => header[key] !== null)
    ) {
      throw protocolFailure('claim_outbox');
    }
    return Object.freeze({
      offeredCount: 0,
      claimedCount: 0,
      claims: Object.freeze([]),
    });
  }
  if (header.offered_count !== header.claimed_count || rows.length !== header.claimed_count) {
    throw protocolFailure('claim_outbox');
  }

  const identities = new Set<string>();
  const tokens = new Set<string>();
  const parsed = rows.map((row, index) => {
    if (
      row.offered_count !== header.offered_count
      || row.claimed_count !== header.claimed_count
      || row.claim_ordinal !== index + 1
      || row.outbox_id === null
      || row.org_id === null
      || row.profile_id === null
      || row.execution_id === null
      || row.plan_id === null
      || row.approval_id === null
      || row.generation === null
      || row.kind === null
      || row.claim_epoch === null
      || row.claimed_at === null
      || row.lease_expires_at === null
      || row.claim_token === null
      || !UUID_PATTERN.test(row.outbox_id)
      || !UUID_PATTERN.test(row.org_id)
      || !UUID_PATTERN.test(row.profile_id)
      || !UUID_PATTERN.test(row.execution_id)
      || !UUID_PATTERN.test(row.plan_id)
      || !UUID_PATTERN.test(row.approval_id)
      || !UUID_PATTERN.test(row.generation)
      || !UUID_PATTERN.test(row.claim_token)
      || !BIGINT_DECIMAL_PATTERN.test(row.claim_epoch)
      || BigInt(row.claim_epoch) < 1n
      || BigInt(row.claim_epoch) > 9_223_372_036_854_775_807n
      || !OUTBOX_KINDS.has(row.kind as SpWriteOutboxKind)
      || !expectedKinds.includes(row.kind as SpWriteOutboxKind)
      || identities.has(row.outbox_id)
      || tokens.has(row.claim_token)
    ) {
      throw protocolFailure('claim_outbox');
    }
    identities.add(row.outbox_id);
    tokens.add(row.claim_token);
    const claimedAt = parseDatabaseDate('claim_outbox', row.claimed_at);
    const expiresAt = parseDatabaseDate('claim_outbox', row.lease_expires_at);
    if (expiresAt.getTime() - claimedAt.getTime() !== expectedLeaseSeconds * 1_000) {
      throw protocolFailure('claim_outbox');
    }
    if (row.kind === 'dispatch') {
      if (
        row.provider_call_id !== null
        || row.intent_id !== null
        || row.source_sync_job_id !== null
      ) {
        throw protocolFailure('claim_outbox');
      }
    } else if (
      row.provider_call_id === null
      || row.intent_id === null
      || row.source_sync_job_id === null
      || !UUID_PATTERN.test(row.provider_call_id)
      || !UUID_PATTERN.test(row.intent_id)
      || !UUID_PATTERN.test(row.source_sync_job_id)
    ) {
      throw protocolFailure('claim_outbox');
    }
    return {
      row,
      claimedAt: claimedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  });

  const claims = parsed.map(({ row, claimedAt, expiresAt }) => {
    const common = {
      outboxId: row.outbox_id as string,
      orgId: row.org_id as string,
      profileId: row.profile_id as string,
      executionId: row.execution_id as string,
      planId: row.plan_id as string,
      approvalId: row.approval_id as string,
      generation: row.generation as string,
      claimEpoch: row.claim_epoch as string,
      claimedAt,
      expiresAt,
      toJSON(): never {
        throw protocolFailure('claim_outbox');
      },
    };
    const claim: SpWriteOutboxClaim = row.kind === 'dispatch'
      ? Object.freeze({ ...common, kind: 'dispatch' as const })
      : Object.freeze({
          ...common,
          kind: 'observe_and_recover' as const,
          providerCallId: row.provider_call_id as string,
          intentId: row.intent_id as string,
          sourceSyncJobId: row.source_sync_job_id as string,
        });
    spWriteOutboxClaimTokens.set(claim, row.claim_token as string);
    return claim;
  });
  return Object.freeze({
    offeredCount: header.offered_count,
    claimedCount: header.claimed_count,
    claims: Object.freeze(claims),
  });
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
          ${JSON.stringify(actionProofs)}::text::jsonb
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
          ${JSON.stringify(prepared.bindings)}::text::jsonb
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

class DefaultSpWriteOutboxLedger implements SpWriteOutboxLedger {
  constructor(private readonly sql: Sql) {}

  async claimAvailable(input: unknown): Promise<SpWriteOutboxClaimBatch> {
    const prepared = parseInput('claim_outbox', () => {
      if (!hasExactKeys(input, ['claimantId', 'kinds', 'limit', 'leaseSeconds'])
        && !hasExactKeys(input, ['claimantId', 'kinds', 'limit'])) {
        throw new Error('invalid claim input');
      }
      const claimantId = input.claimantId;
      const kinds = input.kinds;
      const limit = input.limit;
      const leaseSeconds = 'leaseSeconds' in input ? (input.leaseSeconds ?? 120) : 120;
      if (
        typeof claimantId !== 'string'
        || !CLAIMANT_ID_PATTERN.test(claimantId)
        || !Array.isArray(kinds)
        || kinds.length === 0
        || kinds.length > 2
        || !kinds.every((kind): kind is SpWriteOutboxKind =>
          typeof kind === 'string' && OUTBOX_KINDS.has(kind as SpWriteOutboxKind))
        || new Set(kinds).size !== kinds.length
        || !Number.isInteger(limit)
        || (limit as number) < 1
        || (limit as number) > 10
      ) {
        throw new Error('invalid claim input');
      }
      return {
        claimantId,
        kinds,
        limit: limit as number,
        leaseSeconds: assertLeaseSeconds(leaseSeconds),
      };
    });

    return runDatabaseOperation('claim_outbox', async () => {
      const rows = await this.sql<OutboxClaimRow[]>`
        select offered_count, claimed_count, claim_ordinal,
               outbox_id::text, org_id::text, profile_id::text,
               execution_id::text, plan_id::text, approval_id::text,
               generation::text, kind::text, provider_call_id::text,
               intent_id::text, source_sync_job_id::text, claim_epoch::text,
               claimed_at, lease_expires_at, claim_token::text
          from app.claim_sp_write_outbox(
            ${prepared.claimantId},
            ${this.sql.array([...prepared.kinds])}::public.sp_write_outbox_kind[],
            ${prepared.limit},
            ${prepared.leaseSeconds}
          )
      `;
      return parseClaimBatch(rows, prepared.kinds, prepared.limit, prepared.leaseSeconds);
    });
  }

  async renewClaim(
    claim: SpWriteOutboxClaim,
    leaseSeconds: number,
  ): Promise<SpWriteRenewOutcome> {
    const prepared = parseInput('renew_outbox_claim', () => ({
      outboxId: assertUuid(claim.outboxId),
      claimEpoch: assertClaimEpoch(claim.claimEpoch),
      leaseSeconds: assertLeaseSeconds(leaseSeconds),
    }));
    const token = parseInput('renew_outbox_claim', () =>
      claimToken('renew_outbox_claim', claim));
    return runDatabaseOperation('renew_outbox_claim', async () => {
      const rows = await this.sql<{
        decision: string;
        checked_at: Date | string;
        expires_at: Date | string | null;
      }[]>`
        select decision, checked_at, expires_at
          from app.renew_sp_write_outbox_claim(
            ${prepared.outboxId}::uuid,
            ${prepared.claimEpoch}::bigint,
            ${token}::uuid,
            ${prepared.leaseSeconds}
          )
      `;
      const row = exactSingleRow('renew_outbox_claim', rows);
      if (!hasExactKeys(row, ['decision', 'checked_at', 'expires_at'])) {
        throw protocolFailure('renew_outbox_claim');
      }
      const checkedAt = parseDatabaseDate('renew_outbox_claim', row.checked_at);
      if (row.decision === 'stale_claim' && row.expires_at === null) {
        return Object.freeze({ kind: 'stale_claim' });
      }
      if (
        (row.decision !== 'renewed' && row.decision !== 'renewal_limit_reached')
        || row.expires_at === null
      ) {
        throw protocolFailure('renew_outbox_claim');
      }
      const expiresAt = parseDatabaseDate('renew_outbox_claim', row.expires_at);
      if (expiresAt.getTime() <= checkedAt.getTime()) {
        throw protocolFailure('renew_outbox_claim');
      }
      return Object.freeze({
        kind: row.decision,
        expiresAt: expiresAt.toISOString(),
      });
    });
  }

  async deferClaim(
    claim: SpWriteOutboxClaim,
    reason: SpWriteDeferReason,
  ): Promise<SpWriteDeferOutcome> {
    const prepared = parseInput('defer_outbox_claim', () => {
      if (!DEFER_REASONS.has(reason)) throw new Error('invalid defer reason');
      return {
        outboxId: assertUuid(claim.outboxId),
        claimEpoch: assertClaimEpoch(claim.claimEpoch),
        reason,
      };
    });
    const token = parseInput('defer_outbox_claim', () =>
      claimToken('defer_outbox_claim', claim));
    return runDatabaseOperation('defer_outbox_claim', async () => {
      const rows = await this.sql<{
        decision: string;
        reason: string | null;
        checked_at: Date | string;
        available_at: Date | string | null;
      }[]>`
        select decision, reason, checked_at, available_at
          from app.defer_sp_write_outbox_claim(
            ${prepared.outboxId}::uuid,
            ${prepared.claimEpoch}::bigint,
            ${token}::uuid,
            ${prepared.reason}
          )
      `;
      const row = exactSingleRow('defer_outbox_claim', rows);
      if (!hasExactKeys(row, ['decision', 'reason', 'checked_at', 'available_at'])) {
        throw protocolFailure('defer_outbox_claim');
      }
      const checkedAt = parseDatabaseDate('defer_outbox_claim', row.checked_at);
      if (
        row.decision === 'stale_claim'
        && row.reason === null
        && row.available_at === null
      ) {
        return Object.freeze({ kind: 'stale_claim' });
      }
      if (
        (row.decision !== 'deferred' && row.decision !== 'already_deferred')
        || row.reason !== prepared.reason
        || row.available_at === null
      ) {
        throw protocolFailure('defer_outbox_claim');
      }
      const availableAt = parseDatabaseDate('defer_outbox_claim', row.available_at);
      const claimedAt = parseDatabaseDate('defer_outbox_claim', claim.claimedAt);
      if (
        checkedAt.getTime() < claimedAt.getTime()
        || availableAt.getTime() <= claimedAt.getTime()
        || (row.decision === 'deferred' && availableAt.getTime() <= checkedAt.getTime())
      ) {
        throw protocolFailure('defer_outbox_claim');
      }
      return Object.freeze({
        kind: row.decision,
        reason: prepared.reason,
        availableAt: availableAt.toISOString(),
      });
    });
  }

  async completeClaim(claim: SpWriteOutboxClaim): Promise<SpWriteCompleteOutcome> {
    const prepared = parseInput('complete_outbox_claim', () => ({
      outboxId: assertUuid(claim.outboxId),
      claimEpoch: assertClaimEpoch(claim.claimEpoch),
    }));
    const token = parseInput('complete_outbox_claim', () =>
      claimToken('complete_outbox_claim', claim));
    return runDatabaseOperation('complete_outbox_claim', async () => {
      const rows = await this.sql<{
        decision: string;
        checked_at: Date | string;
        completed_at: Date | string | null;
      }[]>`
        select decision, checked_at, completed_at
          from app.complete_sp_write_outbox_claim(
            ${prepared.outboxId}::uuid,
            ${prepared.claimEpoch}::bigint,
            ${token}::uuid
          )
      `;
      const row = exactSingleRow('complete_outbox_claim', rows);
      if (!hasExactKeys(row, ['decision', 'checked_at', 'completed_at'])) {
        throw protocolFailure('complete_outbox_claim');
      }
      const checkedAt = parseDatabaseDate('complete_outbox_claim', row.checked_at);
      if (
        (row.decision === 'stale_claim' || row.decision === 'not_complete')
        && row.completed_at === null
      ) {
        return Object.freeze({ kind: row.decision });
      }
      if (
        (row.decision !== 'completed' && row.decision !== 'already_completed')
        || row.completed_at === null
      ) {
        throw protocolFailure('complete_outbox_claim');
      }
      const completedAt = parseDatabaseDate('complete_outbox_claim', row.completed_at);
      const claimedAt = parseDatabaseDate('complete_outbox_claim', claim.claimedAt);
      if (
        checkedAt.getTime() < claimedAt.getTime()
        || completedAt.getTime() < claimedAt.getTime()
        || completedAt.getTime() > checkedAt.getTime()
        || (row.decision === 'completed' && completedAt.getTime() !== checkedAt.getTime())
      ) {
        throw protocolFailure('complete_outbox_claim');
      }
      return Object.freeze({
        kind: row.decision,
        completedAt: completedAt.toISOString(),
      });
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
      const claim = input.claim;
      return {
        outboxId: assertUuid(claim.outboxId),
        claimEpoch: assertClaimEpoch(claim.claimEpoch),
        routeKey: SpWriteRouteKey.parse(input.routeKey),
        leaseSeconds: assertLeaseSeconds(input.leaseSeconds ?? 120),
      };
    });
    const token = parseInput('acquire_dispatch_lease', () =>
      claimToken('acquire_dispatch_lease', input.claim, 'dispatch'));
    try {
      const rows = await this.sql<{
        lease_id: string;
        acquired_at: Date | string;
        expires_at: Date | string;
      }[]>`
        select lease_id::text, acquired_at, expires_at
          from app.acquire_sp_write_dispatch_lease_for_claim(
            ${prepared.outboxId}::uuid,
            ${prepared.claimEpoch}::bigint,
            ${token}::uuid,
            ${prepared.routeKey}::public.sp_write_route_key,
            ${prepared.leaseSeconds}
          )
      `;
      const row = exactSingleRow('acquire_dispatch_lease', rows);
      if (!hasExactKeys(row, ['lease_id', 'acquired_at', 'expires_at'])) {
        throw protocolFailure('acquire_dispatch_lease');
      }
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
      const claim = input.claim;
      const observation = parsePredispatchObservation(input.observation);
      const intent = parseProviderIntent(input.intent);
      if (
        claim.executionId !== intent.executionId
        || claim.planId !== intent.planId
        || claim.approvalId !== intent.approvalId
        || claim.generation !== intent.generation
        || observation.planId !== intent.planId
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
        outboxId: assertUuid(claim.outboxId),
        claimEpoch: assertClaimEpoch(claim.claimEpoch),
        observation,
        observationText: canonicalArtifactText(observation),
        observationPreimage: serializeSpWritePredispatchObservationFingerprint(observation),
        intent,
        intentText: canonicalArtifactText(intent),
        requestPreimage: serializeSpWriteProviderRequestFingerprint(intent),
        intentPreimage: serializeSpWriteProviderCallIntentFingerprint(intent),
      };
    });
    const token = parseInput('reserve_provider_call', () =>
      claimToken('reserve_provider_call', input.claim, 'dispatch'));

    const reservation = await runDatabaseOperation('reserve_provider_call', async () => {
      const rows = await this.sql<ReservationRow[]>`
        select decision, refusal_reason, checked_at, result_id::text, intent_text
          from app.reserve_sp_write_provider_call_for_claim(
            ${prepared.outboxId}::uuid,
            ${prepared.claimEpoch}::bigint,
            ${token}::uuid,
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
      const row = exactSingleRow('reserve_provider_call', rows);
      if (!hasExactKeys(
        row,
        ['decision', 'refusal_reason', 'checked_at', 'result_id', 'intent_text'],
      )) {
        throw protocolFailure('reserve_provider_call');
      }
      return row;
    });
    const checkedAtDate = parseDatabaseDate('reserve_provider_call', reservation.checked_at);
    const checkedAt = checkedAtDate.toISOString();

    if (reservation.decision === 'claim_unavailable') {
      assertNoReservationAuthority(reservation);
      return Object.freeze({
        kind: 'closed_without_dispatch',
        checkedAt,
        reason: 'claim_unavailable',
      });
    }
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
      const row = exactSingleRow('read_dispatch_ticket', rows);
      if (!hasExactKeys(row, [
        'intent_id',
        'provider_call_id',
        'reserved_result_id',
        'execution_id',
        'plan_id',
        'approval_id',
        'generation',
        'route_key',
        'dispatch_lease_id',
        'artifact_text',
        'position_count',
        'checked_at',
        'dispatch_start_deadline',
        'provider_attempt_deadline',
        'database_read_at',
        'dispatch_window_elapsed',
      ])) {
        throw protocolFailure('read_dispatch_ticket');
      }
      return row;
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

export function createSpWriteOutboxLedger(
  handle: SpWritePersistenceHandle,
): SpWriteOutboxLedger {
  return new DefaultSpWriteOutboxLedger(requireRootSql(handle, 'create_outbox_ledger'));
}
