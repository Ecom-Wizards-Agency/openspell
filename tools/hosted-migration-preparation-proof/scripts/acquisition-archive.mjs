import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  stat,
} from "node:fs/promises";
import process from "node:process";

const MARKER = Buffer.from("openspell.wp201.acquisition-archive.v1\n", "ascii");
const ARCHIVE_BYTES = 724_207_616;
const MAX_STREAM_BYTES = MARKER.length + ARCHIVE_BYTES;
const BLOCK_BYTES = 512;
const COPY_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_RECORDS = 131_072;
const MAX_TOTAL_FILE_BYTES = 2 * 1024 * 1024 * 1024;

const ROOT_LIMITS = Object.freeze({
  toolchain: Object.freeze({
    directories: 28,
    regularFiles: 168,
    regularFileBytes: 653_573_520,
  }),
  vendor: Object.freeze({
    directories: 941,
    regularFiles: 3_657,
    regularFileBytes: 67_159_121,
  }),
});

const EXPECTED_TOTALS = Object.freeze({
  directories:
    ROOT_LIMITS.toolchain.directories + ROOT_LIMITS.vendor.directories,
  regularFiles:
    ROOT_LIMITS.toolchain.regularFiles + ROOT_LIMITS.vendor.regularFiles,
  regularFileBytes:
    ROOT_LIMITS.toolchain.regularFileBytes +
    ROOT_LIMITS.vendor.regularFileBytes,
});

const PATH_COMPONENT = /^[A-Za-z0-9._+@-]+$/u;
const ZERO_BLOCK = Buffer.alloc(BLOCK_BYTES);

function refuse(reason) {
  throw new Error(`WP-201 acquisition archive refused: ${reason}`);
}

function sameBytes(left, right) {
  return left.length === right.length && left.equals(right);
}

function modeOf(stats) {
  return Number(stats.mode & 0o7777n);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function requireDirectoryStats(stats, expected, mode, reason) {
  if (
    !stats.isDirectory() ||
    !sameIdentity(stats, expected) ||
    stats.dev !== expected.dev ||
    stats.uid !== expected.uid ||
    stats.gid !== expected.gid ||
    modeOf(stats) !== mode
  ) {
    refuse(reason);
  }
}

function requireRegularStats(stats, expected, mode, size, reason) {
  if (
    !stats.isFile() ||
    !sameIdentity(stats, expected) ||
    stats.dev !== expected.dev ||
    stats.uid !== expected.uid ||
    stats.gid !== expected.gid ||
    stats.nlink !== 1n ||
    modeOf(stats) !== mode ||
    stats.size !== BigInt(size)
  ) {
    refuse(reason);
  }
}

function procPath(root, logicalPath = "") {
  return logicalPath.length === 0 ? root : `${root}/${logicalPath}`;
}

function parsePaddedField(header, offset, length, allowEmpty) {
  const field = header.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  if (nul === -1) return Buffer.from(field);
  for (let index = nul; index < field.length; index += 1) {
    if (field[index] !== 0) refuse("noncanonical header padding");
  }
  if (!allowEmpty && nul === 0) refuse("empty header name");
  return Buffer.from(field.subarray(0, nul));
}

function parseOctal(field, digits, reason) {
  if (field.length !== digits + 1 || field[field.length - 1] !== 0) {
    refuse(reason);
  }
  let value = 0;
  for (let index = 0; index < digits; index += 1) {
    const byte = field[index];
    if (byte < 0x30 || byte > 0x37) refuse(reason);
    value = value * 8 + (byte - 0x30);
  }
  if (!Number.isSafeInteger(value)) refuse(reason);
  return value;
}

function octal(value, digits) {
  if (!Number.isSafeInteger(value) || value < 0) {
    refuse("unrepresentable header number");
  }
  const encoded = value.toString(8);
  if (encoded.length > digits) refuse("unrepresentable header number");
  return `${"0".repeat(digits - encoded.length)}${encoded}\0`;
}

function copyAscii(value, target, offset) {
  Buffer.from(value, "ascii").copy(target, offset);
}

function canonicalSplit(rawPath) {
  const bytes = Buffer.from(rawPath, "ascii");
  if (bytes.length <= 100) {
    return { name: bytes, prefix: Buffer.alloc(0) };
  }

  for (let index = bytes.length - 1; index > 0; index -= 1) {
    if (bytes[index] !== 0x2f) continue;
    const prefixLength = index;
    const nameLength = bytes.length - index - 1;
    if (prefixLength <= 155 && nameLength > 0 && nameLength <= 100) {
      return {
        name: Buffer.from(bytes.subarray(index + 1)),
        prefix: Buffer.from(bytes.subarray(0, index)),
      };
    }
  }
  refuse("unrepresentable canonical USTAR path");
}

function parsePath(header, type) {
  const name = parsePaddedField(header, 0, 100, false);
  const prefix = parsePaddedField(header, 345, 155, true);
  const rawBytes =
    prefix.length === 0
      ? name
      : Buffer.concat([prefix, Buffer.from("/", "ascii"), name]);

  if (rawBytes.length === 0 || rawBytes.length > 1_024) {
    refuse("invalid path length");
  }
  for (const byte of rawBytes) {
    const allowed =
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2e ||
      byte === 0x5f ||
      byte === 0x2b ||
      byte === 0x40 ||
      byte === 0x2f ||
      byte === 0x2d;
    if (!allowed) refuse("invalid path byte");
  }

  const rawPath = rawBytes.toString("ascii");
  const isDirectory = type === "5";
  if (isDirectory) {
    if (!rawPath.endsWith("/") || rawPath.endsWith("//")) {
      refuse("noncanonical directory terminator");
    }
  } else if (rawPath.endsWith("/")) {
    refuse("regular file has directory terminator");
  }

  const logicalPath = isDirectory ? rawPath.slice(0, -1) : rawPath;
  if (
    logicalPath.length === 0 ||
    logicalPath.startsWith("/") ||
    logicalPath.includes("//")
  ) {
    refuse("invalid logical path");
  }
  const components = logicalPath.split("/");
  if (
    components.some(
      (component) =>
        component === "." ||
        component === ".." ||
        !PATH_COMPONENT.test(component),
    )
  ) {
    refuse("invalid logical path component");
  }
  if (components[0] !== "toolchain" && components[0] !== "vendor") {
    refuse("path outside fixed acquisition roots");
  }
  if (components.length === 1 && !isDirectory) {
    refuse("acquisition root is not a directory");
  }

  const split = canonicalSplit(rawPath);
  if (!sameBytes(name, split.name) || !sameBytes(prefix, split.prefix)) {
    refuse("noncanonical USTAR path split");
  }
  return {
    components,
    logicalPath,
    name: split.name,
    prefix: split.prefix,
    rawPath,
    root: components[0],
  };
}

function buildCanonicalHeader({ mode, name, prefix, size, type }) {
  const expected = Buffer.alloc(BLOCK_BYTES);
  name.copy(expected, 0);
  copyAscii(octal(mode, 7), expected, 100);
  copyAscii(octal(0, 7), expected, 108);
  copyAscii(octal(0, 7), expected, 116);
  copyAscii(octal(size, 11), expected, 124);
  copyAscii(octal(0, 11), expected, 136);
  expected.fill(0x20, 148, 156);
  copyAscii(type, expected, 156);
  copyAscii("ustar\0", expected, 257);
  copyAscii("00", expected, 263);
  copyAscii(octal(0, 7), expected, 329);
  copyAscii(octal(0, 7), expected, 337);
  prefix.copy(expected, 345);

  let checksum = 0;
  for (const byte of expected) checksum += byte;
  const checksumOctal = checksum.toString(8);
  if (checksumOctal.length > 6) refuse("unrepresentable header checksum");
  copyAscii(`${"0".repeat(6 - checksumOctal.length)}${checksumOctal}\0 `, expected, 148);
  return expected;
}

function parseHeader(header) {
  const typeByte = header[156];
  if (typeByte !== 0x30 && typeByte !== 0x35) {
    refuse("unsupported USTAR entry type");
  }
  const type = String.fromCharCode(typeByte);
  const path = parsePath(header, type);
  const size = parseOctal(header.subarray(124, 136), 11, "invalid size field");
  if (size > MAX_FILE_BYTES) refuse("regular file exceeds fixed cap");

  const isDirectory = type === "5";
  if (isDirectory && size !== 0) refuse("directory has data");
  const mode = isDirectory
    ? 0o555
    : path.root === "vendor"
      ? 0o444
      : parseOctal(header.subarray(100, 108), 7, "invalid mode field");
  if (!isDirectory && path.root === "toolchain" && mode !== 0o444 && mode !== 0o555) {
    refuse("invalid toolchain file mode");
  }

  const expected = buildCanonicalHeader({
    mode,
    name: path.name,
    prefix: path.prefix,
    size,
    type,
  });
  if (!sameBytes(header, expected)) refuse("noncanonical GNU USTAR header");
  return { ...path, isDirectory, mode, size };
}

class ExactByteReader {
  constructor(input) {
    if (
      input === null ||
      typeof input !== "object" ||
      typeof input[Symbol.asyncIterator] !== "function"
    ) {
      refuse("input is not an async byte stream");
    }
    this.iterator = input[Symbol.asyncIterator]();
    this.chunk = Buffer.alloc(0);
    this.offset = 0;
    this.received = 0;
    this.ended = false;
  }

  async nextChunk() {
    while (!this.ended) {
      const item = await this.iterator.next();
      if (item.done) {
        this.ended = true;
        this.chunk = Buffer.alloc(0);
        this.offset = 0;
        return false;
      }
      if (!(item.value instanceof Uint8Array)) {
        refuse("stream yielded a non-byte chunk");
      }
      const chunk = Buffer.from(
        item.value.buffer,
        item.value.byteOffset,
        item.value.byteLength,
      );
      if (chunk.length === 0) continue;
      this.received += chunk.length;
      if (this.received > MAX_STREAM_BYTES) refuse("stream exceeds exact cap");
      this.chunk = chunk;
      this.offset = 0;
      return true;
    }
    return false;
  }

  async readExactly(length) {
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_FILE_BYTES) {
      refuse("invalid bounded read length");
    }
    const result = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      if (this.offset === this.chunk.length && !(await this.nextChunk())) {
        refuse("unexpected stream EOF");
      }
      const available = this.chunk.length - this.offset;
      const count = Math.min(available, length - written);
      this.chunk.copy(result, written, this.offset, this.offset + count);
      this.offset += count;
      written += count;
    }
    return result;
  }

  async requireEof() {
    if (this.offset !== this.chunk.length) refuse("trailing archive bytes");
    while (await this.nextChunk()) {
      refuse("trailing archive bytes");
    }
    if (this.received !== MAX_STREAM_BYTES) refuse("wrong complete stream size");
  }

  async cancel() {
    if (!this.ended && typeof this.iterator.return === "function") {
      try {
        await this.iterator.return();
      } catch {
        // Preserve the original closed-parser refusal.
      }
    }
  }
}

async function writeAll(file, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.write(bytes, offset, bytes.length - offset, null);
    if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) {
      refuse("regular file write did not advance");
    }
    offset += result.bytesWritten;
  }
}

async function validateBase(acquisitionDirectory) {
  if (
    acquisitionDirectory === null ||
    typeof acquisitionDirectory !== "object" ||
    !Number.isInteger(acquisitionDirectory.fd) ||
    acquisitionDirectory.fd < 0 ||
    typeof acquisitionDirectory.stat !== "function"
  ) {
    refuse("destination is not an open directory handle");
  }
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    refuse("invoking identity is unavailable");
  }

  const held = await acquisitionDirectory.stat({ bigint: true });
  const root = `/proc/self/fd/${acquisitionDirectory.fd}`;
  const reached = await stat(root, { bigint: true });
  const uid = BigInt(process.getuid());
  const gid = BigInt(process.getgid());
  if (
    !held.isDirectory() ||
    !sameIdentity(held, reached) ||
    held.uid !== uid ||
    held.gid !== gid ||
    held.dev !== reached.dev ||
    modeOf(held) !== 0o700 ||
    modeOf(reached) !== 0o700
  ) {
    refuse("destination directory identity mismatch");
  }
  if ((await readdir(root)).length !== 0) refuse("destination directory is not empty");
  return { expected: held, root };
}

async function revalidateBase(base) {
  const current = await stat(base.root, { bigint: true });
  requireDirectoryStats(current, base.expected, 0o700, "destination directory changed");
}

async function revalidateAncestors(base, directoryIdentities, components) {
  await revalidateBase(base);
  let logical = "";
  for (const component of components) {
    logical = logical.length === 0 ? component : `${logical}/${component}`;
    const expected = directoryIdentities.get(logical);
    if (expected === undefined) refuse("missing decoder-created ancestor");
    const current = await lstat(procPath(base.root, logical), { bigint: true });
    requireDirectoryStats(current, expected, 0o700, "decoder-created ancestor changed");
  }
}

async function createDirectory(base, directoryIdentities, entry) {
  await revalidateAncestors(base, directoryIdentities, entry.components.slice(0, -1));
  const pathname = procPath(base.root, entry.logicalPath);
  await mkdir(pathname, { mode: 0o700 });
  const created = await lstat(pathname, { bigint: true });
  if (
    !created.isDirectory() ||
    created.dev !== base.expected.dev ||
    created.uid !== base.expected.uid ||
    created.gid !== base.expected.gid ||
    modeOf(created) !== 0o700
  ) {
    refuse("created directory identity mismatch");
  }
  directoryIdentities.set(entry.logicalPath, created);
}

async function createRegularFile(base, directoryIdentities, fileIdentities, entry, reader) {
  await revalidateAncestors(base, directoryIdentities, entry.components.slice(0, -1));
  const pathname = procPath(base.root, entry.logicalPath);
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_NOFOLLOW;
  let file;
  try {
    file = await open(pathname, flags, 0o600);
    const opened = await file.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== base.expected.dev ||
      opened.uid !== base.expected.uid ||
      opened.gid !== base.expected.gid ||
      opened.nlink !== 1n ||
      modeOf(opened) !== 0o600 ||
      opened.size !== 0n
    ) {
      refuse("created regular file identity mismatch");
    }

    let remaining = entry.size;
    while (remaining > 0) {
      const bytes = await reader.readExactly(Math.min(COPY_BYTES, remaining));
      await writeAll(file, bytes);
      remaining -= bytes.length;
    }
    await file.chmod(entry.mode);
    const complete = await file.stat({ bigint: true });
    requireRegularStats(
      complete,
      opened,
      entry.mode,
      entry.size,
      "completed regular file changed",
    );
    fileIdentities.set(entry.logicalPath, {
      identity: complete,
      mode: entry.mode,
      size: entry.size,
    });
  } finally {
    if (file !== undefined) await file.close();
  }

  const closed = await lstat(pathname, { bigint: true });
  const expected = fileIdentities.get(entry.logicalPath);
  if (expected === undefined) refuse("regular file custody missing");
  requireRegularStats(
    closed,
    expected.identity,
    expected.mode,
    expected.size,
    "closed regular file changed",
  );
}

async function finalizeDirectories(base, directoryIdentities) {
  const paths = [...directoryIdentities.keys()].sort((left, right) => {
    const depth = right.split("/").length - left.split("/").length;
    return depth === 0 ? Buffer.compare(Buffer.from(left), Buffer.from(right)) : depth;
  });

  for (const logicalPath of paths) {
    const components = logicalPath.split("/");
    await revalidateAncestors(base, directoryIdentities, components);
    const pathname = procPath(base.root, logicalPath);
    let directory;
    try {
      directory = await open(
        pathname,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const opened = await directory.stat({ bigint: true });
      const expected = directoryIdentities.get(logicalPath);
      requireDirectoryStats(opened, expected, 0o700, "directory changed before finalization");
      await directory.chmod(0o555);
      const finalized = await directory.stat({ bigint: true });
      requireDirectoryStats(finalized, expected, 0o555, "directory finalization failed");
    } finally {
      if (directory !== undefined) await directory.close();
    }
    const closed = await lstat(pathname, { bigint: true });
    const expected = directoryIdentities.get(logicalPath);
    requireDirectoryStats(closed, expected, 0o555, "finalized directory changed");
  }
}

function decodeObservedComponent(bytes) {
  if (bytes.length === 0) refuse("empty observed path component");
  for (const byte of bytes) {
    const allowed =
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2e ||
      byte === 0x5f ||
      byte === 0x2b ||
      byte === 0x40 ||
      byte === 0x2d;
    if (!allowed) refuse("invalid observed path component");
  }
  const component = bytes.toString("ascii");
  if (component === "." || component === ".." || !PATH_COMPONENT.test(component)) {
    refuse("invalid observed path component");
  }
  return component;
}

async function independentlyRevalidateTree(base, directoryIdentities, fileIdentities) {
  await revalidateBase(base);
  const observed = new Set();
  const pending = [""];
  while (pending.length > 0) {
    const parent = pending.pop();
    const names = await readdir(procPath(base.root, parent), { encoding: "buffer" });
    if (observed.size + names.length > MAX_RECORDS) refuse("observed tree exceeds fixed cap");
    for (const nameBytes of names) {
      const component = decodeObservedComponent(nameBytes);
      const logicalPath = parent.length === 0 ? component : `${parent}/${component}`;
      if (observed.has(logicalPath)) refuse("duplicate observed path");
      observed.add(logicalPath);
      const current = await lstat(procPath(base.root, logicalPath), { bigint: true });

      const expectedDirectory = directoryIdentities.get(logicalPath);
      if (expectedDirectory !== undefined) {
        requireDirectoryStats(
          current,
          expectedDirectory,
          0o555,
          "observed directory changed",
        );
        pending.push(logicalPath);
        continue;
      }
      const expectedFile = fileIdentities.get(logicalPath);
      if (expectedFile === undefined) refuse("unexpected observed path");
      requireRegularStats(
        current,
        expectedFile.identity,
        expectedFile.mode,
        expectedFile.size,
        "observed regular file changed",
      );
    }
  }

  if (observed.size !== directoryIdentities.size + fileIdentities.size) {
    refuse("observed tree count mismatch");
  }
  for (const logicalPath of directoryIdentities.keys()) {
    if (!observed.has(logicalPath)) refuse("directory missing from observed tree");
  }
  for (const logicalPath of fileIdentities.keys()) {
    if (!observed.has(logicalPath)) refuse("regular file missing from observed tree");
  }
  await revalidateBase(base);
}

function emptyCounts() {
  return {
    toolchain: { directories: 0, regularFiles: 0, regularFileBytes: 0 },
    vendor: { directories: 0, regularFiles: 0, regularFileBytes: 0 },
  };
}

function accountEntry(counts, entry) {
  const rootCounts = counts[entry.root];
  if (entry.isDirectory) rootCounts.directories += 1;
  else {
    rootCounts.regularFiles += 1;
    rootCounts.regularFileBytes += entry.size;
  }
  const limits = ROOT_LIMITS[entry.root];
  if (
    rootCounts.directories > limits.directories ||
    rootCounts.regularFiles > limits.regularFiles ||
    rootCounts.regularFileBytes > limits.regularFileBytes
  ) {
    refuse("root count or byte total exceeds reviewed value");
  }
}

function requireExactCounts(counts) {
  for (const root of ["toolchain", "vendor"]) {
    const actual = counts[root];
    const expected = ROOT_LIMITS[root];
    if (
      actual.directories !== expected.directories ||
      actual.regularFiles !== expected.regularFiles ||
      actual.regularFileBytes !== expected.regularFileBytes
    ) {
      refuse("root count or byte total mismatch");
    }
  }
}

function frozenSummary() {
  return Object.freeze({
    markerBytes: MARKER.length,
    archiveBytes: ARCHIVE_BYTES,
    directories: EXPECTED_TOTALS.directories,
    regularFiles: EXPECTED_TOTALS.regularFiles,
    regularFileBytes: EXPECTED_TOTALS.regularFileBytes,
    toolchain: Object.freeze({ ...ROOT_LIMITS.toolchain }),
    vendor: Object.freeze({ ...ROOT_LIMITS.vendor }),
  });
}

/**
 * Decode the one WP-201 acquisition marker and GNU tar 1.34 USTAR stream into
 * an already-open, empty acquisition directory. No destination pathname is
 * accepted or derived from input bytes.
 */
export async function extractAcquisitionArchive({ input, acquisitionDirectory } = {}) {
  const reader = new ExactByteReader(input);
  let complete = false;
  try {
    const marker = await reader.readExactly(MARKER.length);
    if (!sameBytes(marker, MARKER)) refuse("marker mismatch");
    const base = await validateBase(acquisitionDirectory);
    const seen = new Set();
    const directoryIdentities = new Map();
    const fileIdentities = new Map();
    const counts = emptyCounts();
    let records = 0;
    let totalFileBytes = 0;

    for (;;) {
      const header = await reader.readExactly(BLOCK_BYTES);
      if (sameBytes(header, ZERO_BLOCK)) {
        const secondZero = await reader.readExactly(BLOCK_BYTES);
        if (!sameBytes(secondZero, ZERO_BLOCK)) refuse("invalid terminal zero blocks");
        break;
      }

      records += 1;
      if (records > MAX_RECORDS) refuse("archive record count exceeds fixed cap");
      const entry = parseHeader(header);
      if (seen.has(entry.logicalPath)) refuse("duplicate logical path");
      seen.add(entry.logicalPath);
      accountEntry(counts, entry);
      totalFileBytes += entry.size;
      if (totalFileBytes > MAX_TOTAL_FILE_BYTES) {
        refuse("archive regular-file bytes exceed fixed cap");
      }

      if (entry.isDirectory) {
        await createDirectory(base, directoryIdentities, entry);
      } else {
        await createRegularFile(
          base,
          directoryIdentities,
          fileIdentities,
          entry,
          reader,
        );
      }

      const padding = (BLOCK_BYTES - (entry.size % BLOCK_BYTES)) % BLOCK_BYTES;
      if (padding > 0) {
        const paddingBytes = await reader.readExactly(padding);
        if (!paddingBytes.equals(Buffer.alloc(padding))) {
          refuse("nonzero regular-file padding");
        }
      }
    }

    requireExactCounts(counts);
    if (records !== EXPECTED_TOTALS.directories + EXPECTED_TOTALS.regularFiles) {
      refuse("archive record count mismatch");
    }
    if (totalFileBytes !== EXPECTED_TOTALS.regularFileBytes) {
      refuse("archive regular-file byte total mismatch");
    }
    if (reader.received < MAX_STREAM_BYTES && reader.ended) {
      refuse("wrong complete stream size");
    }
    await reader.requireEof();
    await finalizeDirectories(base, directoryIdentities);
    await independentlyRevalidateTree(base, directoryIdentities, fileIdentities);
    complete = true;
    return frozenSummary();
  } finally {
    if (!complete) await reader.cancel();
  }
}
