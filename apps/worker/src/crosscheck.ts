/**
 * The worker half of the `crosscheck.ingest` wiring.
 *
 * WP-10 owns the logic and ships it as `runCrosscheckIngest`; this file is the
 * seam the worker calls it through, so a test can substitute a fake without a
 * real inbox on disk, and `docs/handoffs-to-wp03.md`'s retry table has one
 * place to live.
 */
import { isAbsolute, resolve } from 'node:path';
import type { DbHandle } from '@wizard-ads/db';
import { runCrosscheckIngest, type CrosscheckIngestResult } from '@wizard-ads/crosscheck-cli';
import type { CrosscheckIngestJob } from '@wizard-ads/shared';

export type CrosscheckIngest = (job: CrosscheckIngestJob) => Promise<CrosscheckIngestResult>;

/**
 * Failures no retry can fix. From the handoff's retry table: a wrong profile,
 * a missing column or an unreadable date is a human's problem, and a payload
 * naming a profile we do not have will name it again in five minutes.
 */
const PERMANENT_ERRORS = new Set(['ExportContractError', 'ProfileNotFound']);

export function isPermanentCrosscheckError(error: unknown): boolean {
  return error instanceof Error && PERMANENT_ERRORS.has(error.name);
}

export interface CrosscheckIngestConfig {
  /**
   * Root of the export inbox. A schedule's payload carries the profile-night
   * directory relative to it, so the machine-specific half of the path stays in
   * the environment and out of both the database and the repo.
   */
  inboxDir?: string;
  archive?: boolean;
}

export function createCrosscheckIngest(
  handle: DbHandle,
  config: CrosscheckIngestConfig = {},
): CrosscheckIngest {
  return (job) =>
    runCrosscheckIngest(
      handle,
      { ...job, sourcePath: resolveSourcePath(job.sourcePath, config.inboxDir) },
      { archive: config.archive ?? true },
    );
}

export function resolveSourcePath(sourcePath: string, inboxDir?: string): string {
  if (isAbsolute(sourcePath) || !inboxDir) return sourcePath;
  return resolve(inboxDir, sourcePath);
}
