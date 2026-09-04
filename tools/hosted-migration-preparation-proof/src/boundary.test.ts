import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDirectory = join(packageDirectory, "src");
const cleanupHelper = join(packageDirectory, "scripts/path-cleanup-helper.mjs");
const invocationPrefix = "openspell-wp201-root-proof-";
const sentinelPrefix = "openspell-wp201-cleanup-sentinel-";
const cleanupCompletion = "openspell.wp201.path-cleanup-complete.v2\n";
const cleanupRefusal = "openspell.wp201.path-cleanup-refused.v2\n";
const invocationMagic = "openspell.wp201.invocation.v1";
const invocationPattern = /^[0-9a-f]{64}$/u;
const testPathPattern = new RegExp(
  "^/tmp/(?:" + invocationPrefix + "|" + sentinelPrefix + ")[0-9a-f]{64}$",
  "u",
);
const maximumTestEntries = 1_024;
const maximumTestDepth = 32;

interface OwnedTestRoot {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
}

interface InvocationFixture extends OwnedTestRoot {
  readonly invocation: string;
}

interface HelperResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly diagnostics: string;
  readonly completion: string;
  readonly completionObservedBeforeAbsence: boolean;
  readonly diagnosticsOverflow: boolean;
  readonly completionOverflow: boolean;
  readonly timedOut: boolean;
}

function errnoIs(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function pathIsAbsent(path: string): boolean {
  try {
    lstatSync(path, { bigint: true });
    return false;
  } catch (error) {
    if (errnoIs(error, "ENOENT")) return true;
    throw error;
  }
}

function createOwnedRoot(prefix: string): OwnedTestRoot {
  const identity = randomBytes(32).toString("hex");
  const path = `/tmp/${prefix}${identity}`;
  if (!testPathPattern.test(path)) throw new Error("invalid test-owned path");
  mkdirSync(path, { mode: 0o700 });
  try {
    chmodSync(path, 0o700);
    const stats = lstatSync(path, { bigint: true });
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      Number(stats.mode & 0o7777n) !== 0o700
    ) {
      throw new Error("invalid test-owned root");
    }
    return {
      path,
      device: stats.dev,
      inode: stats.ino,
      uid: stats.uid,
      gid: stats.gid,
    };
  } catch (error) {
    rmdirSync(path);
    throw error;
  }
}

function expectOwnedRootPresent(root: OwnedTestRoot): void {
  const stats = lstatSync(root.path, { bigint: true });
  expect(stats.isDirectory()).toBe(true);
  expect(stats.isSymbolicLink()).toBe(false);
  expect(stats.dev).toBe(root.device);
  expect(stats.ino).toBe(root.inode);
  expect(stats.uid).toBe(root.uid);
  expect(stats.gid).toBe(root.gid);
}

function createInvocationFixture(): InvocationFixture {
  const invocation = randomBytes(32).toString("hex");
  if (!invocationPattern.test(invocation)) throw new Error("invalid test invocation");
  const path = `/tmp/${invocationPrefix}${invocation}`;
  if (!testPathPattern.test(path)) throw new Error("invalid test-owned path");
  mkdirSync(path, { mode: 0o700 });
  try {
    chmodSync(path, 0o700);
    const stats = lstatSync(path, { bigint: true });
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      Number(stats.mode & 0o7777n) !== 0o700
    ) {
      throw new Error("invalid test invocation root");
    }
    return {
      invocation,
      path,
      device: stats.dev,
      inode: stats.ino,
      uid: stats.uid,
      gid: stats.gid,
    };
  } catch (error) {
    rmdirSync(path);
    throw error;
  }
}

function removeOwnedTestRoot(root: OwnedTestRoot): void {
  expect(testPathPattern.test(root.path)).toBe(true);
  let entries = 0;

  const visit = (path: string, depth: number, isRoot: boolean): void => {
    expect(depth).toBeLessThanOrEqual(maximumTestDepth);
    let stats;
    try {
      stats = lstatSync(path, { bigint: true });
    } catch (error) {
      if (errnoIs(error, "ENOENT")) return;
      throw error;
    }

    if (isRoot) {
      expect(stats.dev).toBe(root.device);
      expect(stats.ino).toBe(root.inode);
      expect(stats.isDirectory()).toBe(true);
    }
    expect(stats.dev).toBe(root.device);
    expect(stats.uid).toBe(root.uid);
    expect(stats.gid).toBe(root.gid);
    entries += 1;
    expect(entries).toBeLessThanOrEqual(maximumTestEntries);

    if (stats.isDirectory()) {
      chmodSync(path, 0o700);
      for (const name of readdirSync(path)) {
        expect(name).not.toBe("");
        expect(name).not.toBe(".");
        expect(name).not.toBe("..");
        expect(name).not.toContain("/");
        visit(join(path, name), depth + 1, false);
      }
      rmdirSync(path);
      return;
    }

    expect(
      stats.isFile() ||
        stats.isSymbolicLink() ||
        stats.isFIFO() ||
        stats.isSocket(),
    ).toBe(true);
    unlinkSync(path);
  };

  visit(root.path, 0, true);
  expect(pathIsAbsent(root.path)).toBe(true);
}

function cleanupOwnedRoots(roots: readonly OwnedTestRoot[]): void {
  let firstFailure: unknown;
  for (const root of [...roots].reverse()) {
    try {
      removeOwnedTestRoot(root);
    } catch (error) {
      firstFailure ??= error;
    }
  }
  if (firstFailure !== undefined) throw firstFailure;
}

function cleanupControlFrame(
  fixture: InvocationFixture,
  state: "pre-record" | "partial-acquisition" | "ledger-backed",
  device = fixture.device,
  inode = fixture.inode,
): string {
  return `openspell.wp201.path-cleanup.v2\ntmp\n${fixture.invocation}\n${device}\n${inode}\n${state}\n`;
}

function requireReadable(value: Readable | Writable | null | undefined): Readable {
  if (
    value === null ||
    value === undefined ||
    typeof (value as Readable).on !== "function"
  ) {
    throw new Error("missing cleanup-helper readable channel");
  }
  return value as Readable;
}

function requireWritable(value: Readable | Writable | null | undefined): Writable {
  if (
    value === null ||
    value === undefined ||
    typeof (value as Writable).end !== "function"
  ) {
    throw new Error("missing cleanup-helper writable channel");
  }
  return value as Writable;
}

async function runCleanupHelper(options: {
  readonly frame: string;
  readonly observedPath: string;
  readonly environment?: Readonly<Record<string, string>>;
}): Promise<HelperResult> {
  const child = spawn(process.execPath, [cleanupHelper], {
    cwd: "/",
    detached: true,
    env: options.environment ?? { LANG: "C", LC_ALL: "C" },
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  });
  const diagnostics = requireReadable(child.stdio[2]);
  const control = requireWritable(child.stdio[3]);
  const completion = requireReadable(child.stdio[4]);
  const diagnosticChunks: Buffer[] = [];
  const completionChunks: Buffer[] = [];
  let diagnosticsBytes = 0;
  let completionBytes = 0;
  let completionObservedBeforeAbsence = false;
  let diagnosticsOverflow = false;
  let completionOverflow = false;
  let timedOut = false;

  diagnostics.on("data", (chunk: Buffer) => {
    diagnosticsBytes += chunk.length;
    if (diagnosticsBytes > 4_096) {
      diagnosticsOverflow = true;
      child.kill("SIGKILL");
    }
    diagnosticChunks.push(Buffer.from(chunk));
  });
  completion.on("data", (chunk: Buffer) => {
    completionBytes += chunk.length;
    if (completionBytes > 64) {
      completionOverflow = true;
      child.kill("SIGKILL");
    }
    if (!pathIsAbsent(options.observedPath)) {
      completionObservedBeforeAbsence = true;
    }
    completionChunks.push(Buffer.from(chunk));
  });
  control.on("error", () => {
    // Early environment/protocol refusals may close their unread socketpair.
  });

  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 5_000);
  timeout.unref();
  control.end(Buffer.from(options.frame, "utf8"));

  try {
    const outcome = await closed;
    return {
      ...outcome,
      diagnostics: Buffer.concat(diagnosticChunks).toString("utf8"),
      completion: Buffer.concat(completionChunks).toString("utf8"),
      completionObservedBeforeAbsence,
      diagnosticsOverflow,
      completionOverflow,
      timedOut,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function expectCleanupSuccess(result: HelperResult): void {
  expect(result).toEqual({
    code: 0,
    signal: null,
    diagnostics: "",
    completion: cleanupCompletion,
    completionObservedBeforeAbsence: false,
    diagnosticsOverflow: false,
    completionOverflow: false,
    timedOut: false,
  });
}

function expectCleanupRefusal(result: HelperResult): void {
  expect(result).toEqual({
    code: 73,
    signal: null,
    diagnostics: cleanupRefusal,
    completion: "",
    completionObservedBeforeAbsence: false,
    diagnosticsOverflow: false,
    completionOverflow: false,
    timedOut: false,
  });
}

function read(relativePath: string): string {
  return readFileSync(join(packageDirectory, relativePath), "utf8");
}

function tomlTable(contents: string, name: string): string {
  const marker = `[${name}]`;
  const tableStart = contents.indexOf(marker);
  if (tableStart === -1) throw new Error(`missing exact ${marker} table`);
  const bodyStart = tableStart + marker.length;
  const nextTableOffset = contents.slice(bodyStart).search(/^\s*\[/mu);
  return contents.slice(
    bodyStart,
    nextTableOffset === -1 ? undefined : bodyStart + nextTableOffset,
  );
}

describe("private preparation-proof package boundary", () => {
  it("is exactly one inert private rlib with no default feature or executable surface", () => {
    expect(JSON.parse(read("package.json"))).toEqual({
      name: "@wizard-ads/hosted-migration-preparation-proof",
      version: "0.0.0",
      private: true,
      type: "module",
      scripts: {
        typecheck: "tsc --noEmit",
        test: "vitest run",
      },
      devDependencies: { "@types/node": "^22.20.1" },
    });

    const cargo = read("Cargo.toml");
    for (const declaration of [
      "publish = false",
      "autobins = false",
      "autoexamples = false",
      "autobenches = false",
      'crate-type = ["rlib"]',
    ]) {
      expect(cargo).toContain(declaration);
    }
    expect(cargo).not.toMatch(/^\s*\[features\]/mu);
    expect(cargo).not.toMatch(/^\s*\[\[(?:bin|example|bench|test)\]\]/mu);
    expect(cargo).not.toMatch(/^\s*\[(?:build-dependencies|dev-dependencies)\]/mu);
    expect(readdirSync(sourceDirectory).sort()).toEqual([
      "boundary.test.ts",
      "composition.test.ts",
      "interruption.test.ts",
      "lib.rs",
    ]);

    expect(read("rust-toolchain.toml")).toBe(
      '[toolchain]\nchannel = "1.97.1"\nprofile = "minimal"\ncomponents = ["clippy", "rustfmt"]\n',
    );
    expect(
      readdirSync(packageDirectory)
        .filter((entry) => ![".turbo", "node_modules"].includes(entry))
        .sort(),
    ).toEqual([
      "Cargo.lock",
      "Cargo.toml",
      "package.json",
      "rust-toolchain.toml",
      "scripts",
      "src",
      "tsconfig.json",
    ]);
    expect(readdirSync(sourceDirectory).sort()).toEqual([
      "boundary.test.ts",
      "composition.test.ts",
      "interruption.test.ts",
      "lib.rs",
    ]);
  });

  it("keeps the Rust implementation byte-small and incapable of effects", () => {
    const library = read("src/lib.rs");
    expect(library).toBe(
      "//! Inert composition boundary for the WP-201 preparation proof.\n\n#![forbid(unsafe_code)]\n",
    );
    expect(library).not.toMatch(
      /\b(?:pub|fn|struct|enum|trait|impl|mod|extern|use|std::process|std::net|sql|deploy|command)\b/iu,
    );
  });

  it("locks the local package to exactly its two bridge crates", () => {
    const lock = read("Cargo.lock");
    const block = lock.match(
      /\[\[package\]\]\nname = "openspell-hosted-migration-preparation-proof"\n[\s\S]*?(?=\n\[\[package\]\]|$)/u,
    );
    expect(block).not.toBeNull();
    expect(block?.[0]).toBe(
      '[[package]]\nname = "openspell-hosted-migration-preparation-proof"\nversion = "0.0.0"\ndependencies = [\n "openspell-hosted-migration-root-authority",\n "openspell-hosted-migration-runtime-proof",\n]\n',
    );

    expect(
      tomlTable(read("Cargo.toml"), "dependencies")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    ).toEqual([
      'openspell-hosted-migration-root-authority = { path = "../hosted-migration-root-authority", default-features = false, features = ["wp201-internal"] }',
      'openspell-hosted-migration-runtime-proof = { path = "../hosted-migration-runtime-proof", default-features = false, features = ["wp201-internal"] }',
    ]);
  });
});

describe("WP-201 path cleanup helper boundary", () => {
  it("cleans absent and partial pre-record roots and completes only after absence", async () => {
    const roots: OwnedTestRoot[] = [];
    try {
      const absent = createInvocationFixture();
      roots.push(absent);
      expectCleanupSuccess(
        await runCleanupHelper({
          frame: cleanupControlFrame(absent, "pre-record"),
          observedPath: absent.path,
        }),
      );
      expect(pathIsAbsent(absent.path)).toBe(true);

      const partial = createInvocationFixture();
      roots.push(partial);
      const partialRecord = Buffer.from(`${invocationMagic}\n${partial.invocation}\n`).subarray(
        0,
        37,
      );
      writeFileSync(join(partial.path, "INVOCATION"), partialRecord, { mode: 0o600 });
      chmodSync(join(partial.path, "INVOCATION"), 0o600);
      expectCleanupSuccess(
        await runCleanupHelper({
          frame: cleanupControlFrame(partial, "pre-record"),
          observedPath: partial.path,
        }),
      );
      expect(pathIsAbsent(partial.path)).toBe(true);
    } finally {
      cleanupOwnedRoots(roots);
    }
  });

  it("restores and removes a mode-0000 partial cache without following an outward symlink", async () => {
    const roots: OwnedTestRoot[] = [];
    try {
      const fixture = createInvocationFixture();
      const sentinel = createOwnedRoot(sentinelPrefix);
      roots.push(fixture, sentinel);
      const sentinelFile = join(sentinel.path, "must-remain");
      writeFileSync(sentinelFile, "outside\n", { mode: 0o600 });

      writeFileSync(
        join(fixture.path, "INVOCATION"),
        `${invocationMagic}\n${fixture.invocation}\n`,
        { mode: 0o600 },
      );
      const cache = join(fixture.path, "cargo-home");
      mkdirSync(cache, { mode: 0o700 });
      const cachedFile = join(cache, "cached");
      writeFileSync(cachedFile, "synthetic-cache\n", { mode: 0o600 });
      linkSync(cachedFile, join(cache, "cached-hardlink"));
      execFileSync("/usr/bin/mkfifo", ["--mode=600", join(cache, "completion.fifo")], {
        env: { LANG: "C", LC_ALL: "C" },
        stdio: "ignore",
      });
      symlinkSync(sentinel.path, join(cache, "outward"));
      chmodSync(cache, 0o000);
      expect(Number(lstatSync(cache, { bigint: true }).mode & 0o7777n)).toBe(0o000);

      expectCleanupSuccess(
        await runCleanupHelper({
          frame: cleanupControlFrame(fixture, "partial-acquisition"),
          observedPath: fixture.path,
        }),
      );
      expect(pathIsAbsent(fixture.path)).toBe(true);
      expect(readFileSync(sentinelFile, "utf8")).toBe("outside\n");
    } finally {
      cleanupOwnedRoots(roots);
    }
  });

  it("refuses wrong identity, extra environment, and malformed control without deletion", async () => {
    const roots: OwnedTestRoot[] = [];
    try {
      const wrongIdentity = createInvocationFixture();
      roots.push(wrongIdentity);
      expectCleanupRefusal(
        await runCleanupHelper({
          frame: cleanupControlFrame(
            wrongIdentity,
            "pre-record",
            wrongIdentity.device,
            wrongIdentity.inode + 1n,
          ),
          observedPath: wrongIdentity.path,
        }),
      );
      expectOwnedRootPresent(wrongIdentity);

      const extraEnvironment = createInvocationFixture();
      roots.push(extraEnvironment);
      expectCleanupRefusal(
        await runCleanupHelper({
          frame: cleanupControlFrame(extraEnvironment, "pre-record"),
          observedPath: extraEnvironment.path,
          environment: { LANG: "C", LC_ALL: "C", EXTRA: "refuse" },
        }),
      );
      expectOwnedRootPresent(extraEnvironment);

      const malformed = createInvocationFixture();
      roots.push(malformed);
      expectCleanupRefusal(
        await runCleanupHelper({
          frame: `${cleanupControlFrame(malformed, "pre-record")}trailing`,
          observedPath: malformed.path,
        }),
      );
      expectOwnedRootPresent(malformed);
    } finally {
      cleanupOwnedRoots(roots);
    }
  });
});
