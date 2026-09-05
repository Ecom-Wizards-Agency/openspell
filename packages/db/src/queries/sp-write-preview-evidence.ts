import { createHash } from 'node:crypto';
import {
  SpWritePreviewEvidence,
  serializeSpWritePreviewGuardrails,
  serializeSpWritePreviewProvenance,
} from '@wizard-ads/shared/sp-write-preview-evidence';
import {
  serializeSpWriteActionFingerprint,
  serializeSpWritePlanFingerprint,
  verifySpWritePlanFingerprints,
  type SpWritePlan,
} from '@wizard-ads/shared/sp-writes';
import type { DbHandle, QuerySql } from '../client.js';
import { SpWriteApplicationError } from './sp-write-errors.js';

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const hasher = { algorithm: 'sha256' as const, digest: hash };

function verify(rawPlan: unknown, rawEvidence: unknown) {
  const plan = verifySpWritePlanFingerprints(rawPlan, hasher);
  const evidence = SpWritePreviewEvidence.parse(rawEvidence);
  if (plan.direction !== 'forward' || plan.source.kind !== 'apply_batch'
    || evidence.planId !== plan.id || evidence.provenance.applyBatchId !== plan.source.applyBatchId
    || evidence.provenance.rows.length !== plan.counts.providerRows
    || JSON.stringify(evidence.guardrails.providerScope) !== JSON.stringify(plan.providerScope)
    || hash(evidence.provenance.artifactText) !== evidence.provenance.artifactSha256
    || hash(serializeSpWritePreviewGuardrails(evidence)) !== plan.source.guardrailSnapshotFingerprint
    || hash(serializeSpWritePreviewProvenance(evidence)) !== plan.source.provenanceSnapshotFingerprint
    || evidence.provenance.rows.some((row) => plan.actions.filter((action) =>
      action.sources.some((source) => source.kind === 'apply_row' && source.applyRowId === row.applyRowId)).length !== 1)) {
    throw new SpWriteApplicationError('source_changed');
  }
  return { plan, evidence };
}

export async function loadSpWritePreviewEvidence(
  sql: QuerySql, identity: { orgId: string; profileId: string; planId: string },
) {
  const rows = await sql<{ plan_text: string; evidence_text: string | null }[]>`
    select p.artifact_text as plan_text, e.artifact_text as evidence_text
      from public.sp_write_plans p
      left join public.sp_write_preview_evidence e
        on e.org_id = p.org_id and e.profile_id = p.profile_id and e.plan_id = p.plan_id
     where p.org_id = ${identity.orgId}::uuid and p.profile_id = ${identity.profileId}::uuid
       and p.plan_id = ${identity.planId}::uuid
  `;
  if (rows.length === 0) return null;
  if (rows.length !== 1 || rows[0]?.evidence_text == null) throw new SpWriteApplicationError('identity_conflict');
  return verify(JSON.parse(rows[0].plan_text), JSON.parse(rows[0].evidence_text));
}

/** One SQL transaction records both artifacts or neither. This does not grant execution. */
export async function recordSpWritePreviewEvidence(
  handle: Pick<DbHandle, 'sql'>, rawPlan: SpWritePlan, rawEvidence: SpWritePreviewEvidence,
): Promise<void> {
  const { plan, evidence } = verify(rawPlan, rawEvidence);
  try {
    const rows = await handle.sql<{ plan_id: string }[]>`
      select app.record_sp_write_preview(
        ${JSON.stringify(plan)}, ${serializeSpWritePlanFingerprint(plan)},
        ${JSON.stringify(plan.actions.map((action) => ({
          artifactText: JSON.stringify(action), fingerprintPreimage: serializeSpWriteActionFingerprint(action),
        })))}::jsonb,
        ${JSON.stringify(evidence)}, ${serializeSpWritePreviewGuardrails(evidence)},
        ${serializeSpWritePreviewProvenance(evidence)}
      )::text as plan_id
    `;
    if (rows.length !== 1 || rows[0]?.plan_id !== plan.id) throw new SpWriteApplicationError('outcome_unknown');
  } catch (error) {
    if (error instanceof SpWriteApplicationError) throw error;
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
    if (code === '23505') throw new SpWriteApplicationError('identity_conflict');
    if (code === '55000' || code === 'P0002') throw new SpWriteApplicationError('source_changed');
    if (code === '22023' || code === '22P02') throw new SpWriteApplicationError('invalid_request');
    if (code === '42501') throw new SpWriteApplicationError('authorization_refused');
    throw new SpWriteApplicationError('outcome_unknown');
  }
}
