/**
 * WP-187 inert Sponsored Products write-persistence ledger.
 *
 * SQL migrations are authoritative. This file mirrors their public relations
 * for typed reads only; the controlled SQL capabilities remain the sole write
 * boundary and no query facade is introduced here.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  pgView,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  ApproveSpWritePlan,
  SpWriteAction,
  SpWriteAuthorizationReceipt,
  SpWriteBoundedAuthorization,
  SpWriteObservation,
  SpWriteObservedAction,
  SpWritePlan,
  SpWritePreDispatchDisposition,
  SpWritePredispatchObservation,
  SpWriteProviderCallIntent,
  SpWriteProviderResult,
} from '@wizard-ads/shared/sp-writes';
import { ts } from './columns.js';
import type { SpWritePreviewEvidence } from '@wizard-ads/shared/sp-write-preview-evidence';
import {
  adsRegion,
  spWriteActionResolutionKind,
  spWriteApprovalMode,
  spWriteObservationOutcome,
  spWriteOutboxKind,
  spWritePlanDirection,
  spWriteProviderOutcome,
  spWriteRefusalReason,
  spWriteResultOrigin,
  spWriteRouteKey,
} from './enums.js';
import { adProfiles, authUsers } from './tenancy.js';

const dbClock = (name: string) => ts(name).notNull().default(sql`clock_timestamp()`);

const fingerprintedArtifact = <T>() => ({
  artifactText: text('artifact_text').notNull(),
  artifact: jsonb('artifact').$type<T>().notNull(),
  fingerprintPreimage: text('fingerprint_preimage').notNull(),
  fingerprint: text('fingerprint').notNull(),
});

export const spWriteEnvironmentGateVersions = pgTable(
  'sp_write_environment_gate_versions',
  {
    versionId: uuid('version_id').primaryKey(),
    enabled: boolean('enabled').notNull(),
    maxUnresolvedCalls: integer('max_unresolved_calls').notNull(),
    createdAt: dbClock('created_at'),
    createdBy: uuid('created_by'),
  },
  (t) => [
    check(
      'sp_write_environment_gate_versions_capacity_one',
      sql`${t.maxUnresolvedCalls} = 1`,
    ),
  ],
);

export const spWriteEnvironmentGateHead = pgTable(
  'sp_write_environment_gate_head',
  {
    singleton: boolean('singleton').primaryKey().default(true),
    versionId: uuid('version_id').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'sp_write_environment_gate_head_version_id_fkey',
      columns: [t.versionId],
      foreignColumns: [spWriteEnvironmentGateVersions.versionId],
    }),
    unique('sp_write_environment_gate_head_version_id_key').on(t.versionId),
    check('sp_write_environment_gate_head_singleton', sql`${t.singleton}`),
  ],
);

export const spWriteProfileGrantVersions = pgTable(
  'sp_write_profile_grant_versions',
  {
    grantId: uuid('grant_id').notNull(),
    versionId: uuid('version_id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    enabled: boolean('enabled').notNull(),
    amazonProfileId: text('amazon_profile_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    region: adsRegion('region').notNull(),
    marketplaceId: text('marketplace_id').notNull(),
    currencyCode: text('currency_code').notNull(),
    apiDialect: text('api_dialect').notNull(),
    createdAt: dbClock('created_at'),
    createdBy: uuid('created_by'),
  },
  (t) => [
    foreignKey({
      name: 'sp_write_profile_grant_versions_profile_fkey',
      columns: [t.orgId, t.profileId],
      foreignColumns: [adProfiles.orgId, adProfiles.id],
    }).onDelete('cascade'),
    unique('sp_write_profile_grant_versions_identity_key').on(
      t.orgId,
      t.profileId,
      t.grantId,
      t.versionId,
    ),
    check(
      'sp_write_profile_grant_versions_scope',
      sql`${t.amazonProfileId} <> '' and ${t.marketplaceId} <> '' and ${t.currencyCode} ~ '^[A-Z]{3}$' and ${t.apiDialect} = 'sp_v3'`,
    ),
  ],
);

export const spWriteProfileGrantHeads = pgTable(
  'sp_write_profile_grant_heads',
  {
    orgId: uuid('org_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    grantId: uuid('grant_id').notNull(),
    versionId: uuid('version_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.profileId] }),
    foreignKey({
      name: 'sp_write_profile_grant_heads_version_fkey',
      columns: [t.orgId, t.profileId, t.grantId, t.versionId],
      foreignColumns: [
        spWriteProfileGrantVersions.orgId,
        spWriteProfileGrantVersions.profileId,
        spWriteProfileGrantVersions.grantId,
        spWriteProfileGrantVersions.versionId,
      ],
    }).onDelete('cascade'),
  ],
);

export const spWriteBoundedAuthorizations = pgTable(
  'sp_write_bounded_authorizations',
  {
    authorizationId: uuid('authorization_id').primaryKey(),
    ...fingerprintedArtifact<SpWriteBoundedAuthorization>(),
    issuedAt: ts('issued_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    maxLogicalChangesPerPlan: integer('max_logical_changes_per_plan').notNull(),
    maxProviderRowsPerPlan: integer('max_provider_rows_per_plan').notNull(),
    maxConcurrentMutations: integer('max_concurrent_mutations').notNull(),
    maxCycles: integer('max_cycles').notNull(),
    maxExecutions: integer('max_executions').notNull(),
    requireCurrentValueMatch: boolean('require_current_value_match').notNull(),
    requireForwardObservationBeforeInverse: boolean('require_forward_observation_before_inverse').notNull(),
    stopOnConflict: boolean('stop_on_conflict').notNull(),
    disableAfterCycle: boolean('disable_after_cycle').notNull(),
    persistedAt: dbClock('persisted_at'),
  },
  (t) => [
    unique('sp_write_bounded_authorizations_fingerprint_key').on(t.fingerprint),
    check(
      'sp_write_bounded_authorizations_literal_limits',
      sql`${t.issuedAt} < ${t.expiresAt} and ${t.maxLogicalChangesPerPlan} between 1 and 100 and ${t.maxProviderRowsPerPlan} between 1 and 100 and ${t.maxConcurrentMutations} = 1 and ${t.maxCycles} = 1 and ${t.maxExecutions} = 2 and ${t.requireCurrentValueMatch} and ${t.requireForwardObservationBeforeInverse} and ${t.stopOnConflict} and ${t.disableAfterCycle}`,
    ),
    check('sp_write_bounded_authorizations_fingerprint', sql`${t.fingerprint} ~ '^[a-f0-9]{64}$'`),
  ],
);

export const spWriteBoundedAuthorizationProfiles = pgTable(
  'sp_write_bounded_authorization_profiles',
  {
    authorizationId: uuid('authorization_id').notNull(),
    profileIndex: integer('profile_index').notNull(),
    orgId: uuid('org_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    amazonProfileId: text('amazon_profile_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    region: adsRegion('region').notNull(),
    marketplaceId: text('marketplace_id').notNull(),
    currencyCode: text('currency_code').notNull(),
    apiDialect: text('api_dialect').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.authorizationId, t.profileIndex] }),
    foreignKey({
      name: 'sp_write_bounded_authorization_profiles_authorization_id_fkey',
      columns: [t.authorizationId],
      foreignColumns: [spWriteBoundedAuthorizations.authorizationId],
    }),
    foreignKey({
      name: 'sp_write_bounded_authorization_profiles_profile_fkey',
      columns: [t.orgId, t.profileId],
      foreignColumns: [adProfiles.orgId, adProfiles.id],
    }).onDelete('cascade'),
    unique('sp_write_bounded_authorization_profiles_identity_key').on(
      t.authorizationId,
      t.orgId,
      t.profileId,
    ),
    unique('sp_write_bounded_authorization_profiles_complete_key').on(
      t.authorizationId,
      t.profileIndex,
      t.orgId,
      t.profileId,
    ),
    check(
      'sp_write_bounded_authorization_profiles_scope',
      sql`${t.profileIndex} between 0 and 19 and ${t.amazonProfileId} <> '' and ${t.marketplaceId} <> '' and ${t.currencyCode} ~ '^[A-Z]{3}$' and ${t.apiDialect} = 'sp_v3'`,
    ),
  ],
);

export const spWriteBoundedAuthorizationEntities = pgTable(
  'sp_write_bounded_authorization_entities',
  {
    authorizationId: uuid('authorization_id').notNull(),
    profileIndex: integer('profile_index').notNull(),
    entityIndex: integer('entity_index').notNull(),
    orgId: uuid('org_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    routeKey: spWriteRouteKey('route_key').notNull(),
    amazonEntityId: text('amazon_entity_id').notNull(),
    allowedChangeKeys: text('allowed_change_keys').array().notNull(),
    maxAbsoluteMoneyDelta: text('max_absolute_money_delta'),
    maxAbsolutePlacementDelta: integer('max_absolute_placement_delta'),
  },
  (t) => [
    primaryKey({ columns: [t.authorizationId, t.profileIndex, t.entityIndex] }),
    foreignKey({
      name: 'sp_write_bounded_authorization_entities_profile_fkey',
      columns: [t.authorizationId, t.profileIndex, t.orgId, t.profileId],
      foreignColumns: [
        spWriteBoundedAuthorizationProfiles.authorizationId,
        spWriteBoundedAuthorizationProfiles.profileIndex,
        spWriteBoundedAuthorizationProfiles.orgId,
        spWriteBoundedAuthorizationProfiles.profileId,
      ],
    }).onDelete('cascade'),
    unique('sp_write_bounded_authorization_entities_identity_key').on(
      t.authorizationId,
      t.profileIndex,
      t.routeKey,
      t.amazonEntityId,
    ),
    check(
      'sp_write_bounded_authorization_entities_bounds',
      sql`${t.entityIndex} between 0 and 99 and ${t.amazonEntityId} <> '' and cardinality(${t.allowedChangeKeys}) between 1 and 16 and ${t.allowedChangeKeys} = app.sp_write_canonical_text_array(${t.allowedChangeKeys}) and (${t.maxAbsoluteMoneyDelta} is null or ${t.maxAbsoluteMoneyDelta} ~ '^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{0,5}[1-9])?$') and (${t.maxAbsolutePlacementDelta} is null or ${t.maxAbsolutePlacementDelta} between 1 and 900)`,
    ),
  ],
);

export const spWriteBoundedAuthorizationRevocations = pgTable(
  'sp_write_bounded_authorization_revocations',
  {
    revocationId: uuid('revocation_id').primaryKey().defaultRandom(),
    authorizationId: uuid('authorization_id').notNull(),
    revokedAt: dbClock('revoked_at'),
    reason: text('reason').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'sp_write_bounded_authorization_revocation_authorization_id_fkey',
      columns: [t.authorizationId],
      foreignColumns: [spWriteBoundedAuthorizations.authorizationId],
    }),
    unique('sp_write_bounded_authorization_revocations_authorization_id_key').on(t.authorizationId),
    check(
      'sp_write_bounded_authorization_revocations_reason_check',
      sql`${t.reason} = btrim(${t.reason}) and length(${t.reason}) between 1 and 160`,
    ),
  ],
);

export const spWriteBoundedAuthorizationConsumptions = pgTable(
  'sp_write_bounded_authorization_consumptions',
  {
    authorizationId: uuid('authorization_id').primaryKey(),
    executionId: uuid('execution_id').notNull(),
    consumedAt: dbClock('consumed_at'),
  },
  (t) => [
    foreignKey({
      name: 'sp_write_bounded_consumptions_authorization_fkey',
      columns: [t.authorizationId],
      foreignColumns: [spWriteBoundedAuthorizations.authorizationId],
    }),
    unique('sp_write_bounded_authorization_consumptions_execution_id_key').on(t.executionId),
  ],
);

export const spWritePlans = pgTable(
  'sp_write_plans',
  {
    planId: uuid('plan_id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    direction: spWritePlanDirection('direction').notNull(),
    ...fingerprintedArtifact<SpWritePlan>(),
    amazonProfileId: text('amazon_profile_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    region: adsRegion('region').notNull(),
    marketplaceId: text('marketplace_id').notNull(),
    currencyCode: text('currency_code').notNull(),
    apiDialect: text('api_dialect').notNull(),
    sourceExecutionId: uuid('source_execution_id'),
    sourcePlanId: uuid('source_plan_id'),
    sourcePlanFingerprint: text('source_plan_fingerprint'),
    generatedAt: ts('generated_at').notNull(),
    frozenAt: ts('frozen_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    logicalChanges: integer('logical_changes').notNull(),
    providerRows: integer('provider_rows').notNull(),
    uniqueEntities: integer('unique_entities').notNull(),
    persistedAt: dbClock('persisted_at'),
  },
  (t) => [
    foreignKey({
      name: 'sp_write_plans_profile_fkey',
      columns: [t.orgId, t.profileId],
      foreignColumns: [adProfiles.orgId, adProfiles.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sp_write_plans_source_plan_fkey',
      columns: [t.orgId, t.profileId, t.sourcePlanId, t.sourcePlanFingerprint],
      foreignColumns: [t.orgId, t.profileId, t.planId, t.fingerprint],
    }).onDelete('cascade'),
    unique('sp_write_plans_fingerprint_key').on(t.fingerprint),
    unique('sp_write_plans_tenant_identity_key').on(t.orgId, t.profileId, t.planId),
    unique('sp_write_plans_identity_fingerprint_key').on(
      t.orgId,
      t.profileId,
      t.planId,
      t.fingerprint,
    ),
    check(
      'sp_write_plans_shape',
      sql`${t.fingerprint} ~ '^[a-f0-9]{64}$' and ${t.generatedAt} <= ${t.frozenAt} and ${t.frozenAt} < ${t.expiresAt} and ${t.logicalChanges} > 0 and ${t.providerRows} between 1 and 500 and ${t.uniqueEntities} between 1 and 500 and ${t.amazonProfileId} <> '' and ${t.marketplaceId} <> '' and ${t.currencyCode} ~ '^[A-Z]{3}$' and ${t.apiDialect} = 'sp_v3' and ((${t.direction} = 'forward' and ${t.sourceExecutionId} is null and ${t.sourcePlanId} is null and ${t.sourcePlanFingerprint} is null) or (${t.direction} = 'inverse' and ${t.sourceExecutionId} is not null and ${t.sourcePlanId} is not null and ${t.sourcePlanFingerprint} ~ '^[a-f0-9]{64}$'))`,
    ),
  ],
);

/** WP-214: exact source and guardrail preimages, recorded atomically with a preview. */
export const spWritePreviewEvidence = pgTable('sp_write_preview_evidence', {
  planId: uuid('plan_id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  profileId: uuid('profile_id').notNull(),
  artifactText: text('artifact_text').notNull(),
  artifact: jsonb('artifact').$type<SpWritePreviewEvidence>().notNull(),
  guardrailPreimage: text('guardrail_preimage').notNull(),
  provenancePreimage: text('provenance_preimage').notNull(),
  persistedAt: dbClock('persisted_at'),
}, (t) => [
  foreignKey({ name: 'sp_write_preview_evidence_plan_fkey',
    columns: [t.orgId, t.profileId, t.planId],
    foreignColumns: [spWritePlans.orgId, spWritePlans.profileId, spWritePlans.planId],
  }).onDelete('cascade'),
  unique('sp_write_preview_evidence_tenant_key').on(t.orgId, t.profileId, t.planId),
  check('sp_write_preview_evidence_text_agrees', sql`${t.artifactText}::jsonb = ${t.artifact}`),
]);

export const spWritePlanActions = pgTable(
  'sp_write_plan_actions',
  {
    orgId: uuid('org_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    planId: uuid('plan_id').notNull(),
    actionId: uuid('action_id').notNull(),
    actionIndex: integer('action_index').notNull(),
    routeKey: spWriteRouteKey('route_key').notNull(),
    amazonEntityId: text('amazon_entity_id').notNull(),
    ...fingerprintedArtifact<SpWriteAction>(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.profileId, t.planId, t.actionId] }),
    foreignKey({
      name: 'sp_write_plan_actions_plan_fkey',
      columns: [t.orgId, t.profileId, t.planId],
      foreignColumns: [spWritePlans.orgId, spWritePlans.profileId, spWritePlans.planId],
    }).onDelete('cascade'),
    unique('sp_write_plan_actions_order_key').on(t.orgId, t.profileId, t.planId, t.actionIndex),
    unique('sp_write_plan_actions_entity_key').on(
      t.orgId,
      t.profileId,
      t.planId,
      t.routeKey,
      t.amazonEntityId,
    ),
    unique('sp_write_plan_actions_complete_identity_key').on(
      t.orgId,
      t.profileId,
      t.planId,
      t.actionId,
      t.fingerprint,
      t.routeKey,
      t.amazonEntityId,
    ),
    unique('sp_write_plan_actions_position_identity_key').on(
      t.orgId,
      t.profileId,
      t.planId,
      t.actionId,
      t.fingerprint,
      t.amazonEntityId,
    ),
    unique('sp_write_plan_actions_fingerprint_identity_key').on(
      t.orgId,
      t.profileId,
      t.planId,
      t.actionId,
      t.fingerprint,
    ),
    check(
      'sp_write_plan_actions_shape',
      sql`${t.actionIndex} between 0 and 499 and ${t.amazonEntityId} <> '' and ${t.fingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const spWriteApprovalRequests = pgTable(
  'sp_write_approval_requests',
  {
    approvalRequestId: uuid('approval_request_id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    planId: uuid('plan_id').notNull(),
    planFingerprint: text('plan_fingerprint').notNull(),
    approvalMode: spWriteApprovalMode('approval_mode').notNull(),
    artifactText: text('artifact_text').notNull(),
    artifact: jsonb('artifact').$type<ApproveSpWritePlan>().notNull(),
    boundedAuthorizationId: uuid('bounded_authorization_id'),
    inversePlanId: uuid('inverse_plan_id'),
    confirmationVersion: text('confirmation_version').notNull(),
    persistedAt: dbClock('persisted_at'),
  },
  (t) => [
    foreignKey({
      name: 'sp_write_approval_requests_plan_fkey',
      columns: [t.orgId, t.profileId, t.planId, t.planFingerprint],
      foreignColumns: [
        spWritePlans.orgId,
        spWritePlans.profileId,
        spWritePlans.planId,
        spWritePlans.fingerprint,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sp_write_approval_requests_inverse_fkey',
      columns: [t.orgId, t.profileId, t.inversePlanId],
      foreignColumns: [spWritePlans.orgId, spWritePlans.profileId, spWritePlans.planId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sp_write_approval_requests_bounded_authorization_id_fkey',
      columns: [t.boundedAuthorizationId],
      foreignColumns: [spWriteBoundedAuthorizations.authorizationId],
    }),
    unique('sp_write_approval_requests_tenant_identity_key').on(
      t.orgId,
      t.profileId,
      t.approvalRequestId,
    ),
    check(
      'sp_write_approval_requests_mode',
      sql`${t.confirmationVersion} = 'openspell.amazon-sp-write-confirmation.v1' and ((${t.approvalMode} = 'manual' and ${t.boundedAuthorizationId} is null and ${t.inversePlanId} is null) or (${t.approvalMode} = 'bounded_live_test' and ${t.boundedAuthorizationId} is not null and ${t.inversePlanId} is not null))`,
    ),
  ],
);

export const spWriteExecutionCycles = pgTable(
  'sp_write_execution_cycles',
  {
    executionId: uuid('execution_id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    boundedAuthorizationId: uuid('bounded_authorization_id'),
    createdAt: dbClock('created_at'),
  },
  (t) => [
    foreignKey({
      name: 'sp_write_execution_cycles_profile_fkey',
      columns: [t.orgId, t.profileId],
      foreignColumns: [adProfiles.orgId, adProfiles.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sp_write_execution_cycles_bounded_authorization_id_fkey',
      columns: [t.boundedAuthorizationId],
      foreignColumns: [spWriteBoundedAuthorizations.authorizationId],
    }),
    unique('sp_write_execution_cycles_tenant_identity_key').on(t.orgId, t.profileId, t.executionId),
  ],
);

export const spWriteAuthorizationReceipts = pgTable(
  'sp_write_authorization_receipts',
  {
    approvalId: uuid('approval_id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    executionId: uuid('execution_id').notNull(),
    approvalRequestId: uuid('approval_request_id').notNull(),
    planId: uuid('plan_id').notNull(),
    inversePlanId: uuid('inverse_plan_id'),
    boundedAuthorizationId: uuid('bounded_authorization_id'),
    generation: uuid('generation').notNull(),
    approvalMode: spWriteApprovalMode('approval_mode').notNull(),
    artifactText: text('artifact_text').notNull(),
    artifact: jsonb('artifact').$type<SpWriteAuthorizationReceipt>().notNull(),
    approvedBy: uuid('approved_by').notNull(),
    approvedAt: ts('approved_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    environmentGateVersion: uuid('environment_gate_version').notNull(),
    profileGrantId: uuid('profile_grant_id').notNull(),
    profileGrantVersion: uuid('profile_grant_version').notNull(),
    gateSnapshotPreimage: text('gate_snapshot_preimage').notNull(),
    gateSnapshotFingerprint: text('gate_snapshot_fingerprint').notNull(),
    persistedAt: dbClock('persisted_at'),
  },
  (t) => [
    foreignKey({
      name: 'sp_write_authorization_receipts_approved_by_fkey',
      columns: [t.approvedBy],
      foreignColumns: [authUsers.id],
    }),
    foreignKey({
      name: 'sp_write_authorization_receipts_environment_gate_version_fkey',
      columns: [t.environmentGateVersion],
      foreignColumns: [spWriteEnvironmentGateVersions.versionId],
    }),
    foreignKey({
      name: 'sp_write_authorization_receipts_cycle_fkey',
      columns: [t.orgId, t.profileId, t.executionId],
      foreignColumns: [
        spWriteExecutionCycles.orgId,
        spWriteExecutionCycles.profileId,
        spWriteExecutionCycles.executionId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sp_write_authorization_receipts_request_fkey',
      columns: [t.orgId, t.profileId, t.approvalRequestId],
      foreignColumns: [
        spWriteApprovalRequests.orgId,
        spWriteApprovalRequests.profileId,
        spWriteApprovalRequests.approvalRequestId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sp_write_authorization_receipts_plan_fkey',
      columns: [t.orgId, t.profileId, t.planId],
      foreignColumns: [spWritePlans.orgId, spWritePlans.profileId, spWritePlans.planId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sp_write_authorization_receipts_inverse_fkey',
      columns: [t.orgId, t.profileId, t.inversePlanId],
      foreignColumns: [spWritePlans.orgId, spWritePlans.profileId, spWritePlans.planId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sp_write_authorization_receipts_grant_fkey',
      columns: [t.orgId, t.profileId, t.profileGrantId, t.profileGrantVersion],
      foreignColumns: [
        spWriteProfileGrantVersions.orgId,
        spWriteProfileGrantVersions.profileId,
        spWriteProfileGrantVersions.grantId,
        spWriteProfileGrantVersions.versionId,
      ],
    }).onDelete('cascade'),
    unique('sp_write_authorization_receipts_approval_request_id_key').on(t.approvalRequestId),
    unique('sp_write_authorization_receipts_tenant_identity_key').on(t.orgId, t.profileId, t.approvalId),
    unique('sp_write_authorization_receipts_generation_key').on(
      t.orgId,
      t.profileId,
      t.executionId,
      t.planId,
      t.approvalId,
      t.generation,
    ),
    check(
      'sp_write_authorization_receipts_shape',
      sql`${t.approvedAt} < ${t.expiresAt} and ${t.gateSnapshotFingerprint} ~ '^[a-f0-9]{64}$' and ((${t.approvalMode} = 'manual' and ${t.boundedAuthorizationId} is null and ${t.inversePlanId} is null) or (${t.approvalMode} = 'bounded_live_test' and ${t.boundedAuthorizationId} is not null and ${t.inversePlanId} is not null))`,
    ),
  ],
);

export const spWriteCyclePlans = pgTable(
  'sp_write_cycle_plans',
  {
    orgId: uuid('org_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    executionId: uuid('execution_id').notNull(),
    planId: uuid('plan_id').notNull(),
    receiptPlanId: uuid('receipt_plan_id').notNull(),
    approvalId: uuid('approval_id').notNull(),
    generation: uuid('generation').notNull(),
    direction: spWritePlanDirection('direction').notNull(),
    boundAt: dbClock('bound_at'),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.profileId, t.executionId, t.planId] }),
    foreignKey({
      name: 'sp_write_cycle_plans_plan_fkey',
      columns: [t.orgId, t.profileId, t.planId],
      foreignColumns: [spWritePlans.orgId, spWritePlans.profileId, spWritePlans.planId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sp_write_cycle_plans_receipt_fkey',
      columns: [
        t.orgId,
        t.profileId,
        t.executionId,
        t.receiptPlanId,
        t.approvalId,
        t.generation,
      ],
      foreignColumns: [
        spWriteAuthorizationReceipts.orgId,
        spWriteAuthorizationReceipts.profileId,
        spWriteAuthorizationReceipts.executionId,
        spWriteAuthorizationReceipts.planId,
        spWriteAuthorizationReceipts.approvalId,
        spWriteAuthorizationReceipts.generation,
      ],
    }).onDelete('cascade'),
    unique('sp_write_cycle_plans_approval_generation_key').on(
      t.orgId,
      t.profileId,
      t.executionId,
      t.planId,
      t.approvalId,
      t.generation,
    ),
  ],
);

export const spWriteExecutionRequests = pgTable(
  'sp_write_execution_requests',
  {
    orgId: uuid('org_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    executionId: uuid('execution_id').notNull(),
    planId: uuid('plan_id').notNull(),
    approvalId: uuid('approval_id').notNull(),
    generation: uuid('generation').notNull(),
    requestedAt: dbClock('requested_at'),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.profileId, t.executionId, t.planId] }),
    foreignKey({
      name: 'sp_write_execution_requests_cycle_plan_fkey',
      columns: [
        t.orgId,
        t.profileId,
        t.executionId,
        t.planId,
        t.approvalId,
        t.generation,
      ],
      foreignColumns: [
        spWriteCyclePlans.orgId,
        spWriteCyclePlans.profileId,
        spWriteCyclePlans.executionId,
        spWriteCyclePlans.planId,
        spWriteCyclePlans.approvalId,
        spWriteCyclePlans.generation,
      ],
    }).onDelete('cascade'),
    unique('sp_write_execution_requests_complete_key').on(
      t.orgId,
      t.profileId,
      t.executionId,
      t.planId,
      t.approvalId,
      t.generation,
    ),
  ],
);

export const spWriteDispatchLeases = pgTable(
  'sp_write_dispatch_leases',
  {
    leaseId: uuid('lease_id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    executionId: uuid('execution_id').notNull(),
    planId: uuid('plan_id').notNull(),
    approvalId: uuid('approval_id').notNull(),
    generation: uuid('generation').notNull(),
    routeKey: spWriteRouteKey('route_key').notNull(),
    acquiredAt: ts('acquired_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'sp_write_dispatch_leases_execution_fkey',
      columns: [
        t.orgId,
        t.profileId,
        t.executionId,
        t.planId,
        t.approvalId,
        t.generation,
      ],
      foreignColumns: [
        spWriteExecutionRequests.orgId,
        spWriteExecutionRequests.profileId,
        spWriteExecutionRequests.executionId,
        spWriteExecutionRequests.planId,
        spWriteExecutionRequests.approvalId,
        spWriteExecutionRequests.generation,
      ],
    }).onDelete('cascade'),
    unique('sp_write_dispatch_leases_tenant_identity_key').on(t.orgId, t.profileId, t.leaseId),
    unique('sp_write_dispatch_leases_complete_key').on(
      t.orgId,
      t.profileId,
      t.executionId,
      t.planId,
      t.approvalId,
      t.generation,
      t.routeKey,
      t.leaseId,
    ),
    check(
      'sp_write_dispatch_leases_shape',
      sql`${t.acquiredAt} < ${t.expiresAt} and ${t.expiresAt} <= ${t.acquiredAt} + interval '5 minutes'`,
    ),
  ],
);

export const spWritePredispatchObservations = pgTable(
  'sp_write_predispatch_observations',
  {
    observationId: uuid('observation_id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    executionId: uuid('execution_id').notNull(),
    planId: uuid('plan_id').notNull(),
    approvalId: uuid('approval_id').notNull(),
    generation: uuid('generation').notNull(),
    routeKey: spWriteRouteKey('route_key').notNull(),
    observedAt: ts('observed_at').notNull(),
    validUntil: ts('valid_until').notNull(),
    ...fingerprintedArtifact<SpWritePredispatchObservation>(),
    persistedAt: dbClock('persisted_at'),
  },
  (t) => [
    foreignKey({
      name: 'sp_write_predispatch_observations_cycle_plan_fkey',
      columns: [
        t.orgId,
        t.profileId,
        t.executionId,
        t.planId,
        t.approvalId,
        t.generation,
      ],
      foreignColumns: [
        spWriteCyclePlans.orgId,
        spWriteCyclePlans.profileId,
        spWriteCyclePlans.executionId,
        spWriteCyclePlans.planId,
        spWriteCyclePlans.approvalId,
        spWriteCyclePlans.generation,
      ],
    }).onDelete('cascade'),
    unique('sp_write_predispatch_observations_fingerprint_key').on(t.fingerprint),
    unique('sp_write_predispatch_observations_tenant_identity_key').on(
      t.orgId,
      t.profileId,
      t.observationId,
    ),
    unique('sp_write_predispatch_observations_tenant_fingerprint_key').on(
      t.orgId,
      t.profileId,
      t.fingerprint,
    ),
    unique('sp_write_predispatch_observations_complete_key').on(
      t.orgId,
      t.profileId,
      t.executionId,
      t.planId,
      t.approvalId,
      t.generation,
      t.observationId,
      t.fingerprint,
      t.routeKey,
    ),
    unique('sp_write_predispatch_observations_item_parent_key').on(
      t.orgId,
      t.profileId,
      t.executionId,
      t.planId,
      t.approvalId,
      t.generation,
      t.observationId,
      t.routeKey,
    ),
    check(
      'sp_write_predispatch_observations_shape',
      sql`${t.fingerprint} ~ '^[a-f0-9]{64}$' and ${t.observedAt} < ${t.validUntil} and ${t.validUntil} <= ${t.observedAt} + interval '2 minutes'`,
    ),
  ],
);

export const spWritePredispatchObservationItems = pgTable(
  'sp_write_predispatch_observation_items',
  {
    orgId: uuid('org_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    observationId: uuid('observation_id').notNull(),
    executionId: uuid('execution_id').notNull(),
    planId: uuid('plan_id').notNull(),
    approvalId: uuid('approval_id').notNull(),
    generation: uuid('generation').notNull(),
    itemIndex: integer('item_index').notNull(),
    actionId: uuid('action_id').notNull(),
    actionFingerprint: text('action_fingerprint').notNull(),
    routeKey: spWriteRouteKey('route_key').notNull(),
    amazonEntityId: text('amazon_entity_id').notNull(),
    observed: jsonb('observed').$type<SpWriteObservedAction>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.profileId, t.observationId, t.itemIndex] }),
    foreignKey({
      name: 'sp_write_predispatch_observation_items_observation_fkey',
      columns: [
        t.orgId,
        t.profileId,
        t.executionId,
        t.planId,
        t.approvalId,
        t.generation,
        t.observationId,
        t.routeKey,
      ],
      foreignColumns: [
        spWritePredispatchObservations.orgId,
        spWritePredispatchObservations.profileId,
        spWritePredispatchObservations.executionId,
        spWritePredispatchObservations.planId,
        spWritePredispatchObservations.approvalId,
        spWritePredispatchObservations.generation,
        spWritePredispatchObservations.observationId,
        spWritePredispatchObservations.routeKey,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sp_write_predispatch_observation_items_action_fkey',
      columns: [
        t.orgId,
        t.profileId,
        t.planId,
        t.actionId,
        t.actionFingerprint,
        t.routeKey,
        t.amazonEntityId,
      ],
      foreignColumns: [
        spWritePlanActions.orgId,
        spWritePlanActions.profileId,
        spWritePlanActions.planId,
        spWritePlanActions.actionId,
        spWritePlanActions.fingerprint,
        spWritePlanActions.routeKey,
        spWritePlanActions.amazonEntityId,
      ],
    }).onDelete('cascade'),
    unique('sp_write_predispatch_observation_items_action_key').on(
      t.orgId,
      t.profileId,
      t.observationId,
      t.actionId,
    ),
    check(
      'sp_write_predispatch_observation_items_shape',
      sql`${t.itemIndex} between 0 and 99 and ${t.actionFingerprint} ~ '^[a-f0-9]{64}$' and ${t.amazonEntityId} <> ''`,
    ),
  ],
);

export const spWritePredispatchDispositions = pgTable(
  'sp_write_predispatch_dispositions',
  {
    dispositionId: uuid('disposition_id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    executionId: uuid('execution_id').notNull(),
    planId: uuid('plan_id').notNull(),
    approvalId: uuid('approval_id').notNull(),
    generation: uuid('generation').notNull(),
    actionId: uuid('action_id').notNull(),
    actionFingerprint: text('action_fingerprint').notNull(),
    reason: spWriteRefusalReason('reason').notNull(),
    providerObservationFingerprint: text('provider_observation_fingerprint'),
    recordedAt: ts('recorded_at').notNull(),
    persistedAt: ts('persisted_at').notNull(),
    ...fingerprintedArtifact<SpWritePreDispatchDisposition>(),
  },
  (t) => [
    foreignKey({
      name: 'sp_write_predispatch_dispositions_cycle_plan_fkey',
      columns: [
        t.orgId,
        t.profileId,
        t.executionId,
        t.planId,
        t.approvalId,
        t.generation,
      ],
      foreignColumns: [
        spWriteCyclePlans.orgId,
        spWriteCyclePlans.profileId,
        spWriteCyclePlans.executionId,
        spWriteCyclePlans.planId,
        spWriteCyclePlans.approvalId,
        spWriteCyclePlans.generation,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sp_write_predispatch_dispositions_action_fkey',
      columns: [t.orgId, t.profileId, t.planId, t.actionId, t.actionFingerprint],
      foreignColumns: [
        spWritePlanActions.orgId,
        spWritePlanActions.profileId,
        spWritePlanActions.planId,
        spWritePlanActions.actionId,
        spWritePlanActions.fingerprint,
      ],
    }).onDelete('cascade'),
    unique('sp_write_predispatch_dispositions_fingerprint_key').on(t.fingerprint),
    unique('sp_write_predispatch_dispositions_action_key').on(
      t.orgId,
      t.profileId,
      t.executionId,
      t.planId,
      t.actionId,
    ),
    unique('sp_write_predispatch_dispositions_complete_key').on(
      t.orgId,
      t.profileId,
      t.executionId,
      t.planId,
      t.actionId,
      t.dispositionId,
    ),
    unique('sp_write_predispatch_dispositions_tenant_identity_key').on(
      t.orgId,
      t.profileId,
      t.dispositionId,
    ),
    foreignKey({
      name: 'sp_write_predispatch_dispositions_observation_fkey',
      columns: [t.orgId, t.profileId, t.providerObservationFingerprint],
      foreignColumns: [
        spWritePredispatchObservations.orgId,
        spWritePredispatchObservations.profileId,
        spWritePredispatchObservations.fingerprint,
      ],
    }).onDelete('cascade'),
    check(
      'sp_write_predispatch_dispositions_shape',
      sql`${t.actionFingerprint} ~ '^[a-f0-9]{64}$' and ${t.fingerprint} ~ '^[a-f0-9]{64}$' and ${t.persistedAt} >= ${t.recordedAt} and (${t.reason} <> 'stale_expected_state' or ${t.providerObservationFingerprint} is not null)`,
    ),
  ],
);

export const spWriteProviderCallIntents = pgTable(
  'sp_write_provider_call_intents',
  {
    intentId: uuid('intent_id').primaryKey(),
    providerCallId: uuid('provider_call_id').notNull(),
    reservedResultId: uuid('reserved_result_id').notNull(),
    orgId: uuid('org_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    executionId: uuid('execution_id').notNull(),
    planId: uuid('plan_id').notNull(),
    approvalId: uuid('approval_id').notNull(),
    generation: uuid('generation').notNull(),
    routeKey: spWriteRouteKey('route_key').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    dispatchLeaseId: uuid('dispatch_lease_id').notNull(),
    providerObservationFingerprint: text('provider_observation_fingerprint').notNull(),
    requestFingerprintPreimage: text('request_fingerprint_preimage').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    intentFingerprintPreimage: text('intent_fingerprint_preimage').notNull(),
    fingerprint: text('fingerprint').notNull(),
    artifactText: text('artifact_text').notNull(),
    artifact: jsonb('artifact').$type<SpWriteProviderCallIntent>().notNull(),
    recordedAt: ts('recorded_at').notNull(),
    checkedAt: ts('checked_at').notNull(),
    dispatchStartDeadline: ts('dispatch_start_deadline').notNull(),
    providerAttemptDeadline: ts('provider_attempt_deadline').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'sp_write_provider_call_intents_cycle_plan_fkey',
      columns: [
        t.orgId,
        t.profileId,
        t.executionId,
        t.planId,
        t.approvalId,
        t.generation,
      ],
      foreignColumns: [
        spWriteCyclePlans.orgId,
        spWriteCyclePlans.profileId,
        spWriteCyclePlans.executionId,
        spWriteCyclePlans.planId,
        spWriteCyclePlans.approvalId,
        spWriteCyclePlans.generation,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sp_write_provider_call_intents_lease_fkey',
      columns: [
        t.orgId,
        t.profileId,
        t.executionId,
        t.planId,
        t.approvalId,
        t.generation,
        t.routeKey,
        t.dispatchLeaseId,
      ],
      foreignColumns: [
        spWriteDispatchLeases.orgId,
        spWriteDispatchLeases.profileId,
        spWriteDispatchLeases.executionId,
        spWriteDispatchLeases.planId,
        spWriteDispatchLeases.approvalId,
        spWriteDispatchLeases.generation,
        spWriteDispatchLeases.routeKey,
        spWriteDispatchLeases.leaseId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sp_write_provider_call_intents_observation_fkey',
      columns: [t.orgId, t.profileId, t.providerObservationFingerprint],
      foreignColumns: [
        spWritePredispatchObservations.orgId,
        spWritePredispatchObservations.profileId,
        spWritePredispatchObservations.fingerprint,
      ],
    }).onDelete('cascade'),
    unique('sp_write_provider_call_intents_provider_call_id_key').on(t.providerCallId),
    unique('sp_write_provider_call_intents_reserved_result_id_key').on(t.reservedResultId),
    unique('sp_write_provider_call_intents_fingerprint_key').on(t.fingerprint),
    unique('sp_write_provider_call_intents_tenant_identity_key').on(t.orgId, t.profileId, t.intentId),
    unique('sp_write_provider_call_intents_execution_identity_key').on(
      t.orgId,
      t.profileId,
      t.executionId,
      t.planId,
      t.intentId,
    ),
    unique('sp_write_provider_call_intents_result_identity_key').on(
      t.orgId,
      t.profileId,
      t.intentId,
      t.reservedResultId,
    ),
    unique('sp_write_provider_call_intents_provider_identity_key').on(
      t.orgId,
      t.profileId,
      t.executionId,
      t.planId,
      t.approvalId,
      t.generation,
      t.intentId,
      t.providerCallId,
      t.reservedResultId,
      t.fingerprint,
      t.requestFingerprint,
    ),
    unique('sp_write_provider_call_intents_result_parent_key').on(
      t.orgId,
      t.profileId,
      t.intentId,
      t.reservedResultId,
      t.fingerprint,
      t.providerCallId,
      t.requestFingerprint,
    ),
    unique('sp_write_provider_call_intents_outbox_parent_key').on(
      t.orgId,
      t.profileId,
      t.executionId,
      t.planId,
      t.approvalId,
      t.generation,
      t.intentId,
      t.providerCallId,
    ),
    check(
      'sp_write_provider_call_intents_shape',
      sql`${t.attemptNumber} = 1 and ${t.requestFingerprint} ~ '^[a-f0-9]{64}$' and ${t.fingerprint} ~ '^[a-f0-9]{64}$' and ${t.recordedAt} <= ${t.checkedAt} and ${t.dispatchStartDeadline} = ${t.checkedAt} + interval '5 seconds' and ${t.providerAttemptDeadline} = ${t.checkedAt} + interval '35 seconds'`,
    ),
    index('sp_write_intents_open_capacity_idx').on(t.checkedAt, t.intentId),
  ],
);

export const spWriteProviderCallPositions = pgTable(
  'sp_write_provider_call_positions',
  {
    orgId: uuid('org_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    executionId: uuid('execution_id').notNull(),
    planId: uuid('plan_id').notNull(),
    intentId: uuid('intent_id').notNull(),
    requestIndex: integer('request_index').notNull(),
    actionId: uuid('action_id').notNull(),
    actionFingerprint: text('action_fingerprint').notNull(),
    amazonEntityId: text('amazon_entity_id').notNull(),
    actionRequestFingerprint: text('action_request_fingerprint').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.profileId, t.intentId, t.requestIndex] }),
    foreignKey({
      name: 'sp_write_provider_call_positions_intent_fkey',
      columns: [t.orgId, t.profileId, t.executionId, t.planId, t.intentId],
      foreignColumns: [
        spWriteProviderCallIntents.orgId,
        spWriteProviderCallIntents.profileId,
        spWriteProviderCallIntents.executionId,
        spWriteProviderCallIntents.planId,
        spWriteProviderCallIntents.intentId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sp_write_provider_call_positions_action_fkey',
      columns: [
        t.orgId,
        t.profileId,
        t.planId,
        t.actionId,
        t.actionFingerprint,
        t.amazonEntityId,
      ],
      foreignColumns: [
        spWritePlanActions.orgId,
        spWritePlanActions.profileId,
        spWritePlanActions.planId,
        spWritePlanActions.actionId,
        spWritePlanActions.fingerprint,
        spWritePlanActions.amazonEntityId,
      ],
    }).onDelete('cascade'),
    unique('sp_write_provider_call_positions_action_key').on(
      t.orgId,
      t.profileId,
      t.intentId,
      t.actionId,
    ),
    unique('sp_write_provider_call_positions_complete_key').on(
      t.orgId,
      t.profileId,
      t.intentId,
      t.requestIndex,
      t.actionId,
      t.actionFingerprint,
      t.actionRequestFingerprint,
    ),
    unique('sp_write_provider_call_positions_resolution_key').on(
      t.orgId,
      t.profileId,
      t.executionId,
      t.planId,
      t.intentId,
      t.actionId,
    ),
    check(
      'sp_write_provider_call_positions_shape',
      sql`${t.requestIndex} between 0 and 99 and ${t.amazonEntityId} <> '' and ${t.actionFingerprint} ~ '^[a-f0-9]{64}$' and ${t.actionRequestFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    index('sp_write_positions_entity_fence_idx').on(
      t.orgId,
      t.profileId,
      t.amazonEntityId,
      t.intentId,
    ),
  ],
);

export const spWriteActionResolutions = pgTable(
  'sp_write_action_resolutions',
  {
    orgId: uuid('org_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    executionId: uuid('execution_id').notNull(),
    planId: uuid('plan_id').notNull(),
    actionId: uuid('action_id').notNull(),
    resolutionKind: spWriteActionResolutionKind('resolution_kind').notNull(),
    dispositionId: uuid('disposition_id'),
    intentId: uuid('intent_id'),
    resolvedAt: ts('resolved_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.profileId, t.executionId, t.planId, t.actionId] }),
    foreignKey({
      name: 'sp_write_action_resolutions_action_fkey',
      columns: [t.orgId, t.profileId, t.planId, t.actionId],
      foreignColumns: [
        spWritePlanActions.orgId,
        spWritePlanActions.profileId,
        spWritePlanActions.planId,
        spWritePlanActions.actionId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sp_write_action_resolutions_disposition_fkey',
      columns: [
        t.orgId,
        t.profileId,
        t.executionId,
        t.planId,
        t.actionId,
        t.dispositionId,
      ],
      foreignColumns: [
        spWritePredispatchDispositions.orgId,
        spWritePredispatchDispositions.profileId,
        spWritePredispatchDispositions.executionId,
        spWritePredispatchDispositions.planId,
        spWritePredispatchDispositions.actionId,
        spWritePredispatchDispositions.dispositionId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sp_write_action_resolutions_intent_fkey',
      columns: [t.orgId, t.profileId, t.executionId, t.planId, t.intentId, t.actionId],
      foreignColumns: [
        spWriteProviderCallPositions.orgId,
        spWriteProviderCallPositions.profileId,
        spWriteProviderCallPositions.executionId,
        spWriteProviderCallPositions.planId,
        spWriteProviderCallPositions.intentId,
        spWriteProviderCallPositions.actionId,
      ],
    }).onDelete('cascade'),
    check(
      'sp_write_action_resolutions_exact_branch',
      sql`(${t.resolutionKind} = 'refusal' and ${t.dispositionId} is not null and ${t.intentId} is null) or (${t.resolutionKind} = 'intent' and ${t.dispositionId} is null and ${t.intentId} is not null)`,
    ),
  ],
);

export const spWriteProviderResults = pgTable(
  'sp_write_provider_results',
  {
    resultId: uuid('result_id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    intentId: uuid('intent_id').notNull(),
    origin: spWriteResultOrigin('origin').notNull(),
    ...fingerprintedArtifact<SpWriteProviderResult>(),
    intentFingerprint: text('intent_fingerprint').notNull(),
    providerCallId: uuid('provider_call_id').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    completedAt: ts('completed_at').notNull(),
    persistedAt: dbClock('persisted_at'),
  },
  (t) => [
    foreignKey({
      name: 'sp_write_provider_results_reserved_identity_fkey',
      columns: [
        t.orgId,
        t.profileId,
        t.intentId,
        t.resultId,
        t.intentFingerprint,
        t.providerCallId,
        t.requestFingerprint,
      ],
      foreignColumns: [
        spWriteProviderCallIntents.orgId,
        spWriteProviderCallIntents.profileId,
        spWriteProviderCallIntents.intentId,
        spWriteProviderCallIntents.reservedResultId,
        spWriteProviderCallIntents.fingerprint,
        spWriteProviderCallIntents.providerCallId,
        spWriteProviderCallIntents.requestFingerprint,
      ],
    }).onDelete('cascade'),
    unique('sp_write_provider_results_intent_id_key').on(t.intentId),
    unique('sp_write_provider_results_fingerprint_key').on(t.fingerprint),
    unique('sp_write_provider_results_tenant_identity_key').on(t.orgId, t.profileId, t.resultId),
    unique('sp_write_provider_results_intent_identity_key').on(
      t.orgId,
      t.profileId,
      t.intentId,
      t.resultId,
    ),
    check(
      'sp_write_provider_results_shape',
      sql`${t.fingerprint} ~ '^[a-f0-9]{64}$' and ${t.intentFingerprint} ~ '^[a-f0-9]{64}$' and ${t.requestFingerprint} ~ '^[a-f0-9]{64}$' and ${t.completedAt} <= ${t.persistedAt}`,
    ),
    index('sp_write_results_intent_idx').on(t.intentId),
  ],
);

export const spWriteProviderResultPositions = pgTable(
  'sp_write_provider_result_positions',
  {
    orgId: uuid('org_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    resultId: uuid('result_id').notNull(),
    intentId: uuid('intent_id').notNull(),
    requestIndex: integer('request_index').notNull(),
    actionId: uuid('action_id').notNull(),
    actionFingerprint: text('action_fingerprint').notNull(),
    actionRequestFingerprint: text('action_request_fingerprint').notNull(),
    outcome: spWriteProviderOutcome('outcome').notNull(),
    providerEntityId: text('provider_entity_id'),
    code: text('code'),
    message: text('message'),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.profileId, t.resultId, t.requestIndex] }),
    foreignKey({
      name: 'sp_write_provider_result_positions_result_fkey',
      columns: [t.orgId, t.profileId, t.intentId, t.resultId],
      foreignColumns: [
        spWriteProviderResults.orgId,
        spWriteProviderResults.profileId,
        spWriteProviderResults.intentId,
        spWriteProviderResults.resultId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sp_write_provider_result_positions_intent_position_fkey',
      columns: [
        t.orgId,
        t.profileId,
        t.intentId,
        t.requestIndex,
        t.actionId,
        t.actionFingerprint,
        t.actionRequestFingerprint,
      ],
      foreignColumns: [
        spWriteProviderCallPositions.orgId,
        spWriteProviderCallPositions.profileId,
        spWriteProviderCallPositions.intentId,
        spWriteProviderCallPositions.requestIndex,
        spWriteProviderCallPositions.actionId,
        spWriteProviderCallPositions.actionFingerprint,
        spWriteProviderCallPositions.actionRequestFingerprint,
      ],
    }).onDelete('cascade'),
    unique('sp_write_provider_result_positions_action_key').on(
      t.orgId,
      t.profileId,
      t.resultId,
      t.actionId,
    ),
    unique('sp_write_provider_result_positions_observation_key').on(
      t.orgId,
      t.profileId,
      t.resultId,
      t.intentId,
      t.actionId,
    ),
    check(
      'sp_write_provider_result_positions_shape',
      sql`${t.requestIndex} between 0 and 99 and ${t.actionFingerprint} ~ '^[a-f0-9]{64}$' and ${t.actionRequestFingerprint} ~ '^[a-f0-9]{64}$' and (${t.code} is null or (${t.code} = btrim(${t.code}) and length(${t.code}) <= 160)) and (${t.message} is null or (${t.message} = btrim(${t.message}) and length(${t.message}) <= 512)) and (${t.outcome} <> 'accepted' or ${t.providerEntityId} is not null) and (${t.outcome} <> 'ambiguous' or ${t.providerEntityId} is null)`,
    ),
  ],
);

export const spWriteOutbox = pgTable(
  'sp_write_outbox',
  {
    outboxId: uuid('outbox_id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    executionId: uuid('execution_id').notNull(),
    planId: uuid('plan_id').notNull(),
    approvalId: uuid('approval_id').notNull(),
    generation: uuid('generation').notNull(),
    kind: spWriteOutboxKind('kind').notNull(),
    providerCallId: uuid('provider_call_id'),
    intentId: uuid('intent_id'),
    sourceSyncJobId: uuid('source_sync_job_id'),
    createdAt: dbClock('created_at'),
  },
  (t) => [
    foreignKey({
      name: 'sp_write_outbox_cycle_plan_fkey',
      columns: [
        t.orgId,
        t.profileId,
        t.executionId,
        t.planId,
        t.approvalId,
        t.generation,
      ],
      foreignColumns: [
        spWriteCyclePlans.orgId,
        spWriteCyclePlans.profileId,
        spWriteCyclePlans.executionId,
        spWriteCyclePlans.planId,
        spWriteCyclePlans.approvalId,
        spWriteCyclePlans.generation,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sp_write_outbox_intent_fkey',
      columns: [
        t.orgId,
        t.profileId,
        t.executionId,
        t.planId,
        t.approvalId,
        t.generation,
        t.intentId,
        t.providerCallId,
      ],
      foreignColumns: [
        spWriteProviderCallIntents.orgId,
        spWriteProviderCallIntents.profileId,
        spWriteProviderCallIntents.executionId,
        spWriteProviderCallIntents.planId,
        spWriteProviderCallIntents.approvalId,
        spWriteProviderCallIntents.generation,
        spWriteProviderCallIntents.intentId,
        spWriteProviderCallIntents.providerCallId,
      ],
    }).onDelete('cascade'),
    unique('sp_write_outbox_dispatch_key')
      .on(t.orgId, t.profileId, t.executionId, t.planId, t.kind, t.providerCallId)
      .nullsNotDistinct(),
    unique('sp_write_outbox_source_sync_job_key')
      .on(t.orgId, t.profileId, t.sourceSyncJobId),
    unique('sp_write_outbox_source_identity_key')
      .on(
        t.orgId,
        t.profileId,
        t.executionId,
        t.planId,
        t.approvalId,
        t.generation,
        t.intentId,
        t.providerCallId,
        t.sourceSyncJobId,
      )
      .nullsNotDistinct(),
    unique('sp_write_outbox_tenant_identity_key').on(t.orgId, t.profileId, t.outboxId),
    check(
      'sp_write_outbox_kind_shape',
      sql`(${t.kind} = 'dispatch' and ${t.providerCallId} is null and ${t.intentId} is null and ${t.sourceSyncJobId} is null) or (${t.kind} = 'observe_and_recover' and ${t.providerCallId} is not null and ${t.intentId} is not null and ${t.sourceSyncJobId} is not null)`,
    ),
  ],
);

export const spWriteObservations = pgTable(
  'sp_write_observations',
  {
    observationId: uuid('observation_id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    executionId: uuid('execution_id').notNull(),
    planId: uuid('plan_id').notNull(),
    approvalId: uuid('approval_id').notNull(),
    generation: uuid('generation').notNull(),
    intentId: uuid('intent_id').notNull(),
    resultId: uuid('result_id').notNull(),
    providerCallId: uuid('provider_call_id').notNull(),
    actionId: uuid('action_id').notNull(),
    actionFingerprint: text('action_fingerprint').notNull(),
    intentFingerprint: text('intent_fingerprint').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    routeKey: spWriteRouteKey('route_key').notNull(),
    sourceSyncJobId: uuid('source_sync_job_id').notNull(),
    outcome: spWriteObservationOutcome('outcome').notNull(),
    observed: jsonb('observed').$type<SpWriteObservedAction | null>(),
    observedAt: ts('observed_at').notNull(),
    ...fingerprintedArtifact<SpWriteObservation>(),
    persistedAt: dbClock('persisted_at'),
  },
  (t) => [
    foreignKey({
      name: 'sp_write_observations_cycle_plan_fkey',
      columns: [
        t.orgId,
        t.profileId,
        t.executionId,
        t.planId,
        t.approvalId,
        t.generation,
      ],
      foreignColumns: [
        spWriteCyclePlans.orgId,
        spWriteCyclePlans.profileId,
        spWriteCyclePlans.executionId,
        spWriteCyclePlans.planId,
        spWriteCyclePlans.approvalId,
        spWriteCyclePlans.generation,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sp_write_observations_result_fkey',
      columns: [t.orgId, t.profileId, t.intentId, t.resultId],
      foreignColumns: [
        spWriteProviderResults.orgId,
        spWriteProviderResults.profileId,
        spWriteProviderResults.intentId,
        spWriteProviderResults.resultId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sp_write_observations_source_job_fkey',
      columns: [
        t.orgId,
        t.profileId,
        t.executionId,
        t.planId,
        t.approvalId,
        t.generation,
        t.intentId,
        t.providerCallId,
        t.sourceSyncJobId,
      ],
      foreignColumns: [
        spWriteOutbox.orgId,
        spWriteOutbox.profileId,
        spWriteOutbox.executionId,
        spWriteOutbox.planId,
        spWriteOutbox.approvalId,
        spWriteOutbox.generation,
        spWriteOutbox.intentId,
        spWriteOutbox.providerCallId,
        spWriteOutbox.sourceSyncJobId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sp_write_observations_result_position_fkey',
      columns: [t.orgId, t.profileId, t.resultId, t.intentId, t.actionId],
      foreignColumns: [
        spWriteProviderResultPositions.orgId,
        spWriteProviderResultPositions.profileId,
        spWriteProviderResultPositions.resultId,
        spWriteProviderResultPositions.intentId,
        spWriteProviderResultPositions.actionId,
      ],
    }).onDelete('cascade'),
    unique('sp_write_observations_fingerprint_key').on(t.fingerprint),
    unique('sp_write_observations_action_key').on(
      t.orgId,
      t.profileId,
      t.executionId,
      t.planId,
      t.actionId,
    ),
    unique('sp_write_observations_tenant_identity_key').on(t.orgId, t.profileId, t.observationId),
    check(
      'sp_write_observations_shape',
      sql`${t.fingerprint} ~ '^[a-f0-9]{64}$' and ${t.actionFingerprint} ~ '^[a-f0-9]{64}$' and ${t.intentFingerprint} ~ '^[a-f0-9]{64}$' and ${t.requestFingerprint} ~ '^[a-f0-9]{64}$' and ((${t.outcome} = 'missing') = (${t.observed} is null)) and ${t.observedAt} <= ${t.persistedAt}`,
    ),
    index('sp_write_observations_intent_action_idx').on(t.intentId, t.actionId),
  ],
);

export const spWriteLateResultAudits = pgTable(
  'sp_write_late_result_audits',
  {
    auditId: uuid('audit_id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    intentId: uuid('intent_id').notNull(),
    resultId: uuid('result_id').notNull(),
    submittedFingerprint: text('submitted_fingerprint').notNull(),
    completedAt: ts('completed_at').notNull(),
    positionCount: integer('position_count').notNull(),
    diagnosticCodes: text('diagnostic_codes').array().notNull(),
    persistedAt: dbClock('persisted_at'),
  },
  (t) => [
    foreignKey({
      name: 'sp_write_late_result_audits_canonical_result_fkey',
      columns: [t.orgId, t.profileId, t.intentId, t.resultId],
      foreignColumns: [
        spWriteProviderResults.orgId,
        spWriteProviderResults.profileId,
        spWriteProviderResults.intentId,
        spWriteProviderResults.resultId,
      ],
    }).onDelete('cascade'),
    unique('sp_write_late_result_audits_submission_key').on(
      t.orgId,
      t.profileId,
      t.intentId,
      t.submittedFingerprint,
    ),
    check(
      'sp_write_late_result_audits_shape',
      sql`${t.submittedFingerprint} ~ '^[a-f0-9]{64}$' and ${t.positionCount} between 1 and 100 and cardinality(${t.diagnosticCodes}) <= 100 and ${t.completedAt} <= ${t.persistedAt}`,
    ),
  ],
);

/**
 * Read-only, derived execution accounting. PostgreSQL does not propagate
 * source-column NOT NULL metadata through a view, so these columns intentionally
 * retain the catalog's nullable shape even though the defining query produces
 * complete grouped rows.
 */
export const spWriteExecutionAccounting = pgView('sp_write_execution_accounting', {
  orgId: uuid('org_id'),
  profileId: uuid('profile_id'),
  executionId: uuid('execution_id'),
  planId: uuid('plan_id'),
  approvedRows: integer('approved_rows'),
  pendingDispatch: integer('pending_dispatch'),
  refusedBeforeDispatch: integer('refused_before_dispatch'),
  intentCommitted: integer('intent_committed'),
  providerAccepted: integer('provider_accepted'),
  providerRejected: integer('provider_rejected'),
  providerAmbiguous: integer('provider_ambiguous'),
  observedRequested: integer('observed_requested'),
  observedExpectedAfterAmbiguous: integer('observed_expected_after_ambiguous'),
  observationConflict: integer('observation_conflict'),
  observationMissing: integer('observation_missing'),
  pendingObservation: integer('pending_observation'),
  providerCallsCommitted: integer('provider_calls_committed'),
  providerCallsCompleted: integer('provider_calls_completed'),
  status: text('status'),
}).existing();

export type SpWriteEnvironmentGateVersionRow = typeof spWriteEnvironmentGateVersions.$inferSelect;
export type SpWriteEnvironmentGateHeadRow = typeof spWriteEnvironmentGateHead.$inferSelect;
export type SpWriteProfileGrantVersionRow = typeof spWriteProfileGrantVersions.$inferSelect;
export type SpWriteProfileGrantHeadRow = typeof spWriteProfileGrantHeads.$inferSelect;
export type SpWriteBoundedAuthorizationRow = typeof spWriteBoundedAuthorizations.$inferSelect;
export type SpWriteBoundedAuthorizationProfileRow =
  typeof spWriteBoundedAuthorizationProfiles.$inferSelect;
export type SpWriteBoundedAuthorizationEntityRow =
  typeof spWriteBoundedAuthorizationEntities.$inferSelect;
export type SpWriteBoundedAuthorizationRevocationRow =
  typeof spWriteBoundedAuthorizationRevocations.$inferSelect;
export type SpWriteBoundedAuthorizationConsumptionRow =
  typeof spWriteBoundedAuthorizationConsumptions.$inferSelect;
export type SpWritePlanRow = typeof spWritePlans.$inferSelect;
export type SpWritePlanActionRow = typeof spWritePlanActions.$inferSelect;
export type SpWriteApprovalRequestRow = typeof spWriteApprovalRequests.$inferSelect;
export type SpWriteExecutionCycleRow = typeof spWriteExecutionCycles.$inferSelect;
export type SpWriteAuthorizationReceiptRow = typeof spWriteAuthorizationReceipts.$inferSelect;
export type SpWriteCyclePlanRow = typeof spWriteCyclePlans.$inferSelect;
export type SpWriteExecutionRequestRow = typeof spWriteExecutionRequests.$inferSelect;
export type SpWriteDispatchLeaseRow = typeof spWriteDispatchLeases.$inferSelect;
export type SpWritePredispatchObservationRow = typeof spWritePredispatchObservations.$inferSelect;
export type SpWritePredispatchObservationItemRow =
  typeof spWritePredispatchObservationItems.$inferSelect;
export type SpWritePredispatchDispositionRow = typeof spWritePredispatchDispositions.$inferSelect;
export type SpWriteProviderCallIntentRow = typeof spWriteProviderCallIntents.$inferSelect;
export type SpWriteProviderCallPositionRow = typeof spWriteProviderCallPositions.$inferSelect;
export type SpWriteActionResolutionRow = typeof spWriteActionResolutions.$inferSelect;
export type SpWriteProviderResultRow = typeof spWriteProviderResults.$inferSelect;
export type SpWriteProviderResultPositionRow = typeof spWriteProviderResultPositions.$inferSelect;
export type SpWriteObservationRow = typeof spWriteObservations.$inferSelect;
export type SpWriteOutboxRow = typeof spWriteOutbox.$inferSelect;
export type SpWriteLateResultAuditRow = typeof spWriteLateResultAudits.$inferSelect;
export type SpWriteExecutionAccountingRow = typeof spWriteExecutionAccounting.$inferSelect;
