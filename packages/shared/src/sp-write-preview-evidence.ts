import { z } from 'zod';
import { Uuid } from './primitives.js';
import { ApplyRowWire } from './apply.js';
import { TenantStrategy } from './strategy.js';
import { OptimizationGroupSnapshot, normalizeOptimizationGroupSnapshot } from './optimization.js';
import {
  McpKeywordBidProposal, McpWriteDelegation, SpWriteProviderScope, SpWriteSha256,
  verifyMcpPlanLimits, verifyMcpWriteDelegationFingerprint, verifySpWritePlanFingerprints,
  type SpWriteSha256Hasher,
} from './sp-writes.js';

/** The policy actually attached to each exported recommendation at preview time. */
const PreviewPolicy = z.object({
  applyRowId: Uuid,
  recommendationId: Uuid,
  runId: Uuid,
  strategySnapshotText: z.string().refine((text) => {
    try { return TenantStrategy.safeParse(JSON.parse(text)).success; } catch { return false; }
  }, 'expected the exact stored tenant strategy JSON'),
  strategyGoal: z.string().min(1),
  groupId: Uuid.nullable(),
  groupSnapshotText: z.string().refine((text) => {
    try { return OptimizationGroupSnapshot.safeParse(JSON.parse(text)).success; } catch { return false; }
  }, 'expected the exact stored group snapshot JSON').nullable(),
}).strict().superRefine((value, context) => {
  let groupId: string | null = null;
  try {
    if (value.groupSnapshotText !== null) groupId = normalizeOptimizationGroupSnapshot(JSON.parse(value.groupSnapshotText)).group.id;
  } catch { /* The field refinement reports malformed snapshots. */ }
  if (groupId !== value.groupId || (value.groupId === null) !== (value.groupSnapshotText === null)) {
    context.addIssue({ code: 'custom', path: ['groupSnapshotText'], message: 'policy group snapshot differs from its identity' });
  }
});

export const SpWritePreviewEvidence = z.object({
  schemaVersion: z.literal('openspell.sp-write-preview-evidence.v1'),
  planId: Uuid,
  guardrails: z.object({
    profileGrantId: Uuid,
    profileGrantVersion: Uuid,
    providerScope: SpWriteProviderScope,
    maximumProviderRows: z.literal(500),
    requireCurrentValueMatch: z.literal(true),
    policies: z.array(PreviewPolicy).min(1).max(500),
  }).strict(),
  provenance: z.object({
    applyBatchId: Uuid,
    artifactText: z.string().min(1),
    artifactSha256: SpWriteSha256,
    exportedAt: z.iso.datetime(),
    tag: z.string(),
    optGroup: z.string(),
    lever: z.string(),
    note: z.string(),
    /** Exact order in the verified legacy export artifact. */
    rows: z.array(z.object({
      applyRowId: Uuid,
      recommendationId: Uuid,
      runId: Uuid,
      /** Present only for an operator revision frozen by the source export. */
      proposalRevisionId: Uuid.optional(),
    }).strict()).min(1).max(500),
  }).strict(),
}).strict().superRefine((value, context) => {
  const rows = value.provenance.rows;
  const policies = value.guardrails.policies;
  try {
    const artifact = z.array(ApplyRowWire).parse(JSON.parse(value.provenance.artifactText));
    if (artifact.length !== rows.length) throw new Error('count mismatch');
  } catch {
    context.addIssue({ code: 'custom', path: ['provenance', 'artifactText'], message: 'source artifact must contain every recorded row' });
  }
  if (new Set(rows.map((row) => row.applyRowId)).size !== rows.length
    || new Set(rows.map((row) => row.recommendationId)).size !== rows.length
    || policies.length !== rows.length
    || policies.some((policy, index) => {
      const row = rows[index];
      return row === undefined || row.applyRowId !== policy.applyRowId
        || row.recommendationId !== policy.recommendationId || row.runId !== policy.runId;
    })) {
    context.addIssue({ code: 'custom', message: 'every source row needs one exact ordered policy snapshot' });
  }
});
export type SpWritePreviewEvidence = z.infer<typeof SpWritePreviewEvidence>;

const canonicalId = Uuid.refine((value) => value === value.toLowerCase(), 'use canonical lowercase UUIDs');
const mcpSourceRow = McpKeywordBidProposal.safeExtend({ applyRowId: canonicalId });
const mcpRows = z.array(mcpSourceRow).min(1).max(500).refine((rows) =>
  new Set(rows.map((row) => row.applyRowId)).size === rows.length
  && new Set(rows.map((row) => row.keywordId)).size === rows.length, 'proposal rows and entities must be unique');

/** Exact decimal source rows. This is never a legacy ApplyRowWire export. */
export const McpBidProposalArtifact = z.object({
  schemaVersion: z.literal('openspell.mcp-bid-proposal.v1'),
  orgId: canonicalId, profileId: canonicalId, applyBatchId: canonicalId,
  requestId: canonicalId, keyId: canonicalId, issuerUserId: canonicalId, delegationVersionId: canonicalId,
  preparedAt: z.iso.datetime(), note: z.string().trim().min(1).max(1_000), rows: mcpRows,
}).strict();
export type McpBidProposalArtifact = z.infer<typeof McpBidProposalArtifact>;

export function serializeMcpBidProposalArtifact(raw: McpBidProposalArtifact): string {
  return JSON.stringify(McpBidProposalArtifact.parse(raw));
}

export const SpMcpWritePreviewEvidenceV2 = z.object({
  schemaVersion: z.literal('openspell.sp-write-preview-evidence.v2'),
  planId: canonicalId,
  guardrails: z.object({
    profileGrantId: canonicalId, profileGrantVersion: canonicalId, providerScope: SpWriteProviderScope,
    maximumProviderRows: z.literal(500), requireCurrentValueMatch: z.literal(true),
    delegation: McpWriteDelegation,
  }).strict(),
  provenance: z.object({
    kind: z.literal('mcp_keyword_proposals'), applyBatchId: canonicalId,
    artifactText: z.string().min(1), artifactSha256: SpWriteSha256,
    preparedAt: z.iso.datetime(), rows: mcpRows,
  }).strict(),
}).strict().superRefine((value, context) => {
  const d = value.guardrails.delegation;
  let artifact: McpBidProposalArtifact;
  try { artifact = McpBidProposalArtifact.parse(JSON.parse(value.provenance.artifactText)); }
  catch {
    context.addIssue({ code: 'custom', message: 'MCP evidence requires its exact decimal proposal artifact' });
    return;
  }
  if (artifact.orgId !== d.orgId || artifact.keyId !== d.keyId || artifact.issuerUserId !== d.issuerUserId
    || artifact.delegationVersionId !== d.versionId || artifact.applyBatchId !== value.provenance.applyBatchId
    || artifact.preparedAt !== value.provenance.preparedAt
    || !d.profiles.some((profile) => profile.profileId === artifact.profileId
      && profile.currencyCode === value.guardrails.providerScope.currencyCode)
    || JSON.stringify(artifact.rows) !== JSON.stringify(value.provenance.rows)
    || artifact.rows.length > d.limits.maximumRowsPerCall) {
    context.addIssue({ code: 'custom', message: 'MCP evidence must match the recorded issuer, scope and every source row' });
  }
});
export type SpMcpWritePreviewEvidenceV2 = z.infer<typeof SpMcpWritePreviewEvidenceV2>;

/** Keep the original v1 parser available to consumers that must remain recommendation-only. */
export const SpWriteSourceEvidence = z.discriminatedUnion('schemaVersion', [SpWritePreviewEvidence, SpMcpWritePreviewEvidenceV2]);
export type SpWriteSourceEvidence = z.infer<typeof SpWriteSourceEvidence>;

export function serializeSpWritePreviewGuardrails(raw: SpWriteSourceEvidence): string {
  const evidence = SpWriteSourceEvidence.parse(raw);
  return JSON.stringify([evidence.schemaVersion === 'openspell.sp-write-preview-evidence.v1'
    ? 'openspell.sp-write-preview-guards.v1' : 'openspell.sp-write-preview-guards.v2', evidence.guardrails]);
}

export function serializeSpWritePreviewProvenance(raw: SpWriteSourceEvidence): string {
  const evidence = SpWriteSourceEvidence.parse(raw);
  return JSON.stringify([evidence.schemaVersion === 'openspell.sp-write-preview-evidence.v1'
    ? 'openspell.sp-write-preview-source.v1' : 'openspell.sp-write-preview-source.v2', evidence.provenance]);
}

/** Verify MCP source bytes and exact planned values; legacy sources retain their SQL validator. */
export function verifyMcpWritePreviewEvidenceArtifacts(rawPlan: unknown, rawEvidence: unknown, hasher: SpWriteSha256Hasher) {
  const plan = verifySpWritePlanFingerprints(rawPlan, hasher);
  const evidence = SpMcpWritePreviewEvidenceV2.parse(rawEvidence);
  if (plan.direction !== 'forward' || plan.source.kind !== 'apply_batch'
    || evidence.planId !== plan.id || evidence.provenance.applyBatchId !== plan.source.applyBatchId
    || evidence.provenance.rows.length !== plan.counts.providerRows
    || JSON.stringify(evidence.guardrails.providerScope) !== JSON.stringify(plan.providerScope)
    || hasher.digest(evidence.provenance.artifactText) !== evidence.provenance.artifactSha256
    || hasher.digest(serializeSpWritePreviewGuardrails(evidence)) !== plan.source.guardrailSnapshotFingerprint
    || hasher.digest(serializeSpWritePreviewProvenance(evidence)) !== plan.source.provenanceSnapshotFingerprint
    || evidence.provenance.rows.some((row) => plan.actions.filter((action) =>
      action.sources.some((source) => source.kind === 'apply_row' && source.applyRowId === row.applyRowId)).length !== 1)) {
    throw new Error('preview evidence differs from the plan');
  }
  const artifact = McpBidProposalArtifact.parse(JSON.parse(evidence.provenance.artifactText));
  const delegation = verifyMcpWriteDelegationFingerprint(evidence.guardrails.delegation, hasher);
  verifyMcpPlanLimits(plan, delegation);
  if (artifact.orgId !== plan.orgId || artifact.profileId !== plan.profileId
      || Date.parse(artifact.preparedAt) > Date.parse(plan.generatedAt)
      || Date.parse(artifact.preparedAt) < Date.parse(delegation.issuedAt)
      || Date.parse(plan.generatedAt) >= Date.parse(delegation.expiresAt)
      || Date.parse(plan.frozenAt) >= Date.parse(delegation.expiresAt)
      || Date.parse(plan.expiresAt) > Date.parse(delegation.expiresAt)
      || artifact.rows.some((row) => {
        const action = plan.actions.find((candidate) => candidate.sources.some((source) =>
          source.kind === 'apply_row' && source.applyRowId === row.applyRowId));
        return action === undefined || action.routeKey !== 'sp.v3.keywords.update'
          || action.sources.length !== 1 || action.entity.keywordId !== row.keywordId
          || action.changes.bid?.expected.amount !== row.expectedBid
          || action.changes.bid.requested.amount !== row.requestedBid;
      })) throw new Error('MCP proposal differs from its exact plan and authority');
  return { plan, evidence };
}
