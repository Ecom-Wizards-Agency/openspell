#!/usr/bin/env node

import {
  chmod,
  lstat,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import process from 'node:process';

const [rawArtifactRoot] = process.argv.slice(2);
if (!rawArtifactRoot) {
  process.stderr.write('usage: normalize-report-worker-evo-artifact.mjs <artifact-root>\n');
  process.exit(2);
}

const artifactRoot = resolve(rawArtifactRoot);
const virtualStore = join(artifactRoot, 'node_modules', '.pnpm');
const expectedArtifactRootEntries = new Set([
  'Dockerfile',
  'README.md',
  'fly.toml',
  'node_modules',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'src',
  'tsconfig.json',
]);
const workspacePackages = [
  { name: 'ads-api', stablePath: 'packages+ads-api' },
  { name: 'core', stablePath: 'packages+core' },
  { name: 'crosscheck-cli', stablePath: 'tools+crosscheck-cli' },
  { name: 'datadive-api', stablePath: 'packages+datadive-api' },
  { name: 'db', stablePath: 'packages+db' },
  { name: 'keepa-api', stablePath: 'packages+keepa-api' },
  { name: 'mrp-api', stablePath: 'packages+mrp-api' },
  { name: 'shared', stablePath: 'packages+shared' },
  { name: 'sp-api', stablePath: 'packages+sp-api' },
  { name: 'strategy', stablePath: 'packages+strategy' },
];
const renamed = new Map();
const runtimePackageRoots = [];

for (const entry of await readdir(artifactRoot)) {
  if (!expectedArtifactRootEntries.has(entry)) {
    throw new Error('worker artifact contains an unexpected root entry');
  }
}
const storeEntries = await readdir(virtualStore);
const injectedEntries = storeEntries.filter((entry) => entry.startsWith('@wizard-ads+'));
if (injectedEntries.length !== workspacePackages.length) {
  throw new Error('worker artifact has an unexpected injected workspace package count');
}
for (const { name, stablePath } of workspacePackages) {
  const prefix = `@wizard-ads+${name}@file+`;
  const matches = storeEntries.filter((entry) => entry.startsWith(prefix));
  if (matches.length !== 1) {
    throw new Error(`expected one injected ${name} package in the worker artifact`);
  }
  const oldName = matches[0];
  const newName = `${prefix}${stablePath}`;
  await rename(join(virtualStore, oldName), join(virtualStore, newName));
  renamed.set(oldName, newName);
  runtimePackageRoots.push(
    join(virtualStore, newName, 'node_modules', '@wizard-ads', name),
  );
}

async function rewriteLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await readlink(path);
      let stableTarget = target;
      for (const [oldName, newName] of renamed) {
        stableTarget = stableTarget.replaceAll(oldName, newName);
      }
      if (stableTarget !== target) {
        await rm(path);
        await symlink(stableTarget, path);
      }
    } else if (entry.isDirectory()) {
      await rewriteLinks(path);
    }
  }
}
await rewriteLinks(artifactRoot);

const packagePath = join(artifactRoot, 'package.json');
const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
for (const { name } of workspacePackages) {
  const dependency = `@wizard-ads/${name}`;
  if (!(dependency in (packageJson.dependencies ?? {}))) {
    throw new Error(`worker artifact package metadata is missing ${dependency}`);
  }
  packageJson.dependencies[dependency] = 'workspace:*';
}
await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, { mode: 0o644 });

const generatedMetadata = [
  '.turbo',
  'Dockerfile',
  'README.md',
  'fly.toml',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'node_modules/.package-map.json',
  'node_modules/.modules.yaml',
  'node_modules/.pnpm/lock.yaml',
  'node_modules/.pnpm-workspace-state-v1.json',
];
for (const relativePath of generatedMetadata) {
  await rm(join(artifactRoot, relativePath), { force: true, recursive: true });
}

await pruneRuntimePackage(artifactRoot, new Set(['package.json', 'src', 'node_modules']));
for (const runtimePackageRoot of runtimePackageRoots) {
  await pruneRuntimePackage(runtimePackageRoot, new Set(['package.json', 'src', 'node_modules']));
}

const workspaceManifest = {
  schemaVersion: 1,
  offered: workspacePackages.length,
  normalized: renamed.size,
  packages: workspacePackages.map(({ name }) => `@wizard-ads/${name}`),
};
if (
  workspaceManifest.offered !== workspaceManifest.normalized
  || !workspaceManifest.packages.includes('@wizard-ads/sp-api')
) {
  throw new Error('worker workspace input/output reconciliation failed');
}
await writeFile(
  join(artifactRoot, 'WORKSPACE_MANIFEST.json'),
  `${JSON.stringify(workspaceManifest, null, 2)}\n`,
  { mode: 0o644 },
);

async function pruneRuntimePackage(directory, allowedRootEntries) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (!allowedRootEntries.has(entry.name)) {
      await rm(path, { force: true, recursive: true });
    }
  }
  const sourceRoot = join(directory, 'src');
  try {
    await pruneTestSources(sourceRoot);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function pruneTestSources(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (
      entry.name === '__fixtures__'
      || entry.name === 'test-fixtures'
      || entry.name === 'testing'
      || /(?:^|\.)test\.ts$/u.test(entry.name)
    ) {
      await rm(path, { force: true, recursive: true });
    } else if (entry.isDirectory()) {
      await pruneTestSources(path);
    }
  }
}

async function removeGeneratedDirectories(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if ((entry.name === '.turbo' || entry.name === '.bin') && entry.isDirectory()) {
      await rm(path, { recursive: true });
    } else if (entry.isDirectory()) {
      await removeGeneratedDirectories(path);
    }
  }
}
await removeGeneratedDirectories(artifactRoot);

async function assertPortable(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (/(?:^|[+])(?:home|Users)[+]/u.test(entry.name)) {
      throw new Error('worker artifact path retains checkout identity metadata');
    }
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      const target = await readlink(path);
      if (target.startsWith('/') || /(?:^|[+])(?:home|Users)[+]/u.test(target)) {
        throw new Error('worker artifact symlink is not release-relative');
      }
      let resolved;
      try {
        resolved = await realpath(path);
      } catch {
        throw new Error('worker artifact contains an unresolved symlink');
      }
      const relation = relative(artifactRoot, resolved);
      if (relation === '..' || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
        throw new Error('worker artifact symlink escapes its release');
      }
    } else if (metadata.isDirectory()) {
      await chmod(path, metadata.mode & ~0o022);
      await assertPortable(path);
    } else if (metadata.isFile()) {
      await chmod(path, metadata.mode & ~0o022);
    } else {
      throw new Error('worker artifact contains an unsupported filesystem object');
    }
  }
}
const rootMetadata = await lstat(artifactRoot);
await chmod(artifactRoot, rootMetadata.mode & ~0o022);
await assertPortable(artifactRoot);

process.stdout.write(
  `normalized ${basename(artifactRoot)} (${workspaceManifest.normalized}/${workspaceManifest.offered} workspaces)\n`,
);
