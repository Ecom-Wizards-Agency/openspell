import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants,
  lstatSync,
  type BigIntStats,
} from 'node:fs';
import {
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import type { HostedMigrationBundlePolicy, MigrationPolicyEntry } from './policy.js';

const execFileAsync = promisify(execFile);
const MARKER = '.BUNDLE_UNPUBLISHED';
const MANIFEST = 'BUNDLE_MANIFEST.json';
const REVISION = /^[0-9a-f]{40}$/u;
const VERSIONED_SQL = /^(\d{14})_[A-Za-z0-9][A-Za-z0-9._-]*\.sql$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_GIT_OUTPUT = 2 * 1024 * 1024;

export type ArtifactMode = 'sealed' | 'cli-workdir';

export interface BundleEvidence {
  readonly status: 'verified';
  readonly artifactMode: 'sealed' | 'cli_workdir';
  readonly sourceRevision: string;
  readonly baselineFiles: number;
  readonly addedFiles: number;
  readonly totalFiles: number;
  readonly totalBytes: number;
  readonly lastVersion: string;
  readonly baselineLedgerSha256: string;
  readonly bundleLedgerSha256: string;
  readonly manifestSha256: string;
}

export interface EngineBuildOptions {
  readonly historyWorkdir: string;
  readonly outputWorkdir: string;
  readonly sourceRevision: string;
  readonly repoWorkdir: string;
  readonly policy: HostedMigrationBundlePolicy;
  /** Package-internal failure injection; the public build operation never accepts hooks. */
  readonly testHooks?: {
    readonly afterBaselineSnapshot?: () => Promise<void>;
    readonly beforeOutputClaim?: (outputWorkdir: string) => Promise<void>;
    readonly afterParentCustodyCheckBeforeOutputClaim?: (outputWorkdir: string) => Promise<void>;
    readonly beforeManifestWrite?: (outputWorkdir: string) => Promise<void>;
    readonly beforeMarkedVerification?: (outputWorkdir: string) => Promise<void>;
    readonly afterOutputReadyBeforeCommit?: (outputWorkdir: string) => Promise<void>;
    readonly afterCommit?: (outputWorkdir: string) => Promise<void>;
  };
}

export interface EngineVerifyOptions {
  readonly bundleWorkdir: string;
  readonly sourceRevision: string;
  readonly mode: ArtifactMode;
  readonly repoWorkdir: string;
  readonly policy: HostedMigrationBundlePolicy;
}

type FailureCode =
  | 'INVALID_ARGUMENT'
  | 'REPOSITORY_STATE'
  | 'SOURCE_POLICY'
  | 'PATH_POLICY'
  | 'BASELINE_POLICY'
  | 'ARTIFACT_POLICY'
  | 'PUBLISH_FAILED';

export class BundleFailure extends Error {
  public readonly code: FailureCode;

  public constructor(code: FailureCode) {
    super(`hosted migration bundle refused: ${code.toLowerCase()}`);
    this.name = 'BundleFailure';
    this.code = code;
  }
}

interface Snapshot extends MigrationPolicyEntry {
  readonly version: string;
  readonly bytes: Buffer;
  readonly provenance: 'hosted_baseline' | 'reviewed_git_blob';
}

interface ManifestAddition {
  readonly workPackage: string;
  readonly repositoryPath: string;
  readonly version: string;
  readonly byteCount: number;
  readonly sha256: string;
}

interface ManifestMigration {
  readonly ordinal: number;
  readonly version: string;
  readonly filename: string;
  readonly byteCount: number;
  readonly sha256: string;
  readonly provenance: 'hosted_baseline' | 'reviewed_git_blob';
}

interface BundleManifest {
  readonly schemaVersion: 'openspell.hosted-migration-bundle.v1';
  readonly purpose: 'construction_and_review_only';
  readonly sourceRevision: string;
  readonly baseline: {
    readonly fileCount: number;
    readonly byteCount: number;
    readonly lastVersion: string;
    readonly ledgerSha256: string;
  };
  readonly additions: readonly ManifestAddition[];
  readonly bundle: {
    readonly fileCount: number;
    readonly byteCount: number;
    readonly lastVersion: string;
    readonly ledgerSha256: string;
  };
  readonly migrations: readonly ManifestMigration[];
}

function refuse(code: FailureCode): never {
  throw new BundleFailure(code);
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function versionOf(filename: string, code: FailureCode): string {
  if (!/^[\x20-\x7e]+$/u.test(filename)) refuse(code);
  const match = VERSIONED_SQL.exec(filename);
  if (match === null || match[1] === undefined) refuse(code);
  return match[1];
}

export function canonicalLedger(entries: readonly MigrationPolicyEntry[]): string {
  const sorted = [...entries].sort((left, right) =>
    Buffer.from(left.filename).compare(Buffer.from(right.filename)),
  );
  const rows = sorted.map((entry, index) => {
    const version = versionOf(entry.filename, 'SOURCE_POLICY');
    return `${index + 1}\t${version}\t${entry.filename}\t${entry.byteCount}\t${entry.sha256}\n`;
  });
  return `openspell.hosted-migration-ledger.v1\n${rows.join('')}`;
}

function validatePolicy(policy: HostedMigrationBundlePolicy): void {
  const all = [...policy.baseline, ...policy.additions];
  if (policy.baseline.length === 0 || policy.additions.length === 0) refuse('SOURCE_POLICY');

  const filenames = new Set<string>();
  const versions = new Set<string>();
  let previousFilename: string | undefined;
  for (const entry of all) {
    const version = versionOf(entry.filename, 'SOURCE_POLICY');
    if (
      !Number.isSafeInteger(entry.byteCount) ||
      entry.byteCount <= 0 ||
      !SHA256.test(entry.sha256) ||
      filenames.has(entry.filename) ||
      versions.has(version) ||
      (previousFilename !== undefined &&
        Buffer.from(previousFilename).compare(Buffer.from(entry.filename)) >= 0)
    ) {
      refuse('SOURCE_POLICY');
    }
    filenames.add(entry.filename);
    versions.add(version);
    previousFilename = entry.filename;
  }

  for (const addition of policy.additions) {
    if (
      !/^WP-[0-9]+$/u.test(addition.workPackage) ||
      addition.repositoryPath !== `supabase/migrations/${addition.filename}`
    ) {
      refuse('SOURCE_POLICY');
    }
  }

  const baselineBytes = policy.baseline.reduce((total, entry) => total + entry.byteCount, 0);
  const bundleBytes = all.reduce((total, entry) => total + entry.byteCount, 0);
  if (
    baselineBytes !== policy.baselineByteCount ||
    bundleBytes !== policy.bundleByteCount ||
    versionOf(policy.baseline.at(-1)!.filename, 'SOURCE_POLICY') !== policy.baselineLastVersion ||
    versionOf(all.at(-1)!.filename, 'SOURCE_POLICY') !== policy.bundleLastVersion ||
    sha256(canonicalLedger(policy.baseline)) !== policy.baselineLedgerSha256 ||
    sha256(canonicalLedger(all)) !== policy.bundleLedgerSha256
  ) {
    refuse('SOURCE_POLICY');
  }
}

function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

interface DirectoryCustody {
  readonly handle: Awaited<ReturnType<typeof open>>;
  readonly identity: BigIntStats;
}

async function openDirectoryCustody(
  path: string,
  expected: BigIntStats | undefined,
  code: FailureCode,
): Promise<DirectoryCustody> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) refuse(code);
    if ((await realpath(path)) !== path) refuse(code);
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isDirectory() ||
      !sameIdentity(before, opened) ||
      (expected !== undefined && !sameIdentity(expected, opened))
    ) {
      refuse(code);
    }
    return { handle, identity: opened };
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    if (error instanceof BundleFailure) throw error;
    refuse(code);
  }
}

async function assertDirectoryCustody(
  path: string,
  custody: DirectoryCustody,
  code: FailureCode,
): Promise<void> {
  try {
    const pathStat = lstatSync(path, { bigint: true });
    const opened = await custody.handle.stat({ bigint: true });
    if (
      !pathStat.isDirectory() ||
      pathStat.isSymbolicLink() ||
      !opened.isDirectory() ||
      !sameIdentity(custody.identity, pathStat) ||
      !sameIdentity(custody.identity, opened) ||
      (await realpath(path)) !== path
    ) {
      refuse(code);
    }
  } catch (error: unknown) {
    if (error instanceof BundleFailure) throw error;
    refuse(code);
  }
}

function heldDirectoryPath(custody: DirectoryCustody): string {
  if (process.platform !== 'linux') refuse('PUBLISH_FAILED');
  // Linux exposes an open directory descriptor as a descriptor-relative path.
  // The trailing slash makes lstat of the root follow the procfs descriptor,
  // while every child lookup remains anchored to the held directory inode.
  return `/proc/self/fd/${custody.handle.fd}/`;
}

async function claimDirectoryUnderCustody(
  parent: DirectoryCustody,
  name: string,
  code: FailureCode,
): Promise<DirectoryCustody> {
  if (basename(name) !== name || name === '.' || name === '..') refuse(code);
  const claimedPath = join(heldDirectoryPath(parent), name);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(claimedPath, { mode: 0o700 });
    const before = lstatSync(claimedPath, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) refuse(code);
    handle = await open(
      claimedPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory() || !sameIdentity(before, opened)) refuse(code);
    return { handle, identity: opened };
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    if (error instanceof BundleFailure) throw error;
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') refuse('PATH_POLICY');
    refuse(code);
  }
}

async function readRegularFile(
  path: string,
  expected: MigrationPolicyEntry,
  code: FailureCode,
): Promise<Buffer> {
  let before: BigIntStats;
  try {
    before = lstatSync(path, { bigint: true });
  } catch {
    refuse(code);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) refuse(code);

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedBefore = await handle.stat({ bigint: true });
    if (!openedBefore.isFile() || openedBefore.nlink !== 1n || !sameStat(before, openedBefore)) {
      refuse(code);
    }
    const bytes = await handle.readFile();
    const openedAfter = await handle.stat({ bigint: true });
    const after = lstatSync(path, { bigint: true });
    if (!sameStat(openedBefore, openedAfter) || !sameStat(openedAfter, after)) refuse(code);
    if (bytes.byteLength !== expected.byteCount || sha256(bytes) !== expected.sha256) refuse(code);
    return bytes;
  } catch (error: unknown) {
    if (error instanceof BundleFailure) throw error;
    throw new BundleFailure(code);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function git(repoWorkdir: string, args: readonly string[]): Promise<Buffer> {
  try {
    const result = await execFileAsync('git', [...args], {
      cwd: repoWorkdir,
      encoding: 'buffer',
      maxBuffer: MAX_GIT_OUTPUT,
      timeout: 15_000,
      windowsHide: true,
    });
    return result.stdout;
  } catch {
    refuse('REPOSITORY_STATE');
  }
}

async function validateRepository(repoWorkdir: string, revision: string): Promise<string> {
  if (!REVISION.test(revision)) refuse('INVALID_ARGUMENT');
  const rootBytes = await git(repoWorkdir, ['rev-parse', '--show-toplevel']);
  const rootText = rootBytes.toString('utf8').trim();
  if (rootText.length === 0 || rootText.includes('\0')) refuse('REPOSITORY_STATE');

  let root: string;
  try {
    root = await realpath(rootText);
  } catch {
    refuse('REPOSITORY_STATE');
  }

  const [head, originMain, status] = await Promise.all([
    git(root, ['rev-parse', '--verify', 'HEAD']),
    git(root, ['rev-parse', '--verify', 'refs/remotes/origin/main']),
    git(root, ['status', '--porcelain=v1', '--untracked-files=normal']),
  ]);
  if (
    head.toString('ascii').trim() !== revision ||
    originMain.toString('ascii').trim() !== revision ||
    status.byteLength !== 0
  ) {
    refuse('REPOSITORY_STATE');
  }
  return root;
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function validatePaths(
  repoRoot: string,
  historyWorkdir: string,
  outputWorkdir: string,
): Promise<{
  historyRoot: string;
  output: string;
  outputParent: string;
  outputParentIdentity: BigIntStats;
}> {
  let historyRoot: string;
  try {
    const requestedHistory = resolve(historyWorkdir);
    const historyStat = lstatSync(requestedHistory, { bigint: true });
    if (!historyStat.isDirectory() || historyStat.isSymbolicLink()) refuse('PATH_POLICY');
    historyRoot = await realpath(requestedHistory);
  } catch {
    refuse('PATH_POLICY');
  }

  const output = resolve(outputWorkdir);
  if (basename(output) === '' || output === dirname(output)) refuse('PATH_POLICY');
  try {
    lstatSync(output);
    refuse('PATH_POLICY');
  } catch (error: unknown) {
    if (error instanceof BundleFailure) throw error;
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') refuse('PATH_POLICY');
  }

  const requestedParent = dirname(output);
  let outputParent: string;
  try {
    const parentStat = lstatSync(requestedParent, { bigint: true });
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) refuse('PATH_POLICY');
    outputParent = await realpath(requestedParent);
  } catch (error: unknown) {
    if (error instanceof BundleFailure) throw error;
    refuse('PATH_POLICY');
  }
  const canonicalOutput = join(outputParent, basename(output));
  if (
    isWithin(repoRoot, canonicalOutput) ||
    isWithin(historyRoot, canonicalOutput) ||
    isWithin(canonicalOutput, historyRoot)
  ) {
    refuse('PATH_POLICY');
  }
  const outputParentIdentity = lstatSync(outputParent, { bigint: true });
  return { historyRoot, output: canonicalOutput, outputParent, outputParentIdentity };
}

async function readBaseline(
  historyRoot: string,
  policy: HostedMigrationBundlePolicy,
): Promise<Snapshot[]> {
  const supabasePath = join(historyRoot, 'supabase');
  const migrationsPath = join(supabasePath, 'migrations');
  try {
    const supabaseStat = lstatSync(supabasePath, { bigint: true });
    const migrationsStat = lstatSync(migrationsPath, { bigint: true });
    if (
      !supabaseStat.isDirectory() ||
      supabaseStat.isSymbolicLink() ||
      !migrationsStat.isDirectory() ||
      migrationsStat.isSymbolicLink()
    ) {
      refuse('BASELINE_POLICY');
    }
  } catch (error: unknown) {
    if (error instanceof BundleFailure) throw error;
    refuse('BASELINE_POLICY');
  }

  let names: string[];
  try {
    names = (await readdir(migrationsPath, { encoding: 'utf8' })).sort((left, right) =>
      Buffer.from(left).compare(Buffer.from(right)),
    );
  } catch {
    refuse('BASELINE_POLICY');
  }
  const expectedNames = policy.baseline.map((entry) => entry.filename);
  if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) {
    refuse('BASELINE_POLICY');
  }

  const versions = new Set<string>();
  const snapshots: Snapshot[] = [];
  for (const expected of policy.baseline) {
    const version = versionOf(expected.filename, 'BASELINE_POLICY');
    if (versions.has(version)) refuse('BASELINE_POLICY');
    versions.add(version);
    const bytes = await readRegularFile(
      join(migrationsPath, expected.filename),
      expected,
      'BASELINE_POLICY',
    );
    snapshots.push({ ...expected, version, bytes, provenance: 'hosted_baseline' });
  }
  assertSnapshotPolicy(snapshots, policy.baselineByteCount, policy.baselineLedgerSha256, policy.baselineLastVersion, 'BASELINE_POLICY');
  return snapshots;
}

function assertSnapshotPolicy(
  snapshots: readonly Snapshot[],
  expectedBytes: number,
  expectedLedger: string,
  expectedLastVersion: string,
  code: FailureCode,
): void {
  const byteCount = snapshots.reduce((total, entry) => total + entry.byteCount, 0);
  const last = snapshots.at(-1);
  if (
    byteCount !== expectedBytes ||
    last?.version !== expectedLastVersion ||
    sha256(canonicalLedger(snapshots)) !== expectedLedger
  ) {
    refuse(code);
  }
}

export async function readGitAdditionsForPolicy(
  repoRoot: string,
  revision: string,
  policy: HostedMigrationBundlePolicy,
): Promise<Snapshot[]> {
  validatePolicy(policy);
  const snapshots: Snapshot[] = [];
  for (const expected of policy.additions) {
    const bytes = await git(repoRoot, [
      'cat-file',
      'blob',
      `${revision}:${expected.repositoryPath}`,
    ]);
    if (bytes.byteLength !== expected.byteCount || sha256(bytes) !== expected.sha256) {
      refuse('SOURCE_POLICY');
    }
    snapshots.push({
      filename: expected.filename,
      byteCount: expected.byteCount,
      sha256: expected.sha256,
      version: versionOf(expected.filename, 'SOURCE_POLICY'),
      bytes,
      provenance: 'reviewed_git_blob',
    });
  }
  return snapshots;
}

function manifestFor(
  revision: string,
  snapshots: readonly Snapshot[],
  policy: HostedMigrationBundlePolicy,
): BundleManifest {
  return {
    schemaVersion: 'openspell.hosted-migration-bundle.v1',
    purpose: 'construction_and_review_only',
    sourceRevision: revision,
    baseline: {
      fileCount: policy.baseline.length,
      byteCount: policy.baselineByteCount,
      lastVersion: policy.baselineLastVersion,
      ledgerSha256: policy.baselineLedgerSha256,
    },
    additions: policy.additions.map((entry) => ({
      workPackage: entry.workPackage,
      repositoryPath: entry.repositoryPath,
      version: versionOf(entry.filename, 'SOURCE_POLICY'),
      byteCount: entry.byteCount,
      sha256: entry.sha256,
    })),
    bundle: {
      fileCount: snapshots.length,
      byteCount: policy.bundleByteCount,
      lastVersion: policy.bundleLastVersion,
      ledgerSha256: policy.bundleLedgerSha256,
    },
    migrations: snapshots.map((entry, index) => ({
      ordinal: index + 1,
      version: entry.version,
      filename: entry.filename,
      byteCount: entry.byteCount,
      sha256: entry.sha256,
      provenance: entry.provenance,
    })),
  };
}

function manifestBytes(manifest: BundleManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function writeSynced(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function exactNames(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

async function assertTreeShape(root: string, mode: ArtifactMode, marker: 'reject' | 'require'): Promise<void> {
  let rootNames: string[];
  let supabaseNames: string[];
  try {
    const rootStat = lstatSync(root, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) refuse('ARTIFACT_POLICY');
    rootNames = (await readdir(root)).sort();
    const supabasePath = join(root, 'supabase');
    const supabaseStat = lstatSync(supabasePath, { bigint: true });
    if (!supabaseStat.isDirectory() || supabaseStat.isSymbolicLink()) refuse('ARTIFACT_POLICY');
    supabaseNames = (await readdir(supabasePath)).sort();
  } catch (error: unknown) {
    if (error instanceof BundleFailure) throw error;
    refuse('ARTIFACT_POLICY');
  }

  const expectedRoot = marker === 'require' ? [MARKER, MANIFEST, 'supabase'].sort() : [MANIFEST, 'supabase'].sort();
  if (!exactNames(rootNames, expectedRoot)) refuse('ARTIFACT_POLICY');
  const expectedSupabase = mode === 'sealed' ? ['migrations'] : ['.temp', 'migrations'].sort();
  if (mode === 'sealed') {
    if (!exactNames(supabaseNames, expectedSupabase)) refuse('ARTIFACT_POLICY');
  } else {
    const permitted = exactNames(supabaseNames, ['migrations']) || exactNames(supabaseNames, expectedSupabase);
    if (!permitted) refuse('ARTIFACT_POLICY');
    if (supabaseNames.includes('.temp')) {
      const tempStat = lstatSync(join(root, 'supabase', '.temp'), { bigint: true });
      if (!tempStat.isDirectory() || tempStat.isSymbolicLink()) refuse('ARTIFACT_POLICY');
    }
  }
  if (marker === 'require') {
    await readRegularFile(
      join(root, MARKER),
      { filename: MARKER, byteCount: 0, sha256: sha256(Buffer.alloc(0)) },
      'ARTIFACT_POLICY',
    );
  }
}

async function verifyTree(
  root: string,
  revision: string,
  mode: ArtifactMode,
  policy: HostedMigrationBundlePolicy,
  marker: 'reject' | 'require',
): Promise<BundleEvidence> {
  await assertTreeShape(root, mode, marker);
  const migrationsPath = join(root, 'supabase', 'migrations');
  const allPolicy: readonly MigrationPolicyEntry[] = [...policy.baseline, ...policy.additions];
  let names: string[];
  try {
    const migrationStat = lstatSync(migrationsPath, { bigint: true });
    if (!migrationStat.isDirectory() || migrationStat.isSymbolicLink()) refuse('ARTIFACT_POLICY');
    names = (await readdir(migrationsPath)).sort((left, right) =>
      Buffer.from(left).compare(Buffer.from(right)),
    );
  } catch (error: unknown) {
    if (error instanceof BundleFailure) throw error;
    refuse('ARTIFACT_POLICY');
  }
  if (!exactNames(names, allPolicy.map((entry) => entry.filename))) refuse('ARTIFACT_POLICY');

  const snapshots: Snapshot[] = [];
  for (const [index, expected] of allPolicy.entries()) {
    const bytes = await readRegularFile(join(migrationsPath, expected.filename), expected, 'ARTIFACT_POLICY');
    snapshots.push({
      ...expected,
      version: versionOf(expected.filename, 'ARTIFACT_POLICY'),
      bytes,
      provenance: index < policy.baseline.length ? 'hosted_baseline' : 'reviewed_git_blob',
    });
  }
  assertSnapshotPolicy(snapshots, policy.bundleByteCount, policy.bundleLedgerSha256, policy.bundleLastVersion, 'ARTIFACT_POLICY');

  const expectedManifestBytes = manifestBytes(manifestFor(revision, snapshots, policy));
  const manifestPolicy = {
    filename: MANIFEST,
    byteCount: expectedManifestBytes.byteLength,
    sha256: sha256(expectedManifestBytes),
  };
  const observedManifestBytes = await readRegularFile(
    join(root, MANIFEST),
    manifestPolicy,
    'ARTIFACT_POLICY',
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(observedManifestBytes.toString('utf8'));
  } catch {
    refuse('ARTIFACT_POLICY');
  }
  if (`${JSON.stringify(parsed, null, 2)}\n` !== observedManifestBytes.toString('utf8')) {
    refuse('ARTIFACT_POLICY');
  }

  return {
    status: 'verified',
    artifactMode: mode === 'sealed' ? 'sealed' : 'cli_workdir',
    sourceRevision: revision,
    baselineFiles: policy.baseline.length,
    addedFiles: policy.additions.length,
    totalFiles: snapshots.length,
    totalBytes: policy.bundleByteCount,
    lastVersion: policy.bundleLastVersion,
    baselineLedgerSha256: policy.baselineLedgerSha256,
    bundleLedgerSha256: policy.bundleLedgerSha256,
    manifestSha256: sha256(observedManifestBytes),
  };
}

export async function buildWithPolicy(options: EngineBuildOptions): Promise<BundleEvidence> {
  validatePolicy(options.policy);
  const repoRoot = await validateRepository(options.repoWorkdir, options.sourceRevision);
  const paths = await validatePaths(repoRoot, options.historyWorkdir, options.outputWorkdir);
  const baseline = await readBaseline(paths.historyRoot, options.policy);
  await options.testHooks?.afterBaselineSnapshot?.();
  const additions = await readGitAdditionsForPolicy(repoRoot, options.sourceRevision, options.policy);
  const snapshots = [...baseline, ...additions];
  assertSnapshotPolicy(snapshots, options.policy.bundleByteCount, options.policy.bundleLedgerSha256, options.policy.bundleLastVersion, 'SOURCE_POLICY');

  const parentCustody = await openDirectoryCustody(
    paths.outputParent,
    paths.outputParentIdentity,
    'PATH_POLICY',
  );
  let outputCustody: DirectoryCustody | undefined;
  try {
    await options.testHooks?.beforeOutputClaim?.(paths.output);
    await assertDirectoryCustody(paths.outputParent, parentCustody, 'PATH_POLICY');
    await options.testHooks?.afterParentCustodyCheckBeforeOutputClaim?.(paths.output);
    outputCustody = await claimDirectoryUnderCustody(
      parentCustody,
      basename(paths.output),
      'PUBLISH_FAILED',
    );
    const heldOutput = heldDirectoryPath(outputCustody);
    await assertDirectoryCustody(paths.outputParent, parentCustody, 'PATH_POLICY');
    await assertDirectoryCustody(paths.output, outputCustody, 'PUBLISH_FAILED');
    await parentCustody.handle.sync();

    await writeSynced(join(heldOutput, MARKER), Buffer.alloc(0));
    const supabasePath = join(heldOutput, 'supabase');
    const migrationsPath = join(supabasePath, 'migrations');
    await mkdir(supabasePath, { mode: 0o700 });
    await mkdir(migrationsPath, { mode: 0o700 });
    for (const snapshot of snapshots) {
      await writeSynced(join(migrationsPath, snapshot.filename), snapshot.bytes);
    }
    await options.testHooks?.beforeManifestWrite?.(paths.output);
    await writeSynced(
      join(heldOutput, MANIFEST),
      manifestBytes(manifestFor(options.sourceRevision, snapshots, options.policy)),
    );
    await syncDirectory(migrationsPath);
    await syncDirectory(supabasePath);
    await outputCustody.handle.sync();
    await assertDirectoryCustody(paths.output, outputCustody, 'PUBLISH_FAILED');
    await options.testHooks?.beforeMarkedVerification?.(paths.output);
    await assertDirectoryCustody(paths.output, outputCustody, 'PUBLISH_FAILED');
    await verifyTree(heldOutput, options.sourceRevision, 'sealed', options.policy, 'require');

    await options.testHooks?.afterOutputReadyBeforeCommit?.(paths.output);
    await assertDirectoryCustody(paths.output, outputCustody, 'PUBLISH_FAILED');
    await unlink(join(heldOutput, MARKER));
    await outputCustody.handle.sync();
    await options.testHooks?.afterCommit?.(paths.output);
    await assertDirectoryCustody(paths.output, outputCustody, 'PUBLISH_FAILED');
    const evidence = await verifyTree(
      heldOutput,
      options.sourceRevision,
      'sealed',
      options.policy,
      'reject',
    );
    await assertDirectoryCustody(paths.outputParent, parentCustody, 'PUBLISH_FAILED');
    await assertDirectoryCustody(paths.output, outputCustody, 'PUBLISH_FAILED');
    return evidence;
  } catch (error: unknown) {
    if (error instanceof BundleFailure) throw error;
    throw new BundleFailure('PUBLISH_FAILED');
  } finally {
    await outputCustody?.handle.close().catch(() => undefined);
    await parentCustody.handle.close().catch(() => undefined);
  }
}

export async function verifyWithPolicy(options: EngineVerifyOptions): Promise<BundleEvidence> {
  validatePolicy(options.policy);
  const repoRoot = await validateRepository(options.repoWorkdir, options.sourceRevision);
  await readGitAdditionsForPolicy(repoRoot, options.sourceRevision, options.policy);
  let root: string;
  try {
    const requestedRoot = resolve(options.bundleWorkdir);
    const rootStat = lstatSync(requestedRoot, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) refuse('PATH_POLICY');
    root = await realpath(requestedRoot);
  } catch {
    refuse('PATH_POLICY');
  }
  if (isWithin(repoRoot, root)) refuse('PATH_POLICY');
  const rootCustody = await openDirectoryCustody(root, undefined, 'PATH_POLICY');
  try {
    const evidence = await verifyTree(
      root,
      options.sourceRevision,
      options.mode,
      options.policy,
      'reject',
    );
    await assertDirectoryCustody(root, rootCustody, 'ARTIFACT_POLICY');
    return evidence;
  } finally {
    await rootCustody.handle.close().catch(() => undefined);
  }
}
