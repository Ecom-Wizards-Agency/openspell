import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseCommand, run } from './cli.js';
import {
  buildWithPolicy,
  BundleFailure,
  canonicalLedger,
  readGitAdditionsForPolicy,
  verifyWithPolicy,
} from './engine.js';
import {
  HOSTED_MIGRATION_BUNDLE_POLICY,
  type HostedMigrationBundlePolicy,
  type MigrationPolicyEntry,
} from './policy.js';

const roots: string[] = [];
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SQL_EVIDENCE_FILES = [
  'wp-197-hosted-migration-probe.sql',
  'wp-197-hosted-migration-prefix-41.sql',
  'wp-197-hosted-migration-prefix-42.sql',
  'wp-197-hosted-migration-prefix-43.sql',
  'wp-197-hosted-migration-prefix-44.sql',
  'wp-197-hosted-migration-prefix-45.sql',
  'wp-197-hosted-migration-prefix-46.sql',
] as const;

function hash(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function entry(filename: string, bytes: Buffer): MigrationPolicyEntry {
  return { filename, byteCount: bytes.byteLength, sha256: hash(bytes) };
}

async function createFixture(): Promise<{
  root: string;
  repo: string;
  history: string;
  revision: string;
  policy: HostedMigrationBundlePolicy;
  baseline: readonly { filename: string; bytes: Buffer }[];
}> {
  const root = await mkdtemp(join(tmpdir(), 'openspell-bundle-test-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const history = join(root, 'history');
  const repoMigrations = join(repo, 'supabase', 'migrations');
  const historyMigrations = join(history, 'supabase', 'migrations');
  await mkdir(repoMigrations, { recursive: true });
  await mkdir(historyMigrations, { recursive: true });

  const baseline = [
    { filename: '20260101000000_alpha.sql', bytes: Buffer.from('select 1;\n') },
    { filename: '20260101010000_beta.sql', bytes: Buffer.from('select 2;\n') },
    { filename: '20260101020000_gamma.sql', bytes: Buffer.from('select 3;\n') },
  ] as const;
  const additions = [
    {
      workPackage: 'WP-1',
      repositoryPath: 'supabase/migrations/20260101030000_delta.sql',
      filename: '20260101030000_delta.sql',
      bytes: Buffer.from('select 4;\n'),
    },
    {
      workPackage: 'WP-2',
      repositoryPath: 'supabase/migrations/20260101040000_epsilon.sql',
      filename: '20260101040000_epsilon.sql',
      bytes: Buffer.from('select 5;\n'),
    },
  ] as const;
  for (const item of baseline) await writeFile(join(historyMigrations, item.filename), item.bytes);
  for (const item of additions) await writeFile(join(repo, item.repositoryPath), item.bytes);

  execFileSync('git', ['init', '--quiet'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync(
    'git',
    ['-c', 'user.name=Bundle Test', '-c', 'user.email=bundle-test@example.invalid', 'commit', '--quiet', '-m', 'fixture'],
    { cwd: repo },
  );
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', revision], { cwd: repo });

  const baselinePolicy = baseline.map((item) => entry(item.filename, item.bytes));
  const additionPolicy = additions.map((item) => ({
    ...entry(item.filename, item.bytes),
    workPackage: item.workPackage,
    repositoryPath: item.repositoryPath,
  }));
  const allPolicy = [...baselinePolicy, ...additionPolicy];
  const policy: HostedMigrationBundlePolicy = {
    baseline: baselinePolicy,
    additions: additionPolicy,
    baselineByteCount: baselinePolicy.reduce((total, item) => total + item.byteCount, 0),
    baselineLastVersion: '20260101020000',
    baselineLedgerSha256: hash(canonicalLedger(baselinePolicy)),
    bundleByteCount: allPolicy.reduce((total, item) => total + item.byteCount, 0),
    bundleLastVersion: '20260101040000',
    bundleLedgerSha256: hash(canonicalLedger(allPolicy)),
  };
  return { root, repo, history, revision, policy, baseline };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('fixed production policy', () => {
  it('closes exact counts, sizes, ordering and ledger digests', () => {
    const policy = HOSTED_MIGRATION_BUNDLE_POLICY;
    const all = [...policy.baseline, ...policy.additions];
    expect(policy.baseline).toHaveLength(41);
    expect(policy.additions).toHaveLength(5);
    expect(policy.baseline.reduce((sum, item) => sum + item.byteCount, 0)).toBe(279_677);
    expect(all.reduce((sum, item) => sum + item.byteCount, 0)).toBe(646_628);
    expect(hash(canonicalLedger(policy.baseline))).toBe(policy.baselineLedgerSha256);
    expect(hash(canonicalLedger(all))).toBe(policy.bundleLedgerSha256);
    expect(policy.baseline.at(-1)?.filename.startsWith(policy.baselineLastVersion)).toBe(true);
    expect(policy.additions.at(-1)?.filename.startsWith(policy.bundleLastVersion)).toBe(true);
  });
});

describe('bundle construction and verification', () => {
  it('publishes a deterministic exact tree and independently verifies it', async () => {
    const fixture = await createFixture();
    const first = join(fixture.root, 'bundle-one');
    const second = join(fixture.root, 'bundle-two');
    const options = {
      historyWorkdir: fixture.history,
      sourceRevision: fixture.revision,
      repoWorkdir: fixture.repo,
      policy: fixture.policy,
    };
    const firstEvidence = await buildWithPolicy({ ...options, outputWorkdir: first });
    const secondEvidence = await buildWithPolicy({ ...options, outputWorkdir: second });

    expect(firstEvidence).toEqual(secondEvidence);
    expect(firstEvidence.totalFiles).toBe(5);
    const firstManifestBytes = await readFile(join(first, 'BUNDLE_MANIFEST.json'));
    expect(firstManifestBytes).toEqual(await readFile(join(second, 'BUNDLE_MANIFEST.json')));
    expect(firstManifestBytes.at(-1)).toBe(0x0a);
    const manifest = JSON.parse(firstManifestBytes.toString('utf8')) as Record<string, unknown>;
    expect(Object.keys(manifest)).toEqual([
      'schemaVersion',
      'purpose',
      'sourceRevision',
      'baseline',
      'additions',
      'bundle',
      'migrations',
    ]);
    expect(Object.keys((manifest.additions as Record<string, unknown>[])[0]!)).toEqual([
      'workPackage',
      'repositoryPath',
      'version',
      'byteCount',
      'sha256',
    ]);
    expect(Object.keys((manifest.migrations as Record<string, unknown>[])[0]!)).toEqual([
      'ordinal',
      'version',
      'filename',
      'byteCount',
      'sha256',
      'provenance',
    ]);
    expect((await readdir(first)).sort()).toEqual(['BUNDLE_MANIFEST.json', 'supabase']);
    await expectCode(
      buildWithPolicy({ ...options, outputWorkdir: first }),
      'PATH_POLICY',
    );
    await expect(
      verifyWithPolicy({
        bundleWorkdir: first,
        sourceRevision: fixture.revision,
        mode: 'sealed',
        repoWorkdir: fixture.repo,
        policy: fixture.policy,
      }),
    ).resolves.toEqual(firstEvidence);
  });

  it('reads additions from the reviewed Git object, not working-tree bytes', async () => {
    const fixture = await createFixture();
    const addition = fixture.policy.additions[0];
    expect(addition).toBeDefined();
    await writeFile(join(fixture.repo, addition!.repositoryPath), 'changed working tree\n');
    const snapshots = await readGitAdditionsForPolicy(
      fixture.repo,
      fixture.revision,
      fixture.policy,
    );
    expect(snapshots[0]?.sha256).toBe(addition!.sha256);
  });

  it('rejects changed and absent reviewed Git blobs', async () => {
    for (const mutation of ['changed', 'absent'] as const) {
      const fixture = await createFixture();
      const addition = fixture.policy.additions[0]!;
      if (mutation === 'changed') await writeFile(join(fixture.repo, addition.repositoryPath), 'changed\n');
      if (mutation === 'absent') await rm(join(fixture.repo, addition.repositoryPath));
      execFileSync('git', ['add', '-A'], { cwd: fixture.repo });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Bundle Test',
          '-c',
          'user.email=bundle-test@example.invalid',
          'commit',
          '--quiet',
          '-m',
          'mutated fixture',
        ],
        { cwd: fixture.repo },
      );
      const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: fixture.repo,
        encoding: 'utf8',
      }).trim();
      execFileSync('git', ['update-ref', 'refs/remotes/origin/main', revision], {
        cwd: fixture.repo,
      });
      await expectCode(
        readGitAdditionsForPolicy(fixture.repo, revision, fixture.policy),
        mutation === 'changed' ? 'SOURCE_POLICY' : 'REPOSITORY_STATE',
      );
    }
  });

  it('rejects revision, repository-ref and dirty-checkout drift', async () => {
    const fixture = await createFixture();
    const base = {
      historyWorkdir: fixture.history,
      outputWorkdir: join(fixture.root, 'output'),
      repoWorkdir: fixture.repo,
      policy: fixture.policy,
    };
    await expectCode(buildWithPolicy({ ...base, sourceRevision: 'abc' }), 'INVALID_ARGUMENT');
    await expectCode(
      buildWithPolicy({ ...base, sourceRevision: '0'.repeat(40) }),
      'REPOSITORY_STATE',
    );
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', '0'.repeat(40)], { cwd: fixture.repo });
    await expectCode(
      buildWithPolicy({ ...base, sourceRevision: fixture.revision }),
      'REPOSITORY_STATE',
    );
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', fixture.revision], { cwd: fixture.repo });
    await writeFile(join(fixture.repo, 'untracked'), 'dirty');
    await expectCode(
      buildWithPolicy({ ...base, sourceRevision: fixture.revision }),
      'REPOSITORY_STATE',
    );
  });

  it('rejects missing, changed, renamed and extra baseline entries', async () => {
    for (const mutation of ['missing', 'changed', 'renamed', 'extra'] as const) {
      const fixture = await createFixture();
      const migrations = join(fixture.history, 'supabase', 'migrations');
      const first = fixture.baseline[0]!;
      if (mutation === 'missing') await rm(join(migrations, first.filename));
      if (mutation === 'changed') await writeFile(join(migrations, first.filename), 'changed\n');
      if (mutation === 'renamed') await rename(join(migrations, first.filename), join(migrations, '20260101000000_renamed.sql'));
      if (mutation === 'extra') await writeFile(join(migrations, '20260101025000_extra.sql'), 'select 0;\n');
      await expectCode(
        buildWithPolicy({
          historyWorkdir: fixture.history,
          outputWorkdir: join(fixture.root, 'output'),
          sourceRevision: fixture.revision,
          repoWorkdir: fixture.repo,
          policy: fixture.policy,
        }),
        'BASELINE_POLICY',
      );
    }
  });

  it('rejects symlinked, hard-linked and non-file baseline entries', async () => {
    for (const mutation of ['symlink', 'hardlink', 'directory'] as const) {
      const fixture = await createFixture();
      const migrations = join(fixture.history, 'supabase', 'migrations');
      const first = fixture.baseline[0]!;
      const path = join(migrations, first.filename);
      await rm(path);
      if (mutation === 'symlink') await symlink(join(fixture.root, 'missing'), path);
      if (mutation === 'hardlink') {
        const source = join(fixture.root, 'linked-source');
        await writeFile(source, first.bytes);
        await link(source, path);
      }
      if (mutation === 'directory') await mkdir(path);
      await expectCode(
        buildWithPolicy({
          historyWorkdir: fixture.history,
          outputWorkdir: join(fixture.root, 'output'),
          sourceRevision: fixture.revision,
          repoWorkdir: fixture.repo,
          policy: fixture.policy,
        }),
        'BASELINE_POLICY',
      );
    }
  });

  it('rejects output overlap and repository-contained output', async () => {
    const fixture = await createFixture();
    const common = {
      historyWorkdir: fixture.history,
      sourceRevision: fixture.revision,
      repoWorkdir: fixture.repo,
      policy: fixture.policy,
    };
    await expectCode(
      buildWithPolicy({ ...common, outputWorkdir: join(fixture.history, 'output') }),
      'PATH_POLICY',
    );
    await expectCode(
      buildWithPolicy({ ...common, outputWorkdir: join(fixture.repo, 'output') }),
      'PATH_POLICY',
    );
  });

  it('rejects symlinked history and verification roots', async () => {
    const fixture = await createFixture();
    const historyLink = join(fixture.root, 'history-link');
    await symlink(fixture.history, historyLink);
    await expectCode(
      buildWithPolicy({
        historyWorkdir: historyLink,
        outputWorkdir: join(fixture.root, 'refused-output'),
        sourceRevision: fixture.revision,
        repoWorkdir: fixture.repo,
        policy: fixture.policy,
      }),
      'PATH_POLICY',
    );

    const output = join(fixture.root, 'bundle');
    await buildWithPolicy({
      historyWorkdir: fixture.history,
      outputWorkdir: output,
      sourceRevision: fixture.revision,
      repoWorkdir: fixture.repo,
      policy: fixture.policy,
    });
    const outputLink = join(fixture.root, 'bundle-link');
    await symlink(output, outputLink);
    await expectCode(
      verifyWithPolicy({
        bundleWorkdir: outputLink,
        sourceRevision: fixture.revision,
        mode: 'sealed',
        repoWorkdir: fixture.repo,
        policy: fixture.policy,
      }),
      'PATH_POLICY',
    );
  });

  it('refuses destination-creation and parent-swap publication races', async () => {
    const destinationFixture = await createFixture();
    const destination = join(destinationFixture.root, 'raced-output');
    await expectCode(
      buildWithPolicy({
        historyWorkdir: destinationFixture.history,
        outputWorkdir: destination,
        sourceRevision: destinationFixture.revision,
        repoWorkdir: destinationFixture.repo,
        policy: destinationFixture.policy,
        testHooks: {
          beforeOutputClaim: async (output) => mkdir(output),
        },
      }),
      'PATH_POLICY',
    );
    expect(await readdir(destination)).toEqual([]);

    const parentFixture = await createFixture();
    const publishParent = join(parentFixture.root, 'publish');
    const displacedParent = join(parentFixture.root, 'publish-displaced');
    const redirectParent = join(parentFixture.root, 'publish-redirect');
    await mkdir(publishParent);
    await mkdir(redirectParent);
    await expectCode(
      buildWithPolicy({
        historyWorkdir: parentFixture.history,
        outputWorkdir: join(publishParent, 'bundle'),
        sourceRevision: parentFixture.revision,
        repoWorkdir: parentFixture.repo,
        policy: parentFixture.policy,
        testHooks: {
          beforeOutputClaim: async () => {
            await rename(publishParent, displacedParent);
            await symlink(redirectParent, publishParent);
          },
        },
      }),
      'PATH_POLICY',
    );
    expect(await readdir(redirectParent)).toEqual([]);
  });

  it('anchors the output claim to the held parent across the final claim window', async () => {
    const fixture = await createFixture();
    const publishParent = join(fixture.root, 'publish-window');
    const displacedParent = join(fixture.root, 'publish-window-displaced');
    await mkdir(publishParent);

    await expectCode(
      buildWithPolicy({
        historyWorkdir: fixture.history,
        outputWorkdir: join(publishParent, 'bundle'),
        sourceRevision: fixture.revision,
        repoWorkdir: fixture.repo,
        policy: fixture.policy,
        testHooks: {
          afterParentCustodyCheckBeforeOutputClaim: async () => {
            await rename(publishParent, displacedParent);
            await mkdir(publishParent);
          },
        },
      }),
      'PATH_POLICY',
    );

    expect(await readdir(publishParent)).toEqual([]);
    expect(await readdir(join(displacedParent, 'bundle'))).toEqual([]);
  });

  it('detects output-directory substitution and never deletes the replacement', async () => {
    const fixture = await createFixture();
    const output = join(fixture.root, 'bundle');
    const displaced = join(fixture.root, 'bundle-displaced');
    await expectCode(
      buildWithPolicy({
        historyWorkdir: fixture.history,
        outputWorkdir: output,
        sourceRevision: fixture.revision,
        repoWorkdir: fixture.repo,
        policy: fixture.policy,
        testHooks: {
          beforeMarkedVerification: async () => {
            await rename(output, displaced);
            await mkdir(output);
            await writeFile(join(output, 'replacement-sentinel'), 'do not delete');
          },
        },
      }),
      'PUBLISH_FAILED',
    );
    expect(await readFile(join(output, 'replacement-sentinel'), 'utf8')).toBe('do not delete');
  });

  it('never writes the manifest through a substituted output pathname', async () => {
    const fixture = await createFixture();
    const output = join(fixture.root, 'bundle');
    const displaced = join(fixture.root, 'bundle-before-manifest');
    await expectCode(
      buildWithPolicy({
        historyWorkdir: fixture.history,
        outputWorkdir: output,
        sourceRevision: fixture.revision,
        repoWorkdir: fixture.repo,
        policy: fixture.policy,
        testHooks: {
          beforeManifestWrite: async () => {
            await rename(output, displaced);
            await mkdir(output);
            await writeFile(join(output, 'replacement-sentinel'), 'do not write here');
          },
        },
      }),
      'PUBLISH_FAILED',
    );
    expect(await readdir(output)).toEqual(['replacement-sentinel']);
    expect(await readFile(join(displaced, '.BUNDLE_UNPUBLISHED'))).toEqual(Buffer.alloc(0));
    expect(await readFile(join(displaced, 'BUNDLE_MANIFEST.json'), 'utf8')).toContain(
      'openspell.hosted-migration-bundle.v1',
    );
  });

  it('rejects out-of-order and colliding policy entries', async () => {
    const fixture = await createFixture();
    const common = {
      historyWorkdir: fixture.history,
      outputWorkdir: join(fixture.root, 'output'),
      sourceRevision: fixture.revision,
      repoWorkdir: fixture.repo,
    };
    const reorderedBaseline = [
      fixture.policy.baseline[1]!,
      fixture.policy.baseline[0]!,
      fixture.policy.baseline[2]!,
    ];
    await expectCode(
      buildWithPolicy({
        ...common,
        policy: { ...fixture.policy, baseline: reorderedBaseline },
      }),
      'SOURCE_POLICY',
    );

    const collision = {
      ...fixture.policy.additions[0]!,
      filename: fixture.policy.baseline[2]!.filename,
      repositoryPath: `supabase/migrations/${fixture.policy.baseline[2]!.filename}`,
    };
    const additions = [collision, fixture.policy.additions[1]!];
    const all = [...fixture.policy.baseline, ...additions];
    await expectCode(
      buildWithPolicy({
        ...common,
        policy: {
          ...fixture.policy,
          additions,
          bundleByteCount: all.reduce((total, item) => total + item.byteCount, 0),
          bundleLedgerSha256: hash(canonicalLedger(all)),
        },
      }),
      'SOURCE_POLICY',
    );
  });

  it('rejects unpublished, tampered and structurally widened artifacts', async () => {
    const fixture = await createFixture();
    const output = join(fixture.root, 'bundle');
    const verify = (mode: 'sealed' | 'cli-workdir' = 'sealed') =>
      verifyWithPolicy({
        bundleWorkdir: output,
        sourceRevision: fixture.revision,
        mode,
        repoWorkdir: fixture.repo,
        policy: fixture.policy,
      });
    await buildWithPolicy({
      historyWorkdir: fixture.history,
      outputWorkdir: output,
      sourceRevision: fixture.revision,
      repoWorkdir: fixture.repo,
      policy: fixture.policy,
    });

    await writeFile(join(output, '.BUNDLE_UNPUBLISHED'), '');
    await expectCode(verify(), 'ARTIFACT_POLICY');
    await rm(join(output, '.BUNDLE_UNPUBLISHED'));
    await writeFile(join(output, 'BUNDLE_MANIFEST.json'), '{}\n');
    await expectCode(verify(), 'ARTIFACT_POLICY');
  });

  it('copies the verified snapshot even if the input changes afterward', async () => {
    const fixture = await createFixture();
    const output = join(fixture.root, 'bundle');
    const first = fixture.baseline[0]!;
    await buildWithPolicy({
      historyWorkdir: fixture.history,
      outputWorkdir: output,
      sourceRevision: fixture.revision,
      repoWorkdir: fixture.repo,
      policy: fixture.policy,
      testHooks: {
        afterBaselineSnapshot: async () => {
          await writeFile(
            join(fixture.history, 'supabase', 'migrations', first.filename),
            'changed after snapshot\n',
          );
        },
      },
    });
    expect(await readFile(join(output, 'supabase', 'migrations', first.filename))).toEqual(
      first.bytes,
    );
  });

  it('refuses staged tampering before publication', async () => {
    const fixture = await createFixture();
    const output = join(fixture.root, 'bundle');
    const first = fixture.baseline[0]!;
    await expectCode(
      buildWithPolicy({
        historyWorkdir: fixture.history,
        outputWorkdir: output,
        sourceRevision: fixture.revision,
        repoWorkdir: fixture.repo,
        policy: fixture.policy,
        testHooks: {
          beforeMarkedVerification: async (staging) => {
            await writeFile(
              join(staging, 'supabase', 'migrations', first.filename),
              'tampered staging\n',
            );
          },
        },
      }),
      'ARTIFACT_POLICY',
    );
    expect(await readFile(join(output, '.BUNDLE_UNPUBLISHED'))).toEqual(Buffer.alloc(0));
    await expectCode(
      verifyWithPolicy({
        bundleWorkdir: output,
        sourceRevision: fixture.revision,
        mode: 'sealed',
        repoWorkdir: fixture.repo,
        policy: fixture.policy,
      }),
      'ARTIFACT_POLICY',
    );
  });

  it('leaves pre-commit response loss unpublished', async () => {
    const fixture = await createFixture();
    const output = join(fixture.root, 'bundle');
    await expectCode(
      buildWithPolicy({
        historyWorkdir: fixture.history,
        outputWorkdir: output,
        sourceRevision: fixture.revision,
        repoWorkdir: fixture.repo,
        policy: fixture.policy,
        testHooks: {
          afterOutputReadyBeforeCommit: async () => {
            throw new Error('injected pre-commit stop');
          },
        },
      }),
      'PUBLISH_FAILED',
    );
    expect(await readFile(join(output, '.BUNDLE_UNPUBLISHED'))).toEqual(Buffer.alloc(0));
    await expectCode(
      verifyWithPolicy({
        bundleWorkdir: output,
        sourceRevision: fixture.revision,
        mode: 'sealed',
        repoWorkdir: fixture.repo,
        policy: fixture.policy,
      }),
      'ARTIFACT_POLICY',
    );
  });

  it('reconciles post-commit response loss to the exact artifact', async () => {
    const fixture = await createFixture();
    const output = join(fixture.root, 'bundle');
    await expectCode(
      buildWithPolicy({
        historyWorkdir: fixture.history,
        outputWorkdir: output,
        sourceRevision: fixture.revision,
        repoWorkdir: fixture.repo,
        policy: fixture.policy,
        testHooks: {
          afterCommit: async () => {
            throw new Error('injected lost response');
          },
        },
      }),
      'PUBLISH_FAILED',
    );
    await expect(
      verifyWithPolicy({
        bundleWorkdir: output,
        sourceRevision: fixture.revision,
        mode: 'sealed',
        repoWorkdir: fixture.repo,
        policy: fixture.policy,
      }),
    ).resolves.toMatchObject({ status: 'verified', totalFiles: 5 });
  });

  it('permits but never traverses exactly supabase/.temp in CLI-workdir mode', async () => {
    const fixture = await createFixture();
    const output = join(fixture.root, 'bundle');
    const options = {
      bundleWorkdir: output,
      sourceRevision: fixture.revision,
      repoWorkdir: fixture.repo,
      policy: fixture.policy,
    };
    await buildWithPolicy({
      historyWorkdir: fixture.history,
      outputWorkdir: output,
      sourceRevision: fixture.revision,
      repoWorkdir: fixture.repo,
      policy: fixture.policy,
    });
    const temp = join(output, 'supabase', '.temp');
    await mkdir(temp);
    await writeFile(join(temp, 'unreadable'), 'ignored');
    await chmod(temp, 0o000);
    await expect(verifyWithPolicy({ ...options, mode: 'cli-workdir' })).resolves.toMatchObject({
      artifactMode: 'cli_workdir',
    });
    await expectCode(verifyWithPolicy({ ...options, mode: 'sealed' }), 'ARTIFACT_POLICY');
    await chmod(temp, 0o700);
    await writeFile(join(output, 'supabase', 'config.toml'), 'forbidden');
    await expectCode(verifyWithPolicy({ ...options, mode: 'cli-workdir' }), 'ARTIFACT_POLICY');
  });

  it('rejects migration and manifest byte mutation', async () => {
    for (const target of ['migration', 'manifest'] as const) {
      const fixture = await createFixture();
      const output = join(fixture.root, 'bundle');
      const options = {
        bundleWorkdir: output,
        sourceRevision: fixture.revision,
        mode: 'sealed' as const,
        repoWorkdir: fixture.repo,
        policy: fixture.policy,
      };
      await buildWithPolicy({
        historyWorkdir: fixture.history,
        outputWorkdir: output,
        sourceRevision: fixture.revision,
        repoWorkdir: fixture.repo,
        policy: fixture.policy,
      });
      const path =
        target === 'manifest'
          ? join(output, 'BUNDLE_MANIFEST.json')
          : join(output, 'supabase', 'migrations', fixture.baseline[0]!.filename);
      const bytes = await readFile(path);
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      await writeFile(path, bytes);
      await expectCode(verifyWithPolicy(options), 'ARTIFACT_POLICY');
    }
  });

  it('rejects a hard-linked artifact file even when its bytes are exact', async () => {
    const fixture = await createFixture();
    const output = join(fixture.root, 'bundle');
    await buildWithPolicy({
      historyWorkdir: fixture.history,
      outputWorkdir: output,
      sourceRevision: fixture.revision,
      repoWorkdir: fixture.repo,
      policy: fixture.policy,
    });
    const migration = join(
      output,
      'supabase',
      'migrations',
      fixture.policy.baseline[0]!.filename,
    );
    const linkedSource = join(fixture.root, 'linked-artifact-source');
    await writeFile(linkedSource, await readFile(migration));
    await rm(migration);
    await link(linkedSource, migration);
    await expectCode(
      verifyWithPolicy({
        bundleWorkdir: output,
        sourceRevision: fixture.revision,
        mode: 'sealed',
        repoWorkdir: fixture.repo,
        policy: fixture.policy,
      }),
      'ARTIFACT_POLICY',
    );
  });

  it('revalidates reviewed Git blobs instead of trusting a relabeled manifest', async () => {
    const fixture = await createFixture();
    const output = join(fixture.root, 'bundle');
    await buildWithPolicy({
      historyWorkdir: fixture.history,
      outputWorkdir: output,
      sourceRevision: fixture.revision,
      repoWorkdir: fixture.repo,
      policy: fixture.policy,
    });

    const addition = fixture.policy.additions[0]!;
    await writeFile(join(fixture.repo, addition.repositoryPath), 'changed reviewed blob\n');
    execFileSync('git', ['add', '.'], { cwd: fixture.repo });
    execFileSync(
      'git',
      ['-c', 'user.name=Bundle Test', '-c', 'user.email=bundle-test@example.invalid', 'commit', '--quiet', '-m', 'change source blob'],
      { cwd: fixture.repo },
    );
    const laterRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: fixture.repo,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', laterRevision], {
      cwd: fixture.repo,
    });
    const manifestPath = join(output, 'BUNDLE_MANIFEST.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest['sourceRevision'] = laterRevision;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expectCode(
      verifyWithPolicy({
        bundleWorkdir: output,
        sourceRevision: laterRevision,
        mode: 'sealed',
        repoWorkdir: fixture.repo,
        policy: fixture.policy,
      }),
      'SOURCE_POLICY',
    );
  });

  it('refuses verification of an ignored repository-contained bundle', async () => {
    const fixture = await createFixture();
    const output = join(fixture.root, 'bundle');
    await buildWithPolicy({
      historyWorkdir: fixture.history,
      outputWorkdir: output,
      sourceRevision: fixture.revision,
      repoWorkdir: fixture.repo,
      policy: fixture.policy,
    });
    await writeFile(join(fixture.repo, '.git', 'info', 'exclude'), 'ignored-bundle/\n');
    const ignoredBundle = join(fixture.repo, 'ignored-bundle');
    await rename(output, ignoredBundle);
    await expectCode(
      verifyWithPolicy({
        bundleWorkdir: ignoredBundle,
        sourceRevision: fixture.revision,
        mode: 'sealed',
        repoWorkdir: fixture.repo,
        policy: fixture.policy,
      }),
      'PATH_POLICY',
    );
  });
});

describe('read-only database evidence sources', () => {
  it('keeps exactly one bounded rollback-only transaction in every SQL file', async () => {
    const evidenceDirectory = join(REPO_ROOT, 'tools', 'hosted-migration-bundle', 'sql');
    const observed = (await readdir(evidenceDirectory))
      .filter((name) => name.startsWith('wp-197-hosted-migration-') && name.endsWith('.sql'))
      .sort();
    expect(observed).toEqual([...SQL_EVIDENCE_FILES].sort());

    for (const filename of SQL_EVIDENCE_FILES) {
      const source = await readFile(join(evidenceDirectory, filename), 'utf8');
      expect(source.match(/^begin transaction isolation level repeatable read read only;$/gimu)).toHaveLength(1);
      expect(source.match(/^rollback;$/gimu)).toHaveLength(1);
      expect(source.match(/^set local statement_timeout = '30s';$/gimu)).toHaveLength(1);
      expect(source.match(/^set local lock_timeout = '2s';$/gimu)).toHaveLength(1);
      expect(source.match(/^set local search_path = pg_catalog, public, app;$/gimu)).toHaveLength(1);
      expect(source).not.toMatch(
        /^\s*(?:alter|analyze|call|cluster|comment|copy|create|delete|do|drop|grant|insert|listen|merge|notify|refresh|reindex|revoke|security\s+label|truncate|update|vacuum)\b/gimu,
      );
      expect(source).not.toMatch(/^\s*(?:execute|prepare)\b/gimu);
      expect(source).not.toMatch(
        /\b(?:dblink|lo_export|lo_import|pg_ls_dir|pg_read_binary_file|pg_read_file|pg_stat_file|pg_write_binary_file|pg_write_file)\b/giu,
      );
      expect(source).not.toMatch(/\bpg_authid\b/giu);
      expect(source).not.toMatch(/^\s*\\/gmu);
      expect(
        Buffer.from(source, 'utf8').every(
          (byte) => byte === 0x09 || byte === 0x0a || (byte >= 0x20 && byte <= 0x7e),
        ),
      ).toBe(true);
    }
  });

  it('keeps prefix check keys unique and emits the five fixed evidence fields', async () => {
    const evidenceDirectory = join(REPO_ROOT, 'tools', 'hosted-migration-bundle', 'sql');
    for (const filename of SQL_EVIDENCE_FILES.slice(1)) {
      const source = await readFile(join(evidenceDirectory, filename), 'utf8');
      const checkKeys = [...source.matchAll(/^\s*select '([a-z0-9_.]+)'(?:,|\s+as)/gmu)]
        .map((match) => match[1]!);
      expect(checkKeys.length).toBeGreaterThan(0);
      expect(new Set(checkKeys).size).toBe(checkKeys.length);
      for (const field of [
        'queueFingerprint',
        'recommendationFingerprint',
        'scheduleFingerprint',
        'outOfScopePrivilegeFingerprint',
        'prefixEvidenceSha256',
      ]) {
        expect(source.match(new RegExp(`"${field}"`, 'gu'))).toHaveLength(1);
      }
    }
  });
});

describe('strict CLI', () => {
  it('accepts only the two exact command shapes', () => {
    expect(
      parseCommand(['build', '--history-workdir', 'a', '--output-workdir', 'b', '--revision', 'c']),
    ).toMatchObject({ operation: 'build' });
    expect(
      parseCommand(['verify', '--bundle-workdir', 'a', '--revision', 'b', '--mode', 'sealed']),
    ).toMatchObject({ operation: 'verify', mode: 'sealed' });
    expect(
      parseCommand(['--', 'verify', '--bundle-workdir', 'a', '--revision', 'b', '--mode', 'cli-workdir']),
    ).toMatchObject({ operation: 'verify', mode: 'cli-workdir' });
    for (const argv of [
      [],
      ['apply'],
      ['build', '--history-workdir', 'a'],
      ['build', '--history-workdir', 'a', '--history-workdir', 'b', '--revision', 'c'],
      ['verify', '--bundle-workdir', 'a', '--revision', 'b', '--mode', 'unsafe'],
      ['verify', '--bundle-workdir', 'a', '--revision', 'b', '--target', 'c'],
    ]) {
      expect(() => parseCommand(argv)).toThrow(BundleFailure);
    }
  });

  it('keeps the production module free of hosted and mutating subprocess clients', async () => {
    const directory = fileURLToPath(new URL('.', import.meta.url));
    const names = ['bundle.ts', 'cli.ts', 'engine.ts', 'policy.ts'] as const;
    const sources = await Promise.all(names.map((name) => readFile(join(directory, name), 'utf8')));
    const source = sources.join('\n');
    const permittedImports = new Set([
      './bundle.js', './engine.js', './policy.js',
      'node:child_process', 'node:crypto', 'node:fs', 'node:fs/promises',
      'node:path', 'node:util',
    ]);
    const imports = sources.flatMap((text) =>
      [...text.matchAll(/from ['"]([^'"]+)['"]/gu)].map((match) => match[1]!),
    );
    expect(imports.every((specifier) => permittedImports.has(specifier))).toBe(true);
    expect(source).not.toMatch(/execFileAsync\(['"](?:supabase|psql)|from ['"]pg['"]|https?:|fetch\(/u);
    expect(source).not.toMatch(/(?<![.\w])(?:exec|execFileSync|execSync|fork|spawn|spawnSync)\s*\(/u);
    expect(source.match(/execFileAsync\(/gu)).toHaveLength(1);
    expect(source).toContain("execFileAsync('git'");

    const manifest = JSON.parse(
      await readFile(join(REPO_ROOT, 'tools', 'hosted-migration-bundle', 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest['dependencies']).toBeUndefined();
    expect(manifest['devDependencies']).toEqual({
      '@types/node': '^22.20.1',
      postgres: '^3.4.9',
    });
  });

  it('emits only a bounded error code when an argument contains private text', async () => {
    const privateText = '/private/operator/path/that-must-not-escape';
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(
        run([
          'verify', '--bundle-workdir', privateText,
          '--revision', 'not-a-revision', '--mode', 'sealed',
        ]),
      ).resolves.toBe(1);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalledWith(
        `${JSON.stringify({ status: 'error', code: 'INVALID_ARGUMENT' })}\n`,
      );
      expect(String(stderr.mock.calls[0]?.[0])).not.toContain(privateText);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
