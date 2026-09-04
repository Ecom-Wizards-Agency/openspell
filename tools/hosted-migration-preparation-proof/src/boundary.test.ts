import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
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

import {
  verifyControllerFixtures,
  verifyTestOrchestratorRuntimeForTests,
} from "../scripts/test.mjs";
import { requireRootBridgeMarker } from "../scripts/docker-integration.mjs";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDirectory = join(packageDirectory, "src");
const cleanupHelper = join(packageDirectory, "scripts/path-cleanup-helper.mjs");
const invocationPrefix = "openspell-wp201-root-proof-";
const sentinelPrefix = "openspell-wp201-cleanup-sentinel-";
const cleanupCompletion = "openspell.wp201.path-cleanup-complete.v2\n";
const failedCleanupCompletion =
  "openspell.wp201.path-cleanup-failed-cut-complete.v1\n";
const cleanupRefusal = "openspell.wp201.path-cleanup-refused.v2\n";
const invocationMagic = "openspell.wp201.invocation.v1";
const invocationPattern = /^[0-9a-f]{64}$/u;
const testPathPattern = new RegExp(
  "^/tmp/(?:" + invocationPrefix + "|" + sentinelPrefix + ")[0-9a-f]{64}$",
  "u",
);
const maximumTestEntries = 1_024;
const maximumTestDepth = 32;
const linuxCloseOnExec = 0o20_000_00;

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

interface RetainedLedgerFixture extends InvocationFixture {
  readonly ledgerPath: string;
  readonly ledgerBytes: Buffer;
  readonly ledgerDigest: string;
  readonly mountId: bigint;
  readonly rootDescriptor: number;
  readonly ledgerDescriptor: number;
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

function descriptorMountId(descriptor: number): bigint {
  const text = readFileSync(`/proc/self/fdinfo/${descriptor}`, "ascii");
  const matches = [...text.matchAll(/^mnt_id:\s+(?<mountId>[1-9][0-9]*)$/gmu)];
  const mountId = matches[0]?.groups?.mountId;
  if (matches.length !== 1 || mountId === undefined) {
    throw new Error("missing descriptor mount identity");
  }
  return BigInt(mountId);
}

function failedCleanupControlFrame(fixture: RetainedLedgerFixture): string {
  return (
    "openspell.wp201.path-cleanup-failed-cut.v1\n" +
    `tmp\n${fixture.invocation}\n${fixture.device}\n${fixture.inode}\n` +
    `${fixture.mountId}\n${fixture.ledgerDigest}\n`
  );
}

const fixedAuthorityRows = [
  [
    "tools/hosted-migration-preparation-proof/Cargo.toml",
    558,
    "5c89e16cac4721f4a968b2089efcea8fb9c1fe98225d6979166e2c2a3461bad9",
  ],
  [
    "tools/hosted-migration-preparation-proof/Cargo.lock",
    15_208,
    "f3455774926880919588246bc9fc422e3ece13c29250862b4249b91b55ecbc86",
  ],
  [
    "tools/hosted-migration-preparation-proof/rust-toolchain.toml",
    86,
    "8e390d6a0838315f972690f46ef8bae8b7ecc9ee6c1ed70140ef852869c2482e",
  ],
  [
    "tools/hosted-migration-root-authority/Cargo.toml",
    787,
    "7639e2f59bb0c745b54a192478d86bba1ab1a046066ea490efa6b783e4e2860a",
  ],
  [
    "tools/hosted-migration-root-authority/Cargo.lock",
    13_741,
    "bd460b4ca9b06241a393eb9d4b5bcc05b68a6d6af844fab1f9a683826979f6f5",
  ],
  [
    "tools/hosted-migration-root-authority/rust-toolchain.toml",
    86,
    "8e390d6a0838315f972690f46ef8bae8b7ecc9ee6c1ed70140ef852869c2482e",
  ],
  [
    "tools/hosted-migration-runtime-proof/Cargo.toml",
    1_047,
    "cfca33ad8a621f30fd54c4a9843eb1dd2add8a91cb4d785c60cabd4ccb945364",
  ],
  [
    "tools/hosted-migration-runtime-proof/Cargo.lock",
    15_493,
    "58e3c00b558af03db96516e7e62f5df170630a28a9c29395b1e1de477a82f6aa",
  ],
  [
    "tools/hosted-migration-runtime-proof/rust-toolchain.toml",
    86,
    "8e390d6a0838315f972690f46ef8bae8b7ecc9ee6c1ed70140ef852869c2482e",
  ],
] as const;

function distributedSizes(count: number, total: number): readonly number[] {
  const maximum = 256 * 1024 * 1024;
  const sizes = Array.from({ length: count }, () => 0);
  let remaining = total;
  for (let index = 0; index < sizes.length && remaining > 0; index += 1) {
    const size = Math.min(maximum, remaining);
    sizes[index] = size;
    remaining -= size;
  }
  if (remaining !== 0) throw new Error("test ledger byte distribution overflow");
  return sizes;
}

let retainedLedgerBytes: Buffer | undefined;

function syntheticCompleteLedger(): Buffer {
  if (retainedLedgerBytes !== undefined) return retainedLedgerBytes;
  const emptyDigest = createHash("sha256").update("").digest("hex");
  const rows: string[] = [];
  const addDirectory = (path: string): void => {
    rows.push(`D\t0555\t${path}`);
  };
  const addFile = (
    tag: "S" | "V" | "T" | "C",
    path: string,
    size: number,
    digest = emptyDigest,
    mode: "0444" | "0555" = "0444",
  ): void => {
    rows.push(`${tag}\t${mode}\t${size}\t${digest}\t${path}`);
  };

  for (const path of [
    "source",
    "source/tools",
    "source/tools/hosted-migration-preparation-proof",
    "source/tools/hosted-migration-preparation-proof/src",
    "source/tools/hosted-migration-root-authority",
    "source/tools/hosted-migration-root-authority/src",
    "source/tools/hosted-migration-root-authority/src/journal",
    "source/tools/hosted-migration-runtime-proof",
    "source/tools/hosted-migration-runtime-proof/fixtures",
    "source/tools/hosted-migration-runtime-proof/src",
  ]) {
    addDirectory(path);
  }
  addDirectory("vendor");
  for (let index = 0; index < 940; index += 1) {
    addDirectory(`vendor/crate-${index.toString().padStart(4, "0")}`);
  }
  addDirectory("toolchain");
  for (let index = 0; index < 27; index += 1) {
    addDirectory(`toolchain/component-${index.toString().padStart(2, "0")}`);
  }

  for (const [path, size, digest] of fixedAuthorityRows) {
    addFile("S", path, size, digest);
  }
  for (let index = 0; index < 36; index += 1) {
    addFile(
      "S",
      `tools/hosted-migration-preparation-proof/src/synthetic-${index
        .toString()
        .padStart(2, "0")}.rs`,
      0,
    );
  }

  const vendorSizes = distributedSizes(3_657, 67_159_121);
  for (let index = 0; index < vendorSizes.length; index += 1) {
    const crate = index % 940;
    addFile(
      "V",
      `crate-${crate.toString().padStart(4, "0")}/file-${index
        .toString()
        .padStart(4, "0")}`,
      vendorSizes[index] ?? 0,
    );
  }
  const toolchainSizes = distributedSizes(168, 653_573_520);
  for (let index = 0; index < toolchainSizes.length; index += 1) {
    const component = index % 27;
    addFile(
      "T",
      `component-${component.toString().padStart(2, "0")}/file-${index
        .toString()
        .padStart(3, "0")}`,
      toolchainSizes[index] ?? 0,
      emptyDigest,
      index % 2 === 0 ? "0444" : "0555",
    );
  }
  const proofDigest =
    "914feaa7cece86e66a81a4dd8595d7efc2ae2e7be241d6190aee97c5c213bfcb";
  const hostname = Buffer.from("wp201-proof\n");
  const hosts = Buffer.from("127.0.0.1 localhost\n::1 localhost\n");
  addFile("C", "control/proof.sh", 30_322, proofDigest);
  addFile(
    "C",
    "etc/hostname",
    hostname.length,
    createHash("sha256").update(hostname).digest("hex"),
  );
  addFile(
    "C",
    "etc/hosts",
    hosts.length,
    createHash("sha256").update(hosts).digest("hex"),
  );
  addFile("C", "etc/resolv.conf", 0);

  const rowKey = (row: string): Buffer => {
    const fields = row.split("\t");
    return Buffer.from(`${fields[0]}\t${fields.at(-1)}`, "utf8");
  };
  rows.sort((left, right) => Buffer.compare(rowKey(left), rowKey(right)));
  if (rows.length !== 4_853) throw new Error("invalid synthetic ledger record count");
  const body = `openspell.wp201.vendor-ledger.v1\nrecords\t4853\n${rows.join("\n")}\n`;
  const endDigest = createHash("sha256").update(body).digest("hex");
  retainedLedgerBytes = Buffer.from(`${body}end\t${endDigest}\n`, "utf8");
  return retainedLedgerBytes;
}

function createRetainedLedgerFixture(): RetainedLedgerFixture {
  const fixture = createInvocationFixture();
  const acquisition = join(fixture.path, "acquisition");
  mkdirSync(acquisition, { mode: 0o700 });
  chmodSync(acquisition, 0o700);
  const ledgerPath = join(acquisition, "vendor-ledger.v1");
  const ledgerBytes = syntheticCompleteLedger();
  writeFileSync(ledgerPath, ledgerBytes, { mode: 0o444 });
  chmodSync(ledgerPath, 0o444);
  const rootDescriptor = openSync(
    fixture.path,
    constants.O_RDONLY |
      constants.O_DIRECTORY |
      constants.O_NOFOLLOW |
      linuxCloseOnExec,
  );
  try {
    const ledgerDescriptor = openSync(
      ledgerPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | linuxCloseOnExec,
    );
    return {
      ...fixture,
      ledgerPath,
      ledgerBytes,
      ledgerDigest: createHash("sha256").update(ledgerBytes).digest("hex"),
      mountId: descriptorMountId(rootDescriptor),
      rootDescriptor,
      ledgerDescriptor,
    };
  } catch (error) {
    closeSync(rootDescriptor);
    throw error;
  }
}

function closeRetainedFixture(fixture: RetainedLedgerFixture): void {
  closeSync(fixture.ledgerDescriptor);
  closeSync(fixture.rootDescriptor);
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
  readonly rootDescriptor?: number;
  readonly ledgerDescriptor?: number;
  readonly extraDescriptor?: number;
}): Promise<HelperResult> {
  const retainedDescriptors: number[] = [];
  if (options.rootDescriptor !== undefined && options.ledgerDescriptor !== undefined) {
    retainedDescriptors.push(options.rootDescriptor, options.ledgerDescriptor);
  } else if (options.rootDescriptor !== undefined || options.ledgerDescriptor !== undefined) {
    throw new Error("failed-cut helper descriptors must be paired");
  }
  const stdio: (number | "ignore" | "pipe")[] = [
    "ignore",
    "ignore",
    "pipe",
    "pipe",
    "pipe",
    ...retainedDescriptors,
  ];
  if (options.extraDescriptor !== undefined) stdio.push(options.extraDescriptor);
  const child = spawn(process.execPath, [cleanupHelper], {
    cwd: "/",
    detached: true,
    env: options.environment ?? { LANG: "C", LC_ALL: "C" },
    stdio,
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

function expectFailedCleanupSuccess(result: HelperResult): void {
  expect(result).toEqual({
    code: 0,
    signal: null,
    diagnostics: "",
    completion: failedCleanupCompletion,
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
  it("accepts only one exact root bridge line on root-positive stdout", () => {
    const marker = Buffer.from("openspell.wp201.root-bridge-success.v1\n", "ascii");
    const prefix = Buffer.from("cargo output\n", "ascii");
    expect(() =>
      requireRootBridgeMarker("root-positive", Buffer.concat([prefix, marker]), Buffer.alloc(0)),
    ).not.toThrow();
    expect(() =>
      requireRootBridgeMarker("root-fmt", prefix, Buffer.alloc(0)),
    ).not.toThrow();

    for (const [rowId, stdout, stderr] of [
      ["root-positive", prefix, Buffer.alloc(0)],
      ["root-positive", Buffer.concat([prefix, marker, marker]), Buffer.alloc(0)],
      ["root-positive", Buffer.concat([prefix, marker]), marker],
      ["root-positive", Buffer.concat([prefix, Buffer.from("x"), marker]), Buffer.alloc(0)],
      [
        "root-positive",
        Buffer.concat([prefix, marker.subarray(0, marker.length - 1)]),
        Buffer.alloc(0),
      ],
      ["root-fmt", Buffer.concat([prefix, marker]), Buffer.alloc(0)],
    ] as const) {
      expect(() => requireRootBridgeMarker(rowId, stdout, stderr)).toThrow(
        "WP-201 Docker integration refused: root bridge",
      );
    }

    for (let length = 1; length < marker.length - 1; length += 1) {
      const partial = marker.subarray(0, length);
      for (const [rowId, stdout, stderr] of [
        ["root-positive", Buffer.concat([prefix, partial]), Buffer.alloc(0)],
        ["root-positive", Buffer.concat([prefix, marker, partial]), Buffer.alloc(0)],
        ["root-positive", Buffer.concat([prefix, marker]), partial],
        ["root-fmt", Buffer.concat([prefix, partial]), Buffer.alloc(0)],
      ] as const) {
        expect(() => requireRootBridgeMarker(rowId, stdout, stderr)).toThrow(
          "WP-201 Docker integration refused: root bridge partial marker",
        );
      }
    }
  });

  it("holds the boot clock and bounds captured-output refusal before suite spawn", async () => {
    await expect(verifyControllerFixtures()).resolves.toEqual({
      acquisition: {
        bytes: 9_956,
        sha256:
          "72290e827399c5e6eb4c597312a65fbd6402c2d8ad87993c7e336a27f6d48258",
      },
      proof: {
        bytes: 30_322,
        sha256:
          "914feaa7cece86e66a81a4dd8595d7efc2ae2e7be241d6190aee97c5c213bfcb",
      },
    });
    await expect(verifyTestOrchestratorRuntimeForTests()).resolves.toEqual({
      bootTimeParsing: true,
      descriptorClosed: true,
      capturedOutputDisposition: "write:destroy:refuse",
    });

    const orchestrator = read("scripts/test.mjs");
    const integration = read("scripts/docker-integration.mjs");
    expect(orchestrator).not.toContain("process.hrtime");
    expect(orchestrator).toContain(
      "caughtSignal = signal;\n" +
        "  activeChildControl?.requestTermination();\n" +
        "  activeOutputControl?.requestTermination();",
    );
    expect(orchestrator).toContain(
      "const DOCKER_INTEGRATION_DEADLINE_MILLISECONDS = 7_490_000;",
    );
    expect(integration).toContain("const MATRIX_ACTIVE_NS = 1_500n * SECOND_NS;");
    expect(integration).toContain("const INNER_RESERVE_NS = 160n * SECOND_NS;");
    expect(3 * 460 + 1_660 + 3 * (325 + 1_110) + 130 + 15).toBe(7_490);
    expect(3 * 460 + 1_660 + 3 * (325 + 1_110) + 15).toBe(7_360);
    expect(
      orchestrator.indexOf("await verifyControllerFixtures();"),
    ).toBeLessThan(
      orchestrator.indexOf("const vitest = await runFixedVitest(clock);"),
    );
  });

  it("is exactly one inert private rlib with no default feature or executable surface", () => {
    expect(JSON.parse(read("package.json"))).toEqual({
      name: "@wizard-ads/hosted-migration-preparation-proof",
      version: "0.0.0",
      private: true,
      type: "module",
      scripts: {
        typecheck: "tsc --noEmit",
        test: "node scripts/test.mjs",
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

  it("uses retained capabilities to remove an authenticated failed-cut subset", async () => {
    const roots: OwnedTestRoot[] = [];
    let fixture: RetainedLedgerFixture | undefined;
    try {
      fixture = createRetainedLedgerFixture();
      roots.push(fixture);
      const docker = join(fixture.path, "docker");
      const dockerConfig = join(docker, "config");
      mkdirSync(docker, { mode: 0o700 });
      mkdirSync(dockerConfig, { mode: 0o700 });
      writeFileSync(join(dockerConfig, "config.json"), "{}", { mode: 0o400 });
      chmodSync(docker, 0o500);
      chmodSync(dockerConfig, 0o500);
      chmodSync(join(dockerConfig, "config.json"), 0o400);
      const first = Buffer.alloc(1);
      expect(readSync(fixture.ledgerDescriptor, first, 0, 1, null)).toBe(1);
      expect(first[0]).toBe(fixture.ledgerBytes[0]);

      expectFailedCleanupSuccess(
        await runCleanupHelper({
          frame: failedCleanupControlFrame(fixture),
          observedPath: fixture.path,
          rootDescriptor: fixture.rootDescriptor,
          ledgerDescriptor: fixture.ledgerDescriptor,
        }),
      );
      expect(pathIsAbsent(fixture.path)).toBe(true);
      expect(fstatSync(fixture.rootDescriptor, { bigint: true }).nlink).toBe(0n);
      expect(fstatSync(fixture.ledgerDescriptor, { bigint: true }).nlink).toBe(0n);
      expect(readdirSync(`/proc/self/fd/${fixture.rootDescriptor}`)).toEqual([]);

      const second = Buffer.alloc(1);
      expect(readSync(fixture.ledgerDescriptor, second, 0, 1, null)).toBe(1);
      expect(second[0]).toBe(fixture.ledgerBytes[1]);
    } finally {
      if (fixture !== undefined) closeRetainedFixture(fixture);
      cleanupOwnedRoots(roots);
    }
  });

  it.each(["hardlink", "rename"] as const)(
    "refuses an external ledger %s after removing only the authenticated root",
    async (operation) => {
      const roots: OwnedTestRoot[] = [];
      let fixture: RetainedLedgerFixture | undefined;
      try {
        fixture = createRetainedLedgerFixture();
        const sentinel = createOwnedRoot(sentinelPrefix);
        roots.push(fixture, sentinel);
        const externalLedger = join(sentinel.path, "retained-ledger");
        if (operation === "hardlink") {
          linkSync(fixture.ledgerPath, externalLedger);
          unlinkSync(fixture.ledgerPath);
        } else {
          renameSync(fixture.ledgerPath, externalLedger);
        }

        expectCleanupRefusal(
          await runCleanupHelper({
            frame: failedCleanupControlFrame(fixture),
            observedPath: fixture.path,
            rootDescriptor: fixture.rootDescriptor,
            ledgerDescriptor: fixture.ledgerDescriptor,
          }),
        );
        expect(pathIsAbsent(fixture.path)).toBe(true);
        expect(readFileSync(externalLedger)).toEqual(fixture.ledgerBytes);
        expect(fstatSync(fixture.rootDescriptor, { bigint: true }).nlink).toBe(0n);
        expect(fstatSync(fixture.ledgerDescriptor, { bigint: true }).nlink).toBe(1n);
      } finally {
        if (fixture !== undefined) closeRetainedFixture(fixture);
        cleanupOwnedRoots(roots);
      }
    },
  );

  it.each(["root", "ledger"] as const)(
    "refuses a duplicated child %s capability before deletion",
    async (duplicated) => {
      const roots: OwnedTestRoot[] = [];
      let fixture: RetainedLedgerFixture | undefined;
      try {
        fixture = createRetainedLedgerFixture();
        roots.push(fixture);
        expectCleanupRefusal(
          await runCleanupHelper({
            frame: failedCleanupControlFrame(fixture),
            observedPath: fixture.path,
            rootDescriptor: fixture.rootDescriptor,
            ledgerDescriptor: fixture.ledgerDescriptor,
            extraDescriptor:
              duplicated === "root"
                ? fixture.rootDescriptor
                : fixture.ledgerDescriptor,
          }),
        );
        expectOwnedRootPresent(fixture);
        expect(readFileSync(fixture.ledgerPath)).toEqual(fixture.ledgerBytes);
      } finally {
        if (fixture !== undefined) closeRetainedFixture(fixture);
        cleanupOwnedRoots(roots);
      }
    },
  );

  it("refuses an added failed-cut path without following it outside the root", async () => {
    const roots: OwnedTestRoot[] = [];
    let fixture: RetainedLedgerFixture | undefined;
    try {
      fixture = createRetainedLedgerFixture();
      const sentinel = createOwnedRoot(sentinelPrefix);
      roots.push(fixture, sentinel);
      const sentinelFile = join(sentinel.path, "must-remain");
      writeFileSync(sentinelFile, "outside\n", { mode: 0o600 });
      symlinkSync(sentinel.path, join(fixture.path, "unexpected"));

      expectCleanupRefusal(
        await runCleanupHelper({
          frame: failedCleanupControlFrame(fixture),
          observedPath: fixture.path,
          rootDescriptor: fixture.rootDescriptor,
          ledgerDescriptor: fixture.ledgerDescriptor,
        }),
      );
      expectOwnedRootPresent(fixture);
      expect(readFileSync(sentinelFile, "utf8")).toBe("outside\n");
    } finally {
      if (fixture !== undefined) closeRetainedFixture(fixture);
      cleanupOwnedRoots(roots);
    }
  });

  it("refuses swapped failed-cut capabilities and a mismatched ledger digest", async () => {
    const roots: OwnedTestRoot[] = [];
    const fixtures: RetainedLedgerFixture[] = [];
    try {
      const swapped = createRetainedLedgerFixture();
      roots.push(swapped);
      fixtures.push(swapped);
      expectCleanupRefusal(
        await runCleanupHelper({
          frame: failedCleanupControlFrame(swapped),
          observedPath: swapped.path,
          rootDescriptor: swapped.ledgerDescriptor,
          ledgerDescriptor: swapped.rootDescriptor,
        }),
      );
      expectOwnedRootPresent(swapped);

      const wrongDigest = createRetainedLedgerFixture();
      roots.push(wrongDigest);
      fixtures.push(wrongDigest);
      const frame = failedCleanupControlFrame(wrongDigest).replace(
        wrongDigest.ledgerDigest,
        `${wrongDigest.ledgerDigest.slice(0, -1)}${
          wrongDigest.ledgerDigest.endsWith("0") ? "1" : "0"
        }`,
      );
      expectCleanupRefusal(
        await runCleanupHelper({
          frame,
          observedPath: wrongDigest.path,
          rootDescriptor: wrongDigest.rootDescriptor,
          ledgerDescriptor: wrongDigest.ledgerDescriptor,
        }),
      );
      expectOwnedRootPresent(wrongDigest);
    } finally {
      for (const fixture of fixtures) closeRetainedFixture(fixture);
      cleanupOwnedRoots(roots);
    }
  });
});
