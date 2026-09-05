/** SQL owns these private credential/authority tables; this is the typed mirror. */
import { boolean, date, foreignKey, index, integer, jsonb, pgSchema, primaryKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { McpApiKeyScope } from '@wizard-ads/shared/mcp-writes';
import type { McpWriteDelegation } from '@wizard-ads/shared/mcp-writes';
import type { McpBidApplyRequest, McpBidPreviewRequest } from '@wizard-ads/shared/mcp-writes';
import type { McpBidProposalArtifact } from '@wizard-ads/shared/sp-write-preview-evidence';
import { ts } from './columns.js';
import { authUsers, orgs } from './tenancy.js';
import { applyBatches } from './apply.js';
import { spWriteApprovalRequests, spWriteAuthorizationReceipts, spWritePlans } from './sp-writes.js';

const mcp = pgSchema('mcp');
export const mcpKeyScope = mcp.enum('key_scope', McpApiKeyScope.enum);
export const mcpApiKeys = mcp.table('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  keyPrefix: text('key_prefix').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  scope: mcpKeyScope('scope').notNull().default('read'),
  profileIds: uuid('profile_ids').array(),
  expiresAt: ts('expires_at'),
  revokedAt: ts('revoked_at'),
  lastUsedAt: ts('last_used_at'),
  createdBy: uuid('created_by').references(() => authUsers.id, { onDelete: 'set null' }),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [unique('api_keys_tenant_identity_key').on(t.orgId, t.id), index('api_keys_org_idx').on(t.orgId, t.createdAt.desc())]);

export const mcpWriteDelegations = mcp.table('write_delegations', {
  versionId: uuid('version_id').primaryKey(),
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  keyId: uuid('key_id').notNull().unique(),
  issuerUserId: uuid('issuer_user_id').notNull().references(() => authUsers.id),
  issuedAt: ts('issued_at').notNull(),
  expiresAt: ts('expires_at').notNull(),
  artifactText: text('artifact_text').notNull(),
  artifact: jsonb('artifact').$type<McpWriteDelegation>().notNull(),
  fingerprintPreimage: text('fingerprint_preimage').notNull(),
  fingerprint: text('fingerprint').notNull(),
}, (t) => [
  foreignKey({ name: 'write_delegations_key_fkey', columns: [t.orgId, t.keyId],
    foreignColumns: [mcpApiKeys.orgId, mcpApiKeys.id] }).onDelete('cascade'),
  unique('write_delegations_scope_key').on(t.orgId, t.keyId, t.versionId),
]);

/** SQL keeps the plan FK deferred so preparation can insert source and plan atomically. */
export const mcpWritePreviews = mcp.table('write_previews', {
  planId: uuid('plan_id').primaryKey(),
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(),
  keyId: uuid('key_id').notNull(),
  delegationVersionId: uuid('delegation_version_id').notNull(),
  requestId: uuid('request_id').notNull(),
  requestText: text('request_text').notNull(),
  request: jsonb('request').$type<McpBidPreviewRequest>().notNull(),
  requestPreimage: text('request_preimage').notNull(),
  requestFingerprint: text('request_fingerprint').notNull(),
  preparedAt: ts('prepared_at').notNull(),
}, (t) => [
  unique('write_previews_request_key').on(t.orgId, t.keyId, t.requestId),
  unique('write_previews_tenant_key').on(t.orgId, t.profileId, t.planId),
  foreignKey({ name: 'write_previews_plan_fkey', columns: [t.orgId, t.profileId, t.planId],
    foreignColumns: [spWritePlans.orgId, spWritePlans.profileId, spWritePlans.planId] }).onDelete('cascade'),
  foreignKey({ name: 'write_previews_delegation_fkey', columns: [t.orgId, t.keyId, t.delegationVersionId],
    foreignColumns: [mcpWriteDelegations.orgId, mcpWriteDelegations.keyId, mcpWriteDelegations.versionId] }).onDelete('cascade'),
]);

export const mcpBidProposalSources = mcp.table('bid_proposal_sources', {
  batchId: uuid('batch_id').primaryKey(),
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(),
  planId: uuid('plan_id').notNull().unique(),
  artifactText: text('artifact_text').notNull(),
  artifact: jsonb('artifact').$type<McpBidProposalArtifact>().notNull(),
  artifactSha256: text('artifact_sha256').notNull(),
}, (t) => [
  foreignKey({ name: 'bid_proposal_sources_batch_fkey', columns: [t.orgId, t.profileId, t.batchId],
    foreignColumns: [applyBatches.orgId, applyBatches.profileId, applyBatches.id] }).onDelete('cascade'),
  foreignKey({ name: 'bid_proposal_sources_preview_fkey', columns: [t.orgId, t.profileId, t.planId],
    foreignColumns: [mcpWritePreviews.orgId, mcpWritePreviews.profileId, mcpWritePreviews.planId] }).onDelete('cascade'),
  unique('bid_proposal_sources_tenant_key').on(t.orgId, t.profileId, t.batchId),
]);

/** No enabled gate is seeded. Only scoped operator database control changes its head. */
export const mcpWriteGateVersions = mcp.table('write_gate_versions', {
  versionId: uuid('version_id').primaryKey(),
  enabled: boolean('enabled').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});
export const mcpWriteGateHead = mcp.table('write_gate_head', {
  singleton: boolean('singleton').primaryKey().default(true),
  versionId: uuid('version_id').notNull().references(() => mcpWriteGateVersions.versionId),
});

/** Immutable request recovery and permanent UTC row charge; SQL closes receipt/audit/outbox atomically. */
export const mcpWriteAdmissions = mcp.table('write_admissions', {
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  keyId: uuid('key_id').notNull(),
  mcpRequestId: uuid('mcp_request_id').notNull(),
  profileId: uuid('profile_id').notNull(),
  planId: uuid('plan_id').notNull().unique(),
  planFingerprint: text('plan_fingerprint').notNull(),
  delegationVersionId: uuid('delegation_version_id').notNull(),
  approvalRequestId: uuid('approval_request_id').notNull().unique(),
  approvalId: uuid('approval_id').notNull().unique(),
  executionId: uuid('execution_id').notNull(),
  generation: uuid('generation').notNull(),
  mcpGateVersionId: uuid('mcp_gate_version_id').notNull().references(() => mcpWriteGateVersions.versionId),
  reservationId: uuid('reservation_id').notNull().unique(),
  reservationDay: date('reservation_day', { mode: 'string' }).notNull(),
  reservedRows: integer('reserved_rows').notNull(),
  admittedAt: ts('admitted_at').notNull(),
  requestText: text('request_text').notNull(),
  request: jsonb('request').$type<McpBidApplyRequest>().notNull(),
  requestPreimage: text('request_preimage').notNull(),
  requestFingerprint: text('request_fingerprint').notNull(),
}, (t) => [
  primaryKey({ columns: [t.orgId, t.keyId, t.mcpRequestId] }),
  index('write_admissions_daily_rows_idx').on(t.orgId, t.keyId, t.reservationDay),
  foreignKey({ name: 'write_admissions_preview_fkey', columns: [t.orgId, t.profileId, t.planId],
    foreignColumns: [mcpWritePreviews.orgId, mcpWritePreviews.profileId, mcpWritePreviews.planId] }).onDelete('cascade'),
  foreignKey({ name: 'write_admissions_delegation_fkey', columns: [t.orgId, t.keyId, t.delegationVersionId],
    foreignColumns: [mcpWriteDelegations.orgId, mcpWriteDelegations.keyId, mcpWriteDelegations.versionId] }).onDelete('cascade'),
  foreignKey({ name: 'write_admissions_receipt_fkey',
    columns: [t.orgId, t.profileId, t.executionId, t.planId, t.approvalId, t.generation],
    foreignColumns: [spWriteAuthorizationReceipts.orgId, spWriteAuthorizationReceipts.profileId,
      spWriteAuthorizationReceipts.executionId, spWriteAuthorizationReceipts.planId,
      spWriteAuthorizationReceipts.approvalId, spWriteAuthorizationReceipts.generation] }).onDelete('cascade'),
  foreignKey({ name: 'write_admissions_request_fkey', columns: [t.orgId, t.profileId, t.approvalRequestId],
    foreignColumns: [spWriteApprovalRequests.orgId, spWriteApprovalRequests.profileId,
      spWriteApprovalRequests.approvalRequestId] }).onDelete('cascade'),
]);
