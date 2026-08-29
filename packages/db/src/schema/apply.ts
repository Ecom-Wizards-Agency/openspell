/**
 * Staged applies and harvesting maps. Schema in v1, written in v1.x.
 *
 * Mirrors `supabase/migrations/20260813120700_writes.sql`, which is itself a
 * port of the Python staged-apply ledger. `clicks` and `revenue` ride along on
 * a row because the caps-are-ceilings validator reads them.
 */
import {
  boolean,
  bigint,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { ApplyValue } from '@wizard-ads/shared';
import type { AmazonWriteAction, AmazonWriteProviderEvidence } from '@wizard-ads/shared';
import { count, money, ts } from './columns.js';
import {
  amazonWriteActionType,
  amazonWriteApprovalMode,
  amazonWriteAttemptOutcome,
  amazonWriteExecutionDirection,
  amazonWriteExecutionStatus,
  amazonWriteObservationStatus,
  amazonWriteProviderCallEventType,
  amazonWriteProviderCallOutcome,
  amazonWriteRowStatus,
  applyBatchStatus,
  applyEntityType,
  matchType,
} from './enums.js';
import { adProfiles, authUsers, orgs } from './tenancy.js';

export const applyBatches = pgTable(
  'apply_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => adProfiles.id, { onDelete: 'cascade' }),
    /** `<client>-<YYYY>W<ww>-<group>-<lever>`, as the Python flow tags them. */
    tag: text('tag').notNull(),
    /** One opt group per batch. Never a whole account. */
    optGroup: text('opt_group').notNull(),
    lever: text('lever').notNull(),
    note: text('note').notNull(),
    status: applyBatchStatus('status').notNull().default('staged'),
    appliedOn: date('applied_on'),
    cooldownDays: integer('cooldown_days').notNull().default(7),
    /** A reason, not a flag: "why was the cooldown overridden" is the question. */
    cooldownBypass: text('cooldown_bypass'),
    score: jsonb('score'),
    revertedAt: ts('reverted_at'),
    revertNote: text('revert_note'),
    /** A reversion export points to the immutable batch it inverses. */
    sourceBatchId: uuid('source_batch_id'),
    exportedAt: ts('exported_at').notNull().defaultNow(),
    appliedAt: ts('applied_at'),
    artifactSha256: text('artifact_sha256'),
    exportedProposals: integer('exported_proposals').notNull().default(0),
    reversibleRows: integer('reversible_rows').notNull().default(0),
    unsupportedRows: integer('unsupported_rows').notNull().default(0),
    createdBy: uuid('created_by').references(() => authUsers.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('apply_batches_profile_idx').on(t.profileId, t.appliedOn),
    uniqueIndex('apply_batches_org_profile_id_key').on(t.orgId, t.profileId, t.id),
    uniqueIndex('apply_batches_active_reversion_key')
      .on(t.sourceBatchId)
      .where(sql`${t.sourceBatchId} is not null and ${t.status} <> 'abandoned'`),
  ],
);

export const applyRows = pgTable(
  'apply_rows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => applyBatches.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => adProfiles.id, { onDelete: 'cascade' }),
    recommendationId: uuid('recommendation_id'),
    artifactOrdinal: bigint('artifact_ordinal', { mode: 'number' }).notNull().generatedByDefaultAsIdentity(),
    entityType: applyEntityType('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    entityName: text('entity_name'),
    field: text('field').notNull(),
    oldValue: jsonb('old_value').$type<ApplyValue>(),
    newValue: jsonb('new_value').$type<ApplyValue>(),
    lever: text('lever'),
    clicks: count('clicks'),
    revenue: money('revenue'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('apply_rows_batch_idx').on(t.batchId),
    uniqueIndex('apply_rows_org_profile_id_key').on(t.orgId, t.profileId, t.id),
    index('apply_rows_profile_entity_idx').on(
      t.orgId,
      t.profileId,
      t.entityType,
      t.entityId,
      t.field,
    ),
  ],
);

/** Immutable evidence that an operator approved one exact export artifact. */
export const amazonWriteApprovals = pgTable(
  'amazon_write_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull().references(() => adProfiles.id, { onDelete: 'cascade' }),
    applyBatchId: uuid('apply_batch_id').notNull().references(() => applyBatches.id, { onDelete: 'cascade' }),
    mode: amazonWriteApprovalMode('mode').notNull(),
    previewSha256: text('preview_sha256').notNull(),
    approvedCount: integer('approved_count').notNull(),
    approvedBy: uuid('approved_by').notNull().references(() => authUsers.id, { onDelete: 'restrict' }),
    approvedAt: ts('approved_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    inversePreapproved: boolean('inverse_preapproved').notNull().default(false),
    authorizationId: uuid('authorization_id'),
    authorizationSha256: text('authorization_sha256'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('amazon_write_approvals_profile_idx').on(t.orgId, t.profileId, t.approvedAt),
    uniqueIndex('amazon_write_approvals_org_profile_id_key').on(t.orgId, t.profileId, t.id),
  ],
);

/** One replay-safe worker execution for one immutable apply batch. */
export const amazonWriteExecutions = pgTable(
  'amazon_write_executions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull().references(() => adProfiles.id, { onDelete: 'cascade' }),
    applyBatchId: uuid('apply_batch_id').notNull().references(() => applyBatches.id, { onDelete: 'cascade' }),
    approvalId: uuid('approval_id').notNull().references(() => amazonWriteApprovals.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    direction: amazonWriteExecutionDirection('direction').notNull().default('forward'),
    sourceExecutionId: uuid('source_execution_id'),
    status: amazonWriteExecutionStatus('status').notNull().default('queued'),
    requestedCount: integer('requested_count').notNull(),
    attemptedCount: integer('attempted_count').notNull().default(0),
    succeededCount: integer('succeeded_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    ambiguousCount: integer('ambiguous_count').notNull().default(0),
    refusedCount: integer('refused_count').notNull().default(0),
    resyncRequestedCount: integer('resync_requested_count').notNull().default(0),
    resynchronizedCount: integer('resynchronized_count').notNull().default(0),
    observationAttempts: integer('observation_attempts').notNull().default(0),
    nextObservationAt: ts('next_observation_at'),
    inverseReadyAt: ts('inverse_ready_at'),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
    dispatchLeaseToken: uuid('dispatch_lease_token'),
    dispatchLeaseExpiresAt: ts('dispatch_lease_expires_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('amazon_write_executions_apply_batch_key').on(t.orgId, t.profileId, t.applyBatchId),
    uniqueIndex('amazon_write_executions_approval_key').on(t.approvalId),
    uniqueIndex('amazon_write_executions_idempotency_key').on(t.idempotencyKey),
    uniqueIndex('amazon_write_executions_org_profile_id_key').on(t.orgId, t.profileId, t.id),
    index('amazon_write_executions_status_idx').on(t.status, t.nextObservationAt),
  ],
);

/** One already-approved execution slot reserved for an exact rollback subset. */
export const amazonWriteInverseReservations = pgTable(
  'amazon_write_inverse_reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull().references(() => adProfiles.id, { onDelete: 'cascade' }),
    forwardExecutionId: uuid('forward_execution_id').notNull().references(() => amazonWriteExecutions.id, { onDelete: 'cascade' }),
    authorizationId: uuid('authorization_id').notNull(),
    authorizationSha256: text('authorization_sha256').notNull(),
    inverseExecutionId: uuid('inverse_execution_id').references(() => amazonWriteExecutions.id, { onDelete: 'cascade' }),
    reservedAt: ts('reserved_at').notNull().defaultNow(),
    materializedAt: ts('materialized_at'),
  },
  (t) => [
    uniqueIndex('amazon_write_inverse_reservations_forward_key').on(t.forwardExecutionId),
    uniqueIndex('amazon_write_inverse_reservations_inverse_key').on(t.inverseExecutionId),
    uniqueIndex('amazon_write_inverse_reservations_org_profile_id_key').on(t.orgId, t.profileId, t.id),
    index('amazon_write_inverse_reservations_authorization_idx').on(t.authorizationId, t.authorizationSha256),
  ],
);

/** Materialized provider actions and precomputed exact inverses. */
export const amazonWriteRows = pgTable(
  'amazon_write_rows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull().references(() => adProfiles.id, { onDelete: 'cascade' }),
    executionId: uuid('execution_id').notNull().references(() => amazonWriteExecutions.id, { onDelete: 'cascade' }),
    applyRowId: uuid('apply_row_id').notNull().references(() => applyRows.id, { onDelete: 'cascade' }),
    actionType: amazonWriteActionType('action_type').notNull(),
    action: jsonb('action').$type<AmazonWriteAction>().notNull(),
    expectedValue: jsonb('expected_value').$type<ApplyValue>().notNull(),
    requestedValue: jsonb('requested_value').$type<ApplyValue>().notNull(),
    inverseValue: jsonb('inverse_value').$type<ApplyValue>().notNull(),
    inverseAction: jsonb('inverse_action').$type<AmazonWriteAction>().notNull(),
    rowStatus: amazonWriteRowStatus('row_status').notNull().default('pending'),
    observationStatus: amazonWriteObservationStatus('observation_status').notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    refusalReason: text('refusal_reason'),
    providerEvidence: jsonb('provider_evidence').$type<AmazonWriteProviderEvidence>(),
    providerAcceptedAt: ts('provider_accepted_at'),
    currentObservedValue: jsonb('current_observed_value').$type<ApplyValue>(),
    observedAt: ts('observed_at'),
    dispatchToken: uuid('dispatch_token'),
    dispatchedAt: ts('dispatched_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('amazon_write_rows_execution_apply_row_key').on(t.executionId, t.applyRowId),
    uniqueIndex('amazon_write_rows_org_profile_id_key').on(t.orgId, t.profileId, t.id),
    index('amazon_write_rows_execution_status_idx').on(t.executionId, t.rowStatus, t.observationStatus),
  ],
);

/** Append-only, sanitized provider evidence for every attempted row. */
export const amazonWriteAttempts = pgTable(
  'amazon_write_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull().references(() => adProfiles.id, { onDelete: 'cascade' }),
    executionId: uuid('execution_id').notNull().references(() => amazonWriteExecutions.id, { onDelete: 'cascade' }),
    writeRowId: uuid('write_row_id').notNull().references(() => amazonWriteRows.id, { onDelete: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    outcome: amazonWriteAttemptOutcome('outcome').notNull(),
    providerEvidence: jsonb('provider_evidence').$type<AmazonWriteProviderEvidence>().notNull(),
    attemptedAt: ts('attempted_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('amazon_write_attempts_row_attempt_key').on(t.writeRowId, t.attemptNumber),
    uniqueIndex('amazon_write_attempts_request_key').on(t.requestFingerprint),
    index('amazon_write_attempts_execution_idx').on(t.executionId, t.attemptedAt),
  ],
);

/** Append-only dispatch/result events for every outbound Amazon request. */
export const amazonWriteProviderCallEvents = pgTable(
  'amazon_write_provider_call_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull().references(() => adProfiles.id, { onDelete: 'cascade' }),
    executionId: uuid('execution_id').notNull().references(() => amazonWriteExecutions.id, { onDelete: 'cascade' }),
    callId: uuid('call_id').notNull(),
    eventType: amazonWriteProviderCallEventType('event_type').notNull(),
    providerOperation: amazonWriteActionType('provider_operation').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    requestedEntityIds: jsonb('requested_entity_ids').$type<string[]>().notNull(),
    requestedCount: integer('requested_count').notNull(),
    acceptedCount: integer('accepted_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    apiCallCount: integer('api_call_count').notNull(),
    outcome: amazonWriteProviderCallOutcome('outcome').notNull(),
    code: text('code'),
    message: text('message'),
    occurredAt: ts('occurred_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('amazon_write_provider_call_events_call_event_key').on(t.callId, t.eventType),
    uniqueIndex('amazon_write_provider_call_events_org_profile_id_key').on(t.orgId, t.profileId, t.id),
    index('amazon_write_provider_call_events_execution_idx').on(t.executionId, t.occurredAt),
  ],
);

export const campaignMaps = pgTable(
  'campaign_maps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => adProfiles.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    sourceFilter: jsonb('source_filter').notNull().default({}),
    /** Enough to create the destination when it does not exist yet. */
    destinationTemplate: jsonb('destination_template').notNull().default({}),
    matchTypes: matchType('match_types').array().notNull().default([]),
    negateSource: boolean('negate_source').notNull().default(true),
    createdBy: uuid('created_by').references(() => authUsers.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('campaign_maps_profile_idx').on(t.profileId)],
);

export type ApplyBatch = typeof applyBatches.$inferSelect;
export type NewApplyBatch = typeof applyBatches.$inferInsert;
export type ApplyRowDb = typeof applyRows.$inferSelect;
export type NewApplyRowDb = typeof applyRows.$inferInsert;
export type CampaignMap = typeof campaignMaps.$inferSelect;
export type AmazonWriteApprovalDb = typeof amazonWriteApprovals.$inferSelect;
export type AmazonWriteExecutionDb = typeof amazonWriteExecutions.$inferSelect;
export type AmazonWriteRowDb = typeof amazonWriteRows.$inferSelect;
export type AmazonWriteAttemptDb = typeof amazonWriteAttempts.$inferSelect;
export type AmazonWriteInverseReservationDb = typeof amazonWriteInverseReservations.$inferSelect;
export type AmazonWriteProviderCallEventDb = typeof amazonWriteProviderCallEvents.$inferSelect;
