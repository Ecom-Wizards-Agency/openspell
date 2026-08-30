#!/usr/bin/env node

import { chmod, lstat, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';

const [rawArtifactRoot] = process.argv.slice(2);
if (!rawArtifactRoot) {
  process.stderr.write('usage: normalize-mcp-evo-artifact.mjs <artifact-root>\n');
  process.exit(2);
}

const artifactRoot = resolve(rawArtifactRoot);
const virtualStore = join(artifactRoot, 'node_modules', '.pnpm');
const workspacePackages = ['core', 'db', 'shared'];
const renamed = new Map();

const storeEntries = await readdir(virtualStore);
for (const packageName of workspacePackages) {
  const prefix = `@wizard-ads+${packageName}@file+`;
  const matches = storeEntries.filter((entry) => entry.startsWith(prefix));
  if (matches.length !== 1) {
    throw new Error(`expected one injected ${packageName} package in the artifact`);
  }
  const oldName = matches[0];
  const newName = `${prefix}packages+${packageName}`;
  await rename(join(virtualStore, oldName), join(virtualStore, newName));
  renamed.set(oldName, newName);
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
for (const packageName of workspacePackages) {
  const dependency = `@wizard-ads/${packageName}`;
  if (!(dependency in (packageJson.dependencies ?? {}))) {
    throw new Error(`artifact package metadata is missing ${dependency}`);
  }
  packageJson.dependencies[dependency] = 'workspace:*';
}
await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, { mode: 0o644 });

const generatedMetadata = [
  '.turbo',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'node_modules/.package-map.json',
  'node_modules/.modules.yaml',
  'node_modules/.pnpm/lock.yaml',
  'node_modules/.pnpm-workspace-state-v1.json',
];
for (const relativePath of generatedMetadata) {
  await rm(join(artifactRoot, relativePath), { force: true, recursive: true });
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
      throw new Error('artifact path retains checkout identity metadata');
    }
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      const target = await readlink(path);
      if (target.startsWith('/') || /(?:^|[+])(?:home|Users)[+]/u.test(target)) {
        throw new Error('artifact symlink is not release-relative');
      }
    } else if (metadata.isDirectory()) {
      await chmod(path, metadata.mode & ~0o022);
      await assertPortable(path);
    } else if (metadata.isFile()) {
      await chmod(path, metadata.mode & ~0o022);
    }
  }
}
const rootMetadata = await lstat(artifactRoot);
await chmod(artifactRoot, rootMetadata.mode & ~0o022);
await assertPortable(artifactRoot);

process.stdout.write(`normalized ${basename(artifactRoot)}\n`);
