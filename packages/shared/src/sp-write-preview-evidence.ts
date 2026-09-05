import { z } from 'zod';
import { Uuid } from './primitives.js';
import { ApplyRowWire } from './apply.js';
import { TenantStrategy } from './strategy.js';
import { OptimizationGroupSnapshot, normalizeOptimizationGroupSnapshot } from './optimization.js';
import { SpWriteProviderScope, SpWriteSha256 } from './sp-writes.js';

/** The policy actually attached to each exported recommendation at preview time. */
const PreviewPolicy = z.object({
  applyRowId: Uuid,
  recommendationId: Uuid,
  runId: Uuid,
  strategySnapshot: TenantStrategy,
  strategyGoal: z.string().min(1),
  groupId: Uuid.nullable(),
  groupSnapshot: OptimizationGroupSnapshot.nullable(),
}).strict().superRefine((value, context) => {
  if ((value.groupId === null) !== (value.groupSnapshot === null)
    || (value.groupSnapshot !== null
      && normalizeOptimizationGroupSnapshot(value.groupSnapshot).group.id !== value.groupId)) {
    context.addIssue({ code: 'custom', path: ['groupSnapshot'], message: 'policy group snapshot differs from its identity' });
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

export function serializeSpWritePreviewGuardrails(raw: SpWritePreviewEvidence): string {
  const evidence = SpWritePreviewEvidence.parse(raw);
  return JSON.stringify(['openspell.sp-write-preview-guards.v1', evidence.guardrails]);
}

export function serializeSpWritePreviewProvenance(raw: SpWritePreviewEvidence): string {
  const evidence = SpWritePreviewEvidence.parse(raw);
  return JSON.stringify(['openspell.sp-write-preview-source.v1', evidence.provenance]);
}
