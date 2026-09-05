import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  close as closeCallback,
  closeSync,
  constants,
  fchmod as fchmodCallback,
  fstat as fstatCallback,
  fsync as fsyncCallback,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";
import { TextDecoder } from "node:util";

import {
  abortContainedChild,
  containedChildEmpty,
  containedChildReleased,
  containedChildResult,
  containedChildSetupError,
  releaseContainedChild,
  settleContainedChild,
  signalContainedChild,
  spawnContained,
} from "./child-containment.mjs";

const packageRoots = Object.freeze([
  "tools/hosted-migration-preparation-proof",
  "tools/hosted-migration-root-authority",
  "tools/hosted-migration-runtime-proof",
]);

const fixedCompileTimeInputs = new Set([
  "tools/hosted-migration-root-authority/src/grant-ticket-v1.golden.json",
  "tools/hosted-migration-root-authority/src/preparation-policy-v1.golden.json",
  "tools/hosted-migration-root-authority/src/transition-v1.golden.json",
  "tools/hosted-migration-runtime-proof/fixtures/wp199-grant-ticket-v1.golden.json",
]);

const utf8 = new TextDecoder("utf-8", { fatal: true });
const indexRecordPattern = /^(?<mode>[0-9]{6}) (?<object>[0-9a-f]{40}|[0-9a-f]{64}) (?<stage>[0-3])\t(?<path>[^\r\n\0]+)$/u;
const includeMacroNamePattern = /\binclude_(?:bytes|str)\b/gu;
const exactIncludeLiteralPattern =
  /^include_(?:bytes|str)!\(\s*"(?<path>[A-Za-z0-9._+@/-]+)"\s*\)/u;

const fixedSourceObjects = new Map([
  ["tools/hosted-migration-preparation-proof/Cargo.lock", "071a248ec762232d1f4c6cbd12b5f2c200ed9cc5"],
  ["tools/hosted-migration-preparation-proof/Cargo.toml", "ae51db494f8993980de400f147dfdaec4edac04d"],
  ["tools/hosted-migration-preparation-proof/rust-toolchain.toml", "3caff2a7c8054117b0c69401d38fbb47ba2241a2"],
  ["tools/hosted-migration-preparation-proof/src/lib.rs", "c17e470ef9bf45c7f0e9fb92b3972e575667cff9"],
  ["tools/hosted-migration-root-authority/Cargo.lock", "b90437c9cb4fa0096bd043704e73c0089c01ef89"],
  ["tools/hosted-migration-root-authority/Cargo.toml", "b836aa485a81064156cd4ee4801af2f28bbce4f6"],
  ["tools/hosted-migration-root-authority/rust-toolchain.toml", "3caff2a7c8054117b0c69401d38fbb47ba2241a2"],
  ["tools/hosted-migration-root-authority/src/authority_registry.rs", "29aab7a97ba690b1151bf095a4c681d23ba7423f"],
  ["tools/hosted-migration-root-authority/src/authority_registry_tests.rs", "9d44702a9c5cb99e9531ada0113e9901a3c3a191"],
  ["tools/hosted-migration-root-authority/src/canonical.rs", "1e76e4032fda57f1fd295184d49e461eecfa0393"],
  ["tools/hosted-migration-root-authority/src/corruption_tests.rs", "6b12315e7297c9ae57a6b51010e1ba0c410341d1"],
  ["tools/hosted-migration-root-authority/src/cross_version_tests.rs", "f6704a0503f31dc14f2e0e2583ec26612bdad607"],
  ["tools/hosted-migration-root-authority/src/crypto.rs", "225528242e861ddec841f74461edc5c3dce06182"],
  ["tools/hosted-migration-root-authority/src/grant-ticket-v1.golden.json", "b81971ff9ac4f28477b17645682ef9d1e63aab7f"],
  ["tools/hosted-migration-root-authority/src/ipc.rs", "34ba15f85e6ec318081517191f04e5c974b728e9"],
  ["tools/hosted-migration-root-authority/src/journal.rs", "53dde98a770c3b21369478b1f3a175da15f372b4"],
  ["tools/hosted-migration-root-authority/src/journal/storage.rs", "6a531478729fd71afb76572b405176262718a842"],
  ["tools/hosted-migration-root-authority/src/lib.rs", "13992f6b0439374977357692e733bdd3fb6e5962"],
  ["tools/hosted-migration-root-authority/src/mutation_tests.rs", "e0868fa95ce23cfe86a8f4ac64bbbeba9d875deb"],
  ["tools/hosted-migration-root-authority/src/policy_matrix_tests.rs", "a45e448a37f272c812f4ca9c13506b1f7f75ee62"],
  ["tools/hosted-migration-root-authority/src/preparation-policy-v1.golden.json", "88cb0c664d52075ada10e5f42f76bc8cf6394296"],
  ["tools/hosted-migration-root-authority/src/preparation_v2.rs", "9fd8c5aeb7948ce0135d3654b30260dce699d988"],
  ["tools/hosted-migration-root-authority/src/preparation_v2_tests.rs", "3efa8df77cc3f0474cfc0aa88824c1608e037b08"],
  ["tools/hosted-migration-root-authority/src/protocol.rs", "772e0042826f0d83133bc17ce0ba43ad3c391eb5"],
  ["tools/hosted-migration-root-authority/src/records.rs", "1e81b2cf04809f159e99e283e87dbad205cd0656"],
  ["tools/hosted-migration-root-authority/src/state.rs", "91b3a88d6f96eebe46fb92fee942fcf68033dcef"],
  ["tools/hosted-migration-root-authority/src/super_lock.rs", "cfca6c7adae9dd06977c096c189880accef56d6c"],
  ["tools/hosted-migration-root-authority/src/tests.rs", "6be415c9e37987ef8d6af62e22b3fabdc5c8d759"],
  ["tools/hosted-migration-root-authority/src/transition-v1.golden.json", "8d1c53e2370da3a564c9ef24a95a1b443fe6a712"],
  ["tools/hosted-migration-runtime-proof/Cargo.lock", "4ad71a62f833d593e035ca2b5514f283ce7d4611"],
  ["tools/hosted-migration-runtime-proof/Cargo.toml", "50deecb5d06aa0de59e3c4286e811d326b1ce244"],
  ["tools/hosted-migration-runtime-proof/fixtures/wp199-grant-ticket-v1.golden.json", "b81971ff9ac4f28477b17645682ef9d1e63aab7f"],
  ["tools/hosted-migration-runtime-proof/rust-toolchain.toml", "3caff2a7c8054117b0c69401d38fbb47ba2241a2"],
  ["tools/hosted-migration-runtime-proof/src/archive.rs", "5f054336aa77fdee941457dfebff8809290593b8"],
  ["tools/hosted-migration-runtime-proof/src/canonical.rs", "15097b3e3bf09c3fcb54e98c6000dcec89116af5"],
  ["tools/hosted-migration-runtime-proof/src/elf.rs", "a2ce02073396d128dc93f8e66551ad2226bf2c8f"],
  ["tools/hosted-migration-runtime-proof/src/lib.rs", "5e450125a9f5b9bda8ab604ad18d646ca6f1133d"],
  ["tools/hosted-migration-runtime-proof/src/linux_abi.rs", "7aa3b29a8d4b4c75f6bee97697a6aee2485f46b3"],
  ["tools/hosted-migration-runtime-proof/src/linux_kernel_tests.rs", "19b06c4e4e5ec1585c76f3bde3b244008f1ec948"],
  ["tools/hosted-migration-runtime-proof/src/machine.rs", "4e7e6c408f3313a09f8bb8517dc60a1adfb4d408"],
  ["tools/hosted-migration-runtime-proof/src/model_tests.rs", "0205c330cb3baf7bb1dc2ef806e28229d9b46c96"],
  ["tools/hosted-migration-runtime-proof/src/policy.rs", "d5f03c59c9580e960f2805d248aeb23c56975f8c"],
  ["tools/hosted-migration-runtime-proof/src/provenance.rs", "aea0d2b7315579e141a2655e40669dda43947ca0"],
  ["tools/hosted-migration-runtime-proof/src/provenance_tests.rs", "45cc353e2d26e9bc75e7648da04f4eca992334f0"],
  ["tools/hosted-migration-runtime-proof/src/ticket.rs", "8c637c40570282cefd26fba4f84cffec03d2b89f"],
]);

const fixedSourceDirectories = Object.freeze([
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
]);

const SOURCE_REGULAR_FILE_BYTES = 1_283_730;
const workspaceDirectory = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const proofPackageDirectory = resolve(fileURLToPath(new URL("../", import.meta.url)));
const capturedNodeExecutable = process.execPath;
const fixedPathCleanupHelper = resolve(proofPackageDirectory, "scripts/path-cleanup-helper.mjs");
const invocationSourcePattern = /^\/(?:tmp|var\/tmp)\/openspell-wp201-root-proof-[0-9a-f]{64}\/source$/u;
const invocationPrefix = "openspell-wp201-root-proof-";
const invocationRecordPrefix = "openspell.wp201.invocation.v1\n";
const invocationRootPattern = /^\/(?:tmp|var\/tmp)\/openspell-wp201-root-proof-[0-9a-f]{64}$/u;
const sourceLogicalDirectories = new Set(
  fixedSourceDirectories.slice(1).map((path) => path.slice("source/".length)),
);
const completeLedgerMagic = "openspell.wp201.vendor-ledger.v1";
const toolchainAuthorityMagic = "openspell.wp201.toolchain-authority.v1";
const completeLedgerRecords = 4_853;
const maximumLedgerBytes = 16 * 1024 * 1024;
const maximumTreeEntries = 131_072;
const maximumTreeDepth = 64;
const maximumRelativePathBytes = 1_024;
const maximumTotalPathBytes = 16 * 1024 * 1024;
const maximumFileBytes = 256 * 1024 * 1024;
const maximumTotalFileBytes = 2n * 1024n * 1024n * 1024n;
const copyChunkBytes = 1024 * 1024;
const activeCopyNanoseconds = 300_000_000_000n;
const copyCleanupNanoseconds = 15_000_000_000n;
const copyCleanupReserveNanoseconds = 25_000_000_000n;
const cleanupNormalNanoseconds = 4_000_000_000n;
const cleanupTermNanoseconds = 3_000_000_000n;
const cleanupKillNanoseconds = 3_000_000_000n;
const cleanupAbsenceNanoseconds = 5_000_000_000n;
const cleanupCompletionBytes = Buffer.from("openspell.wp201.path-cleanup-complete.v2\n");
const expectedTreeCounts = Object.freeze({
  sourceDirectories: 10,
  sourceFiles: 45,
  vendorDirectories: 941,
  vendorFiles: 3_657,
  vendorBytes: 67_159_121n,
  toolchainDirectories: 28,
  toolchainFiles: 168,
  toolchainBytes: 653_573_520n,
  controlFiles: 4,
});
const expectedToolchainAuthoritySha256 =
  "6078f49e711c3a7059e11a8a7b37f5f49837c792523bd914e0592b42d8f087a4";
const acquisitionController = Object.freeze({
  size: 9_956,
  digest: "72290e827399c5e6eb4c597312a65fbd6402c2d8ad87993c7e336a27f6d48258",
});
const proofController = Object.freeze({
  size: 30_322,
  digest: "914feaa7cece86e66a81a4dd8595d7efc2ae2e7be241d6190aee97c5c213bfcb",
});
const controlLedgerPaths = new Map([
  ["control/proof.sh", "control/proof.sh"],
  ["etc/hostname", "control/hostname"],
  ["etc/hosts", "control/hosts"],
  ["etc/resolv.conf", "control/resolv.conf"],
]);
const exactControlBytes = new Map([
  ["control/hostname", Buffer.from("wp201-proof\n")],
  ["control/hosts", Buffer.from("127.0.0.1 localhost\n::1 localhost\n")],
  ["control/resolv.conf", Buffer.alloc(0)],
  ["docker/config/config.json", Buffer.from("{}")],
]);
const fixedCutPrograms = Object.freeze({
  afterDaemonAcceptBeforeDelivery:
    'import{runAfterDaemonAcceptBeforeDeliveryCut}from"./scripts/interruption-harness.mjs";await runAfterDaemonAcceptBeforeDeliveryCut()',
  afterParentCustodyBeforeStart:
    'import{runAfterParentCustodyBeforeStartCut}from"./scripts/interruption-harness.mjs";await runAfterParentCustodyBeforeStartCut()',
  beforeIssue:
    'import{runBeforeIssueCut}from"./scripts/interruption-harness.mjs";await runBeforeIssueCut()',
});
const fileHandleProbe = await open(
  workspaceDirectory,
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
);
let genuineFileHandleFdGetter;
let fileHandleProbeError;
try {
  genuineFileHandleFdGetter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(fileHandleProbe),
    "fd",
  )?.get;
  if (genuineFileHandleFdGetter === undefined) {
    throw new Error("FileHandle fd getter unavailable");
  }
} catch (error) {
  fileHandleProbeError = error;
}
try {
  await fileHandleProbe.close();
} catch (error) {
  throw combinedFailure(
    fileHandleProbeError ?? new Error("FileHandle probe close failed"),
    [error],
    "FileHandle probe settlement failed",
  );
}
if (fileHandleProbeError !== undefined) throw fileHandleProbeError;

export const SOURCE_ROOTS = packageRoots;
export const SOURCE_FILE_COUNT = fixedSourceObjects.size;
export const SOURCE_DIRECTORY_COUNT = fixedSourceDirectories.length;
export const SOURCE_FILE_BYTES = SOURCE_REGULAR_FILE_BYTES;

function acceptedSourcePath(path) {
  for (const root of packageRoots) {
    if (["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"].some(
      (name) => path === `${root}/${name}`,
    )) {
      return true;
    }
    if (path.startsWith(`${root}/src/`) && path.endsWith(".rs")) return true;
  }
  return fixedCompileTimeInputs.has(path);
}

function parseIndexInventory(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error("git index bytes required");
  if (bytes.length === 0 || bytes.at(-1) !== 0) throw new Error("unterminated git index inventory");
  const records = [];
  const tracked = new Set();
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index === start) throw new Error("empty git index record");
    const record = utf8.decode(bytes.subarray(start, index));
    start = index + 1;
    const match = indexRecordPattern.exec(record);
    if (match?.groups === undefined) throw new Error("malformed git index record");
    const { mode, object, stage, path } = match.groups;
    if (
      mode === undefined ||
      object === undefined ||
      stage === undefined ||
      path === undefined
    ) {
      throw new Error("malformed git index fields");
    }
    if (stage !== "0") throw new Error("non-stage-zero source input");
    if (tracked.has(path)) throw new Error("duplicate source input");
    tracked.add(path);
    if (mode !== "100644") throw new Error("source input mode is not 100644");
    if (!acceptedSourcePath(path)) continue;
    const expectedObject = fixedSourceObjects.get(path);
    if (expectedObject === undefined) throw new Error("extra source input");
    if (object !== expectedObject) throw new Error("source input object mismatch");
    records.push(Object.freeze({ object, path }));
  }
  records.sort((left, right) => compareBytes(left.path, right.path));
  requireExactSourceRecords(records);
  return Object.freeze({ records: Object.freeze(records), tracked });
}

function compareBytes(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

function requireExactSourceRecords(records) {
  if (!Array.isArray(records) || records.length !== SOURCE_FILE_COUNT) {
    throw new Error("source input count mismatch");
  }
  const seen = new Set();
  for (const record of records) {
    if (
      record === null ||
      typeof record !== "object" ||
      typeof record.path !== "string" ||
      typeof record.object !== "string" ||
      seen.has(record.path) ||
      fixedSourceObjects.get(record.path) !== record.object
    ) {
      throw new Error("source input identity mismatch");
    }
    seen.add(record.path);
  }
  for (const path of fixedSourceObjects.keys()) {
    if (!seen.has(path)) throw new Error("missing fixed source input");
  }
}

function gitBlobObjectId(bytes, hexadecimalLength) {
  const algorithm = hexadecimalLength === 40 ? "sha1" : "sha256";
  const header = Buffer.from(`blob ${bytes.length}\0`, "ascii");
  return createHash(algorithm).update(header).update(bytes).digest("hex");
}

function exactSourceBytes(records, sourceBytesByPath) {
  requireExactSourceRecords(records);
  if (!(sourceBytesByPath instanceof Map) || sourceBytesByPath.size !== records.length) {
    throw new Error("source byte inventory mismatch");
  }
  for (const path of sourceBytesByPath.keys()) {
    if (!fixedSourceObjects.has(path)) throw new Error("extra source bytes");
  }

  const exact = new Map();
  let totalBytes = 0;
  for (const { object, path } of records) {
    const supplied = sourceBytesByPath.get(path);
    if (!(supplied instanceof Uint8Array)) throw new Error("missing source bytes");
    const bytes = Buffer.from(supplied);
    if (gitBlobObjectId(bytes, object.length) !== object) {
      throw new Error("source bytes do not match indexed object");
    }
    totalBytes += bytes.length;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > SOURCE_REGULAR_FILE_BYTES) {
      throw new Error("source byte count mismatch");
    }
    exact.set(path, bytes);
  }
  if (totalBytes !== SOURCE_REGULAR_FILE_BYTES) {
    throw new Error("source byte count mismatch");
  }
  return exact;
}

export function parseSourceIndex(bytes) {
  return parseIndexInventory(bytes).records;
}

export function assertCompileTimeInputs(records, sourceBytesByPath) {
  const selected = new Set(records.map(({ path }) => path));
  const referenced = new Set();
  for (const { path } of records) {
    if (!path.endsWith(".rs")) continue;
    const bytes = sourceBytesByPath.get(path);
    if (!(bytes instanceof Uint8Array)) throw new Error("missing source bytes");
    const source = utf8.decode(bytes);
    const sourceDirectory = path.slice(0, path.lastIndexOf("/"));
    for (const macro of source.matchAll(includeMacroNamePattern)) {
      const offset = macro.index;
      if (offset === undefined) throw new Error("invalid compile-time include position");
      const match = exactIncludeLiteralPattern.exec(source.slice(offset));
      if (match?.groups === undefined) {
        throw new Error("unsupported compile-time include form");
      }
      const relative = match.groups.path;
      if (relative === undefined || relative.startsWith("/") || relative.includes("//")) {
        throw new Error("invalid compile-time include literal");
      }
      const components = [...sourceDirectory.split("/"), ...relative.split("/")];
      const normalized = [];
      for (const component of components) {
        if (component === ".") continue;
        if (component === "..") {
          if (normalized.length === 0) throw new Error("compile-time include escapes package");
          normalized.pop();
        } else {
          normalized.push(component);
        }
      }
      const target = normalized.join("/");
      if (!selected.has(target)) throw new Error("untracked compile-time include input");
      referenced.add(target);
    }
  }
  for (const path of fixedCompileTimeInputs) {
    if (!selected.has(path)) throw new Error("missing fixed compile-time input");
  }
  return Object.freeze([...referenced].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))));
}

function sourceDirectoryRows(records) {
  const directories = new Set(["source"]);
  for (const { path } of records) {
    let slash = path.lastIndexOf("/");
    while (slash !== -1) {
      directories.add(`source/${path.slice(0, slash)}`);
      slash = path.lastIndexOf("/", slash - 1);
    }
  }
  const ordered = [...directories].sort(compareBytes);
  if (
    ordered.length !== fixedSourceDirectories.length ||
    ordered.some((path, index) => path !== fixedSourceDirectories[index])
  ) {
    throw new Error("source directory inventory mismatch");
  }
  return ordered.map((path) => `D\t0555\t${path}\n`);
}

export function buildSourceLedgerRows(records, sourceBytesByPath) {
  const exactBytes = exactSourceBytes(records, sourceBytesByPath);
  assertCompileTimeInputs(records, exactBytes);
  const rows = sourceDirectoryRows(records);
  for (const { path } of records) {
    const bytes = exactBytes.get(path);
    if (bytes === undefined) throw new Error("source byte identity lost");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    rows.push(`S\t0444\t${bytes.length}\t${sha256}\t${path}\n`);
  }
  rows.sort((left, right) => {
    const leftKey = left.slice(0, left.indexOf("\n"));
    const rightKey = right.slice(0, right.indexOf("\n"));
    const leftPath = leftKey.slice(leftKey.lastIndexOf("\t") + 1);
    const rightPath = rightKey.slice(rightKey.lastIndexOf("\t") + 1);
    return compareBytes(`${left[0]}\t${leftPath}`, `${right[0]}\t${rightPath}`);
  });
  const ledgerRows = rows.join("");
  return Object.freeze({
    files: SOURCE_FILE_COUNT,
    directories: SOURCE_DIRECTORY_COUNT,
    regularFileBytes: SOURCE_REGULAR_FILE_BYTES,
    records: SOURCE_FILE_COUNT + SOURCE_DIRECTORY_COUNT,
    ledgerRows,
  });
}

export function verifySourceLedgerRows(records, sourceBytesByPath, candidateBytes) {
  if (!(candidateBytes instanceof Uint8Array)) {
    throw new Error("source ledger bytes required");
  }
  const expected = buildSourceLedgerRows(records, sourceBytesByPath);
  if (!Buffer.from(candidateBytes).equals(Buffer.from(expected.ledgerRows, "utf8"))) {
    throw new Error("source ledger byte mismatch");
  }
  return expected;
}

function numericMode(status) {
  return Number(status.mode & 0o7777n);
}

function sameNode(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.rdev === right.rdev &&
    left.nlink === right.nlink
  );
}

function sameDirectoryNode(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.rdev === right.rdev &&
    left.isDirectory() &&
    right.isDirectory()
  );
}

function sameSnapshot(left, right) {
  return (
    sameNode(left, right) &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertWorkspaceDirectory(status, device, label) {
  if (!status.isDirectory() || status.dev !== device) {
    throw new Error(`${label} directory identity mismatch`);
  }
}

function assertInvocationDirectory(status, device, expectedMode, label) {
  if (
    !status.isDirectory() ||
    status.uid !== BigInt(process.getuid()) ||
    status.gid !== BigInt(process.getgid()) ||
    status.dev !== device ||
    (expectedMode === undefined
      ? (numericMode(status) & 0o700) !== 0o700 || (numericMode(status) & 0o7022) !== 0
      : numericMode(status) !== expectedMode)
  ) {
    throw new Error(`${label} directory identity mismatch`);
  }
}

function assertWorkspaceRegular(status, device, label) {
  if (
    !status.isFile() ||
    status.dev !== device ||
    status.nlink !== 1n
  ) {
    throw new Error(`${label} regular-file identity mismatch`);
  }
}

function assertStagedRegular(status, device, label) {
  if (
    !status.isFile() ||
    status.uid !== BigInt(process.getuid()) ||
    status.gid !== BigInt(process.getgid()) ||
    status.dev !== device ||
    status.nlink !== 1n ||
    numericMode(status) !== 0o444
  ) {
    throw new Error(`${label} regular-file identity mismatch`);
  }
}

function fstatDescriptor(fd) {
  return new Promise((resolvePromise, rejectPromise) => {
    fstatCallback(fd, { bigint: true }, (error, status) => {
      if (error) rejectPromise(error);
      else resolvePromise(status);
    });
  });
}

function fchmodDescriptor(fd, mode) {
  return new Promise((resolvePromise, rejectPromise) => {
    fchmodCallback(fd, mode, (error) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    });
  });
}

function fsyncDescriptor(fd) {
  return new Promise((resolvePromise, rejectPromise) => {
    fsyncCallback(fd, (error) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    });
  });
}

function closeDescriptor(fd) {
  return new Promise((resolvePromise, rejectPromise) => {
    closeCallback(fd, (error) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    });
  });
}

function combinedFailure(operationError, settlementErrors, message) {
  if (settlementErrors.length === 0) return operationError;
  return new AggregateError([operationError, ...settlementErrors], message);
}

async function closeHandles(handles) {
  const errors = [];
  for (const handle of [...handles].reverse()) {
    try {
      await handle.close();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function requireClose(handles, operationError, message) {
  const settlementErrors = await closeHandles(handles);
  if (operationError !== undefined) {
    throw combinedFailure(operationError, settlementErrors, message);
  }
  if (settlementErrors.length > 0) {
    throw new AggregateError(settlementErrors, message);
  }
}

function decodeMountPath(path) {
  if (!path.startsWith("/") || /\\(?![0-7]{3})/u.test(path)) {
    throw new Error("malformed mount path");
  }
  const decoded = path.replace(/\\(?<octal>[0-7]{3})/gu, (_match, octal) =>
    String.fromCodePoint(Number.parseInt(octal, 8)),
  );
  return decoded;
}

function isAtOrBelow(candidate, root) {
  const offset = relative(root, candidate);
  return offset === "" || (!offset.startsWith(`..${sep}`) && offset !== "..");
}

export function parseMountInfo(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error("mountinfo bytes required");
  const mountInfo = utf8.decode(bytes);
  if (!mountInfo.endsWith("\n")) throw new Error("unterminated mount inventory");
  const entries = [];
  const mountIds = new Set();
  for (const line of mountInfo.slice(0, -1).split("\n")) {
    if (line.length === 0) continue;
    const separator = line.indexOf(" - ");
    if (separator === -1 || line.indexOf(" - ", separator + 3) !== -1) {
      throw new Error("malformed mount inventory");
    }
    const fields = line.slice(0, separator).split(" ");
    const trailing = line.slice(separator + 3).split(" ");
    const mountId = fields[0];
    const parentId = fields[1];
    const device = fields[2];
    const encodedRoot = fields[3];
    const encodedMountPath = fields[4];
    if (
      fields.length < 6 ||
      trailing.length < 3 ||
      mountId === undefined ||
      parentId === undefined ||
      device === undefined ||
      encodedRoot === undefined ||
      encodedRoot.length === 0 ||
      encodedMountPath === undefined ||
      !/^[1-9][0-9]*$/u.test(mountId) ||
      !/^(?:0|[1-9][0-9]*)$/u.test(parentId) ||
      !/^(?:0|[1-9][0-9]*):(?:0|[1-9][0-9]*)$/u.test(device) ||
      mountIds.has(mountId)
    ) {
      throw new Error("malformed mount inventory");
    }
    mountIds.add(mountId);
    const mountPath = decodeMountPath(encodedMountPath);
    entries.push(Object.freeze({
      mountId,
      mountPath,
      root: encodedRoot,
    }));
  }
  if (entries.length === 0) throw new Error("empty mount inventory");
  return Object.freeze(entries);
}

function mountForPath(entries, path) {
  const matches = entries
    .filter(({ mountPath }) => isAtOrBelow(path, mountPath))
    .sort((left, right) => right.mountPath.length - left.mountPath.length);
  const match = matches[0];
  if (match === undefined) throw new Error("path absent from mount inventory");
  return match;
}

export function assertNoFixedWorkspaceMountpoints(bytes) {
  const entries = parseMountInfo(bytes);
  if (entries.some(({ mountPath }) => isAtOrBelow(mountPath, workspaceDirectory))) {
    throw new Error("mountpoint in fixed workspace ancestry");
  }
  return entries;
}

function descriptorMountIdFromBytes(bytes) {
  const text = utf8.decode(bytes);
  const matches = [...text.matchAll(/^mnt_id:\s+(?<mountId>[1-9][0-9]*)$/gmu)];
  const mountId = matches[0]?.groups?.mountId;
  if (matches.length !== 1 || mountId === undefined) {
    throw new Error("descriptor mount identity missing");
  }
  return mountId;
}

function descriptorFlagsFromBytes(bytes) {
  const text = utf8.decode(bytes);
  const matches = [...text.matchAll(/^flags:\s+(?<flags>0[0-7]+)$/gmu)];
  const flags = matches[0]?.groups?.flags;
  if (matches.length !== 1 || flags === undefined) {
    throw new Error("descriptor flags missing");
  }
  return flags;
}

async function descriptorMountId(descriptor) {
  return descriptorMountIdFromBytes(await readFile(`/proc/self/fdinfo/${descriptor}`));
}

function validateMountBindings(entries, mountInventory) {
  const knownIds = new Set(mountInventory.map(({ mountId }) => mountId));
  for (const entry of entries) {
    if (
      !knownIds.has(entry.mountId) ||
      mountForPath(mountInventory, entry.path).mountId !== entry.mountId
    ) {
      throw new Error("workspace mount identity mismatch");
    }
  }
}

async function assertNoNestedMounts(roots) {
  const bytes = await readFile("/proc/self/mountinfo");
  const mountInfo = assertNoFixedWorkspaceMountpoints(bytes);
  for (const { mountPath } of mountInfo) {
    if (roots.some((root) => isAtOrBelow(mountPath, root))) {
      throw new Error("nested mount in source or destination");
    }
  }
  return mountInfo;
}

async function readStableRegular(path, device, expectedObject, staged = false) {
  const before = await lstat(path, { bigint: true });
  if (staged) assertStagedRegular(before, device, "staged source");
  else assertWorkspaceRegular(before, device, "source");
  if (before.size > 256n * 1024n * 1024n) throw new Error("source file size exceeds bound");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameSnapshot(before, opened)) throw new Error("source identity changed across open");
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error("source identity changed during read");
      offset += bytesRead;
    }
    const trailing = Buffer.alloc(1);
    if ((await handle.read(trailing, 0, 1, bytes.length)).bytesRead !== 0) {
      throw new Error("source identity changed during read");
    }
    const afterRead = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    if (!sameSnapshot(opened, afterRead) || !sameSnapshot(opened, afterPath)) {
      throw new Error("source identity changed during read");
    }
    if (gitBlobObjectId(bytes, expectedObject.length) !== expectedObject) {
      throw new Error("source bytes do not match indexed object");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function trackedDirectories(tracked) {
  const directories = new Set();
  for (const path of tracked) {
    let slash = path.lastIndexOf("/");
    while (slash !== -1) {
      directories.add(path.slice(0, slash));
      slash = path.lastIndexOf("/", slash - 1);
    }
  }
  return directories;
}

function fixedBoundDirectoryPaths() {
  const paths = new Set(["/"]);
  const addWithAncestors = (path) => {
    let cursor = resolve(path);
    while (cursor !== "/") {
      paths.add(cursor);
      cursor = dirname(cursor);
    }
  };
  addWithAncestors(workspaceDirectory);
  for (const root of packageRoots) addWithAncestors(join(workspaceDirectory, root));
  return [...paths].sort((left, right) => {
    const depth = (path) => path.split("/").filter(Boolean).length;
    return depth(left) - depth(right) || compareBytes(left, right);
  });
}

async function bindWorkspaceDirectories() {
  const entries = [];
  const byPath = new Map();
  let workspaceDevice;
  try {
    for (const path of fixedBoundDirectoryPaths()) {
      const parentPath = dirname(path);
      const parent = path === "/" ? undefined : byPath.get(parentPath);
      if (path !== "/" && parent === undefined) {
        throw new Error("workspace directory ancestry is incomplete");
      }
      const openPath = path === "/"
        ? "/"
        : `/proc/self/fd/${parent.handle.fd}/${path.slice(parentPath === "/" ? 1 : parentPath.length + 1)}`;
      const handle = await open(
        openPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        const opened = await handle.stat({ bigint: true });
        const reached = await lstat(path, { bigint: true });
        if (!sameDirectoryNode(opened, reached) || (await realpath(path)) !== path) {
          throw new Error("workspace directory ancestry identity mismatch");
        }
        if (path === workspaceDirectory) workspaceDevice = opened.dev;
        if (
          workspaceDevice !== undefined &&
          isAtOrBelow(path, workspaceDirectory) &&
          opened.dev !== workspaceDevice
        ) {
          throw new Error("workspace directory device mismatch");
        }
        const mountId = await descriptorMountId(handle.fd);
        const entry = Object.freeze({ handle, identity: opened, mountId, path });
        entries.push(entry);
        byPath.set(path, entry);
      } catch (error) {
        await requireClose([handle], error, "workspace directory close failed");
      }
    }
    if (workspaceDevice === undefined) throw new Error("workspace directory was not bound");
    return Object.freeze({ entries, workspaceDevice });
  } catch (error) {
    await requireClose(entries.map(({ handle }) => handle), error, "workspace binding settlement failed");
  }
}

async function settleWorkspaceDirectories(binding) {
  const errors = [];
  let mountInventory;
  try {
    mountInventory = assertNoFixedWorkspaceMountpoints(await readFile("/proc/self/mountinfo"));
    validateMountBindings(binding.entries, mountInventory);
  } catch (error) {
    errors.push(error);
  }
  for (const { handle, identity, mountId, path } of [...binding.entries].reverse()) {
    try {
      const opened = await handle.stat({ bigint: true });
      const reached = await lstat(path, { bigint: true });
      if (!sameDirectoryNode(identity, opened) || !sameDirectoryNode(identity, reached)) {
        throw new Error("workspace directory identity changed");
      }
      if (await descriptorMountId(handle.fd) !== mountId) {
        throw new Error("workspace descriptor mount identity changed");
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      await handle.close();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function inspectTrackedTree(path, logicalPath, tracked, directories, device) {
  const before = await lstat(path, { bigint: true });
  assertWorkspaceDirectory(before, device, "source");
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const childLogical = `${logicalPath}/${entry.name}`;
    const childPath = join(path, entry.name);
    const status = await lstat(childPath, { bigint: true });
    if (status.isDirectory()) {
      if (!directories.has(childLogical)) throw new Error("untracked source directory");
      await inspectTrackedTree(childPath, childLogical, tracked, directories, device);
    } else if (status.isFile()) {
      if (!tracked.has(childLogical)) throw new Error("untracked source file");
      assertWorkspaceRegular(status, device, "tracked source");
    } else {
      throw new Error("link or special source entry");
    }
  }
  const after = await lstat(path, { bigint: true });
  if (!sameSnapshot(before, after)) throw new Error("source directory identity changed");
}

async function collectFixedSourceBytes(indexBytes) {
  const { records, tracked } = parseIndexInventory(indexBytes);
  const binding = await bindWorkspaceDirectories();
  try {
    const packagePaths = packageRoots.map((path) => join(workspaceDirectory, path));
    const mountInventory = await assertNoNestedMounts(packagePaths);
    validateMountBindings(binding.entries, mountInventory);

    const directories = trackedDirectories(tracked);
    for (const root of packageRoots) {
      for (const name of ["src", "fixtures"]) {
        const logicalPath = `${root}/${name}`;
        try {
          const status = await lstat(join(workspaceDirectory, logicalPath), { bigint: true });
          if (!status.isDirectory()) throw new Error("source scan root is not a directory");
          if (!directories.has(logicalPath)) throw new Error("untracked source directory");
          await inspectTrackedTree(
            join(workspaceDirectory, logicalPath),
            logicalPath,
            tracked,
            directories,
            binding.workspaceDevice,
          );
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
    }

    const sourceBytes = new Map();
    for (const { object, path } of records) {
      sourceBytes.set(
        path,
        await readStableRegular(join(workspaceDirectory, path), binding.workspaceDevice, object),
      );
    }
    exactSourceBytes(records, sourceBytes);
    assertCompileTimeInputs(records, sourceBytes);
    return Object.freeze({ binding, records, sourceBytes });
  } catch (error) {
    const settlementErrors = await settleWorkspaceDirectories(binding);
    throw combinedFailure(error, settlementErrors, "source workspace settlement failed");
  }
}

async function assertDescriptorCloseOnExec(descriptor) {
  const descriptorInfo = await readFile(`/proc/self/fdinfo/${descriptor}`, "ascii");
  const flags = /^flags:\s+(?<flags>[0-7]+)$/mu.exec(descriptorInfo)?.groups?.flags;
  if (flags === undefined || (BigInt(`0o${flags}`) & 0o2000000n) === 0n) {
    throw new Error("source destination descriptor lacks close-on-exec");
  }
}

async function authenticateInvocationRecord(invocationPath, invocationValue, device) {
  const recordPath = join(invocationPath, "INVOCATION");
  const expected = Buffer.from(`${invocationRecordPrefix}${invocationValue}\n`, "ascii");
  const before = await lstat(recordPath, { bigint: true });
  if (
    !before.isFile() ||
    before.uid !== BigInt(process.getuid()) ||
    before.gid !== BigInt(process.getgid()) ||
    before.dev !== device ||
    before.nlink !== 1n ||
    numericMode(before) !== 0o600 ||
    before.size !== BigInt(expected.length)
  ) {
    throw new Error("invocation record identity mismatch");
  }
  const handle = await open(recordPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let operationError;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameSnapshot(before, opened)) throw new Error("invocation record identity changed");
    const actual = Buffer.alloc(expected.length);
    let offset = 0;
    while (offset < actual.length) {
      const { bytesRead } = await handle.read(actual, offset, actual.length - offset, offset);
      if (bytesRead === 0) throw new Error("invocation record truncated");
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, actual.length)).bytesRead !== 0) {
      throw new Error("invocation record trailing bytes");
    }
    if (!actual.equals(expected)) throw new Error("invocation record byte mismatch");
    await fsyncDescriptor(handle.fd);
    const settled = await handle.stat({ bigint: true });
    const reached = await lstat(recordPath, { bigint: true });
    if (!sameSnapshot(opened, settled) || !sameSnapshot(opened, reached)) {
      throw new Error("invocation record identity changed");
    }
  } catch (error) {
    operationError = error;
  }
  await requireClose([handle], operationError, "invocation record close failed");
}

async function syncInvocationDirectory(invocationPath, expectedIdentity) {
  const handle = await open(
    invocationPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let operationError;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameDirectoryNode(expectedIdentity, opened)) {
      throw new Error("invocation directory identity changed");
    }
    await fsyncDescriptor(handle.fd);
    const settled = await handle.stat({ bigint: true });
    const reached = await lstat(invocationPath, { bigint: true });
    if (
      !sameDirectoryNode(expectedIdentity, settled) ||
      !sameDirectoryNode(expectedIdentity, reached)
    ) {
      throw new Error("invocation directory identity changed");
    }
  } catch (error) {
    operationError = error;
  }
  await requireClose([handle], operationError, "invocation directory close failed");
}

function claimDestinationHandle(sourceDirectory) {
  if (sourceDirectory === null || typeof sourceDirectory !== "object") {
    throw new Error("open source destination directory required");
  }
  let suppliedDescriptor;
  try {
    suppliedDescriptor = Reflect.apply(genuineFileHandleFdGetter, sourceDirectory, []);
    if (!Number.isInteger(suppliedDescriptor) || suppliedDescriptor < 0) {
      throw new Error("actual FileHandle source destination required");
    }
  } catch {
    throw new Error("actual FileHandle source destination required");
  }
  const suppliedDescriptorPath = `/proc/self/fd/${suppliedDescriptor}`;
  let descriptor;
  try {
    const destinationPath = realpathSync(suppliedDescriptorPath);
    const suppliedIdentity = fstatSync(suppliedDescriptor, { bigint: true });
    descriptor = openSync(
      suppliedDescriptorPath,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    const descriptorPath = `/proc/self/fd/${descriptor}`;
    const ownedIdentity = fstatSync(descriptor, { bigint: true });
    const ownedPath = realpathSync(descriptorPath);
    if (
      destinationPath !== ownedPath ||
      !sameSnapshot(suppliedIdentity, ownedIdentity)
    ) {
      throw new Error("source destination synchronous reopen identity mismatch");
    }
    return Object.freeze({
      descriptor,
      descriptorPath,
      destinationPath,
      identity: ownedIdentity,
      mountId: descriptorMountIdFromBytes(readFileSync(`/proc/self/fdinfo/${descriptor}`)),
    });
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "source destination synchronous reopen settlement failed",
          { cause: closeError },
        );
      }
    }
    throw error;
  }
}

async function validateDestinationClaim(claim) {
  const { descriptor, descriptorPath, destinationPath } = claim;
  await assertDescriptorCloseOnExec(descriptor);
  if (!invocationSourcePattern.test(destinationPath)) {
    throw new Error("source destination path mismatch");
  }
  const invocationPath = dirname(destinationPath);
  const invocationName = invocationPath.slice(invocationPath.lastIndexOf("/") + 1);
  const invocationValue = invocationName.slice(invocationPrefix.length);
  const temporaryParent = dirname(invocationPath);
  if (!["/tmp", "/var/tmp"].includes(temporaryParent)) {
    throw new Error("source destination parent mismatch");
  }
  if ((await realpath(temporaryParent)) !== temporaryParent) {
    throw new Error("source destination parent identity mismatch");
  }
  const parentStatus = await lstat(temporaryParent, { bigint: true });
  if (
    !parentStatus.isDirectory() ||
    parentStatus.uid !== 0n ||
    parentStatus.gid !== 0n ||
    numericMode(parentStatus) !== 0o1777
  ) {
    throw new Error("source destination parent identity mismatch");
  }
  const invocationStatus = await lstat(invocationPath, { bigint: true });
  assertInvocationDirectory(invocationStatus, parentStatus.dev, 0o700, "invocation");
  const descriptorStatus = await fstatDescriptor(descriptor);
  const pathStatus = await lstat(destinationPath, { bigint: true });
  assertInvocationDirectory(descriptorStatus, parentStatus.dev, 0o700, "source destination");
  if (!sameSnapshot(descriptorStatus, pathStatus)) {
    throw new Error("source destination descriptor identity mismatch");
  }
  await authenticateInvocationRecord(invocationPath, invocationValue, parentStatus.dev);
  await syncInvocationDirectory(invocationPath, invocationStatus);
  const reachedStatus = await lstat(destinationPath, { bigint: true });
  if (
    !sameSnapshot(claim.identity, descriptorStatus) ||
    !sameSnapshot(claim.identity, reachedStatus)
  ) {
    throw new Error("source destination reopened identity mismatch");
  }
  if ((await readdir(descriptorPath)).length !== 0) {
    throw new Error("source destination is not empty");
  }
  if (await descriptorMountId(descriptor) !== claim.mountId) {
    throw new Error("source destination mount identity changed");
  }
  const mountInventory = parseMountInfo(await readFile("/proc/self/mountinfo"));
  if (
    mountForPath(mountInventory, destinationPath).mountId !== claim.mountId ||
    mountInventory.some(({ mountPath }) => isAtOrBelow(mountPath, destinationPath))
  ) {
    throw new Error("source destination mount boundary mismatch");
  }
  return Object.freeze({
    ...claim,
    device: parentStatus.dev,
  });
}

async function settleDestinationHandle(destination) {
  const errors = [];
  try {
    const opened = await fstatDescriptor(destination.descriptor);
    const reached = await lstat(destination.destinationPath, { bigint: true });
    if (
      !sameDirectoryNode(destination.identity, opened) ||
      !sameDirectoryNode(destination.identity, reached)
    ) {
      throw new Error("source destination identity changed before close");
    }
    const mountInventory = parseMountInfo(await readFile("/proc/self/mountinfo"));
    if (
      await descriptorMountId(destination.descriptor) !== destination.mountId ||
      mountForPath(mountInventory, destination.destinationPath).mountId !== destination.mountId
    ) {
      throw new Error("source destination mount identity changed before close");
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    await closeDescriptor(destination.descriptor);
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

async function writeExactFile(path, bytes, device) {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const created = await handle.stat({ bigint: true });
    if (
      !created.isFile() ||
      created.uid !== BigInt(process.getuid()) ||
      created.gid !== BigInt(process.getgid()) ||
      created.dev !== device ||
      created.nlink !== 1n ||
      numericMode(created) !== 0o600 ||
      created.size !== 0n
    ) {
      throw new Error("destination file creation identity mismatch");
    }
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (bytesWritten === 0) throw new Error("destination write made no progress");
      offset += bytesWritten;
    }
    await handle.chmod(0o444);
    await handle.sync();
    const settled = await handle.stat({ bigint: true });
    if (!sameNode(created, settled) || numericMode(settled) !== 0o444 || settled.size !== BigInt(bytes.length)) {
      throw new Error("destination file identity mismatch");
    }
    return settled;
  } finally {
    await handle.close();
  }
}

async function proveDestination(
  descriptorPath,
  destinationPath,
  descriptor,
  device,
  expectedBytes,
  identities,
) {
  const observedDirectories = new Set(["source"]);
  const observedFiles = new Set();
  const visit = async (directoryPath, logicalDirectory) => {
    const isRoot = logicalDirectory === "source";
    const before = isRoot
      ? await fstatDescriptor(descriptor)
      : await lstat(directoryPath, { bigint: true });
    assertInvocationDirectory(before, device, 0o555, "staged source");
    for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
      const childLogical = `${logicalDirectory}/${entry.name}`;
      const childPath = join(directoryPath, entry.name);
      const status = await lstat(childPath, { bigint: true });
      if (status.isDirectory()) {
        observedDirectories.add(childLogical);
        await visit(childPath, childLogical);
      } else if (status.isFile()) {
        const sourcePath = childLogical.slice("source/".length);
        const expected = expectedBytes.get(sourcePath);
        const identity = identities.get(sourcePath);
        if (expected === undefined || identity === undefined) throw new Error("extra staged source file");
        if (!sameSnapshot(status, identity) || numericMode(status) !== 0o444) {
          throw new Error("staged source file identity mismatch");
        }
        const bytes = await readStableRegular(
          childPath,
          device,
          fixedSourceObjects.get(sourcePath),
          true,
        );
        if (!bytes.equals(expected)) throw new Error("staged source bytes mismatch");
        observedFiles.add(sourcePath);
      } else {
        throw new Error("link or special staged source entry");
      }
    }
    const after = isRoot
      ? await fstatDescriptor(descriptor)
      : await lstat(directoryPath, { bigint: true });
    if (!sameSnapshot(before, after)) throw new Error("staged source directory identity changed");
    if (isRoot && !sameSnapshot(after, await lstat(destinationPath, { bigint: true }))) {
      throw new Error("staged source descriptor identity mismatch");
    }
  };
  await visit(descriptorPath, "source");
  if (
    observedFiles.size !== SOURCE_FILE_COUNT ||
    [...fixedSourceObjects.keys()].some((path) => !observedFiles.has(path)) ||
    observedDirectories.size !== SOURCE_DIRECTORY_COUNT ||
    [...sourceLogicalDirectories].some((path) => !observedDirectories.has(`source/${path}`))
  ) {
    throw new Error("staged source inventory mismatch");
  }
}

export async function stageFixedSourceSnapshot({ indexBytes, sourceDirectory } = {}) {
  let destination = claimDestinationHandle(sourceDirectory);
  let source;
  const directoryHandles = [];
  const identities = new Map();
  let result;
  let operationError;
  try {
    await Promise.resolve();
    destination = await validateDestinationClaim(destination);
    source = await collectFixedSourceBytes(indexBytes);
    await assertNoNestedMounts([destination.destinationPath]);
    for (const logicalDirectory of fixedSourceDirectories.slice(1)) {
      const relativePath = logicalDirectory.slice("source/".length);
      const path = join(destination.descriptorPath, relativePath);
      await mkdir(path, { mode: 0o700 });
      const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      directoryHandles.push(Object.freeze({ handle, logicalDirectory }));
      const status = await handle.stat({ bigint: true });
      assertInvocationDirectory(status, destination.device, 0o700, "created source");
      if (!sameSnapshot(status, await lstat(path, { bigint: true }))) {
        throw new Error("created source directory identity mismatch");
      }
    }
    for (const { path } of source.records) {
      const bytes = source.sourceBytes.get(path);
      if (bytes === undefined) throw new Error("source bytes disappeared before staging");
      identities.set(
        path,
        await writeExactFile(join(destination.descriptorPath, path), bytes, destination.device),
      );
    }
    for (const { handle } of [...directoryHandles].reverse()) {
      await handle.chmod(0o555);
      await handle.sync();
    }
    await fchmodDescriptor(destination.descriptor, 0o555);
    await fsyncDescriptor(destination.descriptor);
    await proveDestination(
      destination.descriptorPath,
      destination.destinationPath,
      destination.descriptor,
      destination.device,
      source.sourceBytes,
      identities,
    );
    result = buildSourceLedgerRows(source.records, source.sourceBytes);
  } catch (error) {
    operationError = error;
  }
  const settlementErrors = await closeHandles(directoryHandles.map(({ handle }) => handle));
  if (source !== undefined) {
    settlementErrors.push(...await settleWorkspaceDirectories(source.binding));
  }
  if (destination !== undefined) {
    settlementErrors.push(...await settleDestinationHandle(destination));
  }
  if (operationError !== undefined) {
    throw combinedFailure(operationError, settlementErrors, "source staging settlement failed");
  }
  if (settlementErrors.length > 0) {
    throw new AggregateError(settlementErrors, "source staging settlement failed");
  }
  if (result === undefined) throw new Error("source staging result missing");
  return result;
}

const freshRootCopyBudgets = new WeakSet();
const freshRootTokens = new WeakMap();
const freshRootHandoffFailures = new WeakMap();

export function createFreshRootCopyBudget(startNanoseconds) {
  if (typeof startNanoseconds !== "bigint" || startNanoseconds < 0n) {
    throw new Error("invalid fresh-root CLOCK_BOOTTIME sample");
  }
  const budget = Object.freeze({
    startNanoseconds,
    lastNanoseconds: startNanoseconds,
    activeDeadlineNanoseconds: startNanoseconds + activeCopyNanoseconds,
    cleanupDeadlineNanoseconds:
      startNanoseconds + activeCopyNanoseconds + copyCleanupNanoseconds,
    hardDeadlineNanoseconds:
      startNanoseconds + activeCopyNanoseconds + copyCleanupReserveNanoseconds,
    cleanupState: "uncreated",
    phase: "active",
  });
  freshRootCopyBudgets.add(budget);
  return budget;
}

export function advanceFreshRootCopyBudget(budget, transition, sampleNanoseconds) {
  if (!freshRootCopyBudgets.has(budget)) throw new Error("unbranded fresh-root copy budget");
  if (typeof sampleNanoseconds !== "bigint" || sampleNanoseconds < budget.lastNanoseconds) {
    throw new Error("fresh-root CLOCK_BOOTTIME regressed");
  }
  if (sampleNanoseconds >= budget.hardDeadlineNanoseconds) {
    throw new Error("fresh-root construction hard deadline reached");
  }
  let phase = budget.phase;
  if (transition === "cleanup-start") {
    if (phase !== "active") throw new Error("invalid fresh-root cleanup transition");
    if (sampleNanoseconds >= budget.cleanupDeadlineNanoseconds) {
      throw new Error("fresh-root construction cleanup deadline reached");
    }
    phase = "cleanup";
  } else if (transition === "cleanup-work") {
    if (phase !== "cleanup") throw new Error("invalid fresh-root cleanup transition");
    if (sampleNanoseconds >= budget.cleanupDeadlineNanoseconds) {
      throw new Error("fresh-root construction cleanup deadline reached");
    }
  } else if (transition === "cleanup-settled") {
    if (phase !== "cleanup") throw new Error("invalid fresh-root cleanup transition");
    if (sampleNanoseconds >= budget.cleanupDeadlineNanoseconds) {
      throw new Error("fresh-root construction cleanup deadline reached");
    }
    phase = "reserve";
  } else if (transition === "reserve") {
    if (phase !== "reserve") throw new Error("invalid fresh-root reserve transition");
  } else if (phase !== "active" || sampleNanoseconds >= budget.activeDeadlineNanoseconds) {
    throw new Error("fresh-root construction active deadline reached");
  }
  let cleanupState = budget.cleanupState;
  if (["work", "cleanup-start", "cleanup-work", "cleanup-settled", "reserve"].includes(transition)) {
    // A read, write or verification boundary leaves the cleanup state unchanged.
  } else if (transition === "directory-created" && cleanupState === "uncreated") {
    cleanupState = "pre-record";
  } else if (transition === "record-synced" && cleanupState === "pre-record") {
    cleanupState = "partial-acquisition";
  } else if (transition === "ledger-verified" && cleanupState === "partial-acquisition") {
    cleanupState = "ledger-backed";
  } else {
    throw new Error("invalid fresh-root construction transition");
  }
  const next = Object.freeze({
    ...budget,
    lastNanoseconds: sampleNanoseconds,
    cleanupState,
    phase,
  });
  freshRootCopyBudgets.add(next);
  return next;
}

function advanceHeldFreshRootBudget(budgetState, transition, clock, observeSignal = true) {
  if (observeSignal && budgetState.signal?.aborted === true) {
    throw new Error("fresh-root construction signal latched");
  }
  budgetState.value = advanceFreshRootCopyBudget(
    budgetState.value,
    transition,
    clock.sample(),
  );
  return budgetState.value;
}

function parseBootTimeNanoseconds(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > 128) {
    throw new Error("fresh-root boot-time sample size mismatch");
  }
  for (const byte of bytes) {
    if (byte > 0x7f) throw new Error("fresh-root boot-time sample encoding mismatch");
  }
  let position = 0;
  const parseField = (terminator) => {
    let seconds = 0n;
    if (bytes[position] === 0x30) {
      position += 1;
      if (bytes[position] >= 0x30 && bytes[position] <= 0x39) {
        throw new Error("fresh-root boot-time leading zero");
      }
    } else {
      if (bytes[position] < 0x31 || bytes[position] > 0x39) {
        throw new Error("fresh-root boot-time seconds mismatch");
      }
      while (bytes[position] >= 0x30 && bytes[position] <= 0x39) {
        seconds = seconds * 10n + BigInt(bytes[position] - 0x30);
        position += 1;
      }
    }
    let fraction = 0n;
    let digits = 0;
    if (bytes[position] === 0x2e) {
      position += 1;
      while (bytes[position] >= 0x30 && bytes[position] <= 0x39) {
        if (digits === 9) throw new Error("fresh-root boot-time fraction overflow");
        fraction = fraction * 10n + BigInt(bytes[position] - 0x30);
        digits += 1;
        position += 1;
      }
      if (digits === 0) throw new Error("fresh-root boot-time fraction mismatch");
    }
    if (bytes[position] !== terminator) throw new Error("fresh-root boot-time delimiter mismatch");
    position += 1;
    while (digits < 9) {
      fraction *= 10n;
      digits += 1;
    }
    return seconds * 1_000_000_000n + fraction;
  };
  const bootTime = parseField(0x20);
  parseField(0x0a);
  if (position !== bytes.length) throw new Error("fresh-root boot-time trailing bytes");
  return bootTime;
}

function openFreshRootClock() {
  const descriptor = openSync(
    "/proc/uptime",
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC,
  );
  try {
    const identity = fstatSync(descriptor, { bigint: true });
    if (
      !identity.isFile() ||
      identity.uid !== 0n ||
      identity.gid !== 0n ||
      identity.nlink !== 1n ||
      identity.size !== 0n ||
      numericMode(identity) !== 0o444
    ) {
      throw new Error("fresh-root boot-time descriptor identity mismatch");
    }
    let previous;
    let closed = false;
    return Object.freeze({
      sample() {
        if (closed) throw new Error("fresh-root boot-time descriptor closed");
        const buffer = Buffer.allocUnsafe(129);
        const count = readSync(descriptor, buffer, 0, buffer.length, 0);
        if (count <= 0 || count > 128) throw new Error("fresh-root boot-time sample cap");
        const sample = parseBootTimeNanoseconds(buffer.subarray(0, count));
        if (previous !== undefined && sample < previous) {
          throw new Error("fresh-root CLOCK_BOOTTIME regressed");
        }
        previous = sample;
        return sample;
      },
      close() {
        if (closed) return;
        closed = true;
        closeSync(descriptor);
      },
    });
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function validateLedgerPath(path) {
  if (
    typeof path !== "string" ||
    Buffer.byteLength(path, "utf8") > maximumRelativePathBytes ||
    !/^[A-Za-z0-9._+@/-]+$/u.test(path) ||
    path.startsWith("/") ||
    path.includes("//") ||
    path.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("invalid complete-ledger path");
  }
}

function parseLedgerUnsigned(value, maximum = (1n << 64n) - 1n) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("invalid complete-ledger integer");
  }
  const parsed = BigInt(value);
  if (parsed > maximum) throw new Error("complete-ledger integer exceeds bound");
  return parsed;
}

function ledgerActualPath(tag, logicalPath) {
  if (tag === "D") {
    if (logicalPath === "source" || logicalPath.startsWith("source/")) return logicalPath;
    if (logicalPath === "vendor" || logicalPath.startsWith("vendor/")) {
      return `acquisition/${logicalPath}`;
    }
    if (logicalPath === "toolchain" || logicalPath.startsWith("toolchain/")) {
      return `acquisition/${logicalPath}`;
    }
    throw new Error("invalid complete-ledger directory root");
  }
  if (tag === "S") return `source/${logicalPath}`;
  if (tag === "V") return `acquisition/vendor/${logicalPath}`;
  if (tag === "T") return `acquisition/toolchain/${logicalPath}`;
  const mapped = controlLedgerPaths.get(logicalPath);
  if (tag !== "C" || mapped === undefined) throw new Error("invalid complete-ledger control path");
  return mapped;
}

export function parseCompleteLedger(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > maximumLedgerBytes) {
    throw new Error("complete ledger bytes required");
  }
  const text = utf8.decode(bytes);
  if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes)) || !text.endsWith("\n") || text.includes("\r") || text.includes("\0")) {
    throw new Error("complete ledger encoding mismatch");
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines[0] !== completeLedgerMagic || lines.length !== completeLedgerRecords + 3) {
    throw new Error("complete ledger framing mismatch");
  }
  const count = lines[1]?.split("\t");
  if (count?.length !== 2 || count[0] !== "records" || parseLedgerUnsigned(count[1]) !== BigInt(completeLedgerRecords)) {
    throw new Error("complete ledger record count mismatch");
  }
  const end = lines.at(-1)?.split("\t");
  if (end?.length !== 2 || end[0] !== "end" || !/^[0-9a-f]{64}$/u.test(end[1])) {
    throw new Error("complete ledger end row mismatch");
  }
  const body = Buffer.from(`${lines.slice(0, -1).join("\n")}\n`, "utf8");
  if (createHash("sha256").update(body).digest("hex") !== end[1]) {
    throw new Error("complete ledger body digest mismatch");
  }

  const specifications = new Map();
  const rows = [];
  const counts = {
    sourceDirectories: 0,
    sourceFiles: 0,
    vendorDirectories: 0,
    vendorFiles: 0,
    vendorBytes: 0n,
    toolchainDirectories: 0,
    toolchainFiles: 0,
    toolchainBytes: 0n,
    controlFiles: 0,
  };
  let previousKey;
  let totalFileBytes = 0n;
  for (const line of lines.slice(2, -1)) {
    if (line.length === 0 || line.endsWith(" ")) throw new Error("malformed complete-ledger row");
    const fields = line.split("\t");
    const tag = fields[0];
    let logicalPath;
    let specification;
    if (tag === "D") {
      if (fields.length !== 3 || fields[1] !== "0555") throw new Error("invalid complete-ledger directory row");
      logicalPath = fields[2];
      validateLedgerPath(logicalPath);
      specification = Object.freeze({ kind: "directory", mode: 0o555 });
      if (logicalPath === "source" || logicalPath.startsWith("source/")) counts.sourceDirectories += 1;
      else if (logicalPath === "vendor" || logicalPath.startsWith("vendor/")) counts.vendorDirectories += 1;
      else if (logicalPath === "toolchain" || logicalPath.startsWith("toolchain/")) counts.toolchainDirectories += 1;
      else throw new Error("invalid complete-ledger directory");
    } else {
      if (!["S", "V", "T", "C"].includes(tag) || fields.length !== 5) {
        throw new Error("invalid complete-ledger file row");
      }
      const modeText = fields[1];
      if (tag === "T" ? !/^(?:0444|0555)$/u.test(modeText) : modeText !== "0444") {
        throw new Error("invalid complete-ledger file mode");
      }
      const size = parseLedgerUnsigned(fields[2], BigInt(maximumFileBytes));
      if (!/^[0-9a-f]{64}$/u.test(fields[3])) throw new Error("invalid complete-ledger file digest");
      logicalPath = fields[4];
      validateLedgerPath(logicalPath);
      specification = Object.freeze({
        kind: "file",
        mode: modeText === "0555" ? 0o555 : 0o444,
        size: Number(size),
        digest: fields[3],
        tag,
        logicalPath,
      });
      totalFileBytes += size;
      if (totalFileBytes > maximumTotalFileBytes) throw new Error("complete-ledger file bytes exceed bound");
      if (tag === "S") counts.sourceFiles += 1;
      else if (tag === "V") { counts.vendorFiles += 1; counts.vendorBytes += size; }
      else if (tag === "T") { counts.toolchainFiles += 1; counts.toolchainBytes += size; }
      else counts.controlFiles += 1;
    }
    const key = Buffer.from(`${tag}\t${logicalPath}`, "utf8");
    if (previousKey !== undefined && Buffer.compare(previousKey, key) >= 0) {
      throw new Error("complete-ledger rows are not strictly sorted");
    }
    previousKey = key;
    const actualPath = ledgerActualPath(tag, logicalPath);
    if (specifications.has(actualPath)) throw new Error("duplicate complete-ledger path");
    specifications.set(actualPath, specification);
    rows.push(Object.freeze({ line, logicalPath, specification, tag }));
  }
  for (const [key, expected] of Object.entries(expectedTreeCounts)) {
    if (counts[key] !== expected) throw new Error(`complete-ledger ${key} mismatch`);
  }
  if (specifications.size !== completeLedgerRecords) throw new Error("complete-ledger membership mismatch");

  const authorityRows = rows
    .filter(({ tag, logicalPath }) => tag === "T" || (tag === "D" && (logicalPath === "toolchain" || logicalPath.startsWith("toolchain/"))))
    .map(({ line }) => line);
  const authorityBody = Buffer.from(
    `${toolchainAuthorityMagic}\nrecords\t${authorityRows.length}\n${authorityRows.join("\n")}\n`,
    "utf8",
  );
  const authorityEnd = createHash("sha256").update(authorityBody).digest("hex");
  const authority = Buffer.concat([authorityBody, Buffer.from(`end\t${authorityEnd}\n`, "utf8")]);
  if (
    authorityRows.length !== 196 ||
    authority.length !== 30_553 ||
    authorityEnd !== "1dcabbf3617ff9821771b09f430a636af81077b643bf32385aadd3c0b9fc1274" ||
    createHash("sha256").update(authority).digest("hex") !== expectedToolchainAuthoritySha256
  ) {
    throw new Error("toolchain authority tuple mismatch");
  }

  return Object.freeze({
    bytes: Buffer.from(bytes),
    digest: createHash("sha256").update(bytes).digest("hex"),
    rows: Object.freeze(rows),
    specifications,
    counts: Object.freeze(counts),
  });
}

function claimCompleteInvocationRoot(sourceDirectory) {
  if (sourceDirectory === null || typeof sourceDirectory !== "object") {
    throw new Error("open ledger-backed source root required");
  }
  let suppliedDescriptor;
  try {
    suppliedDescriptor = Reflect.apply(genuineFileHandleFdGetter, sourceDirectory, []);
    if (!Number.isInteger(suppliedDescriptor) || suppliedDescriptor < 0) throw new Error();
  } catch {
    throw new Error("actual FileHandle ledger-backed source root required");
  }
  let descriptor;
  try {
    const suppliedPath = `/proc/self/fd/${suppliedDescriptor}`;
    const destinationPath = realpathSync(suppliedPath);
    const suppliedIdentity = fstatSync(suppliedDescriptor, { bigint: true });
    descriptor = openSync(
      suppliedPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_CLOEXEC,
    );
    const identity = fstatSync(descriptor, { bigint: true });
    if (
      !invocationRootPattern.test(destinationPath) ||
      realpathSync(`/proc/self/fd/${descriptor}`) !== destinationPath ||
      !sameSnapshot(suppliedIdentity, identity)
    ) {
      throw new Error("ledger-backed source root identity mismatch");
    }
    return Object.freeze({
      descriptor,
      descriptorPath: `/proc/self/fd/${descriptor}`,
      destinationPath,
      identity,
      mountId: descriptorMountIdFromBytes(readFileSync(`/proc/self/fdinfo/${descriptor}`)),
    });
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw error;
  }
}

function invocationFromRootPath(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const invocation = name.slice(invocationPrefix.length);
  if (!/^[0-9a-f]{64}$/u.test(invocation)) throw new Error("ledger-backed invocation mismatch");
  return invocation;
}

function expectedInvocationBytes(invocation) {
  return Buffer.from(`${invocationRecordPrefix}${invocation}\n`, "ascii");
}

async function readBoundedFileByChunks(path, expected, budgetState, clock, onChunk, capture = false) {
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile() ||
    before.uid !== BigInt(process.getuid()) ||
    before.gid !== BigInt(process.getgid()) ||
    before.nlink !== 1n ||
    before.dev !== expected.device ||
    numericMode(before) !== expected.mode ||
    before.size !== BigInt(expected.size)
  ) {
    throw new Error("ledger-backed file identity mismatch");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
  const digest = createHash("sha256");
  const objectDigest = expected.object === undefined
    ? undefined
    : createHash(expected.object.length === 40 ? "sha1" : "sha256")
      .update(Buffer.from(`blob ${expected.size}\0`, "ascii"));
  const captured = capture ? [] : undefined;
  let operationError;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameSnapshot(before, opened)) throw new Error("ledger-backed file changed across open");
    const buffer = Buffer.allocUnsafe(Math.min(copyChunkBytes, Math.max(expected.size, 1)));
    let offset = 0;
    while (offset < expected.size) {
      advanceHeldFreshRootBudget(budgetState, "work", clock);
      const requested = Math.min(buffer.length, expected.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, requested, offset);
      advanceHeldFreshRootBudget(budgetState, "work", clock);
      if (bytesRead !== requested) throw new Error("ledger-backed source read was truncated");
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      objectDigest?.update(chunk);
      captured?.push(Buffer.from(chunk));
      if (onChunk !== undefined) await onChunk(chunk, offset);
      offset += bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    advanceHeldFreshRootBudget(budgetState, "work", clock);
    if ((await handle.read(probe, 0, 1, expected.size)).bytesRead !== 0) {
      throw new Error("ledger-backed source grew during read");
    }
    advanceHeldFreshRootBudget(budgetState, "work", clock);
    const settled = await handle.stat({ bigint: true });
    const reached = await lstat(path, { bigint: true });
    if (!sameSnapshot(opened, settled) || !sameSnapshot(opened, reached)) {
      throw new Error("ledger-backed file changed during read");
    }
  } catch (error) {
    operationError = error;
  }
  await requireClose([handle], operationError, "ledger-backed file read settlement failed");
  const hexadecimal = digest.digest("hex");
  if (expected.digest !== undefined && hexadecimal !== expected.digest) throw new Error("ledger-backed file digest mismatch");
  if (objectDigest !== undefined && objectDigest.digest("hex") !== expected.object) {
    throw new Error("fixed source Git object mismatch");
  }
  return captured === undefined ? hexadecimal : Buffer.concat(captured, expected.size);
}

async function enumerateInvocationTree(rootClaim) {
  const entries = new Map();
  let totalPathBytes = 0;
  const visit = async (path, relativePath, depth) => {
    if (depth > maximumTreeDepth) throw new Error("ledger-backed tree depth exceeded");
    const before = relativePath === ""
      ? await fstatDescriptor(rootClaim.descriptor)
      : await lstat(path, { bigint: true });
    if (!before.isDirectory() || before.dev !== rootClaim.identity.dev) {
      throw new Error("ledger-backed directory identity mismatch");
    }
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const childRelative = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
      validateLedgerPath(childRelative);
      totalPathBytes += Buffer.byteLength(childRelative, "utf8");
      if (totalPathBytes > maximumTotalPathBytes || entries.size >= maximumTreeEntries) {
        throw new Error("ledger-backed tree inventory exceeds bound");
      }
      const childPath = join(path, entry.name);
      const status = await lstat(childPath, { bigint: true });
      if (status.dev !== rootClaim.identity.dev || status.uid !== rootClaim.identity.uid || status.gid !== rootClaim.identity.gid) {
        throw new Error("ledger-backed entry ownership mismatch");
      }
      if (!status.isDirectory() && !status.isFile()) throw new Error("link or special ledger-backed entry");
      entries.set(childRelative, Object.freeze({ path: childPath, status }));
      if (status.isDirectory()) await visit(childPath, childRelative, depth + 1);
    }
    const after = relativePath === ""
      ? await fstatDescriptor(rootClaim.descriptor)
      : await lstat(path, { bigint: true });
    if (!sameSnapshot(before, after)) throw new Error("ledger-backed directory changed during enumeration");
  };
  await visit(rootClaim.descriptorPath, "", 0);
  return entries;
}

function addStructuralSpecifications(specifications, invocation, ledger) {
  const complete = new Map(specifications);
  const add = (path, specification) => {
    if (complete.has(path)) throw new Error("duplicate structural path");
    complete.set(path, Object.freeze(specification));
  };
  const invocationBytes = expectedInvocationBytes(invocation);
  add("INVOCATION", { kind: "bytes", mode: 0o600, size: invocationBytes.length, digest: createHash("sha256").update(invocationBytes).digest("hex"), bytes: invocationBytes });
  add("control", { kind: "directory", mode: 0o555 });
  add("control/acquisition.sh", { kind: "file", mode: 0o444, ...acquisitionController });
  add("acquisition", { kind: "directory", mode: 0o700 });
  add("acquisition/vendor-ledger.v1", { kind: "bytes", mode: 0o444, size: ledger.bytes.length, digest: ledger.digest, bytes: ledger.bytes });
  add("docker", { kind: "directory", mode: 0o500 });
  add("docker/home", { kind: "directory", mode: 0o700 });
  add("docker/config", { kind: "directory", mode: 0o500 });
  const config = exactControlBytes.get("docker/config/config.json");
  add("docker/config/config.json", { kind: "bytes", mode: 0o400, size: config.length, digest: createHash("sha256").update(config).digest("hex"), bytes: config });
  return complete;
}

function requireSourceObjectIdentities(specifications) {
  for (const path of fixedSourceObjects.keys()) {
    const specification = specifications.get(`source/${path}`);
    if (specification?.kind !== "file" || specification.tag !== "S") {
      throw new Error("fixed source object absent from complete ledger");
    }
  }
}

async function validateCargoChecksumMembership(rootPath, rootDevice, ledger, budgetState, clock) {
  const lockedPackages = new Map();
  for (const packageName of [
    "hosted-migration-preparation-proof",
    "hosted-migration-root-authority",
    "hosted-migration-runtime-proof",
  ]) {
    const lockPath = `source/tools/${packageName}/Cargo.lock`;
    const lockSpecification = ledger.specifications.get(lockPath);
    if (lockSpecification?.kind !== "file") throw new Error("Cargo lock absent from complete ledger");
    const lockBytes = await readBoundedFileByChunks(
      join(rootPath, lockPath),
      { ...lockSpecification, device: rootDevice },
      budgetState,
      clock,
      undefined,
      true,
    );
    for (const block of utf8.decode(lockBytes).split("[[package]]").slice(1)) {
      const field = (name) => new RegExp(`^${name} = "([^"]+)"$`, "mu").exec(block)?.[1];
      const name = field("name");
      const version = field("version");
      const source = field("source");
      const checksum = field("checksum");
      if (source === undefined) continue;
      if (
        name === undefined ||
        version === undefined ||
        source !== "registry+https://github.com/rust-lang/crates.io-index" ||
        checksum === undefined ||
        !/^[0-9a-f]{64}$/u.test(checksum)
      ) {
        throw new Error("Cargo lock registry identity mismatch");
      }
      const directory = `${name}-${version}`;
      const existing = lockedPackages.get(directory);
      if (existing !== undefined && existing !== checksum) {
        throw new Error("Cargo lock package checksum conflict");
      }
      lockedPackages.set(directory, checksum);
    }
  }
  const packages = new Map();
  for (const row of ledger.rows) {
    if (row.tag !== "V") continue;
    const slash = row.logicalPath.indexOf("/");
    if (slash <= 0) throw new Error("vendor file lacks package directory");
    const packageName = row.logicalPath.slice(0, slash);
    const relativePath = row.logicalPath.slice(slash + 1);
    const files = packages.get(packageName) ?? new Map();
    files.set(relativePath, row.specification.digest);
    packages.set(packageName, files);
  }
  for (const [packageName, files] of packages) {
    const checksumPath = join(rootPath, "acquisition/vendor", packageName, ".cargo-checksum.json");
    const checksumSpecification = files.get(".cargo-checksum.json");
    if (checksumSpecification === undefined) throw new Error("vendor checksum file absent");
    const checksumLedgerPath = `acquisition/vendor/${packageName}/.cargo-checksum.json`;
    const checksumRecord = ledger.specifications.get(checksumLedgerPath);
    if (checksumRecord?.kind !== "file") throw new Error("vendor checksum file absent");
    const bytes = await readBoundedFileByChunks(
      checksumPath,
      { ...checksumRecord, device: rootDevice },
      budgetState,
      clock,
      undefined,
      true,
    );
    if (createHash("sha256").update(bytes).digest("hex") !== checksumSpecification) {
      throw new Error("vendor checksum file digest mismatch");
    }
    let document;
    try { document = JSON.parse(utf8.decode(bytes)); } catch { throw new Error("vendor checksum JSON mismatch"); }
    if (
      document === null ||
      typeof document !== "object" ||
      Array.isArray(document) ||
      typeof document.package !== "string" ||
      !/^[0-9a-f]{64}$/u.test(document.package) ||
      document.files === null ||
      typeof document.files !== "object" ||
      Array.isArray(document.files)
    ) {
      throw new Error("vendor checksum document mismatch");
    }
    if (document.package !== lockedPackages.get(packageName)) {
      throw new Error("vendor package checksum does not match Cargo locks");
    }
    const expectedFiles = [...files.keys()].filter((path) => path !== ".cargo-checksum.json").sort(compareBytes);
    const declaredFiles = Object.keys(document.files).sort(compareBytes);
    if (expectedFiles.length !== declaredFiles.length || expectedFiles.some((path, index) => path !== declaredFiles[index])) {
      throw new Error("vendor checksum membership mismatch");
    }
    for (const path of expectedFiles) {
      if (document.files[path] !== files.get(path)) throw new Error("vendor checksum digest mismatch");
    }
  }
  if (
    packages.size !== 70 ||
    lockedPackages.size !== packages.size ||
    [...lockedPackages.keys()].some((name) => !packages.has(name))
  ) {
    throw new Error("vendor package count mismatch");
  }
}

async function verifyCompleteInvocation(rootClaim, budgetState, clock) {
  const invocation = invocationFromRootPath(rootClaim.destinationPath);
  const parent = dirname(rootClaim.destinationPath);
  const parentIdentity = await lstat(parent, { bigint: true });
  if (
    !["/tmp", "/var/tmp"].includes(parent) ||
    !parentIdentity.isDirectory() ||
    parentIdentity.uid !== 0n ||
    parentIdentity.gid !== 0n ||
    numericMode(parentIdentity) !== 0o1777 ||
    rootClaim.identity.uid !== BigInt(process.getuid()) ||
    rootClaim.identity.gid !== BigInt(process.getgid()) ||
    rootClaim.identity.dev !== parentIdentity.dev ||
    numericMode(rootClaim.identity) !== 0o700
  ) {
    throw new Error("ledger-backed root boundary mismatch");
  }
  const mountInventory = parseMountInfo(await readFile("/proc/self/mountinfo"));
  if (
    mountForPath(mountInventory, rootClaim.destinationPath).mountId !== rootClaim.mountId ||
    mountInventory.some(({ mountPath }) => isAtOrBelow(mountPath, rootClaim.destinationPath))
  ) {
    throw new Error("mount in ledger-backed root");
  }
  const entries = await enumerateInvocationTree(rootClaim);
  const ledgerEntry = entries.get("acquisition/vendor-ledger.v1");
  if (ledgerEntry === undefined || !ledgerEntry.status.isFile() || ledgerEntry.status.size > BigInt(maximumLedgerBytes)) {
    throw new Error("complete ledger file missing");
  }
  const ledgerBytes = await readBoundedFileByChunks(
    ledgerEntry.path,
    {
      device: rootClaim.identity.dev,
      mode: 0o444,
      size: Number(ledgerEntry.status.size),
    },
    budgetState,
    clock,
    undefined,
    true,
  );
  const ledger = parseCompleteLedger(ledgerBytes);
  const specifications = addStructuralSpecifications(ledger.specifications, invocation, ledger);
  requireSourceObjectIdentities(specifications);
  if (entries.size !== specifications.size) throw new Error("ledger-backed tree membership mismatch");
  for (const [path, specification] of specifications) {
    const entry = entries.get(path);
    if (entry === undefined) throw new Error("missing ledger-backed tree member");
    if (specification.kind === "directory") {
      const childDirectories = [...entries.entries()].filter(([candidate, child]) =>
        child.status.isDirectory() && dirname(candidate) === path,
      ).length;
      if (
        !entry.status.isDirectory() ||
        numericMode(entry.status) !== specification.mode ||
        entry.status.nlink !== BigInt(2 + childDirectories)
      ) {
        throw new Error(`ledger-backed directory mode mismatch: ${path}`);
      }
      continue;
    }
    const expected = {
      ...specification,
      device: rootClaim.identity.dev,
      object: specification.tag === "S"
        ? fixedSourceObjects.get(specification.logicalPath)
        : undefined,
    };
    await readBoundedFileByChunks(entry.path, expected, budgetState, clock);
  }
  for (const path of entries.keys()) {
    if (!specifications.has(path)) throw new Error("extra ledger-backed tree member");
  }
  const proof = ledger.specifications.get("control/proof.sh");
  if (proof?.kind !== "file" || proof.size !== proofController.size || proof.digest !== proofController.digest) {
    throw new Error("proof controller identity mismatch");
  }
  for (const [path, bytes] of exactControlBytes) {
    if (path.startsWith("docker/")) continue;
    const specification = specifications.get(path);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (specification?.kind !== "file" || specification.size !== bytes.length || specification.digest !== digest) {
      throw new Error("fixed control file identity mismatch");
    }
  }
  await validateCargoChecksumMembership(rootClaim.descriptorPath, rootClaim.identity.dev, ledger, budgetState, clock);
  const rootIdentity = fstatSync(rootClaim.descriptor, { bigint: true });
  const reachedRoot = lstatSync(rootClaim.destinationPath, { bigint: true });
  const rootChildren = [...entries.values()].filter(({ path, status }) =>
    status.isDirectory() && dirname(path) === rootClaim.descriptorPath,
  ).length;
  const settledMountInventory = parseMountInfo(readFileSync("/proc/self/mountinfo"));
  const alternateParent = parent === "/tmp" ? "/var/tmp" : "/tmp";
  let alternateExists = true;
  try {
    lstatSync(join(alternateParent, `${invocationPrefix}${invocation}`));
  } catch (error) {
    if (error?.code === "ENOENT") alternateExists = false;
    else throw error;
  }
  if (
    !sameSnapshot(rootIdentity, reachedRoot) ||
    !sameDirectoryNode(rootClaim.identity, rootIdentity) ||
    rootIdentity.nlink !== BigInt(2 + rootChildren) ||
    realpathSync(`/proc/self/fd/${rootClaim.descriptor}`) !== rootClaim.destinationPath ||
    realpathSync(rootClaim.destinationPath) !== rootClaim.destinationPath ||
    descriptorMountIdFromBytes(readFileSync(`/proc/self/fdinfo/${rootClaim.descriptor}`)) !== rootClaim.mountId ||
    mountForPath(settledMountInventory, rootClaim.destinationPath).mountId !== rootClaim.mountId ||
    settledMountInventory.some(({ mountPath }) => isAtOrBelow(mountPath, rootClaim.destinationPath)) ||
    alternateExists
  ) {
    throw new Error("ledger-backed root changed during verification");
  }
  return Object.freeze({ invocation, ledger, specifications, entries, rootIdentity });
}

async function writeCopiedFile(
  sourcePath,
  destinationPath,
  specification,
  sourceDevice,
  destinationDevice,
  budgetState,
  clock,
) {
  const destination = await open(
    destinationPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_CLOEXEC,
    0o600,
  );
  let writeOffset = 0;
  let operationError;
  try {
    await readBoundedFileByChunks(
      sourcePath,
      { ...specification, device: sourceDevice },
      budgetState,
      clock,
      async (chunk) => {
        advanceHeldFreshRootBudget(budgetState, "work", clock);
        const { bytesWritten } = await destination.write(chunk, 0, chunk.length, writeOffset);
        advanceHeldFreshRootBudget(budgetState, "work", clock);
        if (bytesWritten !== chunk.length) throw new Error("fresh-root destination write was short");
        writeOffset += bytesWritten;
      },
    );
    await destination.chmod(specification.mode);
    await destination.sync();
    const settled = await destination.stat({ bigint: true });
    if (
      !settled.isFile() ||
      settled.dev !== destinationDevice ||
      settled.uid !== BigInt(process.getuid()) ||
      settled.gid !== BigInt(process.getgid()) ||
      settled.nlink !== 1n ||
      settled.size !== BigInt(specification.size) ||
      numericMode(settled) !== specification.mode
    ) {
      throw new Error("fresh-root destination file identity mismatch");
    }
  } catch (error) {
    operationError = error;
  }
  await requireClose([destination], operationError, "fresh-root destination write settlement failed");
}

async function writeRebuiltFile(path, bytes, mode, device, budgetState, clock) {
  const specification = {
    mode,
    size: bytes.length,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
  const temporary = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_CLOEXEC,
    0o600,
  );
  let operationError;
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const length = Math.min(copyChunkBytes, bytes.length - offset);
      advanceHeldFreshRootBudget(budgetState, "work", clock);
      const { bytesWritten } = await temporary.write(bytes, offset, length, offset);
      advanceHeldFreshRootBudget(budgetState, "work", clock);
      if (bytesWritten !== length) throw new Error("rebuilt file write was short");
      offset += bytesWritten;
    }
    await temporary.chmod(mode);
    await temporary.sync();
    const status = await temporary.stat({ bigint: true });
    if (
      !status.isFile() ||
      status.dev !== device ||
      status.uid !== BigInt(process.getuid()) ||
      status.gid !== BigInt(process.getgid()) ||
      status.nlink !== 1n ||
      status.size !== BigInt(specification.size) ||
      numericMode(status) !== mode
    ) {
      throw new Error("rebuilt file identity mismatch");
    }
  } catch (error) {
    operationError = error;
  }
  await requireClose([temporary], operationError, "rebuilt file write settlement failed");
}

function syncDirectoryPath(path) {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_CLOEXEC,
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

async function createFreshChildDirectory(path, budgetState, clock) {
  advanceHeldFreshRootBudget(budgetState, "work", clock);
  await mkdir(path, { mode: 0o700 });
  advanceHeldFreshRootBudget(budgetState, "work", clock);
}

async function chmodFreshPath(path, mode, budgetState, clock) {
  advanceHeldFreshRootBudget(budgetState, "work", clock);
  await chmod(path, mode);
  advanceHeldFreshRootBudget(budgetState, "work", clock);
}

function syncFreshDirectoryPath(path, budgetState, clock) {
  advanceHeldFreshRootBudget(budgetState, "work", clock);
  syncDirectoryPath(path);
  advanceHeldFreshRootBudget(budgetState, "work", clock);
}

function attachFreshDestination(error, destination) {
  const failure = error instanceof Error ? error : new Error("fresh-root directory creation failed", { cause: error });
  Object.defineProperty(failure, "freshDestination", {
    configurable: false,
    enumerable: false,
    value: destination,
    writable: false,
  });
  return failure;
}

function createFreshInvocationDirectory(invocation, budgetState, clock) {
  let lastError;
  for (const parent of ["/tmp", "/var/tmp"]) {
    const path = join(parent, `${invocationPrefix}${invocation}`);
    let descriptor;
    let destination;
    try {
      const parentIdentity = lstatSync(parent, { bigint: true });
      if (!parentIdentity.isDirectory() || parentIdentity.uid !== 0n || parentIdentity.gid !== 0n || numericMode(parentIdentity) !== 0o1777 || realpathSync(parent) !== parent) {
        throw new Error("fresh-root parent identity mismatch");
      }
      advanceHeldFreshRootBudget(budgetState, "work", clock);
      mkdirSync(path, { mode: 0o700 });
      budgetState.value = advanceFreshRootCopyBudget(
        budgetState.value,
        "directory-created",
        budgetState.value.lastNanoseconds,
      );
      destination = Object.freeze({ cleanupKind: "identity-uncertain", destinationPath: path, parent });
      advanceHeldFreshRootBudget(budgetState, "work", clock);
      const reached = lstatSync(path, { bigint: true });
      descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
      const identity = fstatSync(descriptor, { bigint: true });
      const mountId = descriptorMountIdFromBytes(readFileSync(`/proc/self/fdinfo/${descriptor}`));
      destination = Object.freeze({ cleanupKind: "authenticated", descriptor, descriptorPath: `/proc/self/fd/${descriptor}`, destinationPath: path, identity, mountId, parent });
      advanceHeldFreshRootBudget(budgetState, "work", clock);
      if (!sameSnapshot(reached, identity) || !identity.isDirectory() || identity.uid !== BigInt(process.getuid()) || identity.gid !== BigInt(process.getgid()) || identity.dev !== parentIdentity.dev || numericMode(identity) !== 0o700) {
        throw new Error("fresh-root directory identity mismatch");
      }
      advanceHeldFreshRootBudget(budgetState, "work", clock);
      const parentDescriptor = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
      try { fsyncSync(parentDescriptor); } finally { closeSync(parentDescriptor); }
      advanceHeldFreshRootBudget(budgetState, "work", clock);
      return destination;
    } catch (error) {
      lastError = error;
      if (budgetState.value.cleanupState !== "uncreated") {
        if (descriptor !== undefined && destination?.identity === undefined) {
          try {
            const identity = fstatSync(descriptor, { bigint: true });
            destination = Object.freeze({
              cleanupKind: "authenticated",
              descriptor,
              descriptorPath: `/proc/self/fd/${descriptor}`,
              destinationPath: path,
              identity,
              mountId: descriptorMountIdFromBytes(readFileSync(`/proc/self/fdinfo/${descriptor}`)),
              parent,
            });
          } catch {
            // The original error remains authoritative when identity capture also failed.
          }
        }
        let uncertainDescriptorSettled = descriptor === undefined;
        if (descriptor !== undefined && destination?.identity === undefined) {
          uncertainDescriptorSettled = settlePrivateDescriptor(descriptor, undefined).settled;
        }
        if (destination?.identity === undefined) {
          try {
            if (!uncertainDescriptorSettled) {
              throw new Error("fresh-root uncertain directory descriptor remained open", { cause: error });
            }
            rmdirSync(path);
            let stillPresent = true;
            try {
              lstatSync(path);
            } catch (absenceError) {
              if (absenceError?.code === "ENOENT") stillPresent = false;
              else throw absenceError;
            }
            if (stillPresent) throw new Error("fresh-root uncertain path remained after rmdir", { cause: error });
            destination = Object.freeze({ cleanupKind: "settled-pre-record", destinationPath: path, parent });
          } catch {
            destination = Object.freeze({ cleanupKind: "identity-uncertain", destinationPath: path, parent });
          }
        }
        throw attachFreshDestination(error, destination);
      }
    }
  }
  throw lastError ?? new Error("fresh-root directory creation failed");
}

function cleanupRecord(destination, invocation, state) {
  if (destination === undefined) return undefined;
  if (destination.cleanupKind !== "authenticated") {
    return Object.freeze({
      helperUsable: false,
      kind: destination.cleanupKind,
      parentToken: destination.parent === "/tmp" ? "tmp" : "var-tmp",
      invocation,
      path: destination.destinationPath,
      state,
    });
  }
  return Object.freeze({
    helperUsable: true,
    kind: "authenticated",
    parentToken: destination.parent === "/tmp" ? "tmp" : "var-tmp",
    invocation,
    path: destination.destinationPath,
    device: destination.identity?.dev,
    inode: destination.identity?.ino,
    mountId: destination.mountId,
    state,
  });
}

function fixedCleanupControlFrame(record) {
  if (
    record?.helperUsable !== true ||
    (record.parentToken !== "tmp" && record.parentToken !== "var-tmp") ||
    !/^[0-9a-f]{64}$/u.test(record.invocation) ||
    typeof record.device !== "bigint" ||
    typeof record.inode !== "bigint" ||
    !["pre-record", "partial-acquisition", "ledger-backed"].includes(record.state)
  ) {
    throw new Error("fresh-root cleanup record is not helper-usable");
  }
  return Buffer.from(
    `openspell.wp201.path-cleanup.v2\n${record.parentToken}\n${record.invocation}\n${record.device}\n${record.inode}\n${record.state}\n`,
    "utf8",
  );
}

function collectBoundedChildPipe(stream, maximumBytes, label, onOverflow) {
  const chunks = [];
  let length = 0;
  let overflow = false;
  let streamError;
  stream.on("data", (chunk) => {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > maximumBytes) {
      overflow = true;
      onOverflow();
      return;
    }
    chunks.push(bytes);
  });
  stream.on("error", (error) => {
    streamError = error;
  });
  return () => {
    if (streamError !== undefined) throw new Error(`${label} pipe failed`, { cause: streamError });
    if (overflow) throw new Error(`${label} pipe overflow`);
    return Buffer.concat(chunks, length);
  };
}

function cleanupPollDelay() {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, 50);
    timer.unref();
  });
}

function classifyCleanupChildPoll(closed, sampleNanoseconds, slotDeadlineNanoseconds) {
  if (sampleNanoseconds >= slotDeadlineNanoseconds) return "expired";
  return closed ? "closed" : "waiting";
}

async function waitForCleanupChild(child, childState, slotNanoseconds, budgetState, clock) {
  const slotStart = advanceHeldFreshRootBudget(
    budgetState,
    "cleanup-work",
    clock,
    false,
  ).lastNanoseconds;
  const slotDeadline = slotStart + slotNanoseconds;
  for (;;) {
    const sample = advanceHeldFreshRootBudget(
      budgetState,
      "cleanup-work",
      clock,
      false,
    ).lastNanoseconds;
    const terminal = childState.closed && containedChildEmpty(child);
    const beforeDelay = classifyCleanupChildPoll(terminal, sample, slotDeadline);
    if (beforeDelay !== "waiting") return beforeDelay === "closed";
    await cleanupPollDelay();
    const postWakeSample = advanceHeldFreshRootBudget(
      budgetState,
      "cleanup-work",
      clock,
      false,
    ).lastNanoseconds;
    const afterDelay = classifyCleanupChildPoll(
      childState.closed && containedChildEmpty(child),
      postWakeSample,
      slotDeadline,
    );
    if (afterDelay !== "waiting") return afterDelay === "closed";
  }
}

function exactPathIsAbsent(path) {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

async function runFixedFreshRootCleanup(record, budgetState, clock) {
  const frame = fixedCleanupControlFrame(record);
  const child = spawnContained(spawn, capturedNodeExecutable, [fixedPathCleanupHelper], {
    cwd: "/",
    detached: true,
    env: { LANG: "C", LC_ALL: "C" },
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  });
  const state = { closed: false, code: undefined, signal: undefined, spawnError: undefined };
  child.once("error", (error) => {
    state.spawnError = error;
  });
  child.once("close", (code, signal) => {
    const containedResult = containedChildResult(child);
    state.closed = true;
    state.code = containedResult === undefined ? code : containedResult.code;
    state.signal = containedResult === undefined ? signal : containedResult.signal;
  });
  const terminateOnOverflow = () => {
    try { signalContainedChild(child, "SIGKILL"); } catch { /* reported after reap */ }
  };
  const diagnosticsResult = collectBoundedChildPipe(
    child.stdio[2],
    4_096,
    "fresh-root cleanup diagnostic",
    terminateOnOverflow,
  );
  const completionResult = collectBoundedChildPipe(
    child.stdio[4],
    64,
    "fresh-root cleanup completion",
    terminateOnOverflow,
  );
  let controlError;
  child.stdio[3].once("error", (error) => {
    controlError = error;
  });
  child.stdio[3].end(frame);

  try {
    let closed = await waitForCleanupChild(
      child,
      state,
      cleanupNormalNanoseconds,
      budgetState,
      clock,
    );
    if (!closed) {
      signalContainedChild(child, "SIGTERM");
      closed = await waitForCleanupChild(
        child,
        state,
        cleanupTermNanoseconds,
        budgetState,
        clock,
      );
    }
    if (!closed) {
      signalContainedChild(child, "SIGKILL");
      closed = await waitForCleanupChild(
        child,
        state,
        cleanupKillNanoseconds,
        budgetState,
        clock,
      );
    }
    if (!closed) throw new Error("fresh-root cleanup helper did not reap");
    if (!containedChildReleased(child)) {
      throw new Error("fresh-root cleanup helper release pipe did not settle");
    }
    const containmentSetupError = containedChildSetupError(child);
    if (containmentSetupError !== undefined) throw containmentSetupError;
    const containmentSettlement = settleContainedChild(child);
    if (!containmentSettlement.settled) {
      throw new AggregateError(
        containmentSettlement.errors,
        "fresh-root cleanup helper containment failed",
        { cause: containmentSettlement.errors[0] },
      );
    }
    if (state.spawnError !== undefined) {
      throw new Error("fresh-root cleanup helper spawn failed", { cause: state.spawnError });
    }
    if (controlError !== undefined) {
      throw new Error("fresh-root cleanup control pipe failed", { cause: controlError });
    }
    const diagnostics = diagnosticsResult();
    const completion = completionResult();
    if (
      state.code !== 0 ||
      state.signal !== null ||
      diagnostics.length !== 0 ||
      !completion.equals(cleanupCompletionBytes)
    ) {
      throw new Error("fresh-root cleanup helper refused or returned invalid completion");
    }

    const absenceStart = advanceHeldFreshRootBudget(
      budgetState,
      "cleanup-work",
      clock,
      false,
    ).lastNanoseconds;
    const absenceDeadline = absenceStart + cleanupAbsenceNanoseconds;
    advanceHeldFreshRootBudget(budgetState, "cleanup-work", clock, false);
    const absent = exactPathIsAbsent(record.path);
    const absenceSample = advanceHeldFreshRootBudget(
      budgetState,
      "cleanup-work",
      clock,
      false,
    ).lastNanoseconds;
    if (absenceSample >= absenceDeadline || !absent) {
      throw new Error("fresh-root cleanup parent absence proof failed");
    }
    return Object.freeze({
      ...record,
      outcome: "helper-complete-and-parent-absent",
    });
  } catch (error) {
    const primary = error instanceof Error
      ? error
      : new Error("fresh-root cleanup helper failed", { cause: error });
    const cleanupErrors = [];
    let terminal = false;
    try {
      terminal = state.closed && containedChildEmpty(child);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (!terminal) {
      try {
        signalContainedChild(child, "SIGKILL");
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        terminal = await waitForCleanupChild(
          child,
          state,
          cleanupKillNanoseconds,
          budgetState,
          clock,
        );
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (!terminal) {
      cleanupErrors.push(new Error("fresh-root cleanup helper retained child residue"));
    } else {
      if (!containedChildReleased(child)) {
        cleanupErrors.push(new Error("fresh-root cleanup helper release pipe did not settle"));
      }
      try {
        const settlement = settleContainedChild(child);
        if (!settlement.settled) {
          cleanupErrors.push(new AggregateError(
            settlement.errors,
            "fresh-root cleanup helper containment failed",
            { cause: settlement.errors[0] },
          ));
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    const failure = cleanupErrors.length === 0
      ? primary
      : new AggregateError(
          [primary, ...cleanupErrors],
          "fresh-root cleanup helper and containment settlement failed",
          { cause: primary },
        );
    Object.defineProperty(failure, "cleanup", {
      configurable: false,
      enumerable: true,
      value: Object.freeze({
        ...record,
        helperPid: child.pid,
        helperReaped: state.closed,
        outcome: "cleanup-helper-failed-or-unsettled",
      }),
      writable: false,
    });
    throw failure;
  }
}

async function settleFreshRootConstruction(destination, invocation, budgetState, clock) {
  let record = cleanupRecord(destination, invocation, budgetState.value.cleanupState);
  if (record === undefined) return undefined;
  advanceHeldFreshRootBudget(budgetState, "cleanup-start", clock, false);
  if (record.helperUsable) {
    record = await runFixedFreshRootCleanup(record, budgetState, clock);
  } else {
    advanceHeldFreshRootBudget(budgetState, "cleanup-work", clock, false);
    const absent = exactPathIsAbsent(record.path);
    advanceHeldFreshRootBudget(budgetState, "cleanup-work", clock, false);
    if (!absent) {
      throw Object.assign(new Error("fresh-root unauthenticated cleanup obligation remains"), {
        cleanup: Object.freeze({ ...record, outcome: "cleanup-uncertain-residue" }),
      });
    }
    record = Object.freeze({ ...record, outcome: "pre-record-path-absent" });
  }
  advanceHeldFreshRootBudget(budgetState, "cleanup-settled", clock, false);
  advanceHeldFreshRootBudget(budgetState, "reserve", clock, false);
  return record;
}

async function closeRawDescriptors(descriptors) {
  const errors = [];
  for (const descriptor of descriptors.reverse()) {
    try { await closeDescriptor(descriptor); } catch (error) { errors.push(error); }
  }
  return errors;
}

function verifyRetainedLedgerDescriptor(descriptor, expected, budgetState, clock) {
  const before = fstatSync(descriptor, { bigint: true });
  if (
    !before.isFile() ||
    before.dev !== expected.device ||
    before.uid !== BigInt(process.getuid()) ||
    before.gid !== BigInt(process.getgid()) ||
    before.nlink !== 1n ||
    before.size !== BigInt(expected.size) ||
    numericMode(before) !== 0o444
  ) {
    throw new Error("fresh-root retained ledger identity mismatch");
  }
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(copyChunkBytes, Math.max(expected.size, 1)));
  let offset = 0;
  while (offset < expected.size) {
    advanceHeldFreshRootBudget(budgetState, "work", clock);
    const requested = Math.min(buffer.length, expected.size - offset);
    const count = readSync(descriptor, buffer, 0, requested, offset);
    advanceHeldFreshRootBudget(budgetState, "work", clock);
    if (count !== requested) throw new Error("fresh-root retained ledger read was truncated");
    digest.update(buffer.subarray(0, count));
    offset += count;
  }
  advanceHeldFreshRootBudget(budgetState, "work", clock);
  if (readSync(descriptor, buffer, 0, 1, expected.size) !== 0) {
    throw new Error("fresh-root retained ledger grew during read");
  }
  advanceHeldFreshRootBudget(budgetState, "work", clock);
  const after = fstatSync(descriptor, { bigint: true });
  if (!sameSnapshot(before, after) || digest.digest("hex") !== expected.digest) {
    throw new Error("fresh-root retained ledger changed during read");
  }
  return before;
}

export async function prepareFreshLedgerBackedRoot({ sourceDirectory, signal } = {}) {
  if (signal !== undefined && !(signal instanceof globalThis.AbortSignal)) {
    throw new Error("fresh-root construction signal must be an AbortSignal");
  }
  let clock;
  let budgetState;
  let invocation;
  let source;
  let destination;
  const custodyDescriptors = [];
  let operationError;
  let resultToken;
  let resultState;
  try {
    clock = openFreshRootClock();
    budgetState = { signal, value: createFreshRootCopyBudget(clock.sample()) };
    invocation = randomBytes(32).toString("hex");
    source = claimCompleteInvocationRoot(sourceDirectory);
    const sourceProof = await verifyCompleteInvocation(source, budgetState, clock);
    destination = createFreshInvocationDirectory(invocation, budgetState, clock);
    await writeRebuiltFile(
      join(destination.descriptorPath, "INVOCATION"),
      expectedInvocationBytes(invocation),
      0o600,
      destination.identity.dev,
      budgetState,
      clock,
    );
    advanceHeldFreshRootBudget(budgetState, "work", clock);
    await fsyncDescriptor(destination.descriptor);
    advanceHeldFreshRootBudget(budgetState, "work", clock);
    advanceHeldFreshRootBudget(budgetState, "record-synced", clock);

    await createFreshChildDirectory(join(destination.descriptorPath, "acquisition"), budgetState, clock);
    await createFreshChildDirectory(join(destination.descriptorPath, "control"), budgetState, clock);
    const directories = [...sourceProof.ledger.specifications.entries()]
      .filter(([, specification]) => specification.kind === "directory")
      .sort(([left], [right]) => left.split("/").length - right.split("/").length || compareBytes(left, right));
    for (const [path] of directories) {
      await createFreshChildDirectory(join(destination.descriptorPath, path), budgetState, clock);
    }
    for (const [path, specification] of sourceProof.ledger.specifications) {
      if (specification.kind !== "file") continue;
      await writeCopiedFile(
        join(source.descriptorPath, path),
        join(destination.descriptorPath, path),
        specification,
        source.identity.dev,
        destination.identity.dev,
        budgetState,
        clock,
      );
    }
    await writeCopiedFile(
      join(source.descriptorPath, "control/acquisition.sh"),
      join(destination.descriptorPath, "control/acquisition.sh"),
      { kind: "file", mode: 0o444, ...acquisitionController },
      source.identity.dev,
      destination.identity.dev,
      budgetState,
      clock,
    );
    await writeCopiedFile(
      join(source.descriptorPath, "acquisition/vendor-ledger.v1"),
      join(destination.descriptorPath, "acquisition/vendor-ledger.v1"),
      { kind: "file", mode: 0o444, size: sourceProof.ledger.bytes.length, digest: sourceProof.ledger.digest },
      source.identity.dev,
      destination.identity.dev,
      budgetState,
      clock,
    );
    await createFreshChildDirectory(join(destination.descriptorPath, "docker"), budgetState, clock);
    await createFreshChildDirectory(join(destination.descriptorPath, "docker/home"), budgetState, clock);
    await createFreshChildDirectory(join(destination.descriptorPath, "docker/config"), budgetState, clock);
    await writeRebuiltFile(join(destination.descriptorPath, "docker/config/config.json"), Buffer.from("{}"), 0o400, destination.identity.dev, budgetState, clock);
    await chmodFreshPath(join(destination.descriptorPath, "docker/config"), 0o500, budgetState, clock);
    await chmodFreshPath(join(destination.descriptorPath, "docker"), 0o500, budgetState, clock);
    await chmodFreshPath(join(destination.descriptorPath, "control"), 0o555, budgetState, clock);
    for (const [path, specification] of [...directories].reverse()) {
      await chmodFreshPath(join(destination.descriptorPath, path), specification.mode, budgetState, clock);
    }
    for (const path of [
      ...directories.map(([path]) => path).reverse(),
      "docker/config",
      "docker/home",
      "docker",
      "control",
      "acquisition",
    ]) {
      syncFreshDirectoryPath(join(destination.descriptorPath, path), budgetState, clock);
    }
    advanceHeldFreshRootBudget(budgetState, "work", clock);
    await fsyncDescriptor(destination.descriptor);
    advanceHeldFreshRootBudget(budgetState, "work", clock);
    const destinationProof = await verifyCompleteInvocation(destination, budgetState, clock);
    if (destinationProof.ledger.digest !== sourceProof.ledger.digest) {
      throw new Error("fresh-root complete ledger changed during copy");
    }
    const settledSourceProof = await verifyCompleteInvocation(source, budgetState, clock);
    if (
      settledSourceProof.ledger.digest !== sourceProof.ledger.digest ||
      settledSourceProof.specifications.size !== sourceProof.specifications.size
    ) {
      throw new Error("fresh-root authenticated source changed during copy");
    }
    destination = Object.freeze({ ...destination, identity: destinationProof.rootIdentity });
    advanceHeldFreshRootBudget(budgetState, "ledger-verified", clock);

    advanceHeldFreshRootBudget(budgetState, "work", clock);
    closeSync(destination.descriptor);
    advanceHeldFreshRootBudget(budgetState, "work", clock);
    destination = Object.freeze({ ...destination, descriptor: undefined, descriptorPath: undefined });
    const rootFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_CLOEXEC;
    advanceHeldFreshRootBudget(budgetState, "work", clock);
    const custodyRoot = openSync(destination.destinationPath, rootFlags);
    custodyDescriptors.push(custodyRoot);
    const handoffRoot = openSync(destination.destinationPath, rootFlags);
    custodyDescriptors.push(handoffRoot);
    const ledgerDescriptor = openSync(join(destination.destinationPath, "acquisition/vendor-ledger.v1"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
    custodyDescriptors.push(ledgerDescriptor);
    advanceHeldFreshRootBudget(budgetState, "work", clock);
    const rootIdentity = fstatSync(custodyRoot, { bigint: true });
    const handoffIdentity = fstatSync(handoffRoot, { bigint: true });
    const ledgerIdentity = verifyRetainedLedgerDescriptor(
      ledgerDescriptor,
      {
        device: destination.identity.dev,
        digest: sourceProof.ledger.digest,
        size: sourceProof.ledger.bytes.length,
      },
      budgetState,
      clock,
    );
    if (!sameSnapshot(rootIdentity, handoffIdentity) || rootIdentity.dev !== destination.identity.dev || rootIdentity.ino !== destination.identity.ino) {
      throw new Error("fresh-root custody identities disagree");
    }
    if (
      descriptorMountIdFromBytes(readFileSync(`/proc/self/fdinfo/${custodyRoot}`)) !== destination.mountId ||
      descriptorMountIdFromBytes(readFileSync(`/proc/self/fdinfo/${handoffRoot}`)) !== destination.mountId ||
      descriptorMountIdFromBytes(readFileSync(`/proc/self/fdinfo/${ledgerDescriptor}`)) !== destination.mountId ||
      descriptorFlagsFromBytes(readFileSync(`/proc/self/fdinfo/${custodyRoot}`)) !== "02700000" ||
      descriptorFlagsFromBytes(readFileSync(`/proc/self/fdinfo/${handoffRoot}`)) !== "02700000" ||
      descriptorFlagsFromBytes(readFileSync(`/proc/self/fdinfo/${ledgerDescriptor}`)) !== "02500000"
    ) {
      throw new Error("fresh-root custody descriptor mismatch");
    }
    resultToken = Object.freeze({ kind: "openspell.wp201.fresh-root-handoff.v1" });
    resultState = {
      phase: "available",
      invocation,
      parentToken: destination.parent === "/tmp" ? "tmp" : "var-tmp",
      path: destination.destinationPath,
      device: rootIdentity.dev,
      inode: rootIdentity.ino,
      mountId: destination.mountId,
      ledgerDigest: sourceProof.ledger.digest,
      ledgerSize: sourceProof.ledger.bytes.length,
      ledgerIdentity: Object.freeze({ device: ledgerIdentity.dev, inode: ledgerIdentity.ino, uid: ledgerIdentity.uid, gid: ledgerIdentity.gid }),
      custodyRoot,
      handoffRoot,
      ledgerDescriptor,
      descriptorSettlement: {
        custodyRoot: false,
        handoffRoot: false,
        ledgerDescriptor: false,
      },
    };
  } catch (error) {
    if (destination === undefined && error instanceof Error && "freshDestination" in error) {
      destination = error.freshDestination;
    }
    operationError = error;
  }
  const closeErrors = [];
  if (source !== undefined) {
    try { closeSync(source.descriptor); } catch (error) { closeErrors.push(error); }
  }
  if (destination?.descriptor !== undefined) {
    try { closeSync(destination.descriptor); } catch (error) { closeErrors.push(error); }
  }
  if (
    operationError === undefined &&
    closeErrors.length === 0 &&
    budgetState !== undefined &&
    clock !== undefined
  ) {
    try {
      advanceHeldFreshRootBudget(budgetState, "work", clock);
    } catch (error) {
      operationError = error;
    }
  }
  if (operationError !== undefined || closeErrors.length > 0) {
    closeErrors.push(...await closeRawDescriptors(custodyDescriptors));
    let cleanup;
    try {
      if (
        destination !== undefined &&
        invocation !== undefined &&
        budgetState !== undefined &&
        clock !== undefined
      ) {
        cleanup = await settleFreshRootConstruction(
          destination,
          invocation,
          budgetState,
          clock,
        );
      }
    } catch (error) {
      closeErrors.push(error);
      cleanup = error?.cleanup ?? Object.freeze({
        ...(destination !== undefined && invocation !== undefined && budgetState !== undefined
          ? cleanupRecord(destination, invocation, budgetState.value.cleanupState)
          : undefined),
        outcome: "cleanup-failed-or-deadline-reached",
      });
    }
    try { clock?.close(); } catch (error) { closeErrors.push(error); }
    const combined = operationError === undefined
      ? new AggregateError(closeErrors, "fresh-root copy settlement failed")
      : combinedFailure(operationError, closeErrors, "fresh-root copy settlement failed");
    const failure = combined instanceof Error ? combined : new Error("fresh-root copy failed", { cause: combined });
    Object.defineProperty(failure, "cleanup", {
      configurable: false,
      enumerable: true,
      value: cleanup,
      writable: false,
    });
    throw failure;
  }
  try {
    clock?.close();
  } catch (error) {
    closeErrors.push(error);
  }
  if (closeErrors.length > 0) {
    closeErrors.push(...await closeRawDescriptors(custodyDescriptors));
    const failure = new AggregateError(closeErrors, "fresh-root copy settlement failed");
    Object.defineProperty(failure, "cleanup", {
      configurable: false,
      enumerable: true,
      value: Object.freeze({
        ...(destination !== undefined && invocation !== undefined && budgetState !== undefined
          ? cleanupRecord(destination, invocation, budgetState.value.cleanupState)
          : undefined),
        outcome: "clock-close-failed-after-construction",
      }),
      writable: false,
    });
    throw failure;
  }
  if (resultToken === undefined || resultState === undefined) {
    closeErrors.push(...await closeRawDescriptors(custodyDescriptors));
    throw new AggregateError(closeErrors, "fresh-root handoff token missing");
  }
  freshRootTokens.set(resultToken, resultState);
  return resultToken;
}

function freshRootCleanupFromState(state) {
  return Object.freeze({
    parentToken: state.parentToken,
    invocation: state.invocation,
    path: state.path,
    device: state.device,
    inode: state.inode,
    mountId: state.mountId,
    state: "ledger-backed",
  });
}

function descriptorIdentityRecord(identity, mountId) {
  return Object.freeze({
    device: identity.device ?? identity.dev,
    inode: identity.inode ?? identity.ino,
    uid: identity.uid,
    gid: identity.gid,
    mountId,
  });
}

function sameDescriptorIdentityRecord(left, right) {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mountId === right.mountId
  );
}

function observePrivateDescriptor(descriptor) {
  const identity = fstatSync(descriptor, { bigint: true });
  const mountId = descriptorMountIdFromBytes(readFileSync(`/proc/self/fdinfo/${descriptor}`));
  return descriptorIdentityRecord(identity, mountId);
}

function matchingPrivateDescriptors(expected) {
  const matches = [];
  const errors = [];
  for (const name of readdirSync("/proc/self/fd")) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(name)) continue;
    const descriptor = Number(name);
    if (!Number.isSafeInteger(descriptor)) continue;
    try {
      const observed = observePrivateDescriptor(descriptor);
      if (sameDescriptorIdentityRecord(observed, expected)) {
        matches.push(Object.freeze({ descriptor, observed }));
      }
    } catch (error) {
      if (error?.code !== "EBADF" && error?.code !== "ENOENT") errors.push(error);
    }
  }
  matches.sort((left, right) => right.descriptor - left.descriptor);
  return Object.freeze({ errors: Object.freeze(errors), matches: Object.freeze(matches) });
}

function settlePrivateDescriptorIdentity(expected, protectedDescriptors = []) {
  const protectedSet = new Set(protectedDescriptors);
  const before = matchingPrivateDescriptors(expected);
  const closeErrors = [...before.errors];
  const protectedBefore = before.matches.filter(({ descriptor }) => protectedSet.has(descriptor));
  for (const { descriptor } of before.matches) {
    if (protectedSet.has(descriptor)) continue;
    try {
      closeSync(descriptor);
    } catch (error) {
      closeErrors.push(error);
    }
  }
  const after = matchingPrivateDescriptors(expected);
  const probeErrors = [...after.errors];
  const protectedAfter = after.matches.filter(({ descriptor }) => protectedSet.has(descriptor));
  const unexpectedAfter = after.matches.filter(({ descriptor }) => !protectedSet.has(descriptor));
  const protectedStable =
    protectedBefore.length === protectedSet.size &&
    protectedAfter.length === protectedSet.size;
  return Object.freeze({
    closeError: closeErrors.length === 0
      ? undefined
      : new AggregateError(closeErrors, "fresh-root identity descriptor close failed"),
    expected,
    observedMatches: before.matches.length,
    protectedMatches: protectedAfter.length,
    probeError: probeErrors.length === 0
      ? undefined
      : new AggregateError(probeErrors, "fresh-root identity descriptor scan failed"),
    remainingMatches: unexpectedAfter.length,
    settled:
      probeErrors.length === 0 &&
      unexpectedAfter.length === 0 &&
      protectedStable,
  });
}

function settlePrivateDescriptor(descriptor, expected) {
  let observedBefore;
  let probeError;
  try {
    observedBefore = observePrivateDescriptor(descriptor);
  } catch (error) {
    if (error?.code === "EBADF") {
      return Object.freeze({
        closeError: undefined,
        expected,
        observed: undefined,
        probeError: undefined,
        settled: true,
      });
    }
    probeError = error;
  }
  if (probeError !== undefined) {
    return Object.freeze({
      closeError: undefined,
      expected,
      observed: observedBefore,
      probeError,
      settled: false,
    });
  }
  if (
    expected !== undefined &&
    !sameDescriptorIdentityRecord(observedBefore, expected)
  ) {
    return Object.freeze({
      closeError: undefined,
      expected,
      identityMismatch: true,
      observed: observedBefore,
      probeError: undefined,
      settled: false,
    });
  }
  let closeError;
  try {
    closeSync(descriptor);
  } catch (error) {
    closeError = error;
  }
  let observed;
  probeError = undefined;
  try {
    observed = observePrivateDescriptor(descriptor);
  } catch (error) {
    if (error?.code !== "EBADF") probeError = error;
  }
  const settled = observed === undefined && probeError === undefined;
  return Object.freeze({
    closeError,
    expected,
    observed,
    probeError,
    settled,
  });
}

function freshRootCustodyFromState(state) {
  return Object.freeze({
    custodyRoot: state.custodyRoot,
    ledgerDescriptor: state.ledgerDescriptor,
    ledgerDigest: state.ledgerDigest,
    ledgerIdentity: state.ledgerIdentity,
    ledgerSize: state.ledgerSize,
  });
}

function freshRootLaunchFromRecovery(recovery, child, spawnError) {
  return Object.freeze({
    child,
    cleanup: recovery.cleanup,
    custody: recovery.custody,
    outcome: spawnError === undefined
      ? child === undefined ? "not-created" : "spawned"
      : "synchronous-spawn-failure",
    spawnError,
  });
}

function handoffIdentityFromState(state) {
  return descriptorIdentityRecord(
    {
      device: state.device,
      gid: BigInt(process.getgid()),
      inode: state.inode,
      uid: BigInt(process.getuid()),
    },
    state.mountId,
  );
}

function descriptorSettlementErrors(settlement) {
  return [settlement.closeError, settlement.probeError].filter(
    (error) => error !== undefined,
  );
}

function exactOrderedFailure(errors, message, fallbackMessage) {
  const ordered = [...errors];
  if (ordered.length === 0) ordered.push(new Error(fallbackMessage));
  return ordered.length === 1
    ? ordered[0]
    : new AggregateError(ordered, message, { cause: ordered[0] });
}

function descriptorSettlementFailure(settlement, message) {
  const errors = descriptorSettlementErrors(settlement);
  if (errors.length === 0 && settlement.settled) return undefined;
  return exactOrderedFailure(
    errors,
    message,
    "fresh-root handoff descriptor remained open",
  );
}

function bindFreshRootHandoffFailure(
  failure,
  recovery,
  child,
  spawnError,
  handoffSettlement,
) {
  freshRootHandoffFailures.set(failure, Object.freeze({
    expected: recovery.expected,
    handoffSettlement,
    launch: freshRootLaunchFromRecovery(recovery, child, spawnError),
    protectedDescriptors: Object.freeze([recovery.custody.custodyRoot]),
  }));
  return failure;
}

function registerHandoffFailure(recovery, child, spawnError, handoffSettlement) {
  const handoffErrors = descriptorSettlementErrors(handoffSettlement);
  if (handoffErrors.length === 0) {
    handoffErrors.push(new Error("fresh-root handoff descriptor remained open"));
  }
  const failure = exactOrderedFailure(
    [spawnError, ...handoffErrors].filter((error) => error !== undefined),
    "fresh-root spawn and handoff settlement failed",
    "fresh-root handoff failed",
  );
  return bindFreshRootHandoffFailure(
    failure,
    recovery,
    child,
    spawnError,
    handoffSettlement,
  );
}

function settleHandoffForClaim(state) {
  const expected = handoffIdentityFromState(state);
  const failures = [];
  let finalSettlement;
  try {
    const initial = settlePrivateDescriptor(state.handoffRoot, expected);
    const initialFailure = descriptorSettlementFailure(
      initial,
      "fresh-root initial handoff settlement failed",
    );
    if (initialFailure !== undefined) failures.push(initialFailure);
    finalSettlement = initial;
    if (!initial.settled) {
      finalSettlement = settlePrivateDescriptorIdentity(expected, [state.custodyRoot]);
      const retryFailure = descriptorSettlementFailure(
        finalSettlement,
        "fresh-root handoff identity retry failed",
      );
      if (retryFailure !== undefined) failures.push(retryFailure);
    }
  } catch (error) {
    failures.push(error);
    finalSettlement = Object.freeze({
      closeError: undefined,
      expected,
      probeError: error,
      settled: false,
    });
  }
  state.descriptorSettlement.handoffRoot = finalSettlement.settled;
  return Object.freeze({
    handoffSettlement: finalSettlement,
    recoveryFailure: failures.length === 0
      ? undefined
      : exactOrderedFailure(
        failures,
        "fresh-root handoff cleanup failed",
        "fresh-root handoff cleanup failed",
      ),
  });
}

function launchFixedFreshRootCut(token, program) {
  const state = freshRootTokens.get(token);
  if (state === undefined || state.phase !== "available") {
    throw new Error("fresh-root handoff token is invalid or consumed");
  }
  const recovery = Object.freeze({
    cleanup: freshRootCleanupFromState(state),
    custody: freshRootCustodyFromState(state),
    expected: handoffIdentityFromState(state),
  });
  state.phase = "launching";
  freshRootTokens.delete(token);
  let child;
  let spawnError;
  try {
    child = spawnContained(
      spawn,
      capturedNodeExecutable,
      ["--input-type=module", "--eval", program],
      {
        cwd: proofPackageDirectory,
        detached: true,
        env: { LANG: "C", LC_ALL: "C" },
        holdRelease: true,
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe", state.handoffRoot],
      },
    );
  } catch (error) {
    spawnError = error;
  }
  let handoffSettlement;
  try {
    handoffSettlement = settlePrivateDescriptor(state.handoffRoot, recovery.expected);
  } catch (error) {
    handoffSettlement = Object.freeze({
      closeError: undefined,
      expected: recovery.expected,
      probeError: error,
      settled: false,
    });
  }
  state.descriptorSettlement.handoffRoot = handoffSettlement.settled;
  if (
    !handoffSettlement.settled ||
    handoffSettlement.closeError !== undefined ||
    handoffSettlement.probeError !== undefined
  ) {
    if (child !== undefined) abortContainedChild(child);
    throw registerHandoffFailure(recovery, child, spawnError, handoffSettlement);
  }
  if (child !== undefined) {
    try {
      releaseContainedChild(child);
    } catch (error) {
      const primary = error instanceof Error
        ? error
        : new Error("fresh-root contained child release failed", { cause: error });
      let failure = primary;
      try {
        abortContainedChild(child);
      } catch (abortError) {
        failure = new AggregateError(
          [primary, abortError],
          "fresh-root contained child release and abort failed",
          { cause: primary },
        );
      }
      throw bindFreshRootHandoffFailure(
        failure,
        recovery,
        child,
        spawnError,
        handoffSettlement,
      );
    }
  }
  return freshRootLaunchFromRecovery(recovery, child, spawnError);
}

export function launchBeforeIssueFreshRoot(token) {
  return launchFixedFreshRootCut(token, fixedCutPrograms.beforeIssue);
}

export function launchAfterDaemonAcceptBeforeDeliveryFreshRoot(token) {
  return launchFixedFreshRootCut(token, fixedCutPrograms.afterDaemonAcceptBeforeDelivery);
}

export function launchAfterParentCustodyBeforeStartFreshRoot(token) {
  return launchFixedFreshRootCut(token, fixedCutPrograms.afterParentCustodyBeforeStart);
}

export function claimFreshRootHandoffFailure(error) {
  const failure = freshRootHandoffFailures.get(error);
  if (failure === undefined) return undefined;
  freshRootHandoffFailures.delete(error);
  let handoffSettlement = failure.handoffSettlement;
  let recoveryFailure;
  if (!handoffSettlement.settled) {
    try {
      handoffSettlement = settlePrivateDescriptorIdentity(
        failure.expected,
        failure.protectedDescriptors,
      );
      recoveryFailure = descriptorSettlementFailure(
        handoffSettlement,
        "fresh-root handoff identity recovery failed",
      );
    } catch (settlementError) {
      handoffSettlement = Object.freeze({
        closeError: undefined,
        expected: failure.expected,
        probeError: settlementError,
        settled: false,
      });
      recoveryFailure = settlementError;
    }
  }
  return Object.freeze({ handoffSettlement, launch: failure.launch, recoveryFailure });
}

export function claimFreshRootCleanup(token) {
  const state = freshRootTokens.get(token);
  if (state === undefined || state.phase !== "available") {
    throw new Error("fresh-root handoff token is invalid or consumed");
  }
  state.phase = "cleanup-claimed";
  freshRootTokens.delete(token);
  const settlement = settleHandoffForClaim(state);
  return Object.freeze({
    handoffSettlement: settlement.handoffSettlement,
    launch: freshRootLaunchFromRecovery(
      Object.freeze({
        cleanup: freshRootCleanupFromState(state),
        custody: freshRootCustodyFromState(state),
      }),
      undefined,
      undefined,
    ),
    recoveryFailure: settlement.recoveryFailure,
  });
}

export async function abandonFreshRootHandoff(token) {
  const state = freshRootTokens.get(token);
  if (state === undefined || !["available", "settlement-failed"].includes(state.phase)) {
    throw new Error("fresh-root handoff token is invalid or consumed");
  }
  const identitySettlement = state.phase === "settlement-failed";
  state.phase = "settling";
  const rootIdentity = { device: state.device, gid: BigInt(process.getgid()), inode: state.inode, uid: BigInt(process.getuid()) };
  const expectedCustodyRoot = descriptorIdentityRecord(
    rootIdentity,
    state.mountId,
  );
  const expectedHandoffRoot = descriptorIdentityRecord(
    rootIdentity,
    state.mountId,
  );
  const expectedLedger = descriptorIdentityRecord(
    state.ledgerIdentity,
    state.mountId,
  );
  const attempts = [];
  for (const [name, descriptor, expected] of [
    ["ledgerDescriptor", state.ledgerDescriptor, expectedLedger],
    ["handoffRoot", state.handoffRoot, expectedHandoffRoot],
    ["custodyRoot", state.custodyRoot, expectedCustodyRoot],
  ]) {
    if (state.descriptorSettlement[name]) continue;
    const result = identitySettlement
      ? settlePrivateDescriptorIdentity(expected)
      : settlePrivateDescriptor(descriptor, expected);
    state.descriptorSettlement[name] = result.settled;
    attempts.push(Object.freeze({ name, ...result }));
  }
  const cleanup = freshRootCleanupFromState(state);
  const unsettled = attempts.filter(({ settled }) => !settled);
  const errors = attempts.flatMap(({ closeError, probeError }) =>
    [closeError, probeError].filter((error) => error !== undefined),
  );
  if (unsettled.length > 0) {
    state.phase = "settlement-failed";
    const failure = new AggregateError(errors, "fresh-root handoff settlement incomplete");
    Object.defineProperties(failure, {
      cleanup: { enumerable: true, value: cleanup },
      unsettled: { enumerable: true, value: Object.freeze(unsettled) },
    });
    throw failure;
  }
  freshRootTokens.delete(token);
  state.phase = "settled";
  if (errors.length > 0) {
    const failure = new AggregateError(errors, "fresh-root handoff close anomaly");
    Object.defineProperties(failure, {
      cleanup: { enumerable: true, value: cleanup },
      unsettled: { enumerable: true, value: Object.freeze([]) },
    });
    throw failure;
  }
  return cleanup;
}
