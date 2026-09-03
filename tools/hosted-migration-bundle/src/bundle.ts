import {
  buildWithPolicy,
  type BundleEvidence as EngineBundleEvidence,
  verifyWithPolicy,
} from './engine.js';
import { HOSTED_MIGRATION_BUNDLE_POLICY } from './policy.js';

export interface BundleEvidence {
  readonly status: 'verified';
  readonly artifactMode: 'sealed' | 'cli_workdir';
  readonly sourceRevision: string;
  readonly baselineFiles: 41;
  readonly addedFiles: 5;
  readonly totalFiles: 46;
  readonly totalBytes: 646628;
  readonly lastVersion: '20260901060000';
  readonly baselineLedgerSha256: string;
  readonly bundleLedgerSha256: string;
  readonly manifestSha256: string;
}

export interface BuildBundleOptions {
  readonly historyWorkdir: string;
  readonly outputWorkdir: string;
  readonly sourceRevision: string;
}

export interface VerifyBundleOptions {
  readonly bundleWorkdir: string;
  readonly sourceRevision: string;
  readonly mode: 'sealed' | 'cli-workdir';
}

export async function buildHostedMigrationBundle(
  options: BuildBundleOptions,
): Promise<BundleEvidence> {
  const evidence = await buildWithPolicy({
    ...options,
    repoWorkdir: process.cwd(),
    policy: HOSTED_MIGRATION_BUNDLE_POLICY,
  });
  return publicEvidence(evidence);
}

export async function verifyHostedMigrationBundle(
  options: VerifyBundleOptions,
): Promise<BundleEvidence> {
  const evidence = await verifyWithPolicy({
    ...options,
    repoWorkdir: process.cwd(),
    policy: HOSTED_MIGRATION_BUNDLE_POLICY,
  });
  return publicEvidence(evidence);
}

function publicEvidence(evidence: EngineBundleEvidence): BundleEvidence {
  if (
    evidence.baselineFiles !== 41 ||
    evidence.addedFiles !== 5 ||
    evidence.totalFiles !== 46 ||
    evidence.totalBytes !== 646628 ||
    evidence.lastVersion !== '20260901060000'
  ) {
    throw new Error('fixed hosted migration policy invariant failed');
  }
  return {
    ...evidence,
    baselineFiles: 41,
    addedFiles: 5,
    totalFiles: 46,
    totalBytes: 646628,
    lastVersion: '20260901060000',
  };
}
