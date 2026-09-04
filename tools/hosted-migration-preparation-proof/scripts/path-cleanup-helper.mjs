import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  opendirSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import process from "node:process";
import { TextDecoder } from "node:util";

const CONTROL_MAGIC = "openspell.wp201.path-cleanup.v2";
const FAILED_CUT_CONTROL_MAGIC = "openspell.wp201.path-cleanup-failed-cut.v1";
const INVOCATION_PREFIX = "openspell-wp201-root-proof-";
const INVOCATION_MAGIC = "openspell.wp201.invocation.v1";
const COMPLETION = Buffer.from("openspell.wp201.path-cleanup-complete.v2\n");
const FAILED_CUT_COMPLETION = Buffer.from(
  "openspell.wp201.path-cleanup-failed-cut-complete.v1\n",
);
const REFUSAL = Buffer.from("openspell.wp201.path-cleanup-refused.v2\n");
const LEDGER_MAGIC = "openspell.wp201.vendor-ledger.v1";

const MAX_CONTROL_BYTES = 512;
const MAX_DIAGNOSTIC_BYTES = 4_096;
const MAX_ENTRIES = 131_072;
const MAX_DEPTH = 64;
const MAX_RELATIVE_PATH_BYTES = 1_024;
const MAX_TOTAL_PATH_BYTES = 16 * 1024 * 1024;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 2n * 1024n * 1024n * 1024n;
const MAX_U64 = (1n << 64n) - 1n;
const LEDGER_RECORDS = 4_853;
const SOURCE_FILES = 45;
const SOURCE_DIRECTORIES = 10;
const VENDOR_FILES = 3_657;
const VENDOR_DIRECTORIES = 941;
const VENDOR_BYTES = 67_159_121n;
const TOOLCHAIN_FILES = 168;
const TOOLCHAIN_DIRECTORIES = 28;
const TOOLCHAIN_BYTES = 653_573_520n;

const ACQUISITION_CONTROLLER = Object.freeze({
  size: 9_956,
  digest: "72290e827399c5e6eb4c597312a65fbd6402c2d8ad87993c7e336a27f6d48258",
});
const PROOF_CONTROLLER = Object.freeze({
  size: 30_322,
  digest: "914feaa7cece86e66a81a4dd8595d7efc2ae2e7be241d6190aee97c5c213bfcb",
});

const AUTHORITY_INPUTS = new Map([
  [
    "tools/hosted-migration-preparation-proof/Cargo.toml",
    [558, "5c89e16cac4721f4a968b2089efcea8fb9c1fe98225d6979166e2c2a3461bad9"],
  ],
  [
    "tools/hosted-migration-preparation-proof/Cargo.lock",
    [15_208, "f3455774926880919588246bc9fc422e3ece13c29250862b4249b91b55ecbc86"],
  ],
  [
    "tools/hosted-migration-preparation-proof/rust-toolchain.toml",
    [86, "8e390d6a0838315f972690f46ef8bae8b7ecc9ee6c1ed70140ef852869c2482e"],
  ],
  [
    "tools/hosted-migration-root-authority/Cargo.toml",
    [787, "7639e2f59bb0c745b54a192478d86bba1ab1a046066ea490efa6b783e4e2860a"],
  ],
  [
    "tools/hosted-migration-root-authority/Cargo.lock",
    [13_741, "bd460b4ca9b06241a393eb9d4b5bcc05b68a6d6af844fab1f9a683826979f6f5"],
  ],
  [
    "tools/hosted-migration-root-authority/rust-toolchain.toml",
    [86, "8e390d6a0838315f972690f46ef8bae8b7ecc9ee6c1ed70140ef852869c2482e"],
  ],
  [
    "tools/hosted-migration-runtime-proof/Cargo.toml",
    [1_047, "cfca33ad8a621f30fd54c4a9843eb1dd2add8a91cb4d785c60cabd4ccb945364"],
  ],
  [
    "tools/hosted-migration-runtime-proof/Cargo.lock",
    [15_493, "58e3c00b558af03db96516e7e62f5df170630a28a9c29395b1e1de477a82f6aa"],
  ],
  [
    "tools/hosted-migration-runtime-proof/rust-toolchain.toml",
    [86, "8e390d6a0838315f972690f46ef8bae8b7ecc9ee6c1ed70140ef852869c2482e"],
  ],
]);

const SOURCE_PACKAGES = Object.freeze([
  "hosted-migration-preparation-proof",
  "hosted-migration-root-authority",
  "hosted-migration-runtime-proof",
]);
const SOURCE_JSON_INPUTS = new Set([
  "tools/hosted-migration-root-authority/src/grant-ticket-v1.golden.json",
  "tools/hosted-migration-root-authority/src/preparation-policy-v1.golden.json",
  "tools/hosted-migration-root-authority/src/transition-v1.golden.json",
  "tools/hosted-migration-runtime-proof/fixtures/wp199-grant-ticket-v1.golden.json",
]);
const CONTROL_FILES = new Map([
  ["control/proof.sh", "control/proof.sh"],
  ["etc/hostname", "control/hostname"],
  ["etc/hosts", "control/hosts"],
  ["etc/resolv.conf", "control/resolv.conf"],
]);

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const slash = Buffer.from("/");

class Refusal extends Error {}

function refuse() {
  throw new Refusal();
}

function requireThat(condition) {
  if (!condition) refuse();
}

function modeBits(stat) {
  return Number(stat.mode & 0o7777n);
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.rdev === right.rdev &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameDirectoryIdentity(left, right) {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

function sameDirectoryAfterPermissionRestore(before, after) {
  return (
    sameDirectoryIdentity(before, after) &&
    before.nlink === after.nlink &&
    before.rdev === after.rdev &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    after.ctimeNs >= before.ctimeNs &&
    modeBits(after) === 0o700
  );
}

function sameUnlinkIdentity(expected, observed, linksAlreadyRemoved) {
  return (
    expected.dev === observed.dev &&
    expected.ino === observed.ino &&
    expected.mode === observed.mode &&
    expected.uid === observed.uid &&
    expected.gid === observed.gid &&
    expected.rdev === observed.rdev &&
    expected.size === observed.size &&
    expected.mtimeNs === observed.mtimeNs &&
    observed.ctimeNs >= expected.ctimeNs &&
    expected.nlink > linksAlreadyRemoved &&
    observed.nlink === expected.nlink - linksAlreadyRemoved
  );
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
    requireThat(written > 0);
    offset += written;
  }
}

function readDescriptorBounded(descriptor, maximumBytes) {
  const chunks = [];
  const scratch = Buffer.allocUnsafe(256);
  let total = 0;
  for (;;) {
    const count = readSync(descriptor, scratch, 0, scratch.length, null);
    if (count === 0) break;
    total += count;
    requireThat(total <= maximumBytes);
    chunks.push(Buffer.from(scratch.subarray(0, count)));
  }
  return Buffer.concat(chunks, total);
}

function decodeExactUtf8(bytes) {
  let value;
  try {
    value = utf8Decoder.decode(bytes);
  } catch {
    refuse();
  }
  requireThat(Buffer.from(value, "utf8").equals(bytes));
  return value;
}

function parseUnsigned(value) {
  requireThat(/^(?:0|[1-9][0-9]*)$/u.test(value));
  const parsed = BigInt(value);
  requireThat(parsed <= MAX_U64);
  return parsed;
}

function parseControl(bytes) {
  const value = decodeExactUtf8(bytes);
  requireThat(!value.includes("\0") && !value.includes("\r"));
  const fields = value.split("\n");
  requireThat(fields.at(-1) === "");
  if (fields[0] === FAILED_CUT_CONTROL_MAGIC) {
    requireThat(fields.length === 8);
    const [magic, parentToken, invocation, device, inode, mountId, ledgerDigest] = fields;
    requireThat(magic === FAILED_CUT_CONTROL_MAGIC);
    requireThat(parentToken === "tmp" || parentToken === "var-tmp");
    requireThat(/^[0-9a-f]{64}$/u.test(invocation));
    requireThat(/^[0-9a-f]{64}$/u.test(ledgerDigest));
    return {
      protocol: "failed-cut",
      parentToken,
      invocation,
      device: parseUnsigned(device),
      inode: parseUnsigned(inode),
      mountId: parseUnsigned(mountId),
      ledgerDigest,
    };
  }

  requireThat(fields.length === 7);
  const [magic, parentToken, invocation, device, inode, cleanupState] = fields;
  requireThat(magic === CONTROL_MAGIC);
  requireThat(parentToken === "tmp" || parentToken === "var-tmp");
  requireThat(/^[0-9a-f]{64}$/u.test(invocation));
  requireThat(
    cleanupState === "pre-record" ||
      cleanupState === "partial-acquisition" ||
      cleanupState === "ledger-backed",
  );
  return {
    protocol: "normal",
    parentToken,
    invocation,
    device: parseUnsigned(device),
    inode: parseUnsigned(inode),
    cleanupState,
  };
}

function appendPath(parent, name) {
  return Buffer.concat([parent, slash, name]);
}

function appendRelative(parent, name) {
  return parent.length === 0 ? Buffer.from(name) : Buffer.concat([parent, slash, name]);
}

function readPathBounded(path, maximumBytes) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_CLOEXEC);
  try {
    return readDescriptorBounded(descriptor, maximumBytes);
  } finally {
    closeSync(descriptor);
  }
}

function descriptorInfo(descriptor) {
  const text = decodeExactUtf8(
    readPathBounded(`/proc/self/fdinfo/${descriptor}`, 4_096),
  );
  requireThat(text.endsWith("\n") && !text.includes("\r") && !text.includes("\0"));
  const flagMatches = [...text.matchAll(/^flags:\s+(?<flags>[0-7]+)$/gmu)];
  const mountMatches = [...text.matchAll(/^mnt_id:\s+(?<mountId>[1-9][0-9]*)$/gmu)];
  requireThat(flagMatches.length === 1 && mountMatches.length === 1);
  const flags = flagMatches[0]?.groups?.flags;
  const mountId = mountMatches[0]?.groups?.mountId;
  requireThat(flags !== undefined && mountId !== undefined);
  return { flags, mountId: parseUnsigned(mountId) };
}

function descriptorIdentity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

function descriptorTableIdentityCount(expected) {
  const directory = opendirSync("/proc/self/fd", { encoding: "buffer" });
  const descriptors = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      const name = Buffer.isBuffer(entry.name)
        ? entry.name.toString("ascii")
        : entry.name;
      if (/^(?:0|[1-9][0-9]*)$/u.test(name)) descriptors.push(Number(name));
    }
  } finally {
    directory.closeSync();
  }

  let count = 0;
  for (const descriptor of descriptors) {
    try {
      const observed = fstatSync(descriptor, { bigint: true });
      if (observed.dev === expected.dev && observed.ino === expected.ino) count += 1;
    } catch (error) {
      requireThat(error?.code === "EBADF" || error?.code === "ENOENT");
    }
  }
  return count;
}

function decodeMountPath(value) {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    const octal = value.slice(index + 1, index + 4);
    requireThat(/^[0-7]{3}$/u.test(octal));
    decoded += String.fromCharCode(Number.parseInt(octal, 8));
    index += 3;
  }
  return decoded;
}

function assertNoNestedMounts(targetPath) {
  const bytes = readPathBounded("/proc/self/mountinfo", MAX_LEDGER_BYTES);
  const text = bytes.toString("latin1");
  requireThat(text.endsWith("\n") && !text.includes("\0") && !text.includes("\r"));
  const lines = text.slice(0, -1).split("\n");
  requireThat(lines.length > 0);
  for (const line of lines) {
    const separator = line.indexOf(" - ");
    requireThat(separator > 0);
    const fields = line.slice(0, separator).split(" ");
    requireThat(fields.length >= 6);
    const mountPoint = decodeMountPath(fields[4]);
    requireThat(mountPoint !== targetPath && !mountPoint.startsWith(`${targetPath}/`));
  }
}

function assertPartialEntryType(stat) {
  requireThat(
    stat.isDirectory() ||
      stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.isFIFO() ||
      stat.isSocket(),
  );
}

function walkInvocation(
  rootPath,
  rootIdentity,
  expectedUid,
  expectedGid,
  expectedDevice,
  requireTextPaths,
) {
  const entries = [];
  const directories = [];
  let totalPathBytes = 0;

  function visit(directoryPath, relativeDirectory, depth, expectedIdentity) {
    requireThat(depth <= MAX_DEPTH);
    const before = lstatSync(directoryPath, { bigint: true });
    requireThat(
      sameIdentity(expectedIdentity, before) &&
        before.isDirectory() &&
        before.uid === expectedUid &&
        before.gid === expectedGid &&
        before.dev === expectedDevice,
    );
    if (modeBits(before) !== 0o700) chmodSync(directoryPath, 0o700);
    const restored = lstatSync(directoryPath, { bigint: true });
    requireThat(
      modeBits(before) === 0o700
        ? sameIdentity(before, restored)
        : sameDirectoryAfterPermissionRestore(before, restored),
    );
    const directory = opendirSync(directoryPath, { encoding: "buffer" });
    try {
      for (;;) {
        const dirent = directory.readSync();
        if (dirent === null) break;
        const name = Buffer.isBuffer(dirent.name)
          ? Buffer.from(dirent.name)
          : Buffer.from(dirent.name, "utf8");
        requireThat(name.length > 0 && !name.includes(0x00) && !name.includes(0x2f));
        const relative = appendRelative(relativeDirectory, name);
        const entryDepth = depth + 1;
        requireThat(entryDepth <= MAX_DEPTH);
        requireThat(relative.length <= MAX_RELATIVE_PATH_BYTES);
        totalPathBytes += relative.length;
        requireThat(totalPathBytes <= MAX_TOTAL_PATH_BYTES);
        requireThat(entries.length < MAX_ENTRIES);

        const absolute = appendPath(directoryPath, name);
        const stat = lstatSync(absolute, { bigint: true });
        requireThat(
          stat.uid === expectedUid &&
            stat.gid === expectedGid &&
            stat.dev === expectedDevice,
        );
        assertPartialEntryType(stat);

        let relativeText;
        if (requireTextPaths) {
          relativeText = decodeExactUtf8(relative);
        }
        const entry = { absolute, relative, relativeText, stat };
        entries.push(entry);
        if (stat.isDirectory()) {
          const restoredStat = visit(absolute, relative, entryDepth, stat);
          directories.push({ ...entry, restoredStat });
        }
      }
    } finally {
      directory.closeSync();
    }
    return restored;
  }

  visit(Buffer.from(rootPath), Buffer.alloc(0), 0, rootIdentity);
  return { entries, directories };
}

function requireExpectedFileStat(entry, expectedMode, maximumSize = MAX_FILE_BYTES) {
  requireThat(
    entry !== undefined &&
      entry.stat.isFile() &&
      modeBits(entry.stat) === expectedMode &&
      entry.stat.nlink === 1n &&
      entry.stat.size >= 0n &&
      entry.stat.size <= BigInt(maximumSize),
  );
}

function readStableFile(entry, maximumBytes) {
  requireThat(entry.stat.size <= BigInt(maximumBytes));
  const before = lstatSync(entry.absolute, { bigint: true });
  requireThat(sameIdentity(entry.stat, before));
  const descriptor = openSync(
    entry.absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC,
  );
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    requireThat(sameIdentity(before, opened));
    const size = Number(opened.size);
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(descriptor, bytes, offset, size - offset, offset);
      requireThat(count > 0);
      offset += count;
    }
    const probe = Buffer.allocUnsafe(1);
    requireThat(readSync(descriptor, probe, 0, 1, size) === 0);
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(entry.absolute, { bigint: true });
    requireThat(sameIdentity(opened, after) && sameIdentity(after, pathAfter));
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function digestStableFile(entry) {
  requireThat(entry.stat.size <= BigInt(MAX_FILE_BYTES));
  const before = lstatSync(entry.absolute, { bigint: true });
  requireThat(sameIdentity(entry.stat, before));
  const descriptor = openSync(
    entry.absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC,
  );
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    requireThat(sameIdentity(before, opened));
    const digest = createHash("sha256");
    const scratch = Buffer.allocUnsafe(64 * 1024);
    let offset = 0n;
    while (offset < opened.size) {
      const remaining = opened.size - offset;
      const requested = Number(remaining < BigInt(scratch.length) ? remaining : scratch.length);
      const count = readSync(descriptor, scratch, 0, requested, Number(offset));
      requireThat(count > 0);
      digest.update(scratch.subarray(0, count));
      offset += BigInt(count);
    }
    const probe = Buffer.allocUnsafe(1);
    requireThat(readSync(descriptor, probe, 0, 1, Number(opened.size)) === 0);
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(entry.absolute, { bigint: true });
    requireThat(sameIdentity(opened, after) && sameIdentity(after, pathAfter));
    return digest.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function requireExactFile(entry, expectedMode, expectedBytes) {
  requireExpectedFileStat(entry, expectedMode, expectedBytes.length);
  requireThat(entry.stat.size === BigInt(expectedBytes.length));
  requireThat(readStableFile(entry, expectedBytes.length).equals(expectedBytes));
}

function requireDigestFile(entry, expectedMode, expectedSize, expectedDigest) {
  requireExpectedFileStat(entry, expectedMode);
  requireThat(entry.stat.size === BigInt(expectedSize));
  requireThat(digestStableFile(entry) === expectedDigest);
}

function requireExactDirectory(entry, expectedMode) {
  requireThat(
    entry !== undefined && entry.stat.isDirectory() && modeBits(entry.stat) === expectedMode,
  );
}

function validatePathGrammar(path) {
  requireThat(
    path.length > 0 &&
      Buffer.byteLength(path, "utf8") <= MAX_RELATIVE_PATH_BYTES &&
      /^[A-Za-z0-9._+@/-]+$/u.test(path) &&
      !path.startsWith("/") &&
      !path.includes("//"),
  );
  for (const component of path.split("/")) {
    requireThat(component !== "" && component !== "." && component !== "..");
  }
}

function sourcePathAllowed(path) {
  if (SOURCE_JSON_INPUTS.has(path)) return true;
  for (const packageName of SOURCE_PACKAGES) {
    const prefix = `tools/${packageName}/`;
    if (!path.startsWith(prefix)) continue;
    const relative = path.slice(prefix.length);
    if (
      relative === "Cargo.toml" ||
      relative === "Cargo.lock" ||
      relative === "rust-toolchain.toml"
    ) {
      return true;
    }
    return /^src\/(?:[A-Za-z0-9._+@-]+\/)*[A-Za-z0-9._+@-]+\.rs$/u.test(relative);
  }
  return false;
}

function mapDirectoryPath(path) {
  for (const root of ["source", "vendor", "toolchain"]) {
    if (path === root || path.startsWith(`${root}/`)) {
      const suffix = path.slice(root.length);
      return root === "source" ? `source${suffix}` : `acquisition/${root}${suffix}`;
    }
  }
  refuse();
}

function parseLedger(bytes) {
  const text = decodeExactUtf8(bytes);
  requireThat(
    text.endsWith("\n") && !text.includes("\r") && !text.includes("\0") && text.length > 0,
  );
  const lines = text.slice(0, -1).split("\n");
  requireThat(lines.length >= 3 && lines[0] === LEDGER_MAGIC);
  const countFields = lines[1].split("\t");
  requireThat(countFields.length === 2 && countFields[0] === "records");
  const declaredCount = parseUnsigned(countFields[1]);
  requireThat(declaredCount === BigInt(LEDGER_RECORDS));
  const recordLines = lines.slice(2, -1);
  requireThat(recordLines.length === LEDGER_RECORDS);

  const endFields = lines.at(-1).split("\t");
  requireThat(
    endFields.length === 2 &&
      endFields[0] === "end" &&
      /^[0-9a-f]{64}$/u.test(endFields[1]),
  );
  const body = Buffer.from(`${lines.slice(0, -1).join("\n")}\n`, "utf8");
  requireThat(createHash("sha256").update(body).digest("hex") === endFields[1]);

  const specifications = new Map();
  const counts = { sourceDirectories: 0, vendorDirectories: 0, toolchainDirectories: 0 };
  const files = { source: 0, vendor: 0, toolchain: 0, control: 0 };
  const bytesByTag = { vendor: 0n, toolchain: 0n };
  let totalFileBytes = 0n;
  let previousKey;

  function addSpecification(actualPath, specification) {
    requireThat(!specifications.has(actualPath));
    specifications.set(actualPath, specification);
  }

  for (const line of recordLines) {
    requireThat(line.length > 0 && !line.endsWith(" "));
    const fields = line.split("\t");
    const tag = fields[0];
    let logicalPath;
    let specification;
    let actualPath;

    if (tag === "D") {
      requireThat(fields.length === 3 && fields[1] === "0555");
      logicalPath = fields[2];
      validatePathGrammar(logicalPath);
      actualPath = mapDirectoryPath(logicalPath);
      specification = { kind: "directory", mode: 0o555 };
      if (logicalPath === "source" || logicalPath.startsWith("source/")) {
        counts.sourceDirectories += 1;
      } else if (logicalPath === "vendor" || logicalPath.startsWith("vendor/")) {
        counts.vendorDirectories += 1;
      } else {
        counts.toolchainDirectories += 1;
      }
    } else {
      requireThat(tag === "S" || tag === "V" || tag === "T" || tag === "C");
      requireThat(fields.length === 5);
      const expectedMode = tag === "T" ? /^(?:0444|0555)$/u : /^0444$/u;
      requireThat(expectedMode.test(fields[1]));
      const size = parseUnsigned(fields[2]);
      requireThat(size <= BigInt(MAX_FILE_BYTES));
      requireThat(/^[0-9a-f]{64}$/u.test(fields[3]));
      logicalPath = fields[4];
      validatePathGrammar(logicalPath);
      const mode = fields[1] === "0555" ? 0o555 : 0o444;
      specification = {
        kind: "file",
        mode,
        size: Number(size),
        digest: fields[3],
      };
      totalFileBytes += size;
      requireThat(totalFileBytes <= MAX_TOTAL_FILE_BYTES);

      if (tag === "S") {
        requireThat(sourcePathAllowed(logicalPath));
        actualPath = `source/${logicalPath}`;
        files.source += 1;
        const authority = AUTHORITY_INPUTS.get(logicalPath);
        if (authority !== undefined) {
          requireThat(specification.size === authority[0] && specification.digest === authority[1]);
        }
      } else if (tag === "V") {
        actualPath = `acquisition/vendor/${logicalPath}`;
        files.vendor += 1;
        bytesByTag.vendor += size;
      } else if (tag === "T") {
        actualPath = `acquisition/toolchain/${logicalPath}`;
        files.toolchain += 1;
        bytesByTag.toolchain += size;
      } else {
        requireThat(CONTROL_FILES.has(logicalPath));
        actualPath = CONTROL_FILES.get(logicalPath);
        files.control += 1;
      }
    }

    const key = Buffer.from(`${tag}\t${logicalPath}`, "utf8");
    if (previousKey !== undefined) requireThat(Buffer.compare(previousKey, key) < 0);
    previousKey = key;
    addSpecification(actualPath, specification);
  }

  requireThat(
    counts.sourceDirectories === SOURCE_DIRECTORIES &&
      counts.vendorDirectories === VENDOR_DIRECTORIES &&
      counts.toolchainDirectories === TOOLCHAIN_DIRECTORIES &&
      files.source === SOURCE_FILES &&
      files.vendor === VENDOR_FILES &&
      files.toolchain === TOOLCHAIN_FILES &&
      files.control === CONTROL_FILES.size &&
      bytesByTag.vendor === VENDOR_BYTES &&
      bytesByTag.toolchain === TOOLCHAIN_BYTES,
  );
  for (const authorityPath of AUTHORITY_INPUTS.keys()) {
    requireThat(specifications.has(`source/${authorityPath}`));
  }
  requireThat(specifications.size === LEDGER_RECORDS);
  return specifications;
}

function addStructuralSpecifications(specifications) {
  function add(path, specification) {
    requireThat(!specifications.has(path));
    specifications.set(path, specification);
  }

  add("INVOCATION", { kind: "invocation" });
  add("control", { kind: "directory", mode: 0o555 });
  add("control/acquisition.sh", {
    kind: "file",
    mode: 0o444,
    size: ACQUISITION_CONTROLLER.size,
    digest: ACQUISITION_CONTROLLER.digest,
  });
  add("acquisition", { kind: "directory", mode: 0o700 });
  add("acquisition/vendor-ledger.v1", { kind: "ledger" });
  add("docker", { kind: "directory", mode: 0o500 });
  add("docker/home", { kind: "directory", mode: 0o700 });
  add("docker/config", { kind: "directory", mode: 0o500 });
  add("docker/config/config.json", {
    kind: "bytes",
    mode: 0o400,
    bytes: Buffer.from("{}"),
  });
  return specifications;
}

function positionalDescriptorBytes(descriptor, size) {
  requireThat(size >= 0 && size <= MAX_LEDGER_BYTES);
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const requested = Math.min(1024 * 1024, size - offset);
    const count = readSync(descriptor, bytes, offset, requested, offset);
    requireThat(count > 0);
    offset += count;
  }
  const probe = Buffer.allocUnsafe(1);
  requireThat(readSync(descriptor, probe, 0, 1, size) === 0);
  return bytes;
}

function sameRetainedLedgerIdentity(expected, observed) {
  return (
    observed.isFile() &&
    expected.dev === observed.dev &&
    expected.ino === observed.ino &&
    expected.uid === observed.uid &&
    expected.gid === observed.gid &&
    expected.mode === observed.mode &&
    expected.rdev === observed.rdev &&
    expected.size === observed.size &&
    expected.mtimeNs === observed.mtimeNs &&
    observed.ctimeNs >= expected.ctimeNs
  );
}

function readRetainedLedger(descriptor, expectedDigest, rootIdentity) {
  const before = fstatSync(descriptor, { bigint: true });
  requireThat(
    before.isFile() &&
      before.dev === rootIdentity.dev &&
      before.uid === BigInt(process.getuid()) &&
      before.gid === BigInt(process.getgid()) &&
      modeBits(before) === 0o444 &&
      (before.nlink === 0n || before.nlink === 1n) &&
      before.size >= 0n &&
      before.size <= BigInt(MAX_LEDGER_BYTES),
  );
  const bytes = positionalDescriptorBytes(descriptor, Number(before.size));
  const after = fstatSync(descriptor, { bigint: true });
  requireThat(
    sameRetainedLedgerIdentity(before, after) && before.nlink === after.nlink,
  );
  requireThat(createHash("sha256").update(bytes).digest("hex") === expectedDigest);
  return { identity: before, bytes };
}

function revalidateRetainedLedger(descriptor, authority, expectedDigest, terminal) {
  const before = fstatSync(descriptor, { bigint: true });
  requireThat(sameRetainedLedgerIdentity(authority.identity, before));
  requireThat(terminal ? before.nlink === 0n : before.nlink === 0n || before.nlink === 1n);
  const bytes = positionalDescriptorBytes(descriptor, Number(before.size));
  const after = fstatSync(descriptor, { bigint: true });
  requireThat(
    sameRetainedLedgerIdentity(authority.identity, after) &&
      before.nlink === after.nlink &&
      bytes.equals(authority.bytes) &&
      createHash("sha256").update(bytes).digest("hex") === expectedDigest,
  );
  return after;
}

function validateInvocationRecord(entry, invocation, allowPartial) {
  const expected = Buffer.from(`${INVOCATION_MAGIC}\n${invocation}\n`, "utf8");
  if (entry === undefined) {
    requireThat(allowPartial);
    return;
  }
  requireExpectedFileStat(entry, 0o600, expected.length);
  const observed = readStableFile(entry, expected.length);
  if (allowPartial) {
    requireThat(observed.length <= expected.length && expected.subarray(0, observed.length).equals(observed));
  } else {
    requireThat(observed.equals(expected));
  }
}

function validateLedgerBackedTree(entries, invocation) {
  const actual = new Map();
  for (const entry of entries) {
    requireThat(entry.relativeText !== undefined && !actual.has(entry.relativeText));
    actual.set(entry.relativeText, entry);
  }

  validateInvocationRecord(actual.get("INVOCATION"), invocation, false);
  const ledgerEntry = actual.get("acquisition/vendor-ledger.v1");
  requireExpectedFileStat(ledgerEntry, 0o444, MAX_LEDGER_BYTES);
  const ledgerBytes = readStableFile(ledgerEntry, MAX_LEDGER_BYTES);
  const specifications = addStructuralSpecifications(parseLedger(ledgerBytes));

  requireThat(actual.size === specifications.size);
  for (const [path, specification] of specifications) {
    const entry = actual.get(path);
    requireThat(entry !== undefined);
    if (specification.kind === "directory") {
      requireExactDirectory(entry, specification.mode);
    } else if (specification.kind === "file") {
      requireDigestFile(
        entry,
        specification.mode,
        specification.size,
        specification.digest,
      );
    } else if (specification.kind === "bytes") {
      requireExactFile(entry, specification.mode, specification.bytes);
    } else if (specification.kind === "invocation") {
      validateInvocationRecord(entry, invocation, false);
    } else {
      requireThat(specification.kind === "ledger" && entry === ledgerEntry);
    }
  }
  for (const path of actual.keys()) requireThat(specifications.has(path));

  validateFixedLedgerSpecifications(specifications);
}

function validateFixedLedgerSpecifications(specifications) {
  const proofSpecification = specifications.get("control/proof.sh");
  requireThat(
    proofSpecification?.kind === "file" &&
      proofSpecification.size === PROOF_CONTROLLER.size &&
      proofSpecification.digest === PROOF_CONTROLLER.digest,
  );
  const hostname = specifications.get("control/hostname");
  const hosts = specifications.get("control/hosts");
  const resolver = specifications.get("control/resolv.conf");
  const expectedHostname = Buffer.from("wp201-proof\n");
  const expectedHosts = Buffer.from("127.0.0.1 localhost\n::1 localhost\n");
  const expectedResolver = Buffer.alloc(0);
  for (const [specification, expected] of [
    [hostname, expectedHostname],
    [hosts, expectedHosts],
    [resolver, expectedResolver],
  ]) {
    requireThat(
      specification?.kind === "file" &&
        specification.size === expected.length &&
        specification.digest === createHash("sha256").update(expected).digest("hex"),
    );
  }
}

function directoryModeAllowed(entry, specification) {
  return (
    entry.stat.isDirectory() &&
    (modeBits(entry.stat) === specification.mode || modeBits(entry.stat) === 0o700)
  );
}

function validateSubsetDirectoryLinks(actual, rootIdentity) {
  const directoryChildren = new Map([["", 0]]);
  for (const [path, entry] of actual) {
    if (entry.stat.isDirectory()) directoryChildren.set(path, 0);
  }
  for (const [path, entry] of actual) {
    if (!entry.stat.isDirectory()) continue;
    const separator = path.lastIndexOf("/");
    const parent = separator === -1 ? "" : path.slice(0, separator);
    requireThat(directoryChildren.has(parent));
    directoryChildren.set(parent, directoryChildren.get(parent) + 1);
  }
  requireThat(rootIdentity.nlink === 2n + BigInt(directoryChildren.get("")));
  for (const [path, children] of directoryChildren) {
    if (path === "") continue;
    const entry = actual.get(path);
    requireThat(entry !== undefined && entry.stat.nlink === 2n + BigInt(children));
  }
}

function validateFailedCutSubset(
  entries,
  rootIdentity,
  invocation,
  ledgerAuthority,
  specifications,
) {
  const actual = new Map();
  for (const entry of entries) {
    requireThat(entry.relativeText !== undefined && !actual.has(entry.relativeText));
    actual.set(entry.relativeText, entry);
  }
  requireThat(actual.size <= specifications.size);

  for (const [path, entry] of actual) {
    const specification = specifications.get(path);
    requireThat(specification !== undefined);
    if (specification.kind === "directory") {
      requireThat(directoryModeAllowed(entry, specification));
    } else if (specification.kind === "file") {
      requireDigestFile(
        entry,
        specification.mode,
        specification.size,
        specification.digest,
      );
    } else if (specification.kind === "bytes") {
      requireExactFile(entry, specification.mode, specification.bytes);
    } else if (specification.kind === "invocation") {
      validateInvocationRecord(entry, invocation, false);
    } else {
      requireThat(
        specification.kind === "ledger" &&
          entry.stat.isFile() &&
          entry.stat.dev === ledgerAuthority.identity.dev &&
          entry.stat.ino === ledgerAuthority.identity.ino &&
          entry.stat.uid === ledgerAuthority.identity.uid &&
          entry.stat.gid === ledgerAuthority.identity.gid &&
          entry.stat.mode === ledgerAuthority.identity.mode &&
          entry.stat.rdev === ledgerAuthority.identity.rdev &&
          entry.stat.size === ledgerAuthority.identity.size &&
          entry.stat.nlink === 1n,
      );
    }
  }
  validateSubsetDirectoryLinks(actual, rootIdentity);
}

function revalidateDirectoryPermissions(directories, rootPath, rootDescriptor, rootIdentity) {
  assertNoNestedMounts(rootPath);
  for (const directory of directories) {
    const observed = lstatSync(directory.absolute, { bigint: true });
    requireThat(
      sameIdentity(directory.restoredStat, observed) && observed.isDirectory(),
    );
  }
  const pathAfter = lstatSync(rootPath, { bigint: true });
  const descriptorAfter = fstatSync(rootDescriptor, { bigint: true });
  requireThat(
    sameIdentity(rootIdentity, pathAfter) &&
      sameIdentity(pathAfter, descriptorAfter) &&
      modeBits(pathAfter) === 0o700,
  );
}

function removeCapturedInventory(entries, rootPath, rootDescriptor, rootIdentity) {
  const removedLinksByIdentity = new Map();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const before = lstatSync(entry.absolute, { bigint: true });
    if (entry.stat.isDirectory()) {
      requireThat(
        sameDirectoryIdentity(entry.stat, before) && modeBits(before) === 0o700,
      );
      rmdirSync(entry.absolute);
    } else {
      const identity = `${entry.stat.dev}:${entry.stat.ino}`;
      const linksAlreadyRemoved = removedLinksByIdentity.get(identity) ?? 0n;
      requireThat(sameUnlinkIdentity(entry.stat, before, linksAlreadyRemoved));
      assertPartialEntryType(before);
      unlinkSync(entry.absolute);
      removedLinksByIdentity.set(identity, linksAlreadyRemoved + 1n);
    }
    requireAbsent(entry.absolute);
  }

  const rootBeforeRemoval = lstatSync(rootPath, { bigint: true });
  const openedRootBeforeRemoval = fstatSync(rootDescriptor, { bigint: true });
  requireThat(
    sameDirectoryIdentity(rootIdentity, rootBeforeRemoval) &&
      sameDirectoryIdentity(rootBeforeRemoval, openedRootBeforeRemoval) &&
      modeBits(rootBeforeRemoval) === 0o700 &&
      modeBits(openedRootBeforeRemoval) === 0o700,
  );
  rmdirSync(rootPath);
  requireAbsent(rootPath);
}

function requireAbsent(path) {
  try {
    lstatSync(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    refuse();
  }
  refuse();
}

function validateEnvironment() {
  requireThat(process.argv.length === 2 && process.cwd() === "/");
  const keys = Object.keys(process.env).sort();
  requireThat(
    keys.length === 2 &&
      keys[0] === "LANG" &&
      keys[1] === "LC_ALL" &&
      process.env.LANG === "C" &&
      process.env.LC_ALL === "C",
  );
}

function validateDescriptorTable() {
  const nullDevice = lstatSync("/dev/null", { bigint: true });
  const standardInput = fstatSync(0, { bigint: true });
  const standardOutput = fstatSync(1, { bigint: true });
  requireThat(
    nullDevice.isCharacterDevice() &&
      sameIdentity(nullDevice, standardInput) &&
      sameIdentity(nullDevice, standardOutput) &&
      readlinkSync("/proc/self/fd/0") === "/dev/null" &&
      readlinkSync("/proc/self/fd/1") === "/dev/null",
  );

  const channels = [2, 3, 4].map((descriptor) =>
    fstatSync(descriptor, { bigint: true }),
  );
  requireThat(
    channels.every((channel) => channel.isFIFO() || channel.isSocket()),
  );
  const channelIdentities = new Set(
    channels.map((channel) => `${channel.dev}:${channel.ino}`),
  );
  requireThat(channelIdentities.size === channels.length);
}

function cleanupNormal(control) {
  requireThat(control.protocol === "normal");
  const parentPath = control.parentToken === "tmp" ? "/tmp" : "/var/tmp";
  const targetPath = `${parentPath}/${INVOCATION_PREFIX}${control.invocation}`;
  const expectedUid = BigInt(process.getuid());
  const expectedGid = BigInt(process.getgid());

  const filesystemRoot = lstatSync("/", { bigint: true });
  const parentIdentity = lstatSync(parentPath, { bigint: true });
  requireThat(
    filesystemRoot.isDirectory() &&
      !filesystemRoot.isSymbolicLink() &&
      filesystemRoot.uid === 0n &&
      parentIdentity.isDirectory() &&
      !parentIdentity.isSymbolicLink() &&
      parentIdentity.uid === 0n &&
      modeBits(parentIdentity) === 0o1777 &&
      realpathSync("/") === "/" &&
      realpathSync(parentPath) === parentPath,
  );

  const parentDescriptor = openSync(
    parentPath,
    constants.O_RDONLY |
      constants.O_DIRECTORY |
      constants.O_NOFOLLOW |
      constants.O_CLOEXEC,
  );
  let rootDescriptor;
  try {
    const openedParent = fstatSync(parentDescriptor, { bigint: true });
    requireThat(
      sameDirectoryIdentity(parentIdentity, openedParent) &&
        modeBits(openedParent) === 0o1777,
    );

    const rootIdentity = lstatSync(targetPath, { bigint: true });
    requireThat(
      rootIdentity.isDirectory() &&
        !rootIdentity.isSymbolicLink() &&
        rootIdentity.uid === expectedUid &&
        rootIdentity.gid === expectedGid &&
        modeBits(rootIdentity) === 0o700 &&
        rootIdentity.dev === control.device &&
        rootIdentity.ino === control.inode &&
        rootIdentity.dev === parentIdentity.dev &&
        realpathSync(targetPath) === targetPath,
    );
    rootDescriptor = openSync(
      targetPath,
      constants.O_RDONLY |
        constants.O_DIRECTORY |
        constants.O_NOFOLLOW |
        constants.O_CLOEXEC,
    );
    const openedRoot = fstatSync(rootDescriptor, { bigint: true });
    requireThat(sameIdentity(rootIdentity, openedRoot));
    assertNoNestedMounts(targetPath);

    const requireTextPaths = control.cleanupState === "ledger-backed";
    const { entries, directories } = walkInvocation(
      targetPath,
      rootIdentity,
      expectedUid,
      expectedGid,
      rootIdentity.dev,
      requireTextPaths,
    );
    assertNoNestedMounts(targetPath);

    const invocationEntry = entries.find((entry) => entry.relative.equals(Buffer.from("INVOCATION")));
    if (control.cleanupState === "pre-record") {
      validateInvocationRecord(invocationEntry, control.invocation, true);
    } else if (control.cleanupState === "partial-acquisition") {
      validateInvocationRecord(invocationEntry, control.invocation, false);
    } else {
      validateLedgerBackedTree(entries, control.invocation);
    }

    revalidateDirectoryPermissions(directories, targetPath, rootDescriptor, rootIdentity);
    const parentBeforeRemoval = lstatSync(parentPath, { bigint: true });
    const openedParentBeforeRemoval = fstatSync(parentDescriptor, { bigint: true });
    requireThat(
      sameDirectoryIdentity(parentIdentity, parentBeforeRemoval) &&
        sameDirectoryIdentity(parentBeforeRemoval, openedParentBeforeRemoval) &&
        modeBits(parentBeforeRemoval) === 0o1777 &&
        modeBits(openedParentBeforeRemoval) === 0o1777,
    );
    assertNoNestedMounts(targetPath);
    removeCapturedInventory(entries, targetPath, rootDescriptor, rootIdentity);
    fsyncSync(parentDescriptor);
    const parentAfterRemoval = fstatSync(parentDescriptor, { bigint: true });
    const parentPathAfterRemoval = lstatSync(parentPath, { bigint: true });
    requireThat(
      sameDirectoryIdentity(parentIdentity, parentAfterRemoval) &&
        sameDirectoryIdentity(parentAfterRemoval, parentPathAfterRemoval) &&
        modeBits(parentAfterRemoval) === 0o1777 &&
        modeBits(parentPathAfterRemoval) === 0o1777,
    );
  } finally {
    if (rootDescriptor !== undefined) closeSync(rootDescriptor);
    closeSync(parentDescriptor);
  }

  writeAll(4, COMPLETION);
  closeSync(4);
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    refuse();
  }
}

function requireHeldDirectoryEmpty(descriptor) {
  const directory = opendirSync(`/proc/self/fd/${descriptor}`, { encoding: "buffer" });
  try {
    requireThat(directory.readSync() === null);
  } finally {
    directory.closeSync();
  }
}

function validateFailedCutDescriptors(control) {
  const rootInfo = descriptorInfo(5);
  const ledgerInfo = descriptorInfo(6);
  requireThat(rootInfo.flags === "02700000" && rootInfo.mountId === control.mountId);
  requireThat(ledgerInfo.flags === "02500000");

  const root = fstatSync(5, { bigint: true });
  const ledger = fstatSync(6, { bigint: true });
  requireThat(
    root.isDirectory() &&
      root.dev === control.device &&
      root.ino === control.inode &&
      root.uid === BigInt(process.getuid()) &&
      root.gid === BigInt(process.getgid()) &&
      modeBits(root) === 0o700 &&
      ledger.isFile() &&
      descriptorIdentity(root) !== descriptorIdentity(ledger) &&
      descriptorTableIdentityCount(root) === 1 &&
      descriptorTableIdentityCount(ledger) === 1,
  );
  return { root, ledger };
}

function validateFixedParent(parentPath) {
  const filesystemRoot = lstatSync("/", { bigint: true });
  const parentIdentity = lstatSync(parentPath, { bigint: true });
  requireThat(
    filesystemRoot.isDirectory() &&
      !filesystemRoot.isSymbolicLink() &&
      filesystemRoot.uid === 0n &&
      parentIdentity.isDirectory() &&
      !parentIdentity.isSymbolicLink() &&
      parentIdentity.uid === 0n &&
      modeBits(parentIdentity) === 0o1777 &&
      realpathSync("/") === "/" &&
      realpathSync(parentPath) === parentPath,
  );
  return parentIdentity;
}

function revalidateFailedCutTerminal(control, rootStart, ledgerAuthority) {
  const ledger = revalidateRetainedLedger(
    6,
    ledgerAuthority,
    control.ledgerDigest,
    true,
  );
  const root = fstatSync(5, { bigint: true });
  requireThat(
    sameDirectoryIdentity(rootStart, root) &&
      root.dev === control.device &&
      root.ino === control.inode &&
      root.uid === BigInt(process.getuid()) &&
      root.gid === BigInt(process.getgid()) &&
      modeBits(root) === 0o700 &&
      root.nlink === 0n &&
      descriptorInfo(5).mountId === control.mountId &&
      descriptorTableIdentityCount(root) === 1 &&
      descriptorTableIdentityCount(ledger) === 1,
  );
  requireHeldDirectoryEmpty(5);
}

function cleanupFailedCut(control) {
  requireThat(control.protocol === "failed-cut");
  const { root: rootStart } = validateFailedCutDescriptors(control);
  const parentPath = control.parentToken === "tmp" ? "/tmp" : "/var/tmp";
  const alternateParentPath = control.parentToken === "tmp" ? "/var/tmp" : "/tmp";
  const targetPath = `${parentPath}/${INVOCATION_PREFIX}${control.invocation}`;
  const alternatePath = `${alternateParentPath}/${INVOCATION_PREFIX}${control.invocation}`;
  const expectedUid = BigInt(process.getuid());
  const expectedGid = BigInt(process.getgid());
  const parentIdentity = validateFixedParent(parentPath);
  validateFixedParent(alternateParentPath);
  requireAbsent(alternatePath);
  requireThat(rootStart.dev === parentIdentity.dev);
  const ledgerAuthority = readRetainedLedger(
    6,
    control.ledgerDigest,
    rootStart,
  );
  const specifications = addStructuralSpecifications(parseLedger(ledgerAuthority.bytes));
  validateFixedLedgerSpecifications(specifications);

  const parentDescriptor = openSync(
    parentPath,
    constants.O_RDONLY |
      constants.O_DIRECTORY |
      constants.O_NOFOLLOW |
      constants.O_CLOEXEC,
  );
  let rootPathDescriptor;
  try {
    const openedParent = fstatSync(parentDescriptor, { bigint: true });
    requireThat(
      sameDirectoryIdentity(parentIdentity, openedParent) &&
        modeBits(openedParent) === 0o1777,
    );
    const rootPathIdentity = lstatIfPresent(targetPath);
    if (rootPathIdentity === undefined) {
      requireThat(rootStart.nlink === 0n);
      requireHeldDirectoryEmpty(5);
    } else {
      requireThat(
        rootPathIdentity.isDirectory() &&
          !rootPathIdentity.isSymbolicLink() &&
          rootPathIdentity.dev === control.device &&
          rootPathIdentity.ino === control.inode &&
          rootPathIdentity.uid === expectedUid &&
          rootPathIdentity.gid === expectedGid &&
          modeBits(rootPathIdentity) === 0o700 &&
          realpathSync(targetPath) === targetPath,
      );
      rootPathDescriptor = openSync(
        targetPath,
        constants.O_RDONLY |
          constants.O_DIRECTORY |
          constants.O_NOFOLLOW |
          constants.O_CLOEXEC,
      );
      const openedPath = fstatSync(rootPathDescriptor, { bigint: true });
      requireThat(
        sameIdentity(rootPathIdentity, openedPath) &&
          sameDirectoryIdentity(rootStart, openedPath) &&
          descriptorInfo(rootPathDescriptor).mountId === control.mountId,
      );
      closeSync(rootPathDescriptor);
      rootPathDescriptor = undefined;
      assertNoNestedMounts(targetPath);

      const { entries, directories } = walkInvocation(
        targetPath,
        rootPathIdentity,
        expectedUid,
        expectedGid,
        rootPathIdentity.dev,
        true,
      );
      validateFailedCutSubset(
        entries,
        rootPathIdentity,
        control.invocation,
        ledgerAuthority,
        specifications,
      );
      revalidateRetainedLedger(6, ledgerAuthority, control.ledgerDigest, false);
      revalidateDirectoryPermissions(directories, targetPath, 5, rootPathIdentity);
      const parentBeforeRemoval = lstatSync(parentPath, { bigint: true });
      const openedParentBeforeRemoval = fstatSync(parentDescriptor, { bigint: true });
      requireThat(
        sameDirectoryIdentity(parentIdentity, parentBeforeRemoval) &&
          sameDirectoryIdentity(parentBeforeRemoval, openedParentBeforeRemoval) &&
          modeBits(parentBeforeRemoval) === 0o1777 &&
          modeBits(openedParentBeforeRemoval) === 0o1777,
      );
      assertNoNestedMounts(targetPath);
      removeCapturedInventory(entries, targetPath, 5, rootPathIdentity);
      fsyncSync(parentDescriptor);
      const parentAfterRemoval = fstatSync(parentDescriptor, { bigint: true });
      const parentPathAfterRemoval = lstatSync(parentPath, { bigint: true });
      requireThat(
        sameDirectoryIdentity(parentIdentity, parentAfterRemoval) &&
          sameDirectoryIdentity(parentAfterRemoval, parentPathAfterRemoval) &&
          modeBits(parentAfterRemoval) === 0o1777 &&
          modeBits(parentPathAfterRemoval) === 0o1777,
      );
    }
  } finally {
    if (rootPathDescriptor !== undefined) closeSync(rootPathDescriptor);
    closeSync(parentDescriptor);
  }

  requireAbsent(targetPath);
  requireAbsent(alternatePath);
  revalidateFailedCutTerminal(control, rootStart, ledgerAuthority);
  writeAll(4, FAILED_CUT_COMPLETION);
  closeSync(4);
}

function cleanup() {
  validateEnvironment();
  validateDescriptorTable();
  const controlBytes = readDescriptorBounded(3, MAX_CONTROL_BYTES);
  closeSync(3);
  const control = parseControl(controlBytes);
  if (control.protocol === "failed-cut") cleanupFailedCut(control);
  else cleanupNormal(control);
}

try {
  cleanup();
} catch {
  try {
    closeSync(4);
  } catch {
    // The parent may already have closed the completion channel.
  }
  try {
    requireThat(REFUSAL.length <= MAX_DIAGNOSTIC_BYTES);
    writeAll(2, REFUSAL);
  } catch {
    // Diagnostics never widen cleanup authority.
  }
  process.exitCode = 73;
}
