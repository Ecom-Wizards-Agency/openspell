import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import { buildDockerEventOpenFrame } from "./docker-event-helper.mjs";

const ROOT_HANDOFF_FD = 7;
const RELEASE_FD = 3;
const IDENTITY_FD = 4;
const ACCEPTED_ID_FD = 5;
const AUDIT_FD = 6;
const ROOT_FLAGS =
  constants.O_RDONLY |
  constants.O_DIRECTORY |
  constants.O_NOFOLLOW |
  constants.O_CLOEXEC;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC;
const INVOCATION_PREFIX = "openspell-wp201-root-proof-";
const INVOCATION_RECORD_PREFIX = "openspell.wp201.invocation.v1\n";
const PROOF_ROLE = "root-bridge-proof-v1";
const ROW_ID = "root-fmt";
const MAXIMUM_LEDGER_BYTES = 16 * 1024 * 1024;
const MAXIMUM_TREE_ENTRIES = 131_072;
const MAXIMUM_TREE_DEPTH = 64;
const MAXIMUM_RELATIVE_PATH_BYTES = 1_024;
const MAXIMUM_TOTAL_PATH_BYTES = 16 * 1024 * 1024;
const COPY_CHUNK_BYTES = 1024 * 1024;
const ACTIVE_NS = 900_000_000_000n;
const CLEANUP_NS = 160_000_000_000n;
const SECOND_NS = 1_000_000_000n;
const POLL_MILLISECONDS = 50;
const DOCKER_NORMAL_NS = 5n * SECOND_NS;
const DOCKER_TERM_NS = 2n * SECOND_NS;
const DOCKER_KILL_NS = 3n * SECOND_NS;
const CREATE_TERM_NS = 5n * SECOND_NS;
const CREATE_KILL_NS = 5n * SECOND_NS;
const PARENT_ABSENCE_NS = 5n * SECOND_NS;
const DOCKER_BINARY_SIZE = 45_570_321n;
const DOCKER_BINARY_SHA256 =
  "dbf7fd0c0ae54d208314ee5c19a97a12d966dab039b7d94872ca91cbe490373c";
const DOCKER_EVENT_CLOSE = Buffer.from(
  "openspell.wp201.docker-event-close.v1\n",
  "ascii",
);
const WATCHER_READY = Buffer.from(
  "openspell.wp201.docker-event-ready.v1\n",
  "ascii",
);
const WATCHER_EVENT_PREFIX = Buffer.from(
  "openspell.wp201.docker-event-id.v1\n",
  "ascii",
);
const AUDIT_OPEN = Buffer.from(
  "openspell.wp201.real-cut-audit-open.v1\n",
  "ascii",
);
const AUDIT_CLOSE = Buffer.from(
  "openspell.wp201.real-cut-audit-close.v1\n",
  "ascii",
);
const TERMINAL_STDERR = Buffer.from(
  "openspell.wp201.interrupted-before-start.v1\n",
  "ascii",
);
const REFUSAL_STDERR = Buffer.from(
  "openspell.wp201.interruption-harness.refused.v1\n",
  "ascii",
);
const AUTHENTICATED_WATCHER_SETTLEMENT = Object.freeze(Object.create(null));
const DOCKER_EVENT_HELPER = fileURLToPath(
  new URL("./docker-event-helper.mjs", import.meta.url),
);
const PATH_CLEANUP_HELPER = fileURLToPath(
  new URL("./path-cleanup-helper.mjs", import.meta.url),
);
const capturedNodeExecutable = process.execPath;
const capturedRandomBytes = randomBytes;
const descriptorPattern = /^(?:0|[1-9][0-9]{0,19})$/u;
const freshnessChallengePattern = /^[0-9a-f]{64}$/u;

let entryConsumed = false;

function numericMode(status) {
  return Number(status.mode & 0o7777n);
}

function writeAllSync(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(
      descriptor,
      bytes,
      offset,
      bytes.length - offset,
    );
    if (written <= 0) throw new Error("short protocol write");
    offset += written;
  }
}

function closeIgnoringErrors(descriptor) {
  try {
    closeSync(descriptor);
  } catch {
    // Refusal remains authoritative if a peer closed first.
  }
}

function readDescriptorInfo(descriptor) {
  const text = readFileSync(`/proc/self/fdinfo/${descriptor}`, "ascii");
  const flags = [...text.matchAll(/^flags:\s+(?<flags>0[0-7]+)$/gmu)];
  const mounts = [...text.matchAll(/^mnt_id:\s+(?<mount>[1-9][0-9]*)$/gmu)];
  if (
    flags.length !== 1 ||
    mounts.length !== 1 ||
    flags[0].groups?.flags === undefined ||
    mounts[0].groups?.mount === undefined
  ) {
    throw new Error("descriptor metadata missing");
  }
  return Object.freeze({
    flags: flags[0].groups.flags,
    mountId: mounts[0].groups.mount,
  });
}

function sameStableStatus(left, right) {
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

function readBoundedDescriptor(descriptor, maximum) {
  const before = fstatSync(descriptor, { bigint: true });
  if (!before.isFile() || before.size < 0n || before.size > BigInt(maximum)) {
    throw new Error("bounded descriptor identity mismatch");
  }
  const size = Number(before.size);
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const length = Math.min(COPY_CHUNK_BYTES, size - offset);
    const count = readSync(descriptor, bytes, offset, length, offset);
    if (count !== length) throw new Error("bounded descriptor truncated");
    offset += count;
  }
  const probe = Buffer.allocUnsafe(1);
  if (readSync(descriptor, probe, 0, 1, size) !== 0) {
    throw new Error("bounded descriptor grew");
  }
  if (!sameStableStatus(before, fstatSync(descriptor, { bigint: true }))) {
    throw new Error("bounded descriptor changed");
  }
  return bytes;
}

function readAdmissionInvocation(rootPath, rootStatus) {
  const recordPath = `/proc/self/fd/${ROOT_HANDOFF_FD}/INVOCATION`;
  const descriptor = openSync(recordPath, FILE_FLAGS);
  try {
    const status = fstatSync(descriptor, { bigint: true });
    if (
      !status.isFile() ||
      status.dev !== rootStatus.dev ||
      status.uid !== BigInt(process.getuid()) ||
      status.gid !== BigInt(process.getgid()) ||
      status.nlink !== 1n ||
      numericMode(status) !== 0o600 ||
      status.size > 256n
    ) {
      throw new Error("invocation record identity mismatch");
    }
    const bytes = readBoundedDescriptor(descriptor, 256);
    const match = /^openspell\.wp201\.invocation\.v1\n(?<value>[0-9a-f]{64})\n$/u.exec(
      bytes.toString("ascii"),
    );
    if (match?.groups?.value === undefined) {
      throw new Error("invocation record mismatch");
    }
    if (rootPath !== `${dirname(rootPath)}/${INVOCATION_PREFIX}${match.groups.value}`) {
      throw new Error("invocation path mismatch");
    }
    return match.groups.value;
  } finally {
    closeSync(descriptor);
  }
}

function requireAbsent(path) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("unexpected path exists");
}

function admitRootCapability() {
  if (entryConsumed) throw new Error("interruption harness entry already consumed");
  entryConsumed = true;
  const handoffInfo = readDescriptorInfo(ROOT_HANDOFF_FD);
  const handoffStatus = fstatSync(ROOT_HANDOFF_FD, { bigint: true });
  if (
    handoffInfo.flags !== "02700000" ||
    !descriptorPattern.test(handoffStatus.dev.toString()) ||
    !descriptorPattern.test(handoffStatus.ino.toString()) ||
    !descriptorPattern.test(handoffInfo.mountId) ||
    !handoffStatus.isDirectory() ||
    handoffStatus.uid !== BigInt(process.getuid()) ||
    handoffStatus.gid !== BigInt(process.getgid()) ||
    numericMode(handoffStatus) !== 0o700
  ) {
    throw new Error("fd 7 root capability mismatch");
  }
  const rootPath = realpathSync(`/proc/self/fd/${ROOT_HANDOFF_FD}`);
  if (!/^\/(?:tmp|var\/tmp)\/openspell-wp201-root-proof-[0-9a-f]{64}$/u.test(rootPath)) {
    throw new Error("fd 7 root path mismatch");
  }
  const parent = dirname(rootPath);
  const parentStatus = lstatSync(parent, { bigint: true });
  if (
    !["/tmp", "/var/tmp"].includes(parent) ||
    realpathSync(parent) !== parent ||
    !parentStatus.isDirectory() ||
    parentStatus.uid !== 0n ||
    parentStatus.gid !== 0n ||
    numericMode(parentStatus) !== 0o1777 ||
    parentStatus.dev !== handoffStatus.dev
  ) {
    throw new Error("fd 7 parent identity mismatch");
  }
  const invocation = readAdmissionInvocation(rootPath, handoffStatus);
  const alternateParent = parent === "/tmp" ? "/var/tmp" : "/tmp";
  requireAbsent(join(alternateParent, `${INVOCATION_PREFIX}${invocation}`));

  const retainedRoot = openSync(rootPath, ROOT_FLAGS);
  let retainedStatus;
  let retainedInfo;
  try {
    retainedStatus = fstatSync(retainedRoot, { bigint: true });
    retainedInfo = readDescriptorInfo(retainedRoot);
    if (
      !sameStableStatus(handoffStatus, retainedStatus) ||
      retainedInfo.flags !== "02700000" ||
      retainedInfo.mountId !== handoffInfo.mountId ||
      realpathSync(`/proc/self/fd/${retainedRoot}`) !== rootPath
    ) {
      throw new Error("retained root capability mismatch");
    }
  } catch (error) {
    closeSync(retainedRoot);
    throw error;
  }

  closeSync(ROOT_HANDOFF_FD);
  try {
    fstatSync(ROOT_HANDOFF_FD);
  } catch (error) {
    if (error?.code !== "EBADF") {
      closeSync(retainedRoot);
      throw error;
    }
    return Object.freeze({
      alternatePath: join(alternateParent, `${INVOCATION_PREFIX}${invocation}`),
      device: retainedStatus.dev,
      gid: retainedStatus.gid,
      inode: retainedStatus.ino,
      invocation,
      mountId: retainedInfo.mountId,
      parent,
      parentToken: parent === "/tmp" ? "tmp" : "var-tmp",
      path: rootPath,
      retainedRoot,
      uid: retainedStatus.uid,
    });
  }
  closeSync(retainedRoot);
  throw new Error("fd 7 remained open");
}

function parseBootTime(bytes) {
  if (bytes.length === 0 || bytes.length > 128 || bytes.at(-1) !== 0x0a) {
    throw new Error("boot-time frame mismatch");
  }
  const match = /^(?<seconds>0|[1-9][0-9]*)(?:\.(?<fraction>[0-9]{1,9}))? (?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?\n$/u.exec(
    bytes.toString("ascii"),
  );
  if (match?.groups?.seconds === undefined) throw new Error("boot-time syntax mismatch");
  const fraction = (match.groups.fraction ?? "").padEnd(9, "0");
  return BigInt(match.groups.seconds) * SECOND_NS + BigInt(fraction || "0");
}

function openBootClock() {
  const descriptor = openSync("/proc/uptime", FILE_FLAGS);
  const status = fstatSync(descriptor, { bigint: true });
  if (
    !status.isFile() ||
    status.uid !== 0n ||
    status.gid !== 0n ||
    status.nlink !== 1n ||
    status.size !== 0n ||
    numericMode(status) !== 0o444
  ) {
    closeSync(descriptor);
    throw new Error("boot-time descriptor mismatch");
  }
  let previous;
  let closed = false;
  return Object.freeze({
    sample() {
      if (closed) throw new Error("boot-time descriptor closed");
      const bytes = Buffer.allocUnsafe(129);
      const count = readSync(descriptor, bytes, 0, bytes.length, 0);
      if (count <= 0 || count > 128) throw new Error("boot-time frame cap");
      const value = parseBootTime(bytes.subarray(0, count));
      if (previous !== undefined && value < previous) {
        throw new Error("CLOCK_BOOTTIME regressed");
      }
      previous = value;
      return value;
    },
    close() {
      if (closed) return;
      closed = true;
      closeSync(descriptor);
    },
  });
}

function isAtOrBelow(candidate, root) {
  const offset = relative(root, candidate);
  return offset === "" || (!offset.startsWith(`..${sep}`) && offset !== "..");
}

function revalidateLinkedRoot(admission, cargo, clock) {
  clock.sample();
  const held = fstatSync(admission.retainedRoot, { bigint: true });
  const reached = lstatSync(admission.path, { bigint: true });
  const info = readDescriptorInfo(admission.retainedRoot);
  const mountInfo = cargo.parseMountInfo(readFileSync("/proc/self/mountinfo"));
  const containing = [...mountInfo]
    .filter(({ mountPath }) => isAtOrBelow(admission.path, mountPath))
    .sort((left, right) => right.mountPath.length - left.mountPath.length)[0];
  if (
    !sameStableStatus(held, reached) ||
    held.dev !== admission.device ||
    held.ino !== admission.inode ||
    held.uid !== admission.uid ||
    held.gid !== admission.gid ||
    numericMode(held) !== 0o700 ||
    info.flags !== "02700000" ||
    info.mountId !== admission.mountId ||
    containing?.mountId !== admission.mountId ||
    mountInfo.some(({ mountPath }) => isAtOrBelow(mountPath, admission.path)) ||
    realpathSync(admission.path) !== admission.path ||
    realpathSync(`/proc/self/fd/${admission.retainedRoot}`) !== admission.path
  ) {
    throw new Error("retained root changed");
  }
  requireAbsent(admission.alternatePath);
  clock.sample();
}

function validateRelativePath(path) {
  if (
    path.length === 0 ||
    Buffer.byteLength(path, "utf8") > MAXIMUM_RELATIVE_PATH_BYTES ||
    !/^[A-Za-z0-9._+@/-]+$/u.test(path) ||
    path.startsWith("/") ||
    path.includes("//") ||
    path.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("root member path mismatch");
  }
}

function enumerateRoot(admission, clock) {
  const entries = new Map();
  let pathBytes = 0;
  const rootPath = `/proc/self/fd/${admission.retainedRoot}`;
  const visit = (path, logicalParent, depth) => {
    if (depth > MAXIMUM_TREE_DEPTH) throw new Error("root tree depth exceeded");
    clock.sample();
    const before = logicalParent === ""
      ? fstatSync(admission.retainedRoot, { bigint: true })
      : lstatSync(path, { bigint: true });
    if (!before.isDirectory() || before.dev !== admission.device) {
      throw new Error("root directory identity mismatch");
    }
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const logical = logicalParent === "" ? entry.name : `${logicalParent}/${entry.name}`;
      validateRelativePath(logical);
      pathBytes += Buffer.byteLength(logical, "utf8");
      if (entries.size >= MAXIMUM_TREE_ENTRIES || pathBytes > MAXIMUM_TOTAL_PATH_BYTES) {
        throw new Error("root tree inventory cap");
      }
      const childPath = join(path, entry.name);
      const status = lstatSync(childPath, { bigint: true });
      if (
        status.dev !== admission.device ||
        status.uid !== admission.uid ||
        status.gid !== admission.gid ||
        (!status.isDirectory() && !status.isFile())
      ) {
        throw new Error("root member identity mismatch");
      }
      entries.set(logical, Object.freeze({ path: childPath, status }));
      if (status.isDirectory()) visit(childPath, logical, depth + 1);
    }
    const after = logicalParent === ""
      ? fstatSync(admission.retainedRoot, { bigint: true })
      : lstatSync(path, { bigint: true });
    if (!sameStableStatus(before, after)) throw new Error("root directory changed");
    clock.sample();
  };
  visit(rootPath, "", 0);
  return entries;
}

function readVerifiedFile(path, status, specification, admission, clock) {
  if (
    !status.isFile() ||
    status.dev !== admission.device ||
    status.uid !== admission.uid ||
    status.gid !== admission.gid ||
    status.nlink !== 1n ||
    status.size !== BigInt(specification.size) ||
    numericMode(status) !== specification.mode
  ) {
    throw new Error("root file metadata mismatch");
  }
  const descriptor = openSync(path, FILE_FLAGS);
  const digest = createHash("sha256");
  const capture = specification.capture === true ? Buffer.alloc(specification.size) : undefined;
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameStableStatus(status, opened)) throw new Error("root file changed across open");
    const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, Math.max(specification.size, 1)));
    let offset = 0;
    while (offset < specification.size) {
      clock.sample();
      const length = Math.min(buffer.length, specification.size - offset);
      const count = readSync(descriptor, buffer, 0, length, offset);
      clock.sample();
      if (count !== length) throw new Error("root file truncated");
      digest.update(buffer.subarray(0, count));
      if (capture !== undefined) buffer.copy(capture, offset, 0, count);
      offset += count;
    }
    clock.sample();
    if (readSync(descriptor, buffer, 0, 1, specification.size) !== 0) {
      throw new Error("root file grew");
    }
    clock.sample();
    if (!sameStableStatus(opened, fstatSync(descriptor, { bigint: true }))) {
      throw new Error("root file changed during read");
    }
  } finally {
    closeSync(descriptor);
  }
  const hexadecimal = digest.digest("hex");
  if (specification.digest !== undefined && hexadecimal !== specification.digest) {
    throw new Error("root file digest mismatch");
  }
  return Object.freeze({ bytes: capture, digest: hexadecimal });
}

function completeRootSpecifications(cargo, ledger, admission) {
  const specifications = new Map(ledger.specifications);
  const add = (path, specification) => {
    if (specifications.has(path)) throw new Error("duplicate structural root member");
    specifications.set(path, Object.freeze(specification));
  };
  const invocationBytes = Buffer.from(
    `${INVOCATION_RECORD_PREFIX}${admission.invocation}\n`,
    "ascii",
  );
  add("INVOCATION", {
    digest: createHash("sha256").update(invocationBytes).digest("hex"),
    kind: "file",
    mode: 0o600,
    size: invocationBytes.length,
  });
  add("control", { kind: "directory", mode: 0o555 });
  add("control/acquisition.sh", {
    digest: cargo.ACQUISITION_CONTROLLER_SHA256,
    kind: "file",
    mode: 0o444,
    size: 9_956,
  });
  add("acquisition", { kind: "directory", mode: 0o700 });
  add("acquisition/vendor-ledger.v1", {
    digest: ledger.digest,
    kind: "file",
    mode: 0o444,
    size: ledger.bytes.length,
  });
  add("docker", { kind: "directory", mode: 0o500 });
  add("docker/home", { kind: "directory", mode: 0o700 });
  add("docker/config", { kind: "directory", mode: 0o500 });
  add("docker/config/config.json", {
    digest: createHash("sha256").update(Buffer.from("{}", "ascii")).digest("hex"),
    kind: "file",
    mode: 0o400,
    size: 2,
  });
  return specifications;
}

function verifyCompleteRoot(admission, modules, clock) {
  revalidateLinkedRoot(admission, modules.cargo, clock);
  const entries = enumerateRoot(admission, clock);
  const ledgerEntry = entries.get("acquisition/vendor-ledger.v1");
  if (
    ledgerEntry === undefined ||
    !ledgerEntry.status.isFile() ||
    ledgerEntry.status.size <= 0n ||
    ledgerEntry.status.size > BigInt(MAXIMUM_LEDGER_BYTES)
  ) {
    throw new Error("root ledger missing");
  }
  const ledgerRead = readVerifiedFile(
    ledgerEntry.path,
    ledgerEntry.status,
    {
      capture: true,
      kind: "file",
      mode: 0o444,
      size: Number(ledgerEntry.status.size),
    },
    admission,
    clock,
  );
  const ledger = modules.cargo.parseCompleteLedger(ledgerRead.bytes);
  if (ledger.digest !== ledgerRead.digest) throw new Error("root ledger digest mismatch");
  const specifications = completeRootSpecifications(modules.proofEngine, ledger, admission);
  if (entries.size !== specifications.size) throw new Error("root membership mismatch");
  for (const [path, specification] of specifications) {
    const entry = entries.get(path);
    if (entry === undefined) throw new Error("root member missing");
    if (specification.kind === "directory") {
      const childDirectories = [...entries.entries()].filter(
        ([candidate, child]) => child.status.isDirectory() && dirname(candidate) === path,
      ).length;
      if (
        !entry.status.isDirectory() ||
        entry.status.dev !== admission.device ||
        entry.status.uid !== admission.uid ||
        entry.status.gid !== admission.gid ||
        numericMode(entry.status) !== specification.mode ||
        entry.status.nlink !== BigInt(2 + childDirectories)
      ) {
        throw new Error("root directory member mismatch");
      }
    } else if (path !== "acquisition/vendor-ledger.v1") {
      readVerifiedFile(entry.path, entry.status, specification, admission, clock);
    }
  }
  revalidateLinkedRoot(admission, modules.cargo, clock);
  return Object.freeze({ digest: ledger.digest, size: ledger.bytes.length });
}

function captureStream(stream, maximumBytes) {
  if (stream === null || stream === undefined) throw new Error("child pipe missing");
  const state = {
    bytes: 0,
    chunks: [],
    ended: false,
    error: undefined,
    overflow: false,
  };
  let settle;
  const settled = new Promise((resolvePromise) => {
    settle = resolvePromise;
  });
  const finish = () => {
    if (state.ended) return;
    state.ended = true;
    settle();
  };
  stream.on("data", (bytes) => {
    if (state.overflow) return;
    state.bytes += bytes.length;
    if (state.bytes > maximumBytes) {
      state.overflow = true;
      state.chunks = [];
      return;
    }
    state.chunks.push(Buffer.from(bytes));
  });
  stream.once("error", (error) => {
    state.error = error;
    finish();
  });
  stream.once("end", finish);
  stream.once("close", finish);
  return Object.freeze({
    bytes() {
      return state.overflow ? Buffer.alloc(0) : Buffer.concat(state.chunks, state.bytes);
    },
    get ended() {
      return state.ended;
    },
    get error() {
      return state.error;
    },
    get overflow() {
      return state.overflow;
    },
    settled,
  });
}

function processGroupAbsent(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw error;
  }
}

function signalProcessGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function assertNoRootDescriptorInChild(pid, admission) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  let names;
  try {
    names = readdirSync(`/proc/${pid}/fd`);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(name)) continue;
    try {
      const status = statSync(`/proc/${pid}/fd/${name}`, { bigint: true });
      if (status.dev !== admission.device || status.ino !== admission.inode) continue;
      const text = readFileSync(`/proc/${pid}/fdinfo/${name}`, "ascii");
      const match = /^mnt_id:\s+(?<mount>[1-9][0-9]*)$/gmu.exec(text);
      if (match?.groups?.mount === admission.mountId) {
        throw new Error("root capability inherited by child");
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "EBADF") throw error;
    }
  }
}

function registerOwnedChild(context, child, origin) {
  const state = {
    closed: false,
    signal: null,
    spawnError: undefined,
    status: null,
  };
  let settle;
  const closed = new Promise((resolvePromise) => {
    settle = resolvePromise;
  });
  child.once("error", (error) => {
    state.spawnError = error;
  });
  child.once("close", (status, signal) => {
    state.closed = true;
    state.status = status;
    state.signal = signal;
    settle();
  });
  const ownership = {
    captureAttempted: false,
    captureSettled: undefined,
    child,
    closed,
    observation: undefined,
    origin,
    settled: false,
    settlement: undefined,
    state,
  };
  context.ownedChildren.add(ownership);
  return ownership;
}

function captureOwnedResult(ownership, result) {
  if (ownership.captureAttempted) return;
  ownership.captureAttempted = true;
  if (ownership.captureSettled !== undefined) {
    ownership.captureSettled(result);
  }
}

function observeOwnedChild(ownership, caps, admission) {
  const { child, closed, state } = ownership;
  const stdout = caps.stdout === null ? null : captureStream(child.stdout, caps.stdout);
  const stderr = caps.stderr === null ? null : captureStream(child.stderr, caps.stderr);
  const extra = (caps.extra ?? []).map(({ index, cap }) =>
    captureStream(child.stdio[index], cap),
  );
  const observation = Object.freeze({ child, closed, extra, state, stderr, stdout });
  ownership.observation = observation;
  assertNoRootDescriptorInChild(child.pid, admission);
  return observation;
}

function unobservedOwnedChild(ownership) {
  return Object.freeze({
    child: ownership.child,
    closed: ownership.closed,
    extra: Object.freeze([]),
    state: ownership.state,
    stderr: null,
    stdout: null,
  });
}

function deadlinesFrom(started, hardDeadlineNs, normalNs, termNs, killNs) {
  const normalDeadlineNs = started + normalNs < hardDeadlineNs
    ? started + normalNs
    : hardDeadlineNs;
  const termDeadlineNs = normalDeadlineNs + termNs < hardDeadlineNs
    ? normalDeadlineNs + termNs
    : hardDeadlineNs;
  const killDeadlineNs = termDeadlineNs + killNs < hardDeadlineNs
    ? termDeadlineNs + killNs
    : hardDeadlineNs;
  if (killDeadlineNs <= started) throw new Error("child settlement budget exhausted");
  return Object.freeze({ killDeadlineNs, normalDeadlineNs, termDeadlineNs });
}

function latchDeadlines(ownership, signalState, clock, hardDeadlineNs) {
  const sampled = clock.sample();
  const started = typeof signalState.atNs === "bigint" ? signalState.atNs : sampled;
  if (started > sampled) throw new Error("signal latch time advanced beyond clock");
  return ownership.origin === "create"
    ? deadlinesFrom(
        started,
        hardDeadlineNs,
        DOCKER_NORMAL_NS,
        CREATE_TERM_NS,
        CREATE_KILL_NS,
      )
    : deadlinesFrom(
        started,
        hardDeadlineNs,
        DOCKER_NORMAL_NS,
        DOCKER_TERM_NS,
        DOCKER_KILL_NS,
      );
}

async function waitForChildSettlement(ownership, options) {
  const observation = ownership.observation ?? unobservedOwnedChild(ownership);
  const settlement = ownership.settlement ?? {
    deadlines: Object.freeze({
      killDeadlineNs: options.killDeadlineNs,
      normalDeadlineNs: options.normalDeadlineNs,
      termDeadlineNs: options.termDeadlineNs,
    }),
    expired: false,
    latchApplied: false,
    stage: "settle",
  };
  ownership.settlement = settlement;
  const noteExpiry = (now) => {
    if (settlement.expired) return;
    settlement.expired = true;
    if (options.onExpire !== undefined) options.onExpire(now);
  };
  const channels = [observation.stdout, observation.stderr, ...observation.extra]
    .filter((channel) => channel !== null);
  while (
    !observation.state.closed ||
    !processGroupAbsent(observation.child.pid) ||
    channels.some((channel) => !channel.ended)
  ) {
    const now = synchronizeRevocation(options.context);
    const forced =
      observation.state.spawnError !== undefined ||
      channels.some((channel) => channel.error !== undefined || channel.overflow);
    if (forced && options.interruptible && !options.signalState.latched) {
      latchFailure(options.context);
    }
    if (
      options.interruptible &&
      !settlement.latchApplied
    ) {
      if (options.signalState.latched) {
        settlement.deadlines = latchDeadlines(
          ownership,
          options.signalState,
          options.clock,
          options.hardDeadlineNs,
        );
        settlement.latchApplied = true;
      } else if (now >= options.activeLatchNs) {
        settlement.latchApplied = true;
      }
    }
    if (
      settlement.stage === "settle" &&
      now >= settlement.deadlines.normalDeadlineNs
    ) {
      signalProcessGroup(observation.child.pid, "SIGTERM");
      settlement.stage = "term";
      if (options.onStage !== undefined) options.onStage("term", now);
    }
    if (
      settlement.stage === "term" &&
      now >= settlement.deadlines.termDeadlineNs
    ) {
      signalProcessGroup(observation.child.pid, "SIGKILL");
      settlement.stage = "kill";
      if (options.onStage !== undefined) options.onStage("kill", now);
    }
    if (now >= settlement.deadlines.killDeadlineNs) {
      noteExpiry(now);
      throw new Error("owned child or process group exceeded its operation cap");
    }
    await delay(POLL_MILLISECONDS);
  }
  const settledAtNs = synchronizeRevocation(options.context);
  if (settledAtNs >= settlement.deadlines.killDeadlineNs) {
    noteExpiry(settledAtNs);
  }
  const result = Object.freeze({
    extra: Object.freeze(observation.extra.map((channel) => channel.bytes())),
    signal: observation.state.signal,
    status: observation.state.status,
    stderr: observation.stderr?.bytes() ?? Buffer.alloc(0),
    stdout: observation.stdout?.bytes() ?? Buffer.alloc(0),
  });
  ownership.settled = true;
  options.context.ownedChildren.delete(ownership);
  captureOwnedResult(ownership, result);
  if (settlement.expired) {
    throw new Error("owned child settled after operation cap");
  }
  if (
    observation.state.spawnError !== undefined ||
    channels.some((channel) => channel.error !== undefined || channel.overflow)
  ) {
    throw new Error("owned child output or spawn refusal");
  }
  return result;
}

function childDeadlines(clock, hardDeadlineNs, normalNs, termNs, killNs) {
  const started = clock.sample();
  return deadlinesFrom(started, hardDeadlineNs, normalNs, termNs, killNs);
}

async function settleRegisteredChild(
  context,
  ownership,
  { hardDeadlineNs, interruptible, killNs, normalNs, termNs },
) {
  if (ownership === undefined) return;
  const releaseReferences = () => {
    if (context.activeChild === ownership) context.activeChild = null;
    if (context.watcherOwnership === ownership) context.watcherOwnership = undefined;
    if (context.pathHelperOwnership === ownership) {
      context.pathHelperOwnership = undefined;
    }
  };
  if (ownership.settled) {
    releaseReferences();
    return;
  }
  let deadlines = ownership.settlement?.deadlines;
  if (deadlines === undefined) {
    try {
      deadlines = childDeadlines(
        context.clock,
        hardDeadlineNs,
        normalNs,
        termNs,
        killNs,
      );
    } catch (error) {
      signalProcessGroup(ownership.child.pid, "SIGKILL");
      throw error;
    }
  }
  try {
    await waitForChildSettlement(ownership, {
      ...deadlines,
      activeLatchNs: context.activeDeadlineNs,
      clock: context.clock,
      context,
      hardDeadlineNs: deadlines.killDeadlineNs,
      interruptible,
      signalState: context.signalState,
    });
  } finally {
    if (ownership.settled) releaseReferences();
  }
}

function hashDockerBinary(clock) {
  const before = lstatSync("/usr/bin/docker", { bigint: true });
  if (
    !before.isFile() ||
    before.uid !== 0n ||
    before.gid !== 0n ||
    before.nlink !== 1n ||
    before.size !== DOCKER_BINARY_SIZE ||
    numericMode(before) !== 0o755
  ) {
    throw new Error("Docker binary identity mismatch");
  }
  const descriptor = openSync("/usr/bin/docker", FILE_FLAGS);
  const digest = createHash("sha256");
  try {
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let offset = 0n;
    while (offset < before.size) {
      clock.sample();
      const length = Number(
        before.size - offset > BigInt(buffer.length)
          ? BigInt(buffer.length)
          : before.size - offset,
      );
      const count = readSync(descriptor, buffer, 0, length, Number(offset));
      clock.sample();
      if (count !== length) throw new Error("Docker binary truncated");
      digest.update(buffer.subarray(0, count));
      offset += BigInt(count);
    }
    if (readSync(descriptor, buffer, 0, 1, Number(before.size)) !== 0) {
      throw new Error("Docker binary grew");
    }
    if (!sameStableStatus(before, fstatSync(descriptor, { bigint: true }))) {
      throw new Error("Docker binary changed");
    }
  } finally {
    closeSync(descriptor);
  }
  if (digest.digest("hex") !== DOCKER_BINARY_SHA256) {
    throw new Error("Docker binary digest mismatch");
  }
  return Object.freeze({ device: before.dev, inode: before.ino });
}

function captureDockerAnchor(clock) {
  const binary = hashDockerBinary(clock);
  const socket = lstatSync("/var/run/docker.sock", { bigint: true });
  if (
    !socket.isSocket() ||
    socket.uid !== 0n ||
    numericMode(socket) !== 0o660
  ) {
    throw new Error("Docker socket identity mismatch");
  }
  return Object.freeze({
    binary,
    socket: Object.freeze({
      device: socket.dev,
      gid: socket.gid,
      inode: socket.ino,
      realPath: realpathSync("/var/run/docker.sock"),
    }),
  });
}

function revalidateDockerAnchor(anchor, clock) {
  clock.sample();
  const binary = lstatSync("/usr/bin/docker", { bigint: true });
  const socket = lstatSync("/var/run/docker.sock", { bigint: true });
  if (
    !binary.isFile() ||
    binary.dev !== anchor.binary.device ||
    binary.ino !== anchor.binary.inode ||
    binary.uid !== 0n ||
    binary.gid !== 0n ||
    binary.nlink !== 1n ||
    binary.size !== DOCKER_BINARY_SIZE ||
    numericMode(binary) !== 0o755 ||
    !socket.isSocket() ||
    socket.dev !== anchor.socket.device ||
    socket.ino !== anchor.socket.inode ||
    socket.uid !== 0n ||
    socket.gid !== anchor.socket.gid ||
    realpathSync("/var/run/docker.sock") !== anchor.socket.realPath ||
    numericMode(socket) !== 0o660
  ) {
    throw new Error("Docker endpoint identity changed");
  }
  clock.sample();
}

function forbiddenFrame(operation) {
  if (operation === "create") {
    return Buffer.from("openspell.wp201.real-cut-forbidden-create.v1\n", "ascii");
  }
  if (operation === "configuration-inspect") {
    return Buffer.from(
      "openspell.wp201.real-cut-forbidden-config-inspect.v1\n",
      "ascii",
    );
  }
  if (operation === "start-attach") {
    return Buffer.from(
      "openspell.wp201.real-cut-forbidden-start-attach.v1\n",
      "ascii",
    );
  }
  throw new Error("invalid normal Docker dispatch");
}

function guardNormalDockerDispatch(context, operation) {
  synchronizeRevocation(context);
  if (!context.signalState.latched) return;
  writeAllSync(AUDIT_FD, forbiddenFrame(operation));
  throw new Error("normal Docker dispatch after signal latch");
}

async function runDocker(context, arguments_, options = {}) {
  if (context.activeChild !== null) throw new Error("Docker child custody already active");
  if (options.normalOperation !== undefined) {
    guardNormalDockerDispatch(context, options.normalOperation);
  }
  revalidateLinkedRoot(context.admission, context.modules.cargo, context.clock);
  revalidateDockerAnchor(context.dockerAnchor, context.clock);
  const prefix = context.modules.proofEngine.dockerPrefix(
    context.admission.invocation,
    context.admission.path,
  );
  if (options.normalOperation !== undefined) {
    guardNormalDockerDispatch(context, options.normalOperation);
  }
  if (
    options.cleanupWindow !== undefined &&
    synchronizeRevocation(context) >= options.cleanupWindow.endNs
  ) {
    throw new Error("cleanup Docker dispatch deadline reached");
  }
  const deadlines = options.cleanupWindow !== undefined
    ? Object.freeze({
        killDeadlineNs: options.cleanupWindow.endNs,
        normalDeadlineNs: options.cleanupWindow.normalEndNs,
        termDeadlineNs: options.cleanupWindow.termEndNs,
      })
    : options.cleanup === true
    ? childDeadlines(
        context.clock,
        context.hardDeadlineNs,
        DOCKER_NORMAL_NS,
        DOCKER_TERM_NS,
        DOCKER_KILL_NS,
      )
    : deadlinesFrom(
        context.activeDeadlineNs,
        context.hardDeadlineNs,
        DOCKER_NORMAL_NS,
        options.normalOperation === "create" ? CREATE_TERM_NS : DOCKER_TERM_NS,
        options.normalOperation === "create" ? CREATE_KILL_NS : DOCKER_KILL_NS,
      );
  if (options.normalOperation !== undefined) {
    guardNormalDockerDispatch(context, options.normalOperation);
  }
  if (options.beforeNormalSpawn !== undefined) options.beforeNormalSpawn();
  const child = spawn(prefix[0], [...prefix.slice(1), ...arguments_], {
    cwd: "/",
    detached: true,
    env: context.modules.proofEngine.dockerEnvironment(
      context.admission.invocation,
      context.admission.path,
    ),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ownership = registerOwnedChild(
    context,
    child,
    options.normalOperation === "create" ? "create" : "other",
  );
  ownership.token = options.ownedToken;
  ownership.captureSettled = options.captureSettled;
  context.activeChild = ownership;
  if (options.normalOperation === "create") context.createIssued = true;
  const settlementOptions = {
    ...deadlines,
    activeLatchNs: context.activeDeadlineNs,
    clock: context.clock,
    context,
    hardDeadlineNs: deadlines.killDeadlineNs,
    interruptible: options.cleanup !== true,
    onExpire: options.onExpire,
    onStage: options.onStage,
    signalState: context.signalState,
  };
  try {
    observeOwnedChild(
      ownership,
      {
        stderr: options.stderrCap ?? 1024 * 1024,
        stdout: options.stdoutCap ?? 1024 * 1024,
      },
      context.admission,
    );
    const result = await waitForChildSettlement(ownership, settlementOptions);
    captureOwnedResult(ownership, result);
    revalidateDockerAnchor(context.dockerAnchor, context.clock);
    revalidateLinkedRoot(context.admission, context.modules.cargo, context.clock);
    return result;
  } finally {
    if (!ownership.settled) {
      try {
        if (options.cleanupWindow !== undefined) {
          const result = await waitForChildSettlement(ownership, settlementOptions);
          captureOwnedResult(ownership, result);
        } else if (
          ownership.token !== undefined &&
          context.cleanupCursor?.active?.token === ownership.token
        ) {
          latchFailure(context);
          if (ownership.settlement === undefined) {
            const active = context.cleanupCursor.active;
            const result = await waitForChildSettlement(ownership, {
              activeLatchNs: context.activeDeadlineNs,
              clock: context.clock,
              context,
              hardDeadlineNs: active.window.endNs,
              interruptible: false,
              killDeadlineNs: active.window.endNs,
              normalDeadlineNs: active.window.normalEndNs,
              onExpire(atNs) {
                if (!context.cleanupCursor.active?.capReached) {
                  reduceCursor(
                    context,
                    { type: "expire-active", token: ownership.token },
                    atNs,
                  );
                }
              },
              onStage(stage, atNs) {
                reduceCursor(
                  context,
                  {
                    type: "advance-child-stage",
                    token: ownership.token,
                    stage,
                  },
                  atNs,
                );
              },
              signalState: context.signalState,
              termDeadlineNs: active.window.termEndNs,
            });
            captureOwnedResult(ownership, result);
          } else {
            const result = await waitForChildSettlement(
              ownership,
              settlementOptions,
            );
            captureOwnedResult(ownership, result);
          }
        } else {
          await settleRegisteredChild(context, ownership, {
            hardDeadlineNs: context.hardDeadlineNs,
            interruptible: options.cleanup !== true,
            killNs: ownership.origin === "create" ? CREATE_KILL_NS : DOCKER_KILL_NS,
            normalNs: DOCKER_NORMAL_NS,
            termNs: ownership.origin === "create" ? CREATE_TERM_NS : DOCKER_TERM_NS,
          });
        }
      } catch {
        // Retain ownership for the one-shot cleanup path and outer supervisor.
      }
    }
    if (ownership.settled && context.activeChild === ownership) {
      context.activeChild = null;
    }
  }
}

function dockerParserInput(result) {
  return Object.freeze({
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  });
}

function initializeCleanupCursor(context, watcherReady) {
  if (context.cleanupCursor !== undefined) return;
  context.cleanupCursor = context.modules.proofEngine.createCleanupCursor({
    activeDeadlineNs: context.activeDeadlineNs,
    createIssued: false,
    hardDeadlineNs: context.hardDeadlineNs,
    ids: [],
    sample: bootSample(context, context.startedAtNs),
    watcherReady,
  });
  synchronizeRevocation(context);
  for (const id of context.eventCustodyIds) {
    reduceCursor(context, { type: "watcher-event", id });
  }
}

async function runExactNameInspection(context, operation) {
  const token = context.modules.proofEngine.createOwnedChildToken();
  const result = await runDocker(
    context,
    context.modules.proofEngine.dockerOperationArguments("exact-name-proof", {
      invocation: context.admission.invocation,
      rowId: ROW_ID,
    }),
    operation === "exact-name-proof"
      ? { cleanup: false, normalOperation: "configuration-inspect" }
      : { cleanup: true },
  );
  return context.modules.proofEngine.classifyDockerExactName(
    dockerParserInput(result),
    { kind: "proof", invocation: context.admission.invocation, rowId: ROW_ID },
    { operation, token },
  );
}

async function runInitialLabelCensus(context) {
  const token = context.modules.proofEngine.createOwnedChildToken();
  const result = await runDocker(
    context,
    context.modules.proofEngine.dockerOperationArguments("label-census", {
      invocation: context.admission.invocation,
    }),
    { normalOperation: "configuration-inspect" },
  );
  return context.modules.proofEngine.parseDockerLabelCensus(
    dockerParserInput(result),
    context.admission.invocation,
    { operation: "label-census", token },
  );
}

async function runCreateResult(context) {
  initializeCleanupCursor(context, true);
  let classified;
  const token = context.modules.proofEngine.createOwnedChildToken();
  const result = await runDocker(
    context,
    context.modules.proofEngine.proofCreateArguments({
      invocation: context.admission.invocation,
      invocationDirectory: context.admission.path,
      ledgerSha256: context.ledger.digest,
      rowId: ROW_ID,
    }),
    {
      captureSettled(settled) {
        classified = context.modules.proofEngine.classifyDockerCreateResult(
          dockerParserInput(settled),
        );
        if (classified.custodyId !== null) {
          context.responseCustodyIds.add(classified.custodyId);
        }
        reduceCursor(
          context,
          classified.custodyId === null
            ? { type: "record-result", token, outcome: "ambiguous" }
            : {
                type: "record-result",
                token,
                outcome: "created",
                id: classified.custodyId,
              },
        );
        if (!classified.success) latchFailure(context);
        reduceCursor(context, { type: "observe-reap", token });
        reduceCursor(context, { type: "advance" });
      },
      beforeNormalSpawn() {
        reduceCursor(context, {
          type: "begin-child",
          origin: "create",
          operation: "create",
          token,
        });
      },
      normalOperation: "create",
      onExpire(atNs) {
        if (!context.cleanupCursor.active?.capReached) {
          reduceCursor(context, { type: "expire-active", token }, atNs);
        }
      },
      onStage(stage, atNs) {
        reduceCursor(
          context,
          { type: "advance-child-stage", token, stage },
          atNs,
        );
      },
      ownedToken: token,
      stderrCap: 4_096,
      stdoutCap: 4_096,
    },
  );
  if (classified === undefined) throw new Error("create response interception missing");
  return Object.freeze({ classified, result });
}

function interceptCreateResult(createResult) {
  const { classified } = createResult;
  if (!classified.success || classified.custodyId === null) {
    throw new Error("Docker create did not succeed exactly");
  }
  return classified.custodyId;
}

async function runCreateAndDeliverToParent(context) {
  const id = interceptCreateResult(await runCreateResult(context));
  context.custodyIds.add(id);
  context.wrapperDeliveryState = "delivered";
  return id;
}

async function runCreateAtDaemonDeliveryCut(context) {
  const id = interceptCreateResult(await runCreateResult(context));
  context.wrapperDeliveryState = "intercepted";
  const eventId = await waitForWatcherEvent(context);
  if (id !== eventId) throw new Error("create response and event identity conflict");
  await pauseAfterDaemonAcceptBeforeDelivery(context, id);
}

function writePipe(stream, bytes, closeAfterWrite) {
  return new Promise((resolvePromise, rejectPromise) => {
    stream.write(bytes, (error) => {
      if (error !== undefined && error !== null) {
        rejectPromise(error);
        return;
      }
      if (closeAfterWrite) stream.end(resolvePromise);
      else resolvePromise();
    });
  });
}

function readProcessStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("watcher PID missing");
  const text = readFileSync(`/proc/${pid}/stat`, "ascii");
  const close = text.lastIndexOf(")");
  if (close <= 0 || text[close + 1] !== " ") throw new Error("process stat framing");
  const fields = text.slice(close + 2).trimEnd().split(" ");
  const startTime = fields[19];
  if (startTime === undefined || !descriptorPattern.test(startTime)) {
    throw new Error("process start identity mismatch");
  }
  return startTime;
}

function installReleaseReader() {
  const stream = createReadStream("/dev/null", {
    autoClose: true,
    fd: RELEASE_FD,
  });
  const state = {
    bytes: 0,
    closed: false,
    chunks: [],
    eof: false,
    error: undefined,
    overflow: false,
  };
  stream.on("data", (bytes) => {
    state.bytes += bytes.length;
    if (state.bytes > 160) {
      state.overflow = true;
      state.chunks = [];
      return;
    }
    if (!state.overflow) state.chunks.push(Buffer.from(bytes));
  });
  stream.once("error", (error) => {
    state.error = error;
  });
  stream.once("end", () => {
    state.eof = true;
  });
  stream.once("close", () => {
    state.closed = true;
  });
  return Object.freeze({
    bytes() {
      return state.overflow ? Buffer.alloc(0) : Buffer.concat(state.chunks, state.bytes);
    },
    get closed() {
      return state.closed;
    },
    get eof() {
      return state.eof;
    },
    get error() {
      return state.error;
    },
    get overflow() {
      return state.overflow;
    },
  });
}

function installSignalLatch(clock) {
  let challenge;
  const state = {
    acknowledged: false,
    auditWriteFailed: false,
    atNs: undefined,
    cause: undefined,
    latched: false,
    signal: undefined,
  };
  const handler = (signal) => {
    if (state.latched) return;
    state.latched = true;
    state.cause = "signal";
    state.signal = signal;
    if (signal !== "SIGTERM") {
      state.auditWriteFailed = true;
      return;
    }
    try {
      state.atNs = clock.sample();
      const entropy = capturedRandomBytes(32);
      if (!Buffer.isBuffer(entropy) || entropy.length !== 32) {
        throw new Error("signal freshness entropy mismatch");
      }
      challenge = entropy.toString("hex");
      if (!freshnessChallengePattern.test(challenge)) {
        throw new Error("signal freshness challenge mismatch");
      }
      const acknowledgment = Buffer.concat([
        Buffer.from("openspell.wp201.real-cut-", "ascii"),
        Buffer.from("signal-latched.v2\nSIGTERM\n", "ascii"),
        Buffer.from(challenge, "ascii"),
        Buffer.from("\n", "ascii"),
      ]);
      if (acknowledgment.length !== 116) {
        throw new Error("signal acknowledgment framing mismatch");
      }
      writeAllSync(AUDIT_FD, acknowledgment);
      state.acknowledged = true;
    } catch {
      state.auditWriteFailed = true;
    }
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, handler);
  }
  return Object.freeze({
    get challenge() {
      return challenge;
    },
    handler,
    state,
    uninstall() {
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        process.off(signal, handler);
      }
    },
  });
}

function bootSample(context, nanoseconds = context.clock.sample()) {
  return context.modules.proofEngine.createBootTimeSample(nanoseconds);
}

function reduceCursor(context, transition, nanoseconds) {
  if (transition.type !== "latch") synchronizeRevocation(context);
  const atNs = nanoseconds ?? context.clock.sample();
  context.cleanupCursor = context.modules.proofEngine.reduceCleanupCursor(
    context.cleanupCursor,
    transition,
    bootSample(context, atNs),
  );
  return context.cleanupCursor;
}

function synchronizeRevocation(context) {
  const now = context.clock.sample();
  if (!context.signalState.latched && now >= context.activeDeadlineNs) {
    context.signalState.latched = true;
    context.signalState.cause = "deadline";
    context.signalState.atNs = now;
  }
  if (
    context.cleanupCursor !== undefined &&
    context.signalState.latched &&
    !context.cleanupCursor.revocation.latched
  ) {
    context.cleanupCursor = context.modules.proofEngine.reduceCleanupCursor(
      context.cleanupCursor,
      { type: "latch", cause: context.signalState.cause },
      bootSample(context, context.signalState.atNs),
    );
  }
  return now;
}

function latchNormalCleanup(context) {
  const now = synchronizeRevocation(context);
  if (!context.signalState.latched) {
    context.signalState.latched = true;
    context.signalState.cause = "normal";
    context.signalState.atNs = now;
  }
  synchronizeRevocation(context);
}

function latchFailure(context) {
  const now = synchronizeRevocation(context);
  if (!context.signalState.latched) {
    context.signalState.latched = true;
    context.signalState.cause = "failure";
    context.signalState.atNs = now;
  }
  synchronizeRevocation(context);
}

async function waitForCondition(context, predicate, deadlineNs, label) {
  while (true) {
    const now = synchronizeRevocation(context);
    if (context.asyncFailure !== undefined) throw context.asyncFailure;
    if (predicate()) return;
    if (now >= deadlineNs) {
      throw new Error(`${label} deadline`);
    }
    await delay(POLL_MILLISECONDS);
  }
}

async function startWatcher(context) {
  synchronizeRevocation(context);
  if (context.signalState.latched) throw new Error("watcher blocked after signal");
  revalidateLinkedRoot(context.admission, context.modules.cargo, context.clock);
  revalidateDockerAnchor(context.dockerAnchor, context.clock);
  const containerName = context.modules.proofEngine.proofContainerName(
    context.admission.invocation,
    ROW_ID,
  );
  if (
    containerName !==
    `openspell-wp201-${context.admission.invocation}-proof-root-fmt`
  ) {
    throw new Error("watcher container-name derivation mismatch");
  }
  const openFrame = buildDockerEventOpenFrame(
    context.admission.invocation,
    PROOF_ROLE,
    containerName,
  );
  synchronizeRevocation(context);
  if (context.signalState.latched) throw new Error("watcher blocked after signal");
  const watcherToken = context.modules.proofEngine.createOwnedChildToken();
  context.preReadyWatcherCustody =
    context.modules.proofEngine.createPreReadyWatcherCustody({
      activeDeadlineNs: context.activeDeadlineNs,
      hardDeadlineNs: context.hardDeadlineNs,
      sample: bootSample(context),
      token: watcherToken,
    });
  const child = spawn(capturedNodeExecutable, [DOCKER_EVENT_HELPER], {
    cwd: "/",
    detached: true,
    env: { LANG: "C", LC_ALL: "C" },
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe", "pipe"],
  });
  const ownership = registerOwnedChild(context, child, "watcher");
  ownership.token = watcherToken;
  context.watcherOwnership = ownership;
  const observation = observeOwnedChild(
    ownership,
    {
      extra: [
        { cap: WATCHER_READY.length, index: 4 },
        { cap: WATCHER_EVENT_PREFIX.length + 65, index: 5 },
      ],
      stderr: 4_096,
      stdout: null,
    },
    context.admission,
  );
  const startTime = readProcessStartTime(child.pid);
  const watcher = {
    child,
    closeSent: false,
    observation,
    ownership,
    ready: observation.extra[0],
    event: observation.extra[1],
    startTime,
  };
  context.watcher = watcher;
  child.stdio[5].on("data", () => {
    try {
      currentWatcherEvent(context);
    } catch (error) {
      context.asyncFailure = error;
      latchFailure(context);
    }
  });
  await writePipe(child.stdio[3], openFrame, false);
  await waitForCondition(
    context,
    () =>
      watcher.ready.bytes().length === WATCHER_READY.length ||
      watcher.ready.ended ||
      observation.state.closed,
    context.activeDeadlineNs,
    "watcher READY",
  );
  if (
    observation.state.closed ||
    watcher.ready.ended ||
    watcher.ready.error !== undefined ||
    watcher.ready.overflow ||
    !watcher.ready.bytes().equals(WATCHER_READY)
  ) {
    throw new Error("watcher READY refusal");
  }
  context.modules.proofEngine.parseDockerEventReadyFrame(watcher.ready.bytes());
  synchronizeRevocation(context);
  if (context.signalState.latched) {
    throw new Error("watcher READY after revocation");
  }
  context.preReadyWatcherCustody =
    context.modules.proofEngine.reducePreReadyWatcherCustody(
      context.preReadyWatcherCustody,
      { type: "ready" },
      bootSample(context),
    );
  initializeCleanupCursor(context, true);
  revalidateDockerAnchor(context.dockerAnchor, context.clock);
  revalidateLinkedRoot(context.admission, context.modules.cargo, context.clock);
}

function currentWatcherEvent(context) {
  synchronizeRevocation(context);
  if (context.watcher === undefined) return null;
  const channel = context.watcher.event;
  const bytes = channel.bytes();
  if (channel.error !== undefined || channel.overflow) {
    throw new Error("watcher event channel refusal");
  }
  if (bytes.length === 0) return null;
  if (bytes.length !== WATCHER_EVENT_PREFIX.length + 65) {
    if (channel.ended) throw new Error("watcher event frame truncated");
    return undefined;
  }
  const id = context.modules.proofEngine.parseDockerEventIdFrame(bytes);
  if (!context.eventCustodyIds.has(id)) {
    context.eventCustodyIds.add(id);
    if (context.cleanupCursor !== undefined) {
      reduceCursor(context, { type: "watcher-event", id });
    }
  }
  return id;
}

async function waitForWatcherEvent(context) {
  await waitForCondition(
    context,
    () => {
      const value = currentWatcherEvent(context);
      if (value === null && context.watcher.event.ended) {
        throw new Error("watcher event EOF before accepted ID");
      }
      return value !== undefined && value !== null;
    },
    context.activeDeadlineNs,
    "watcher event",
  );
  const id = currentWatcherEvent(context);
  if (typeof id !== "string") throw new Error("watcher event missing");
  return id;
}

function watcherIdentityStillLive(watcher) {
  try {
    return readProcessStartTime(watcher.child.pid) === watcher.startTime;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function emitAcceptedId(id) {
  writeAllSync(
    ACCEPTED_ID_FD,
    Buffer.from(
      `openspell.wp201.real-cut-accepted-id.v1\n${id ?? "none"}\n`,
      "ascii",
    ),
  );
}

function emitIdentity(context, cutCase) {
  if (context.watcher === undefined || !watcherIdentityStillLive(context.watcher)) {
    throw new Error("watcher identity not live at cut");
  }
  const frame = Buffer.from(
    [
      "openspell.wp201.real-cut-identity.v2",
      cutCase,
      context.admission.invocation,
      context.admission.parentToken,
      context.admission.device.toString(),
      context.admission.inode.toString(),
      context.admission.mountId,
      context.ledger.digest,
      String(context.watcher.child.pid),
      context.watcher.startTime,
      "",
    ].join("\n"),
    "ascii",
  );
  if (frame.length > 320) throw new Error("cut identity frame cap");
  writeAllSync(IDENTITY_FD, frame);
}

async function awaitSignalAndRelease(context, cutCase) {
  await waitForCondition(
    context,
    () => context.signalState.latched,
    context.activeDeadlineNs,
    "cut signal",
  );
  if (
    context.signalState.signal !== "SIGTERM" ||
    !context.signalState.acknowledged ||
    context.signalState.auditWriteFailed ||
    context.signalState.atNs === undefined ||
    !freshnessChallengePattern.test(context.signalControl.challenge ?? "")
  ) {
    throw new Error("cut signal protocol mismatch");
  }
  await waitForCondition(
    context,
    () =>
      context.release.eof ||
      context.release.closed ||
      context.release.error !== undefined ||
      context.release.overflow,
    context.hardDeadlineNs,
    "cut release",
  );
  const challenge = context.signalControl.challenge;
  const expected = Buffer.from(
    `openspell.wp201.real-cut-release.v2\n${cutCase}\n${challenge}\n`,
    "ascii",
  );
  if (
    !context.release.eof ||
    context.release.error !== undefined ||
    context.release.overflow ||
    expected.length > 160 ||
    !context.release.bytes().equals(expected)
  ) {
    throw new Error("cut release protocol mismatch");
  }
  context.releaseAccepted = true;
}

async function pauseBeforeIssue(context) {
  synchronizeRevocation(context);
  if (context.signalState.latched) throw new Error("cut pause reached after revocation");
  const event = currentWatcherEvent(context);
  if (event !== null) throw new Error("before-issue watcher observed a create");
  emitAcceptedId(null);
  emitIdentity(context, "before-issue");
  await awaitSignalAndRelease(context, "before-issue");
}

async function pauseAfterDaemonAcceptBeforeDelivery(context, id) {
  synchronizeRevocation(context);
  if (
    context.signalState.latched ||
    context.custodyIds.size !== 0 ||
    context.wrapperDeliveryState !== "intercepted" ||
    !context.responseCustodyIds.has(id) ||
    !context.eventCustodyIds.has(id)
  ) {
    throw new Error("daemon delivery cut predicate mismatch");
  }
  emitAcceptedId(id);
  emitIdentity(context, "after-daemon-accept-before-delivery");
  await awaitSignalAndRelease(context, "after-daemon-accept-before-delivery");
  context.custodyIds.add(id);
}

async function pauseAfterParentCustodyBeforeStart(context, id) {
  synchronizeRevocation(context);
  if (
    context.signalState.latched ||
    !context.custodyIds.has(id) ||
    context.wrapperDeliveryState !== "delivered" ||
    !context.responseCustodyIds.has(id) ||
    !context.eventCustodyIds.has(id)
  ) {
    throw new Error("parent custody cut predicate mismatch");
  }
  emitAcceptedId(id);
  emitIdentity(context, "after-parent-custody-before-start");
  await awaitSignalAndRelease(context, "after-parent-custody-before-start");
}

async function runPathCleanup(context, execution) {
  const deadlines = Object.freeze({
    killDeadlineNs: execution.window.endNs,
    normalDeadlineNs: execution.window.normalEndNs,
    termDeadlineNs: execution.window.termEndNs,
  });
  const child = spawn(capturedNodeExecutable, [PATH_CLEANUP_HELPER], {
    cwd: "/",
    detached: true,
    env: { LANG: "C", LC_ALL: "C" },
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  });
  const ownership = registerOwnedChild(context, child, "path-helper");
  ownership.token = execution.token;
  context.pathHelperOwnership = ownership;
  const control = Buffer.from(
    [
      "openspell.wp201.path-cleanup.v2",
      context.admission.parentToken,
      context.admission.invocation,
      context.admission.device.toString(),
      context.admission.inode.toString(),
      "ledger-backed",
      "",
    ].join("\n"),
    "ascii",
  );
  let controlError;
  let result;
  const settlementOptions = {
    ...deadlines,
    clock: context.clock,
    context,
    hardDeadlineNs: execution.window.endNs,
    interruptible: false,
    onExpire(atNs) {
      if (!context.cleanupCursor.active?.capReached) {
        advanceCursorChild(context, execution, { type: "expire-active" }, atNs);
      }
    },
    onStage(stage, atNs) {
      reduceCursor(
        context,
        { type: "advance-child-stage", token: execution.token, stage },
        atNs,
      );
    },
    signalState: context.signalState,
  };
  try {
    observeOwnedChild(
      ownership,
      { extra: [{ cap: 64, index: 4 }], stderr: 4_096, stdout: null },
      context.admission,
    );
    try {
      await writePipe(child.stdio[3], control, true);
    } catch (error) {
      controlError = error;
      child.stdio[3].destroy();
    }
    result = await waitForChildSettlement(ownership, settlementOptions);
  } finally {
    if (!ownership.settled) {
      try {
        await waitForChildSettlement(ownership, settlementOptions);
      } catch {
        // The cursor retains this child at its exact expired operation.
      }
    }
  }
  context.pathHelperOwnership = undefined;
  if (
    result === undefined ||
    controlError !== undefined ||
    result.status !== 0 ||
    result.signal !== null ||
    result.stderr.length !== 0 ||
    result.extra.length !== 1 ||
    !result.extra[0].equals(
      Buffer.from("openspell.wp201.path-cleanup-complete.v2\n", "ascii"),
    )
  ) {
    throw new Error("path cleanup helper refused");
  }
}

async function requireParentsAbsent(context, fixedDeadlineNs) {
  const sampled = context.clock.sample();
  const deadlineNs = fixedDeadlineNs ?? (
    sampled + PARENT_ABSENCE_NS < context.hardDeadlineNs
      ? sampled + PARENT_ABSENCE_NS
      : context.hardDeadlineNs
  );
  if (deadlineNs <= sampled) throw new Error("parent absence budget exhausted");
  let lastError;
  while (context.clock.sample() < deadlineNs) {
    try {
      requireAbsent(context.admission.path);
      requireAbsent(context.admission.alternatePath);
      return;
    } catch (error) {
      lastError = error;
    }
    await delay(POLL_MILLISECONDS);
  }
  throw new Error("invocation parents remained present", { cause: lastError });
}

function closeUnlinkedRoot(context) {
  const status = fstatSync(context.admission.retainedRoot, { bigint: true });
  const info = readDescriptorInfo(context.admission.retainedRoot);
  if (
    !status.isDirectory() ||
    status.dev !== context.admission.device ||
    status.ino !== context.admission.inode ||
    status.uid !== context.admission.uid ||
    status.gid !== context.admission.gid ||
    status.nlink !== 0n ||
    info.mountId !== context.admission.mountId ||
    readdirSync(`/proc/self/fd/${context.admission.retainedRoot}`).length !== 0
  ) {
    throw new Error("unlinked root custody mismatch");
  }
  const descriptor = context.admission.retainedRoot;
  closeSync(descriptor);
  context.rootClosed = true;
  try {
    fstatSync(descriptor);
  } catch (error) {
    if (error?.code === "EBADF") return;
    throw error;
  }
  throw new Error("retained root descriptor remained open");
}

function beginCursorOperation(context, expected) {
  const token = context.modules.proofEngine.createOwnedChildToken();
  reduceCursor(context, {
    type: "begin-operation",
    operation: expected.operation,
    token,
    ...(expected.id === undefined ? {} : { id: expected.id }),
  });
  return Object.freeze({ token, window: context.cleanupCursor.active.window });
}

function advanceCursorChild(context, execution, transition, nanoseconds) {
  reduceCursor(context, { ...transition, token: execution.token }, nanoseconds);
}

function cursorDockerArguments(context, expected) {
  if (expected.operation === "name-recovery") {
    return context.modules.proofEngine.dockerOperationArguments("exact-name-proof", {
      invocation: context.admission.invocation,
      rowId: ROW_ID,
    });
  }
  if (expected.operation === "preliminary-census" || expected.operation === "final-census") {
    return context.modules.proofEngine.dockerOperationArguments("label-census", {
      invocation: context.admission.invocation,
    });
  }
  if (expected.operation.startsWith("remove-")) {
    return context.modules.proofEngine.dockerOperationArguments("remove", { id: expected.id });
  }
  if (expected.operation.startsWith("absence-")) {
    return context.modules.proofEngine.dockerOperationArguments("absence", { id: expected.id });
  }
  throw new Error("unsupported cursor Docker operation");
}

function classifyCursorDockerResult(context, expected, execution, result) {
  const input = dockerParserInput(result);
  try {
    if (expected.operation === "name-recovery") {
      const receipt = context.modules.proofEngine.classifyDockerExactName(
        input,
        { kind: "proof", invocation: context.admission.invocation, rowId: ROW_ID },
        { operation: "exact-name-recovery", token: execution.token },
      );
      return receipt.outcome === "present"
        ? { type: "record-result", outcome: "found", id: receipt.id }
        : { type: "record-result", outcome: "absent" };
    }
    if (expected.operation === "preliminary-census" || expected.operation === "final-census") {
      const operation = expected.operation === "preliminary-census"
        ? "label-census"
        : "final-label-census";
      const receipt = context.modules.proofEngine.parseDockerLabelCensus(
        input,
        context.admission.invocation,
        { operation, token: execution.token },
      );
      return { type: "record-result", rows: [...receipt.ids] };
    }
    if (expected.operation.startsWith("remove-")) {
      const receipt = context.modules.proofEngine.parseDockerRemove(
        input,
        expected.id,
        { operation: expected.operation, token: execution.token },
      );
      return { type: "record-result", outcome: receipt.outcome };
    }
    const receipt = context.modules.proofEngine.parseDockerAbsence(
      input,
      expected.id,
      { operation: expected.operation, token: execution.token },
    );
    return { type: "record-result", outcome: receipt.outcome };
  } catch {
    if (expected.operation === "preliminary-census" || expected.operation === "final-census") {
      return { type: "record-result", rows: ["invalid"] };
    }
    if (expected.operation === "name-recovery") {
      return { type: "record-result", outcome: "invalid" };
    }
    return { type: "record-result", outcome: "ambiguous" };
  }
}

async function executeCursorDockerOperation(context, expected) {
  const execution = beginCursorOperation(context, expected);
  await runDocker(context, cursorDockerArguments(context, expected), {
    captureSettled(result) {
      let eventError;
      try {
        currentWatcherEvent(context);
      } catch (error) {
        eventError = error;
        context.asyncFailure = error;
        latchFailure(context);
      }
      advanceCursorChild(
        context,
        execution,
        classifyCursorDockerResult(context, expected, execution, result),
      );
      advanceCursorChild(context, execution, { type: "observe-reap" });
      reduceCursor(context, { type: "advance" });
      if (eventError !== undefined) throw eventError;
    },
    cleanup: true,
    cleanupWindow: execution.window,
    onExpire(atNs) {
      if (!context.cleanupCursor.active?.capReached) {
        advanceCursorChild(context, execution, { type: "expire-active" }, atNs);
      }
    },
    onStage(stage, atNs) {
      reduceCursor(
        context,
        { type: "advance-child-stage", token: execution.token, stage },
        atNs,
      );
    },
    ownedToken: execution.token,
  });
}

async function executeCursorSendClose(context, expected) {
  const execution = beginCursorOperation(context, expected);
  let outcome = "failed";
  const watcher = context.watcher;
  if (watcher !== undefined && !watcher.observation.state.closed) {
    try {
      if (!watcher.ready.bytes().equals(WATCHER_READY)) {
        throw new Error("watcher READY custody missing");
      }
      await writePipe(watcher.child.stdio[3], DOCKER_EVENT_CLOSE, true);
      watcher.closeSent = true;
      outcome = "sent";
    } catch {
      watcher.child.stdio[3].destroy();
    }
  }
  advanceCursorChild(context, execution, { type: "record-result", outcome });
  reduceCursor(context, { type: "advance" });
}

async function executeCursorWatcherSettlement(context, expected) {
  const execution = beginCursorOperation(context, expected);
  const ownership = context.watcherOwnership;
  if (ownership === undefined) {
    advanceCursorChild(context, execution, {
      type: "record-result",
      outcome: "failed",
    });
    throw new Error("watcher ownership missing");
  }
  const deadlines = Object.freeze({
    killDeadlineNs: execution.window.endNs,
    normalDeadlineNs: execution.window.normalEndNs,
    termDeadlineNs: execution.window.termEndNs,
  });
  const result = await waitForChildSettlement(ownership, {
    ...deadlines,
    activeLatchNs: context.activeDeadlineNs,
    clock: context.clock,
    context,
    hardDeadlineNs: execution.window.endNs,
    interruptible: false,
    onExpire(atNs) {
      if (!context.cleanupCursor.active?.capReached) {
        advanceCursorChild(context, execution, { type: "expire-active" }, atNs);
      }
    },
    onStage(stage, atNs) {
      reduceCursor(
        context,
        { type: "advance-child-stage", token: execution.token, stage },
        atNs,
      );
    },
    signalState: context.signalState,
  });
  context.watcherOwnership = undefined;
  let eventError;
  try {
    currentWatcherEvent(context);
  } catch (error) {
    eventError = error;
    context.asyncFailure = error;
    latchFailure(context);
  }
  if (!context.watcher.event.ended) throw new Error("watcher event EOF missing");
  reduceCursor(context, { type: "watcher-eof" });
  const watcherSettlementValid =
    eventError === undefined &&
    result.status === 0 &&
    result.signal === null &&
    result.stderr.length === 0 &&
    context.watcher.closeSent &&
    context.watcher.ready.ended &&
    context.watcher.event.ended;
  const outcome = watcherSettlementValid ? "reaped" : "failed";
  advanceCursorChild(context, execution, { type: "record-result", outcome });
  advanceCursorChild(context, execution, { type: "observe-reap" });
  reduceCursor(context, { type: "advance" });
  if (watcherSettlementValid) {
    context.watcherSettlementReceipt = AUTHENTICATED_WATCHER_SETTLEMENT;
  }
  if (eventError !== undefined) throw eventError;
}

async function executeCursorPathHelper(context, expected) {
  const execution = beginCursorOperation(context, expected);
  let outcome = "complete";
  try {
    await runPathCleanup(context, execution);
  } catch {
    outcome = "failed";
  }
  if (context.cleanupCursor.active?.token !== execution.token) return;
  if (!context.pathHelperOwnership?.settled && context.pathHelperOwnership !== undefined) {
    throw new Error("path helper remained in custody");
  }
  advanceCursorChild(context, execution, { type: "record-result", outcome });
  advanceCursorChild(context, execution, { type: "observe-reap" });
  reduceCursor(context, { type: "advance" });
}

async function executeCursorParentAbsence(context, expected) {
  const execution = beginCursorOperation(context, expected);
  let outcome;
  try {
    await requireParentsAbsent(context, execution.window.endNs);
    outcome = "absent";
  } catch {
    outcome = "failed";
  }
  if (context.clock.sample() >= execution.window.endNs && outcome !== "absent") {
    advanceCursorChild(context, execution, { type: "expire-active" });
  } else {
    advanceCursorChild(context, execution, { type: "record-result", outcome });
  }
  reduceCursor(context, { type: "advance" });
}

function cleanupCursorProvesCut(context) {
  const cursor = context.cleanupCursor;
  const responseIds = [...context.responseCustodyIds];
  const eventIds = [...context.eventCustodyIds];
  const identityAgreement = context.createIssued
    ? responseIds.length === 1 &&
      eventIds.length === 1 &&
      responseIds[0] === eventIds[0]
    : responseIds.length === 0 && eventIds.length === 0;
  return (
    cursor.phase === "complete" &&
    cursor.active === null &&
    cursor.ids.every((entry) => entry.state === "absent") &&
    cursor.finalIds.every((entry) => entry.state === "absent") &&
    ["empty", "deferred"].includes(cursor.preliminary.result) &&
    (!cursor.watcher.ready ||
      (cursor.watcher.closeSent &&
        cursor.watcher.eofObserved &&
        cursor.watcher.reaped &&
        context.watcherSettlementReceipt === AUTHENTICATED_WATCHER_SETTLEMENT)) &&
    cursor.finalCensus &&
    cursor.pathCleanup &&
    cursor.parentAbsence &&
    identityAgreement
  );
}

async function settlePreReadyWatcher(context) {
  const custody = context.preReadyWatcherCustody;
  if (custody?.phase !== "opening") return;
  const ownership = context.watcherOwnership;
  if (ownership === undefined || ownership.token !== custody.token) {
    throw new Error("pre-READY watcher ownership missing");
  }
  context.preReadyWatcherCustody =
    context.modules.proofEngine.reducePreReadyWatcherCustody(
      custody,
      { type: "latch" },
      bootSample(context, context.signalState.atNs),
    );
  const window = context.preReadyWatcherCustody.cleanupWindow;
  try {
    await waitForChildSettlement(ownership, {
      activeLatchNs: context.activeDeadlineNs,
      clock: context.clock,
      context,
      hardDeadlineNs: window.endNs,
      interruptible: false,
      killDeadlineNs: window.endNs,
      normalDeadlineNs: window.normalEndNs,
      onStage(stage, atNs) {
        context.preReadyWatcherCustody =
          context.modules.proofEngine.reducePreReadyWatcherCustody(
            context.preReadyWatcherCustody,
            { type: "advance-stage", stage },
            bootSample(context, atNs),
          );
      },
      signalState: context.signalState,
      termDeadlineNs: window.termEndNs,
    });
    context.preReadyWatcherCustody =
      context.modules.proofEngine.reducePreReadyWatcherCustody(
        context.preReadyWatcherCustody,
        { type: "reap" },
        bootSample(context),
      );
  } finally {
    if (ownership.settled) {
      if (context.watcherOwnership === ownership) {
        context.watcherOwnership = undefined;
      }
      if (context.activeChild === ownership) context.activeChild = null;
    }
  }
}

async function cleanupRuntime(context) {
  if (context.cleanupState !== "idle") return;
  context.cleanupState = "running";
  try {
    if (context.modules === undefined || context.dockerAnchor === undefined) {
      throw new Error("cleanup authority unavailable");
    }
    latchNormalCleanup(context);
    await settlePreReadyWatcher(context);
    initializeCleanupCursor(
      context,
      context.preReadyWatcherCustody?.phase === "ready" &&
        context.watcher !== undefined &&
        context.watcher.ready.bytes().equals(WATCHER_READY),
    );

    if (context.activeChild !== null) {
      const active = context.activeChild;
      const cursorActive = context.cleanupCursor.active;
      if (
        active.token !== undefined &&
        cursorActive?.token === active.token &&
        cursorActive.window !== null
      ) {
        try {
          const result = await waitForChildSettlement(active, {
            activeLatchNs: context.activeDeadlineNs,
            clock: context.clock,
            context,
            hardDeadlineNs: cursorActive.window.endNs,
            interruptible: true,
            killDeadlineNs: cursorActive.window.endNs,
            normalDeadlineNs: cursorActive.window.normalEndNs,
            onExpire(atNs) {
              if (!context.cleanupCursor.active?.capReached) {
                reduceCursor(
                  context,
                  { type: "expire-active", token: active.token },
                  atNs,
                );
              }
            },
            onStage(stage, atNs) {
              reduceCursor(
                context,
                {
                  type: "advance-child-stage",
                  token: active.token,
                  stage,
                },
                atNs,
              );
            },
            signalState: context.signalState,
            termDeadlineNs: cursorActive.window.termEndNs,
          });
          captureOwnedResult(active, result);
        } finally {
          if (active.settled && context.activeChild === active) {
            context.activeChild = null;
          }
        }
      } else {
        await settleRegisteredChild(context, active, {
          hardDeadlineNs: context.hardDeadlineNs,
          interruptible: true,
          killNs: active.origin === "create" ? CREATE_KILL_NS : DOCKER_KILL_NS,
          normalNs: DOCKER_NORMAL_NS,
          termNs: active.origin === "create" ? CREATE_TERM_NS : DOCKER_TERM_NS,
        });
      }
    }
    if (context.cleanupCursor.active !== null) {
      const active = context.cleanupCursor.active;
      if (active.result === null && !active.capReached) {
        const responseId = [...context.responseCustodyIds][0];
        reduceCursor(
          context,
          active.origin === "create" && responseId !== undefined
            ? { type: "record-result", token: active.token, outcome: "created", id: responseId }
            : { type: "record-result", token: active.token, outcome: "hung" },
        );
      }
      if (context.cleanupCursor.active?.requiresReap && !context.cleanupCursor.active.reaped) {
        reduceCursor(context, {
          type: "observe-reap",
          token: context.cleanupCursor.active.token,
        });
      }
      reduceCursor(context, { type: "advance" });
    }

    const cleanupErrors = [];
    let operations = 0;
    while (context.cleanupCursor.phase !== "complete") {
      if (operations >= 32) throw new Error("cleanup cursor operation cap");
      operations += 1;
      currentWatcherEvent(context);
      const expected = context.modules.proofEngine.expectedCleanupOperation(
        context.cleanupCursor,
      );
      if (expected === null) break;
      try {
        if (
          expected.operation === "name-recovery" ||
          expected.operation === "preliminary-census" ||
          expected.operation === "final-census" ||
          expected.operation.startsWith("remove-") ||
          expected.operation.startsWith("absence-")
        ) {
          await executeCursorDockerOperation(context, expected);
        } else if (expected.operation === "send-close") {
          await executeCursorSendClose(context, expected);
        } else if (expected.operation === "settle-watcher") {
          await executeCursorWatcherSettlement(context, expected);
        } else if (expected.operation === "path-helper") {
          await executeCursorPathHelper(context, expected);
        } else if (expected.operation === "parent-absence") {
          await executeCursorParentAbsence(context, expected);
        } else {
          throw new Error("unknown cleanup cursor operation");
        }
      } catch (error) {
        cleanupErrors.push(error);
        if (context.cleanupCursor.active !== null) break;
      }
    }

    revalidateDockerAnchor(context.dockerAnchor, context.clock);
    if (
      !cleanupCursorProvesCut(context) ||
      context.asyncFailure !== undefined ||
      context.ownedChildren.size !== 0 ||
      cleanupErrors.length !== 0
    ) {
      throw new Error("cleanup cursor did not prove completion");
    }
    closeUnlinkedRoot(context);
    context.cleanupState = "complete";
  } finally {
    if (context.cleanupState === "running") context.cleanupState = "failed";
    if (!context.rootClosed && context.cleanupState === "failed") {
      closeIgnoringErrors(context.admission.retainedRoot);
      context.rootClosed = true;
    }
  }
}

async function initializeContext(admission) {
  const clock = openBootClock();
  const startedAtNs = clock.sample();
  const context = {
    activeChild: null,
    activeDeadlineNs: startedAtNs + ACTIVE_NS,
    admission,
    asyncFailure: undefined,
    cleanupState: "idle",
    cleanupCursor: undefined,
    clock,
    createIssued: false,
    custodyIds: new Set(),
    dockerAnchor: undefined,
    eventCustodyIds: new Set(),
    hardDeadlineNs: startedAtNs + ACTIVE_NS + CLEANUP_NS,
    ledger: undefined,
    modules: undefined,
    ownedChildren: new Set(),
    pathHelperOwnership: undefined,
    responseCustodyIds: new Set(),
    release: undefined,
    releaseAccepted: false,
    rootClosed: false,
    signalControl: undefined,
    signalState: undefined,
    startedAtNs,
    watcher: undefined,
    watcherOwnership: undefined,
    watcherSettlementReceipt: null,
    wrapperDeliveryState: "none",
  };
  try {
    writeAllSync(AUDIT_FD, AUDIT_OPEN);
    context.signalControl = installSignalLatch(clock);
    context.signalState = context.signalControl.state;
    context.release = installReleaseReader();
    const [cargo, proofEngine] = await Promise.all([
      import("./cargo.mjs"),
      import("./proof-engine.mjs"),
    ]);
    context.modules = Object.freeze({ cargo, proofEngine });
    context.ledger = verifyCompleteRoot(admission, context.modules, clock);
    context.dockerAnchor = captureDockerAnchor(clock);
    const initialCensus = await runInitialLabelCensus(context);
    if (initialCensus.ids.length !== 0) throw new Error("proof invocation label already exists");
    const preflight = await runExactNameInspection(context, "exact-name-proof");
    if (preflight.outcome !== "absent") throw new Error("proof container name already exists");
    await startWatcher(context);
    return context;
  } catch (error) {
    const failure = error instanceof Error
      ? error
      : new Error("interruption harness initialization failed", { cause: error });
    Object.defineProperty(failure, "wp201Context", {
      configurable: false,
      enumerable: false,
      value: context,
      writable: false,
    });
    throw failure;
  }
}

async function finishInterrupted(context) {
  if (
    context.cleanupState !== "complete" ||
    context.ownedChildren.size !== 0 ||
    context.activeChild !== null ||
    !context.rootClosed ||
    context.signalState.signal !== "SIGTERM" ||
    !context.signalState.acknowledged ||
    context.signalState.auditWriteFailed ||
    !freshnessChallengePattern.test(context.signalControl.challenge ?? "") ||
    !context.releaseAccepted ||
    context.watcherSettlementReceipt !== AUTHENTICATED_WATCHER_SETTLEMENT
  ) {
    throw new Error("interrupted terminal prerequisites missing");
  }
  context.signalControl.uninstall();
  context.clock.close();
  writeAllSync(AUDIT_FD, AUDIT_CLOSE);
  closeSync(AUDIT_FD);
  closeSync(IDENTITY_FD);
  closeSync(ACCEPTED_ID_FD);
  writeAllSync(2, TERMINAL_STDERR);
  process.exitCode = 73;
}

let terminalWritten = false;

function finishRefused(context) {
  if (terminalWritten) return;
  terminalWritten = true;
  try {
    context?.signalControl?.uninstall();
  } catch {
    // The fixed refusal remains authoritative.
  }
  try {
    context?.clock?.close();
  } catch {
    // The fixed refusal remains authoritative.
  }
  if (context !== undefined && !context.rootClosed) {
    closeIgnoringErrors(context.admission.retainedRoot);
    context.rootClosed = true;
  }
  if (context !== undefined) {
    for (const descriptor of [RELEASE_FD, IDENTITY_FD, ACCEPTED_ID_FD, AUDIT_FD]) {
      closeIgnoringErrors(descriptor);
    }
  }
  try {
    writeAllSync(2, REFUSAL_STDERR);
  } catch {
    // Status 125 remains the refusal signal if stderr's peer is gone.
  }
  process.exitCode = 125;
}

async function refuseAfterCleanup(context) {
  if (
    context?.clock !== undefined &&
    context.modules !== undefined &&
    context.signalState !== undefined &&
    !context.signalState.latched
  ) {
    latchFailure(context);
  }
  if (context?.clock !== undefined && context.hardDeadlineNs > 0n) {
    try {
      await cleanupRuntime(context);
    } catch {
      // The supervisor's retained capabilities own failed-cut teardown.
    }
  }
  finishRefused(context);
}

async function runBeforeIssueLifecycle(admission) {
  let context;
  try {
    context = await initializeContext(admission);
    await pauseBeforeIssue(context);
    await cleanupRuntime(context);
    await finishInterrupted(context);
  } catch (error) {
    context = error?.wp201Context ?? context;
    await refuseAfterCleanup(context ?? {
      activeChild: null,
      activeDeadlineNs: 0n,
      admission,
      cleanupState: "idle",
      clock: undefined,
      createIssued: false,
      custodyIds: new Set(),
      dockerAnchor: undefined,
      hardDeadlineNs: 0n,
      ledger: undefined,
      modules: undefined,
      ownedChildren: new Set(),
      pathHelperOwnership: undefined,
      release: undefined,
      rootClosed: false,
      signalControl: undefined,
      signalState: { latched: true },
      watcher: undefined,
      watcherOwnership: undefined,
    });
  }
}

async function runAfterDaemonAcceptBeforeDeliveryLifecycle(admission) {
  let context;
  try {
    context = await initializeContext(admission);
    context.ledger = verifyCompleteRoot(admission, context.modules, context.clock);
    await runCreateAtDaemonDeliveryCut(context);
    await cleanupRuntime(context);
    await finishInterrupted(context);
  } catch (error) {
    context = error?.wp201Context ?? context;
    await refuseAfterCleanup(context ?? {
      activeChild: null,
      activeDeadlineNs: 0n,
      admission,
      cleanupState: "idle",
      clock: undefined,
      createIssued: false,
      custodyIds: new Set(),
      dockerAnchor: undefined,
      hardDeadlineNs: 0n,
      ledger: undefined,
      modules: undefined,
      ownedChildren: new Set(),
      pathHelperOwnership: undefined,
      release: undefined,
      rootClosed: false,
      signalControl: undefined,
      signalState: { latched: true },
      watcher: undefined,
      watcherOwnership: undefined,
    });
  }
}

async function runAfterParentCustodyBeforeStartLifecycle(admission) {
  let context;
  try {
    context = await initializeContext(admission);
    context.ledger = verifyCompleteRoot(admission, context.modules, context.clock);
    const responseId = await runCreateAndDeliverToParent(context);
    const eventId = await waitForWatcherEvent(context);
    if (responseId !== eventId) throw new Error("create response and event identity conflict");
    await pauseAfterParentCustodyBeforeStart(context, responseId);
    await cleanupRuntime(context);
    await finishInterrupted(context);
  } catch (error) {
    context = error?.wp201Context ?? context;
    await refuseAfterCleanup(context ?? {
      activeChild: null,
      activeDeadlineNs: 0n,
      admission,
      cleanupState: "idle",
      clock: undefined,
      createIssued: false,
      custodyIds: new Set(),
      dockerAnchor: undefined,
      hardDeadlineNs: 0n,
      ledger: undefined,
      modules: undefined,
      ownedChildren: new Set(),
      pathHelperOwnership: undefined,
      release: undefined,
      rootClosed: false,
      signalControl: undefined,
      signalState: { latched: true },
      watcher: undefined,
      watcherOwnership: undefined,
    });
  }
}

export function runBeforeIssueCut() {
  let admission;
  try {
    admission = admitRootCapability();
  } catch {
    finishRefused();
    return undefined;
  }
  return runBeforeIssueLifecycle(admission);
}

export function runAfterDaemonAcceptBeforeDeliveryCut() {
  let admission;
  try {
    admission = admitRootCapability();
  } catch {
    finishRefused();
    return undefined;
  }
  return runAfterDaemonAcceptBeforeDeliveryLifecycle(admission);
}

export function runAfterParentCustodyBeforeStartCut() {
  let admission;
  try {
    admission = admitRootCapability();
  } catch {
    finishRefused();
    return undefined;
  }
  return runAfterParentCustodyBeforeStartLifecycle(admission);
}
