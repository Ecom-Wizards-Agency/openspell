import { createHash } from 'node:crypto';
import { SpWriteMirrorReceipt } from '@wizard-ads/shared/sp-write-mirror';
import { SpWriteObservation, serializeSpWriteObservationFingerprint } from '@wizard-ads/shared/sp-writes';
import type { DbHandle } from '../client.js';

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
