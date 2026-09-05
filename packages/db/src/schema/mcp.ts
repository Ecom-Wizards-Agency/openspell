/** SQL owns these private credential/authority tables; this is the typed mirror. */
import { foreignKey, index, jsonb, pgSchema, text, unique, uuid } from 'drizzle-orm/pg-core';
import { McpApiKeyScope } from '@wizard-ads/shared/mcp-writes';
import type { McpWriteDelegation } from '@wizard-ads/shared/mcp-writes';
import type { McpBidPreviewRequest } from '@wizard-ads/shared/mcp-writes';
import type { McpBidProposalArtifact } from '@wizard-ads/shared/sp-write-preview-evidence';
import { ts } from './columns.js';
import { authUsers, orgs } from './tenancy.js';
import { applyBatches } from './apply.js';
import { spWritePlans } from './sp-writes.js';

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
