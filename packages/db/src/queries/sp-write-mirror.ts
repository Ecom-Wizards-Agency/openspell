import { createHash } from 'node:crypto';
import { SpWriteMirrorCounts, SpWriteMirrorReceipt } from '@wizard-ads/shared/sp-write-mirror';
import { SpWriteObservation, serializeSpWriteObservationFingerprint, type SpWriteExecutionEvidence } from '@wizard-ads/shared/sp-writes';
import type { DbHandle } from '../client.js';

// PostgreSQL emits six fractional digits; ledger JSON can retain fewer. Do not
// compare through Date, which would erase a real sub-millisecond difference.
function canonicalInstant(value: string): string {
  return value.replace(/\.(\d+)Z$/, (_match, fraction: string) => {
    const significant = fraction.replace(/0+$/, '');
    return significant.length === 0 ? 'Z' : `.${significant}Z`;
  });
}

/** Reconciles one already persisted provider observation. This performs no Amazon call. */
export async function reconcileSpWriteObservation(
  database: Pick<DbHandle, 'sql'>, rawObservation: SpWriteObservation,
): Promise<SpWriteMirrorReceipt> {
  const observation = SpWriteObservation.parse(rawObservation);
  const digest = createHash('sha256').update(serializeSpWriteObservationFingerprint(observation)).digest('hex');
  if (digest !== observation.fingerprint) throw new Error('SP write mirror observation fingerprint mismatch');
  const rows = await database.sql<{ artifact: unknown }[]>`
    select app.reconcile_sp_write_mirror(${observation.observationId}::uuid, ${observation.fingerprint}) as artifact
  `;
  if (rows.length !== 1) throw new Error('SP write mirror receipt count mismatch');
  const receipt = SpWriteMirrorReceipt.parse(rows[0]!.artifact);
  if (receipt.observationId !== observation.observationId || receipt.observationFingerprint !== observation.fingerprint
    || receipt.executionId !== observation.executionId || receipt.planId !== observation.planId
    || receipt.actionId !== observation.actionId || receipt.observationOutcome !== observation.outcome) {
    throw new Error('SP write mirror receipt identity mismatch');
  }
  return receipt;
}

/** Only immutable observations included in this verified execution snapshot are counted. */
export async function readSpWriteMirrorCounts(
  handle: Pick<DbHandle, 'sql'>, evidence: SpWriteExecutionEvidence,
): Promise<SpWriteMirrorCounts> {
  const counts: SpWriteMirrorCounts = { observations: evidence.observations.length, pending: evidence.observations.length,
    promoted: 0, alreadyCurrent: 0, superseded: 0, missing: 0 };
  if (counts.observations === 0) return SpWriteMirrorCounts.parse(counts);
  const observations = new Map(evidence.observations.map((observation) => [observation.observationId, observation]));
  const rows = await handle.sql<{ artifact: unknown }[]>`
    select artifact from public.sp_write_mirror_observations
    where org_id = ${evidence.plan.orgId}::uuid and profile_id = ${evidence.plan.profileId}::uuid
      and execution_id = ${evidence.authorization.executionId}::uuid and plan_id = ${evidence.plan.id}::uuid
      and observation_id = any(${[...observations.keys()]}::uuid[])`;
  const seen = new Set<string>();
  for (const row of rows) {
    const receipt = SpWriteMirrorReceipt.parse(row.artifact);
    const observation = observations.get(receipt.observationId);
    const action = evidence.plan.actions.find((candidate) => candidate.actionId === receipt.actionId);
    if (observation === undefined || action === undefined || seen.has(receipt.observationId)
      || receipt.observationFingerprint !== observation.fingerprint || receipt.actionId !== observation.actionId
      || receipt.observationOutcome !== observation.outcome || canonicalInstant(receipt.observedAt) !== canonicalInstant(observation.observedAt)
      || receipt.orgId !== evidence.plan.orgId || receipt.profileId !== evidence.plan.profileId
      || receipt.executionId !== evidence.authorization.executionId || receipt.planId !== evidence.plan.id
      || action.routeKey !== 'sp.v3.keywords.update'
      || receipt.amazonEntityId !== action.entity.keywordId) throw new Error('SP write mirror status evidence mismatch');
    seen.add(receipt.observationId);
    counts.pending -= 1;
    if (receipt.outcome === 'already_current') counts.alreadyCurrent += 1;
    else counts[receipt.outcome] += 1;
  }
  return SpWriteMirrorCounts.parse(counts);
}
