#!/usr/bin/env node
/**
 * `pnpm hygiene` - the public-repo gate. Runs in CI on every push and PR.
 *
 * It reads what git says is tracked (not what is on disk), so a gitignored
 * `_local/` file is invisible to it by construction, which is the point.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  formatFindings,
  parseDenylist,
  scanFiles,
  scanTopLevelDirs,
  type Finding,
  type ScanTarget,
} from './scan.js';

/** Anything bigger than this in a source repo is data, not authored text. */
const MAX_BYTES = 512 * 1024;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function repoRoot(): string {
  return git(['rev-parse', '--show-toplevel'], process.cwd()).trim();
}

function trackedFiles(root: string): string[] {
  return git(['ls-files', '-z'], root).split('\0').filter((p) => p !== '');
}

function untrackedEntries(root: string): string[] {
  return git(
    ['ls-files', '--others', '--exclude-standard', '--directory', '--no-empty-directory', '-z'],
    root,
  )
    .split('\0')
    .filter((p) => p !== '');
}

function loadTargets(root: string, paths: readonly string[]): ScanTarget[] {
  const targets: ScanTarget[] = [];
  for (const path of paths) {
    const absolute = join(root, path);
    try {
      if (statSync(absolute).size > MAX_BYTES) continue;
      targets.push({ path, content: readFileSync(absolute, 'utf8') });
    } catch {
      // A tracked path that cannot be read right now (submodule, broken symlink)
      // is not a hygiene problem. git's own checks own that.
    }
  }
  return targets;
}

function main(): number {
  const root = resolve(repoRoot());
  const denylistPath = join(root, '_local', 'hygiene-denylist.txt');

  let denylist: string[] = [];
  let denylistNote: string;
  try {
    denylist = parseDenylist(readFileSync(denylistPath, 'utf8'));
    denylistNote = `denylist: ${denylist.length} terms from _local/hygiene-denylist.txt`;
  } catch {
    denylistNote =
      'WARNING: _local/hygiene-denylist.txt not found, client-name check SKIPPED. ' +
      'Copy _local/hygiene-denylist.TEMPLATE.txt to create it.';
  }

  const tracked = trackedFiles(root);
  const targets = loadTargets(root, tracked);

  const findings: Finding[] = [
    ...scanFiles(targets, { denylist }),
    ...scanTopLevelDirs(untrackedEntries(root)),
  ];

  process.stdout.write(`hygiene-lint: ${targets.length} of ${tracked.length} tracked files scanned\n`);
  process.stdout.write(`hygiene-lint: ${denylistNote}\n`);

  if (findings.length === 0) {
    process.stdout.write('hygiene-lint: clean\n');
    return 0;
  }

  process.stderr.write(`${formatFindings(findings)}\n`);
  process.stderr.write(`hygiene-lint: ${findings.length} finding(s)\n`);
  return 1;
}

process.exit(main());
