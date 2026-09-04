import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  close as closeCallback,
  closeSync,
  constants,
  fchmod as fchmodCallback,
  fstat as fstatCallback,
  fsync as fsyncCallback,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { TextDecoder } from "node:util";

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
  ["tools/hosted-migration-root-authority/src/authority_registry.rs", "d8c1ad93f8d3f7f1c2cefcd46f076741a68c607f"],
  ["tools/hosted-migration-root-authority/src/authority_registry_tests.rs", "2bc2416f00b255ce48121d71b4470d5c481a5329"],
  ["tools/hosted-migration-root-authority/src/canonical.rs", "1e76e4032fda57f1fd295184d49e461eecfa0393"],
  ["tools/hosted-migration-root-authority/src/corruption_tests.rs", "5433d0add00d0b8a1c970b1a688cd00c27bcd17d"],
  ["tools/hosted-migration-root-authority/src/cross_version_tests.rs", "f6704a0503f31dc14f2e0e2583ec26612bdad607"],
  ["tools/hosted-migration-root-authority/src/crypto.rs", "225528242e861ddec841f74461edc5c3dce06182"],
  ["tools/hosted-migration-root-authority/src/grant-ticket-v1.golden.json", "b81971ff9ac4f28477b17645682ef9d1e63aab7f"],
  ["tools/hosted-migration-root-authority/src/ipc.rs", "34ba15f85e6ec318081517191f04e5c974b728e9"],
  ["tools/hosted-migration-root-authority/src/journal.rs", "53dde98a770c3b21369478b1f3a175da15f372b4"],
  ["tools/hosted-migration-root-authority/src/journal/storage.rs", "6a531478729fd71afb76572b405176262718a842"],
  ["tools/hosted-migration-root-authority/src/lib.rs", "13992f6b0439374977357692e733bdd3fb6e5962"],
  ["tools/hosted-migration-root-authority/src/mutation_tests.rs", "e0868fa95ce23cfe86a8f4ac64bbbeba9d875deb"],
  ["tools/hosted-migration-root-authority/src/policy_matrix_tests.rs", "64c7a8810a2a4d8944aa95af700a6bf1c5912803"],
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

const SOURCE_REGULAR_FILE_BYTES = 1_281_104;
const workspaceDirectory = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const invocationSourcePattern = /^\/(?:tmp|var\/tmp)\/openspell-wp201-root-proof-[0-9a-f]{64}\/source$/u;
const invocationPrefix = "openspell-wp201-root-proof-";
const invocationRecordPrefix = "openspell.wp201.invocation.v1\n";
const sourceLogicalDirectories = new Set(
  fixedSourceDirectories.slice(1).map((path) => path.slice("source/".length)),
);
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
