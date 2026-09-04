import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  readSync,
  realpathSync,
  writeSync,
  chmodSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

import { extractAcquisitionArchive } from "./acquisition-archive.mjs";
import { buildDockerEventOpenFrame } from "./docker-event-helper.mjs";
import {
  abandonFreshRootHandoff,
  launchAfterDaemonAcceptBeforeDeliveryFreshRoot,
  launchAfterParentCustodyBeforeStartFreshRoot,
  launchBeforeIssueFreshRoot,
  parseCompleteLedger,
  prepareFreshLedgerBackedRoot,
  stageFixedSourceSnapshot,
} from "./cargo.mjs";
import {
  ACQUISITION_ROLE,
  CUT_CASES,
  INVOCATION_PREFIX,
  PROOF_ROLE,
  ROW_IDS,
  acquisitionContainerName,
  acquisitionCreateArguments,
  assertCleanEnvironment,
  buildCutReleaseFrame,
  classifyDockerCachedImage,
  classifyDockerCreateResult,
  classifyDockerExactName,
  createCutHarnessReapReceipt,
  createCutSupervisorCursor,
  createOwnedChildToken,
  dockerEnvironment,
  dockerOperationArguments,
  dockerPrefix,
  expectedCutSupervisorOperation,
  invocationRecord,
  parseCutAcceptedIdFrame,
  parseCutAuditStream,
  parseCutIdentityFrame,
  parseCutSignalAcknowledgement,
  parseCutTerminalResult,
  parseDockerAbsence,
  parseDockerApiSupport,
  parseDockerContainerInspection,
  parseDockerContextEndpoint,
  parseDockerContextName,
  parseDockerEventIdFrame,
  parseDockerEventReadyFrame,
  parseDockerLabelCensus,
  parseDockerPlatformManifest,
  parseDockerRemove,
  proofCreateArguments,
  proofContainerName,
  reduceCutSupervisorCursor,
  requireCutIdentityAgreement,
} from "./proof-engine.mjs";
import { writeControllerFiles } from "./test.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PACKAGE_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const EVENT_HELPER = fileURLToPath(new URL("./docker-event-helper.mjs", import.meta.url));
const PATH_HELPER = fileURLToPath(new URL("./path-cleanup-helper.mjs", import.meta.url));
const NODE_EXECUTABLE = process.execPath;
const DOCKER_BINARY_SIZE = 45_570_321n;
const DOCKER_BINARY_SHA256 =
  "dbf7fd0c0ae54d208314ee5c19a97a12d966dab039b7d94872ca91cbe490373c";
const SECOND_NS = 1_000_000_000n;
const POLL_MS = 50;
const ACQUISITION_ACTIVE_NS = 300n * SECOND_NS;
const MATRIX_ACTIVE_NS = 900n * SECOND_NS;
const INNER_RESERVE_NS = 160n * SECOND_NS;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const MAX_CHILD_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_STDERR = 16 * 1024 * 1024;
const READY_FRAME = Buffer.from("openspell.wp201.docker-event-ready.v1\n", "ascii");
const EVENT_PREFIX = Buffer.from("openspell.wp201.docker-event-id.v1\n", "ascii");
const EVENT_CLOSE = Buffer.from("openspell.wp201.docker-event-close.v1\n", "ascii");
const PATH_COMPLETE = Buffer.from("openspell.wp201.path-cleanup-complete.v2\n", "ascii");
const FAILED_PATH_COMPLETE = Buffer.from(
  "openspell.wp201.path-cleanup-failed-cut-complete.v1\n",
  "ascii",
);
const NAMESPACE_READY = Buffer.from("openspell.wp201.namespace-ready.v1\n", "ascii");
const ROOT_SUCCESS = Buffer.from("openspell.wp201.root-bridge-success.v1\n", "ascii");
const AUDIT_OPEN = Buffer.from("openspell.wp201.real-cut-audit-open.v1\n", "ascii");
const CUT_SIGNAL_ACKNOWLEDGEMENT_BYTES = 155;
const SUCCESS = Buffer.from("openspell.wp201.docker-integration-complete.v1\n", "ascii");
const REFUSAL = Buffer.from("openspell.wp201.docker-integration-refused.v1\n", "ascii");
const SOURCE_ROOTS = Object.freeze([
  "tools/hosted-migration-preparation-proof",
  "tools/hosted-migration-root-authority",
  "tools/hosted-migration-runtime-proof",
]);
const CONTROL_BYTES = Object.freeze([
  ["hostname", "etc/hostname", Buffer.from("wp201-proof\n", "ascii")],
  ["hosts", "etc/hosts", Buffer.from("127.0.0.1 localhost\n::1 localhost\n", "ascii")],
  ["resolv.conf", "etc/resolv.conf", Buffer.alloc(0)],
]);

let caughtSignal;
let activeChild;

function refuse(reason) {
  throw new Error(`WP-201 Docker integration refused: ${reason}`);
}

function modeOf(status) {
  return Number(status.mode & 0o7777n);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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

function parseBootTime(bytes) {
  if (bytes.length === 0 || bytes.length > 128 || bytes.at(-1) !== 0x0a) {
    refuse("boot-time frame");
  }
  const match = /^(?<seconds>0|[1-9][0-9]*)(?:\.(?<fraction>[0-9]{1,9}))? (?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?\n$/u.exec(
    bytes.toString("ascii"),
  );
  if (match?.groups?.seconds === undefined) refuse("boot-time syntax");
  return (
    BigInt(match.groups.seconds) * SECOND_NS +
    BigInt((match.groups.fraction ?? "").padEnd(9, "0") || "0")
  );
}

function openBootClock() {
  const descriptor = openSync(
    "/proc/uptime",
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC,
  );
  const status = fstatSync(descriptor, { bigint: true });
  if (
    !status.isFile() ||
    status.uid !== 0n ||
    status.gid !== 0n ||
    status.nlink !== 1n ||
    status.size !== 0n ||
    modeOf(status) !== 0o444
  ) {
    closeSync(descriptor);
    refuse("boot-time descriptor identity");
  }
  let previous;
  let closed = false;
  return Object.freeze({
    sample() {
      if (closed) refuse("boot-time descriptor closed");
      const buffer = Buffer.allocUnsafe(129);
      const count = readSync(descriptor, buffer, 0, buffer.length, 0);
      if (count <= 0 || count > 128) refuse("boot-time read cap");
      const value = parseBootTime(buffer.subarray(0, count));
      if (previous !== undefined && value < previous) refuse("CLOCK_BOOTTIME regressed");
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

function signalGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function groupAbsent(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw error;
  }
}

function capture(stream, cap) {
  if (stream === null || stream === undefined) return null;
  const state = { chunks: [], count: 0, ended: false, error: undefined, overflow: false };
  let settle;
  const settled = new Promise((resolve) => {
    settle = resolve;
  });
  stream.on("data", (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    state.count += bytes.length;
    if (state.count <= cap) state.chunks.push(Buffer.from(bytes));
    else state.overflow = true;
  });
  stream.once("error", (error) => {
    state.error = error;
    settle();
  });
  stream.once("end", () => {
    state.ended = true;
    settle();
  });
  return Object.freeze({
    bytes: () => Buffer.concat(state.chunks),
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

function observeChild(child, options = {}) {
  const state = { closed: false, error: undefined, signal: null, status: null };
  let finish;
  const closed = new Promise((resolve) => {
    finish = resolve;
  });
  child.once("error", (error) => {
    state.error = error;
  });
  child.once("close", (status, signal) => {
    state.closed = true;
    state.status = status;
    state.signal = signal;
    finish();
  });
  return Object.freeze({
    child,
    closed,
    state,
    stdout: options.stdout === false ? null : capture(child.stdout, options.stdout ?? MAX_CHILD_BYTES),
    stderr: options.stderr === false ? null : capture(child.stderr, options.stderr ?? MAX_CHILD_BYTES),
    extra: Object.freeze(
      (options.extra ?? []).map(({ index, cap }) => capture(child.stdio[index], cap)),
    ),
  });
}

async function writePipe(stream, bytes, end) {
  await new Promise((resolve, reject) => {
    stream.write(bytes, (error) => {
      if (error !== null && error !== undefined) reject(error);
      else resolve();
    });
  });
  if (end) stream.end();
}

async function waitUntil(clock, deadlineNs, predicate, reason) {
  while (!predicate()) {
    if (caughtSignal !== undefined) refuse("interrupted while waiting");
    if (clock.sample() >= deadlineNs) refuse(reason);
    await delay(POLL_MS);
  }
}

async function settleObserved(observation, options) {
  const { clock, normalDeadlineNs, termDeadlineNs, killDeadlineNs } = options;
  let termSent = false;
  let killSent = false;
  activeChild = observation;
  try {
    while (!observation.state.closed) {
      const now = clock.sample();
      if (
        ((caughtSignal !== undefined && options.ignoreSignal !== true) || now >= normalDeadlineNs) &&
        !termSent
      ) {
        signalGroup(observation.child.pid, "SIGTERM");
        termSent = true;
      }
      if (termSent && now >= termDeadlineNs && !killSent) {
        signalGroup(observation.child.pid, "SIGKILL");
        killSent = true;
      }
      if (now >= killDeadlineNs) {
        signalGroup(observation.child.pid, "SIGKILL");
        refuse("owned child failed to reap");
      }
      await Promise.race([observation.closed, delay(POLL_MS)]);
    }
    await waitUntil(clock, killDeadlineNs, () => groupAbsent(observation.child.pid), "process group residue");
    await Promise.all(
      [observation.stdout, observation.stderr, ...observation.extra]
        .filter((channel) => channel !== null)
        .map((channel) => channel.settled),
    );
    const channels = [observation.stdout, observation.stderr, ...observation.extra].filter(
      (channel) => channel !== null,
    );
    if (
      observation.state.error !== undefined ||
      channels.some((channel) => channel.error !== undefined || channel.overflow)
    ) {
      refuse("owned child output or spawn");
    }
    return Object.freeze({
      status: observation.state.status,
      stdout: observation.stdout?.bytes() ?? Buffer.alloc(0),
      stderr: observation.stderr?.bytes() ?? Buffer.alloc(0),
      signal: observation.state.signal,
      extra: Object.freeze(observation.extra.map((channel) => channel.bytes())),
    });
  } finally {
    if (activeChild === observation) activeChild = undefined;
  }
}

function operationDeadlines(clock, hardDeadlineNs, cleanup = false) {
  const now = clock.sample();
  const normal = cleanup ? now + 5n * SECOND_NS : hardDeadlineNs - INNER_RESERVE_NS;
  const term = cleanup ? now + 7n * SECOND_NS : normal + 2n * SECOND_NS;
  const kill = cleanup ? now + 10n * SECOND_NS : normal + 5n * SECOND_NS;
  return Object.freeze({
    normalDeadlineNs: normal < hardDeadlineNs ? normal : hardDeadlineNs,
    termDeadlineNs: term < hardDeadlineNs ? term : hardDeadlineNs,
    killDeadlineNs: kill < hardDeadlineNs ? kill : hardDeadlineNs,
  });
}

async function runProcess(executable, arguments_, options) {
  if (caughtSignal !== undefined && !options.cleanup) refuse("new child after signal");
  const child = spawn(executable, arguments_, {
    cwd: options.cwd,
    detached: true,
    env: options.env,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  const observation = observeChild(child, options.capture);
  const result = await settleObserved(observation, {
    clock: options.clock,
    ignoreSignal: options.cleanup === true,
    ...operationDeadlines(options.clock, options.hardDeadlineNs, options.cleanup),
  });
  return Object.freeze({ child, observation, result });
}

function isAtOrBelow(candidate, root) {
  const offset = relative(root, candidate);
  return offset === "" || (!offset.startsWith(`..${sep}`) && offset !== "..");
}

function requireNoMountBelow(path) {
  const text = readFileSync("/proc/self/mountinfo", "utf8");
  for (const line of text.trimEnd().split("\n")) {
    const fields = line.split(" ");
    if (fields.length < 10) refuse("mountinfo framing");
    const mountPath = fields[4].replaceAll("\\040", " ").replaceAll("\\011", "\t");
    if (isAtOrBelow(mountPath, path)) refuse("nested invocation mount");
  }
}

function descriptorInfo(descriptor) {
  const text = readFileSync(`/proc/self/fdinfo/${descriptor}`, "ascii");
  const flags = /^flags:\s+(?<value>0[0-7]+)$/mu.exec(text)?.groups?.value;
  const mountId = /^mnt_id:\s+(?<value>[1-9][0-9]*)$/mu.exec(text)?.groups?.value;
  if (flags === undefined || mountId === undefined) refuse("descriptor metadata");
  return Object.freeze({ flags, mountId });
}

function hashRegularFile(path, expectedSize, clock) {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.size !== expectedSize) refuse("fixed file identity");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
  const hash = createHash("sha256");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0n;
    while (offset < before.size) {
      clock.sample();
      const length = Number(before.size - offset > BigInt(buffer.length) ? BigInt(buffer.length) : before.size - offset);
      const count = readSync(descriptor, buffer, 0, length, Number(offset));
      clock.sample();
      if (count !== length) refuse("fixed file truncated");
      hash.update(buffer.subarray(0, count));
      offset += BigInt(count);
    }
    if (!sameStableStatus(before, fstatSync(descriptor, { bigint: true }))) {
      refuse("fixed file changed");
    }
  } finally {
    closeSync(descriptor);
  }
  return Object.freeze({ digest: hash.digest("hex"), status: before });
}

function captureDockerAnchor(clock) {
  const binary = hashRegularFile("/usr/bin/docker", DOCKER_BINARY_SIZE, clock);
  if (
    binary.digest !== DOCKER_BINARY_SHA256 ||
    binary.status.uid !== 0n ||
    binary.status.gid !== 0n ||
    binary.status.nlink !== 1n ||
    modeOf(binary.status) !== 0o755
  ) {
    refuse("Docker binary identity");
  }
  const socket = lstatSync("/var/run/docker.sock", { bigint: true });
  if (!socket.isSocket() || socket.uid !== 0n || modeOf(socket) !== 0o660) {
    refuse("Docker socket identity");
  }
  return Object.freeze({
    binary: Object.freeze({ device: binary.status.dev, inode: binary.status.ino }),
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
    modeOf(binary) !== 0o755 ||
    !socket.isSocket() ||
    socket.dev !== anchor.socket.device ||
    socket.ino !== anchor.socket.inode ||
    socket.uid !== 0n ||
    socket.gid !== anchor.socket.gid ||
    modeOf(socket) !== 0o660 ||
    realpathSync("/var/run/docker.sock") !== anchor.socket.realPath
  ) {
    refuse("Docker endpoint changed");
  }
  clock.sample();
}

function dockerReceipt(operation) {
  return Object.freeze({ operation, token: createOwnedChildToken() });
}

async function runDocker(context, kind, options = {}, settings = {}) {
  if (caughtSignal !== undefined && !settings.cleanup) refuse("Docker dispatch after signal");
  revalidateDockerAnchor(context.dockerAnchor, context.clock);
  if (context.rootPath !== undefined) requireNoMountBelow(context.rootPath);
  const prefix = dockerPrefix(context.invocation, context.rootPath);
  const run = await runProcess(prefix[0], [...prefix.slice(1), ...dockerOperationArguments(kind, options)], {
    capture: { stderr: settings.stderrCap ?? 1024 * 1024, stdout: settings.stdoutCap ?? 1024 * 1024 },
    cleanup: settings.cleanup === true,
    clock: context.clock,
    cwd: "/",
    env: dockerEnvironment(context.invocation, context.rootPath),
    hardDeadlineNs: context.hardDeadlineNs,
  });
  revalidateDockerAnchor(context.dockerAnchor, context.clock);
  return Object.freeze({
    result: Object.freeze({
      status: run.result.status,
      stdout: run.result.stdout,
      stderr: run.result.stderr,
    }),
    receipt: dockerReceipt(settings.operation ?? kind),
  });
}

function writeExclusive(path, bytes, mode) {
  const descriptor = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW |
      constants.O_CLOEXEC,
    0o600,
  );
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (count <= 0) refuse("exclusive file write");
      offset += count;
    }
    chmodSync(`/proc/self/fd/${descriptor}`, mode);
    fsyncSync(descriptor);
    const status = fstatSync(descriptor, { bigint: true });
    if (
      !status.isFile() ||
      status.uid !== BigInt(process.getuid()) ||
      status.gid !== BigInt(process.getgid()) ||
      status.nlink !== 1n ||
      status.size !== BigInt(bytes.length) ||
      modeOf(status) !== mode
    ) {
      refuse("exclusive file identity");
    }
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(path) {
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

function requireTemporaryParent(path) {
  const status = lstatSync(path, { bigint: true });
  if (
    !status.isDirectory() ||
    status.uid !== 0n ||
    status.gid !== 0n ||
    modeOf(status) !== 0o1777 ||
    realpathSync(path) !== path
  ) {
    refuse("temporary parent identity");
  }
  return status;
}

function createInvocationRoot(invocation) {
  let lastError;
  for (const parent of ["/tmp", "/var/tmp"]) {
    const path = join(parent, `${INVOCATION_PREFIX}${invocation}`);
    const alternate = join(
      parent === "/tmp" ? "/var/tmp" : "/tmp",
      `${INVOCATION_PREFIX}${invocation}`,
    );
    let authenticatedRoot;
    try {
      const parentStatus = requireTemporaryParent(parent);
      if (!pathAbsent(alternate)) refuse("alternate invocation root already exists");
      mkdirSync(path, { mode: 0o700 });
      const status = lstatSync(path, { bigint: true });
      authenticatedRoot = Object.freeze({
        device: status.dev,
        gid: status.gid,
        inode: status.ino,
        invocation,
        parent,
        parentToken: parent === "/tmp" ? "tmp" : "var-tmp",
        path,
        uid: status.uid,
      });
      if (
        !status.isDirectory() ||
        status.uid !== BigInt(process.getuid()) ||
        status.gid !== BigInt(process.getgid()) ||
        status.dev !== parentStatus.dev ||
        modeOf(status) !== 0o700 ||
        realpathSync(path) !== path
      ) {
        refuse("invocation root identity");
      }
      syncDirectory(parent);
      return authenticatedRoot;
    } catch (error) {
      lastError = error;
      if (authenticatedRoot !== undefined && error instanceof Error) {
        Object.defineProperty(error, "cleanupRoot", {
          configurable: false,
          enumerable: false,
          value: authenticatedRoot,
          writable: false,
        });
      }
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw lastError ?? new Error("invocation root creation failed");
}

async function readSourceIndex(clock, hardDeadlineNs) {
  const run = await runProcess(
    "/usr/bin/git",
    ["ls-files", "--stage", "-z", "--", ...SOURCE_ROOTS],
    {
      clock,
      cwd: REPOSITORY_ROOT,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      hardDeadlineNs,
      capture: { stdout: 1024 * 1024, stderr: 4_096 },
    },
  );
  if (
    run.result.status !== 0 ||
    run.result.signal !== null ||
    run.result.stderr.length !== 0 ||
    run.result.stdout.length === 0
  ) {
    refuse("source index inventory");
  }
  return run.result.stdout;
}

function enumerateNormalizedTree(root, logicalRoot, tag, clock) {
  const rows = [];
  let files = 0;
  let directories = 0;
  let bytes = 0;
  const visit = (path, logical) => {
    const before = lstatSync(path, { bigint: true });
    if (
      !before.isDirectory() ||
      before.uid !== BigInt(process.getuid()) ||
      before.gid !== BigInt(process.getgid()) ||
      modeOf(before) !== 0o555
    ) {
      refuse("normalized directory identity");
    }
    rows.push(`D\t0555\t${logical}\n`);
    directories += 1;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const childPath = join(path, entry.name);
      const childLogical = `${logical}/${entry.name}`;
      const status = lstatSync(childPath, { bigint: true });
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        visit(childPath, childLogical);
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        const mode = modeOf(status);
        if (
          status.uid !== BigInt(process.getuid()) ||
          status.gid !== BigInt(process.getgid()) ||
          status.nlink !== 1n ||
          (tag === "T" ? ![0o444, 0o555].includes(mode) : mode !== 0o444) ||
          status.size < 0n ||
          status.size > 268_435_456n
        ) {
          refuse("normalized file identity");
        }
        const verified = hashRegularFile(childPath, status.size, clock);
        rows.push(
          `${tag}\t${mode === 0o555 ? "0555" : "0444"}\t${status.size}\t${verified.digest}\t${childLogical.slice(logicalRoot.length + 1)}\n`,
        );
        files += 1;
        bytes += Number(status.size);
      } else {
        refuse("link or special normalized entry");
      }
    }
    if (!sameStableStatus(before, lstatSync(path, { bigint: true }))) {
      refuse("normalized directory changed");
    }
  };
  visit(root, logicalRoot);
  return Object.freeze({ rows, files, directories, bytes });
}

function ledgerSortKey(row) {
  const fields = row.slice(0, -1).split("\t");
  return Buffer.from(`${fields[0]}\t${fields.at(-1)}`, "utf8");
}

function writeCompleteLedger(root, sourceRows, clock) {
  const vendor = enumerateNormalizedTree(
    join(root.path, "acquisition/vendor"),
    "vendor",
    "V",
    clock,
  );
  const toolchain = enumerateNormalizedTree(
    join(root.path, "acquisition/toolchain"),
    "toolchain",
    "T",
    clock,
  );
  if (
    vendor.files !== 3_657 ||
    vendor.directories !== 941 ||
    vendor.bytes !== 67_159_121 ||
    toolchain.files !== 168 ||
    toolchain.directories !== 28 ||
    toolchain.bytes !== 653_573_520
  ) {
    refuse("acquisition normalized totals");
  }
  const controls = [
    ["proof.sh", "control/proof.sh"],
    ...CONTROL_BYTES.map(([name, logical]) => [name, logical]),
  ].map(([name, logical]) => {
    const status = lstatSync(join(root.path, "control", name), { bigint: true });
    const verified = hashRegularFile(join(root.path, "control", name), status.size, clock);
    return `C\t0444\t${status.size}\t${verified.digest}\t${logical}\n`;
  });
  const rows = [
    ...(sourceRows.ledgerRows.match(/[^\n]+\n/gu) ?? []),
    ...vendor.rows,
    ...toolchain.rows,
    ...controls,
  ].sort((left, right) => Buffer.compare(ledgerSortKey(left), ledgerSortKey(right)));
  if (rows.length !== 4_853) refuse("complete ledger row count");
  const body = Buffer.from(
    `openspell.wp201.vendor-ledger.v1\nrecords\t4853\n${rows.join("")}`,
    "utf8",
  );
  const bytes = Buffer.concat([body, Buffer.from(`end\t${digest(body)}\n`, "ascii")]);
  if (bytes.length > MAX_LEDGER_BYTES) refuse("complete ledger byte cap");
  writeExclusive(join(root.path, "acquisition/vendor-ledger.v1"), bytes, 0o444);
  syncDirectory(join(root.path, "acquisition"));
  const parsed = parseCompleteLedger(bytes);
  if (parsed.rows.length !== 4_853 || parsed.bytes.length !== bytes.length) {
    refuse("complete ledger parser disagreement");
  }
  return parsed;
}

async function stageInvocation(root, clock, hardDeadlineNs) {
  mkdirSync(join(root.path, "source"), { mode: 0o700 });
  const sourceHandle = await open(
    join(root.path, "source"),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let sourceRows;
  try {
    const indexBytes = await readSourceIndex(clock, hardDeadlineNs);
    sourceRows = await stageFixedSourceSnapshot({
      indexBytes,
      sourceDirectory: sourceHandle,
    });
  } finally {
    await sourceHandle.close();
  }
  mkdirSync(join(root.path, "control"), { mode: 0o700 });
  const controlHandle = await open(
    join(root.path, "control"),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await writeControllerFiles({ controlDirectory: controlHandle });
  } finally {
    await controlHandle.close();
  }
  for (const [name, , bytes] of CONTROL_BYTES) {
    writeExclusive(join(root.path, "control", name), bytes, 0o444);
  }
  chmodSync(join(root.path, "control"), 0o555);
  syncDirectory(join(root.path, "control"));
  mkdirSync(join(root.path, "docker"), { mode: 0o700 });
  mkdirSync(join(root.path, "docker/home"), { mode: 0o700 });
  mkdirSync(join(root.path, "docker/config"), { mode: 0o700 });
  writeExclusive(join(root.path, "docker/config/config.json"), Buffer.from("{}"), 0o400);
  chmodSync(join(root.path, "docker/config"), 0o500);
  chmodSync(join(root.path, "docker"), 0o500);
  syncDirectory(join(root.path, "docker/config"));
  syncDirectory(join(root.path, "docker/home"));
  syncDirectory(join(root.path, "docker"));
  mkdirSync(join(root.path, "acquisition"), { mode: 0o700 });
  syncDirectory(root.path);
  requireNoMountBelow(root.path);
  return sourceRows;
}

async function runDockerArguments(context, arguments_, settings = {}) {
  if (caughtSignal !== undefined && !settings.cleanup) refuse("Docker dispatch after signal");
  revalidateDockerAnchor(context.dockerAnchor, context.clock);
  requireNoMountBelow(context.rootPath);
  const prefix = dockerPrefix(context.invocation, context.rootPath);
  const run = await runProcess(prefix[0], [...prefix.slice(1), ...arguments_], {
    capture: {
      stderr: settings.stderrCap ?? 1024 * 1024,
      stdout: settings.stdoutCap ?? 1024 * 1024,
    },
    cleanup: settings.cleanup === true,
    clock: context.clock,
    cwd: "/",
    env: dockerEnvironment(context.invocation, context.rootPath),
    hardDeadlineNs: context.hardDeadlineNs,
  });
  revalidateDockerAnchor(context.dockerAnchor, context.clock);
  return Object.freeze({
    status: run.result.status,
    stdout: run.result.stdout,
    stderr: run.result.stderr,
  });
}

function processStartTime(pid) {
  const text = readFileSync(`/proc/${pid}/stat`, "ascii");
  const close = text.lastIndexOf(")");
  if (close < 0 || text.slice(0, text.indexOf(" ")) !== String(pid)) {
    refuse("process stat framing");
  }
  const fields = text.slice(close + 2).trimEnd().split(" ");
  const value = fields[19];
  if (!/^(?:0|[1-9][0-9]{0,19})$/u.test(value ?? "")) refuse("process start time");
  return value;
}

function currentWatcherEvent(watcher) {
  if (watcher.event.error !== undefined || watcher.event.overflow) {
    refuse("watcher event channel");
  }
  const bytes = watcher.event.bytes();
  if (bytes.length === 0) return watcher.event.ended ? null : undefined;
  if (bytes.length !== EVENT_PREFIX.length + 65) {
    if (watcher.event.ended) refuse("watcher event truncated");
    return undefined;
  }
  return parseDockerEventIdFrame(bytes);
}

async function startWatcher(context, target) {
  if (caughtSignal !== undefined) refuse("watcher after signal");
  const role = target.kind === "acquisition" ? ACQUISITION_ROLE : PROOF_ROLE;
  const name = target.kind === "acquisition"
    ? acquisitionContainerName(context.invocation)
    : proofContainerName(context.invocation, target.rowId);
  revalidateDockerAnchor(context.dockerAnchor, context.clock);
  const child = spawn(NODE_EXECUTABLE, [EVENT_HELPER], {
    cwd: "/",
    detached: true,
    env: { LANG: "C", LC_ALL: "C" },
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe", "pipe"],
  });
  let observation;
  try {
    observation = observeChild(child, {
      stdout: false,
      stderr: 4_096,
      extra: [
        { index: 4, cap: READY_FRAME.length },
        { index: 5, cap: EVENT_PREFIX.length + 65 },
      ],
    });
    const watcher = Object.freeze({
      child,
      observation,
      ready: observation.extra[0],
      event: observation.extra[1],
      startTime: processStartTime(child.pid),
    });
    await writePipe(
      child.stdio[3],
      buildDockerEventOpenFrame(context.invocation, role, name),
      false,
    );
    await waitUntil(
      context.clock,
      context.activeDeadlineNs,
      () => watcher.ready.bytes().length === READY_FRAME.length || watcher.ready.ended || observation.state.closed,
      "watcher READY deadline",
    );
    if (
      observation.state.closed ||
      watcher.ready.ended ||
      watcher.ready.error !== undefined ||
      watcher.ready.overflow
    ) {
      refuse("watcher READY settlement");
    }
    parseDockerEventReadyFrame(watcher.ready.bytes());
    revalidateDockerAnchor(context.dockerAnchor, context.clock);
    return watcher;
  } catch (error) {
    signalGroup(child.pid, "SIGKILL");
    if (observation !== undefined) {
      try {
        const now = context.clock.sample();
        await settleObserved(observation, {
          clock: context.clock,
          normalDeadlineNs: now,
          termDeadlineNs: now,
          killDeadlineNs: now + 10n * SECOND_NS < context.hardDeadlineNs
            ? now + 10n * SECOND_NS
            : context.hardDeadlineNs,
        });
      } catch {
        // The original watcher refusal remains authoritative.
      }
    }
    throw error;
  }
}

async function closeWatcher(context, watcher) {
  let writeError;
  if (!watcher.observation.state.closed) {
    try {
      await writePipe(watcher.child.stdio[3], EVENT_CLOSE, true);
    } catch (error) {
      writeError = error;
      watcher.child.stdio[3].destroy();
    }
  }
  const now = context.clock.sample();
  const result = await settleObserved(watcher.observation, {
    clock: context.clock,
    ignoreSignal: true,
    normalDeadlineNs: now + 5n * SECOND_NS,
    termDeadlineNs: now + 8n * SECOND_NS,
    killDeadlineNs: now + 10n * SECOND_NS < context.hardDeadlineNs
      ? now + 10n * SECOND_NS
      : context.hardDeadlineNs,
  });
  revalidateDockerAnchor(context.dockerAnchor, context.clock);
  if (
    writeError !== undefined ||
    result.status !== 0 ||
    result.signal !== null ||
    result.stderr.length !== 0 ||
    !watcher.ready.ended ||
    !watcher.ready.bytes().equals(READY_FRAME) ||
    !watcher.event.ended
  ) {
    refuse("watcher close");
  }
  return currentWatcherEvent(watcher);
}

async function exactName(context, target, operation, cleanup = false) {
  const kind = target.kind === "acquisition" ? "exact-name-acquisition" : "exact-name-proof";
  const options = target.kind === "acquisition"
    ? { invocation: context.invocation }
    : { invocation: context.invocation, rowId: target.rowId };
  const token = createOwnedChildToken();
  const result = await runDockerArguments(context, dockerOperationArguments(kind, options), { cleanup });
  return classifyDockerExactName(
    result,
    target.kind === "acquisition"
      ? { kind: "acquisition", invocation: context.invocation }
      : { kind: "proof", invocation: context.invocation, rowId: target.rowId },
    { operation, token },
  );
}

async function labelCensus(context, operation, cleanup = false) {
  const token = createOwnedChildToken();
  const result = await runDockerArguments(
    context,
    dockerOperationArguments("label-census", { invocation: context.invocation }),
    { cleanup },
  );
  return parseDockerLabelCensus(result, context.invocation, { operation, token });
}

async function removeAndProveAbsent(context, id) {
  let firstError;
  try {
    const token = createOwnedChildToken();
    const result = await runDockerArguments(
      context,
      dockerOperationArguments("remove", { id }),
      { cleanup: true, stderrCap: 4_096, stdoutCap: 4_096 },
    );
    parseDockerRemove(result, id, { operation: "remove", token });
  } catch (error) {
    firstError = error;
  }
  try {
    const token = createOwnedChildToken();
    const result = await runDockerArguments(
      context,
      dockerOperationArguments("absence", { id }),
      { cleanup: true },
    );
    parseDockerAbsence(result, id, { operation: "absence", token });
    return;
  } catch {
    // The first absence always precedes the one allowed retry.
  }
  let secondError;
  try {
    const token = createOwnedChildToken();
    const result = await runDockerArguments(
      context,
      dockerOperationArguments("remove", { id }),
      { cleanup: true, stderrCap: 4_096, stdoutCap: 4_096 },
    );
    parseDockerRemove(result, id, { operation: "remove", token });
  } catch (error) {
    secondError = error;
  }
  try {
    const token = createOwnedChildToken();
    const result = await runDockerArguments(
      context,
      dockerOperationArguments("absence", { id }),
      { cleanup: true },
    );
    parseDockerAbsence(result, id, { operation: "absence", token });
  } catch (error) {
    throw new AggregateError(
      [firstError, secondError, error].filter((entry) => entry !== undefined),
      "container absence was not established",
      { cause: error },
    );
  }
}

function hostNamespaceGate() {
  const lines = ["openspell.wp201.namespace-gate.v1"];
  for (const name of ["cgroup", "ipc", "mnt", "net", "pid", "user", "uts"]) {
    const value = readlinkSync(`/proc/self/ns/${name}`);
    if (!new RegExp(`^${name}:\\[[1-9][0-9]{0,19}\\]$`, "u").test(value)) {
      refuse("host namespace identity");
    }
    lines.push(value);
  }
  lines.push("");
  const frame = Buffer.from(lines.join("\n"), "ascii");
  if (frame.length > 512) refuse("namespace gate cap");
  return frame;
}

async function startAcquisition(context, id, acquisitionHandle) {
  revalidateDockerAnchor(context.dockerAnchor, context.clock);
  const prefix = dockerPrefix(context.invocation, context.rootPath);
  const child = spawn(
    prefix[0],
    [...prefix.slice(1), ...dockerOperationArguments("acquisition-start-attach", { id })],
    {
      cwd: "/",
      detached: true,
      env: dockerEnvironment(context.invocation, context.rootPath),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const observation = observeChild(child, { stdout: false, stderr: MAX_ARCHIVE_STDERR });
  const archive = extractAcquisitionArchive({
    acquisitionDirectory: acquisitionHandle,
    input: child.stdout,
  });
  let summary;
  let settled;
  try {
    [summary, settled] = await Promise.all([
      archive,
      settleObserved(observation, {
        clock: context.clock,
        ...operationDeadlines(context.clock, context.hardDeadlineNs),
      }),
    ]);
  } catch (error) {
    signalGroup(child.pid, "SIGKILL");
    throw error;
  }
  if (
    settled.status !== 0 ||
    settled.signal !== null ||
    summary.regularFiles !== 3_825 ||
    summary.directories !== 969
  ) {
    refuse("dependency acquisition result");
  }
  revalidateDockerAnchor(context.dockerAnchor, context.clock);
}

async function startProof(context, id, rowId) {
  revalidateDockerAnchor(context.dockerAnchor, context.clock);
  const prefix = dockerPrefix(context.invocation, context.rootPath);
  const child = spawn(
    prefix[0],
    [...prefix.slice(1), ...dockerOperationArguments("proof-start-attach", { id })],
    {
      cwd: "/",
      detached: true,
      env: dockerEnvironment(context.invocation, context.rootPath),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const observation = observeChild(child, { stdout: MAX_CHILD_BYTES, stderr: MAX_CHILD_BYTES });
  try {
    await waitUntil(
      context.clock,
      context.activeDeadlineNs,
      () =>
        observation.stdout.bytes().includes(0x0a) ||
        observation.stdout.ended ||
        observation.state.closed,
      "namespace readiness deadline",
    );
    const first = observation.stdout.bytes().subarray(0, NAMESPACE_READY.length);
    if (!first.equals(NAMESPACE_READY)) refuse("namespace readiness frame");
    await writePipe(child.stdin, hostNamespaceGate(), true);
    const result = await settleObserved(observation, {
      clock: context.clock,
      ...operationDeadlines(context.clock, context.hardDeadlineNs),
    });
    if (result.status !== 0 || result.signal !== null) refuse("proof Cargo row");
    const complete = result.stdout.subarray(NAMESPACE_READY.length);
    const occurrences = complete.toString("utf8").split(ROOT_SUCCESS.toString("ascii")).length - 1;
    if ((rowId === "root-positive" && occurrences !== 1) || (rowId !== "root-positive" && occurrences !== 0)) {
      refuse("root bridge marker count");
    }
  } catch (error) {
    signalGroup(child.pid, "SIGKILL");
    throw error;
  }
  revalidateDockerAnchor(context.dockerAnchor, context.clock);
}

function inspectionOptions(context, target, localImageId, state) {
  return target.kind === "acquisition"
    ? {
        kind: "acquisition",
        invocation: context.invocation,
        invocationDirectory: context.rootPath,
        localImageId,
        state,
        uid: process.getuid(),
        gid: process.getgid(),
      }
    : {
        kind: "proof",
        invocation: context.invocation,
        invocationDirectory: context.rootPath,
        localImageId,
        state,
        rowId: target.rowId,
        ledgerSha256: context.ledger.digest,
      };
}

async function inspectContainer(context, target, id, localImageId, state) {
  const token = createOwnedChildToken();
  const result = await runDockerArguments(
    context,
    dockerOperationArguments("inspect", { id }),
  );
  const receipt = parseDockerContainerInspection(
    result,
    inspectionOptions(context, target, localImageId, state),
    { operation: "inspect", token },
  );
  if (receipt.id !== id) refuse("container inspection ID");
  return receipt;
}

async function runContainerLifecycle(context, target, localImageId, acquisitionHandle) {
  const preflightOperation = target.kind === "acquisition"
    ? "exact-name-acquisition"
    : "exact-name-proof";
  const preflight = await exactName(context, target, preflightOperation);
  if (preflight.outcome !== "absent") refuse("container exact-name preflight");
  if ((await labelCensus(context, "label-census")).ids.length !== 0) {
    refuse("container label preflight");
  }

  let watcher;
  let createIssued = false;
  let lifecycleSucceeded = false;
  const ids = new Set();
  let operationError;
  try {
    watcher = await startWatcher(context, target);
    const createArguments = target.kind === "acquisition"
      ? acquisitionCreateArguments({
          gid: process.getgid(),
          invocation: context.invocation,
          invocationDirectory: context.rootPath,
          uid: process.getuid(),
        })
      : proofCreateArguments({
          invocation: context.invocation,
          invocationDirectory: context.rootPath,
          ledgerSha256: context.ledger.digest,
          rowId: target.rowId,
        });
    createIssued = true;
    const createResult = await runDockerArguments(context, createArguments, {
      stderrCap: 4_096,
      stdoutCap: 4_096,
    });
    const classified = classifyDockerCreateResult(createResult);
    if (classified.custodyId !== null) ids.add(classified.custodyId);
    await waitUntil(
      context.clock,
      context.activeDeadlineNs,
      () => {
        const event = currentWatcherEvent(watcher);
        return event !== undefined && event !== null;
      },
      "Docker create event deadline",
    );
    const eventId = currentWatcherEvent(watcher);
    if (eventId !== null && eventId !== undefined) ids.add(eventId);
    if (
      !classified.success ||
      classified.custodyId === null ||
      eventId !== classified.custodyId ||
      ids.size !== 1
    ) {
      refuse("Docker create custody disagreement");
    }
    const id = classified.custodyId;
    await inspectContainer(context, target, id, localImageId, "created");
    if (target.kind === "acquisition") {
      if (acquisitionHandle === undefined) refuse("acquisition destination missing");
      await startAcquisition(context, id, acquisitionHandle);
    } else {
      await startProof(context, id, target.rowId);
    }
    await inspectContainer(context, target, id, localImageId, "exited-zero");
    lifecycleSucceeded = true;
  } catch (error) {
    operationError = error;
  }

  const cleanupErrors = [];
  if (createIssued && ids.size === 0) {
    try {
      const recovered = await exactName(context, target, "exact-name-recovery", true);
      if (recovered.outcome === "present") ids.add(recovered.id);
      lifecycleSucceeded = false;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  for (const id of ids) {
    try {
      await removeAndProveAbsent(context, id);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    const preliminary = await labelCensus(context, "label-census", true);
    if (preliminary.ids.length !== 0) refuse("pre-CLOSE label census");
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (watcher !== undefined) {
    try {
      const finalEvent = await closeWatcher(context, watcher);
      if (finalEvent !== null && !ids.has(finalEvent)) {
        if (ids.size >= 2) refuse("second Docker create event");
        ids.add(finalEvent);
        await removeAndProveAbsent(context, finalEvent);
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    const final = await labelCensus(context, "final-label-census", true);
    if (final.ids.length !== 0) refuse("final label census");
    revalidateDockerAnchor(context.dockerAnchor, context.clock);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (operationError !== undefined || cleanupErrors.length > 0 || !lifecycleSucceeded) {
    throw new AggregateError(
      [operationError, ...cleanupErrors].filter((entry) => entry !== undefined),
      "container lifecycle failed",
      { cause: operationError },
    );
  }
}

async function runNoCreateWatcher(context) {
  const target = { kind: "proof", rowId: "root-fmt" };
  if ((await exactName(context, target, "exact-name-proof")).outcome !== "absent") {
    refuse("no-create exact name");
  }
  const watcher = await startWatcher(context, target);
  const event = await closeWatcher(context, watcher);
  if (event !== null) refuse("no-create watcher event");
  if ((await labelCensus(context, "final-label-census", true)).ids.length !== 0) {
    refuse("no-create label census");
  }
}

async function authenticateImage(context) {
  parseDockerContextName((await runDocker(context, "context-name")).result);
  parseDockerContextEndpoint((await runDocker(context, "context-endpoint")).result);
  parseDockerApiSupport((await runDocker(context, "api-support")).result);
  let image = classifyDockerCachedImage((await runDocker(context, "cached-image")).result);
  if (image.outcome === "missing") {
    const pulled = (await runDocker(context, "image-pull", {}, {
      stderrCap: MAX_CHILD_BYTES,
      stdoutCap: MAX_CHILD_BYTES,
    })).result;
    if (pulled.status !== 0) refuse("image pull");
    image = classifyDockerCachedImage((await runDocker(context, "cached-image")).result);
  }
  if (image.outcome !== "present") refuse("cached image remained absent");
  parseDockerPlatformManifest((await runDocker(context, "platform-manifest")).result);
  return image.localImageId;
}

async function runAcquisitionAndMatrix(root, sourceRows, clock, dockerAnchor, runtimeState) {
  let now = clock.sample();
  const imageContext = {
    activeDeadlineNs: now + ACQUISITION_ACTIVE_NS,
    hardDeadlineNs: now + ACQUISITION_ACTIVE_NS + INNER_RESERVE_NS,
    clock,
    dockerAnchor,
    invocation: root.invocation,
    rootPath: root.path,
  };
  const localImageId = await authenticateImage(imageContext);
  await runNoCreateWatcher(imageContext);

  now = clock.sample();
  const acquisitionContext = {
    ...imageContext,
    activeDeadlineNs: now + ACQUISITION_ACTIVE_NS,
    hardDeadlineNs: now + ACQUISITION_ACTIVE_NS + INNER_RESERVE_NS,
  };
  const acquisitionHandle = await open(
    join(root.path, "acquisition"),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await runContainerLifecycle(
      acquisitionContext,
      { kind: "acquisition" },
      localImageId,
      acquisitionHandle,
    );
  } finally {
    await acquisitionHandle.close();
  }
  const ledger = writeCompleteLedger(root, sourceRows, clock);
  runtimeState.cleanupState = "ledger-backed";

  now = clock.sample();
  const matrixContext = {
    ...imageContext,
    activeDeadlineNs: now + MATRIX_ACTIVE_NS,
    hardDeadlineNs: now + MATRIX_ACTIVE_NS + INNER_RESERVE_NS,
    ledger,
  };
  for (const rowId of ROW_IDS) {
    if (clock.sample() >= matrixContext.activeDeadlineNs || caughtSignal !== undefined) {
      refuse("proof matrix active deadline");
    }
    try {
      await runContainerLifecycle(
        matrixContext,
        { kind: "proof", rowId },
        localImageId,
      );
    } catch (error) {
      throw new Error(`proof matrix row ${rowId} failed`, { cause: error });
    }
  }
  return Object.freeze({ ledger, localImageId });
}

async function runPathHelper(root, state, clock, hardDeadlineNs) {
  const child = spawn(NODE_EXECUTABLE, [PATH_HELPER], {
    cwd: "/",
    detached: true,
    env: { LANG: "C", LC_ALL: "C" },
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  });
  const observation = observeChild(child, {
    stdout: false,
    stderr: 4_096,
    extra: [{ index: 4, cap: 64 }],
  });
  const control = Buffer.from(
    [
      "openspell.wp201.path-cleanup.v2",
      root.parentToken,
      root.invocation,
      root.device.toString(),
      root.inode.toString(),
      state,
      "",
    ].join("\n"),
    "ascii",
  );
  await writePipe(child.stdio[3], control, true);
  const now = clock.sample();
  const result = await settleObserved(observation, {
    clock,
    ignoreSignal: true,
    normalDeadlineNs: now + 4n * SECOND_NS,
    termDeadlineNs: now + 7n * SECOND_NS,
    killDeadlineNs: now + 10n * SECOND_NS < hardDeadlineNs
      ? now + 10n * SECOND_NS
      : hardDeadlineNs,
  });
  if (
    result.status !== 0 ||
    result.signal !== null ||
    result.stderr.length !== 0 ||
    result.extra.length !== 1 ||
    !result.extra[0].equals(PATH_COMPLETE)
  ) {
    refuse("path cleanup helper");
  }
  for (const parent of ["/tmp", "/var/tmp"]) {
    try {
      lstatSync(join(parent, `${INVOCATION_PREFIX}${root.invocation}`));
      refuse("invocation path residue");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function pathAbsent(path) {
  try {
    lstatSync(path, { bigint: true });
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

function requireCutLocalAbsence(cleanup, identity) {
  const alternate = join(
    cleanup.parentToken === "tmp" ? "/var/tmp" : "/tmp",
    `${INVOCATION_PREFIX}${cleanup.invocation}`,
  );
  if (
    !pathAbsent(cleanup.path) ||
    !pathAbsent(alternate) ||
    !groupAbsent(identity.watcherPid)
  ) {
    refuse("cut local absence");
  }
  try {
    const observed = processStartTime(Number(identity.watcherPid));
    if (observed === identity.watcherStartTime) refuse("cut watcher identity remained live");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function identityRecord(descriptor) {
  const status = fstatSync(descriptor, { bigint: true });
  return Object.freeze({
    device: status.dev,
    gid: status.gid,
    inode: status.ino,
    mountId: descriptorInfo(descriptor).mountId,
    uid: status.uid,
  });
}

function sameIdentityRecord(left, right) {
  return (
    left.device === right.device &&
    left.gid === right.gid &&
    left.inode === right.inode &&
    left.mountId === right.mountId &&
    left.uid === right.uid
  );
}

function matchingDescriptors(expected) {
  const matches = [];
  for (const name of readdirSync("/proc/self/fd")) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(name)) continue;
    const descriptor = Number(name);
    try {
      if (sameIdentityRecord(identityRecord(descriptor), expected)) matches.push(descriptor);
    } catch (error) {
      if (error?.code !== "EBADF" && error?.code !== "ENOENT") throw error;
    }
  }
  return matches.sort((left, right) => left - right);
}

function requireDescriptorClosed(descriptor) {
  try {
    fstatSync(descriptor, { bigint: true });
  } catch (error) {
    if (error?.code === "EBADF") return;
    throw error;
  }
  refuse("retained descriptor remained open");
}

function readRetainedLedger(custody, clock) {
  const before = fstatSync(custody.ledgerDescriptor, { bigint: true });
  const expected = custody.ledgerIdentity;
  if (
    !before.isFile() ||
    before.dev !== expected.device ||
    before.ino !== expected.inode ||
    before.uid !== expected.uid ||
    before.gid !== expected.gid ||
    before.nlink !== 0n ||
    before.size !== BigInt(custody.ledgerSize) ||
    modeOf(before) !== 0o444
  ) {
    refuse("retained ledger identity");
  }
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  while (offset < custody.ledgerSize) {
    clock.sample();
    const length = Math.min(buffer.length, custody.ledgerSize - offset);
    const count = readSync(custody.ledgerDescriptor, buffer, 0, length, offset);
    clock.sample();
    if (count !== length) refuse("retained ledger truncated");
    hash.update(buffer.subarray(0, count));
    offset += count;
  }
  clock.sample();
  if (readSync(custody.ledgerDescriptor, buffer, 0, 1, custody.ledgerSize) !== 0) {
    refuse("retained ledger grew");
  }
  clock.sample();
  if (
    !sameStableStatus(before, fstatSync(custody.ledgerDescriptor, { bigint: true })) ||
    hash.digest("hex") !== custody.ledgerDigest
  ) {
    refuse("retained ledger changed");
  }
}

function settleRetainedCustody(cleanup, custody, clock) {
  readRetainedLedger(custody, clock);
  const rootBefore = fstatSync(custody.custodyRoot, { bigint: true });
  const rootExpected = Object.freeze({
    device: cleanup.device,
    gid: BigInt(process.getgid()),
    inode: cleanup.inode,
    mountId: String(cleanup.mountId),
    uid: BigInt(process.getuid()),
  });
  const ledgerExpected = Object.freeze({
    device: custody.ledgerIdentity.device,
    gid: custody.ledgerIdentity.gid,
    inode: custody.ledgerIdentity.inode,
    mountId: String(cleanup.mountId),
    uid: custody.ledgerIdentity.uid,
  });
  if (
    !rootBefore.isDirectory() ||
    rootBefore.nlink !== 0n ||
    readdirSync(`/proc/self/fd/${custody.custodyRoot}`).length !== 0 ||
    !sameIdentityRecord(identityRecord(custody.custodyRoot), rootExpected) ||
    !sameIdentityRecord(identityRecord(custody.ledgerDescriptor), ledgerExpected) ||
    matchingDescriptors(rootExpected).length !== 1 ||
    matchingDescriptors(ledgerExpected).length !== 1
  ) {
    refuse("retained custody identity");
  }
  clock.sample();
  closeSync(custody.ledgerDescriptor);
  requireDescriptorClosed(custody.ledgerDescriptor);
  closeSync(custody.custodyRoot);
  requireDescriptorClosed(custody.custodyRoot);
  clock.sample();
  if (
    matchingDescriptors(rootExpected).length !== 0 ||
    matchingDescriptors(ledgerExpected).length !== 0
  ) {
    refuse("retained custody descriptor residue");
  }
}

function settleMatchingCustody(cleanup, custody) {
  const records = [
    {
      device: cleanup.device,
      gid: BigInt(process.getgid()),
      inode: cleanup.inode,
      mountId: String(cleanup.mountId),
      uid: BigInt(process.getuid()),
    },
    {
      device: custody.ledgerIdentity.device,
      gid: custody.ledgerIdentity.gid,
      inode: custody.ledgerIdentity.inode,
      mountId: String(cleanup.mountId),
      uid: custody.ledgerIdentity.uid,
    },
  ];
  const errors = [];
  for (const expected of records) {
    let matches = [];
    try {
      matches = matchingDescriptors(expected);
    } catch (error) {
      errors.push(error);
    }
    for (const descriptor of matches) {
      try {
        closeSync(descriptor);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      if (matchingDescriptors(expected).length !== 0) {
        errors.push(new Error("retained identity remained open"));
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "retained custody settlement failed");
}

async function runFailedPathHelper(cleanup, custody, clock, hardDeadlineNs) {
  const child = spawn(NODE_EXECUTABLE, [PATH_HELPER], {
    cwd: "/",
    detached: true,
    env: { LANG: "C", LC_ALL: "C" },
    stdio: [
      "ignore",
      "ignore",
      "pipe",
      "pipe",
      "pipe",
      custody.custodyRoot,
      custody.ledgerDescriptor,
    ],
  });
  const observation = observeChild(child, {
    stdout: false,
    stderr: 4_096,
    extra: [{ index: 4, cap: 64 }],
  });
  const control = Buffer.from(
    [
      "openspell.wp201.path-cleanup-failed-cut.v1",
      cleanup.parentToken,
      cleanup.invocation,
      cleanup.device.toString(),
      cleanup.inode.toString(),
      cleanup.mountId.toString(),
      custody.ledgerDigest,
      "",
    ].join("\n"),
    "ascii",
  );
  await writePipe(child.stdio[3], control, true);
  const now = clock.sample();
  const result = await settleObserved(observation, {
    clock,
    ignoreSignal: true,
    normalDeadlineNs: now + 4n * SECOND_NS,
    termDeadlineNs: now + 7n * SECOND_NS,
    killDeadlineNs: now + 10n * SECOND_NS < hardDeadlineNs
      ? now + 10n * SECOND_NS
      : hardDeadlineNs,
  });
  if (
    result.status !== 0 ||
    result.signal !== null ||
    result.stderr.length !== 0 ||
    result.extra.length !== 1 ||
    !result.extra[0].equals(FAILED_PATH_COMPLETE)
  ) {
    refuse("failed-cut path helper");
  }
}

function cutLauncher(cutCase) {
  if (cutCase === "before-issue") return launchBeforeIssueFreshRoot;
  if (cutCase === "after-daemon-accept-before-delivery") {
    return launchAfterDaemonAcceptBeforeDeliveryFreshRoot;
  }
  if (cutCase === "after-parent-custody-before-start") {
    return launchAfterParentCustodyBeforeStartFreshRoot;
  }
  refuse("unknown cut case");
}

function cutFrameReady(channel, maximum) {
  if (channel.error !== undefined || channel.overflow) refuse("cut frame channel");
  const bytes = channel.bytes();
  if (bytes.length > maximum) refuse("cut frame cap");
  return bytes.length > 0 && bytes.at(-1) === 0x0a;
}

async function observeCutHarness(launch, cursor, harnessToken, cutCase, clock) {
  if (launch.outcome !== "spawned" || launch.child === undefined) {
    refuse("cut harness spawn");
  }
  const child = launch.child;
  const harnessStartTime = processStartTime(child.pid);
  const observation = observeChild(child, {
    stdout: 64,
    stderr: 128,
    extra: [
      { index: 4, cap: 320 },
      { index: 5, cap: 128 },
      { index: 6, cap: 512 },
    ],
  });
  activeChild = observation;
  const [identityChannel, acceptedChannel, auditChannel] = observation.extra;
  await waitUntil(
    clock,
    cursor.activeDeadlineNs,
    () => auditChannel.bytes().length >= AUDIT_OPEN.length || observation.state.closed,
    "cut audit-open deadline",
  );
  if (!auditChannel.bytes().equals(AUDIT_OPEN)) refuse("cut audit-open frame");
  let accepted;
  let identity;
  let signalAcknowledgement;
  try {
    await waitUntil(
      clock,
      cursor.activeDeadlineNs,
      () => cutFrameReady(acceptedChannel, 128) || observation.state.closed,
      "cut accepted-ID deadline",
    );
    accepted = parseCutAcceptedIdFrame(acceptedChannel.bytes(), cutCase, harnessToken);
    await waitUntil(
      clock,
      cursor.activeDeadlineNs,
      () => cutFrameReady(identityChannel, 320) || observation.state.closed,
      "cut reached deadline",
    );
    identity = parseCutIdentityFrame(identityChannel.bytes(), harnessToken);
    requireCutIdentityAgreement(identity, {
    cutCase,
    invocation: launch.cleanup.invocation,
    parent: launch.cleanup.parentToken,
    directoryDevice: launch.cleanup.device.toString(),
    directoryInode: launch.cleanup.inode.toString(),
    directoryMountId: launch.cleanup.mountId.toString(),
    ledgerSha256: launch.custody.ledgerDigest,
    });
    if (
      caughtSignal !== undefined ||
      observation.state.closed ||
      processStartTime(child.pid) !== harnessStartTime ||
      processStartTime(Number(identity.watcherPid)) !== identity.watcherStartTime
    ) {
      refuse("cut process identity before signal");
    }
    process.kill(child.pid, "SIGTERM");
    await waitUntil(
      clock,
      cursor.activeDeadlineNs,
      () =>
        auditChannel.bytes().length >= CUT_SIGNAL_ACKNOWLEDGEMENT_BYTES ||
        observation.state.closed,
      "cut signal acknowledgment deadline",
    );
    signalAcknowledgement = parseCutSignalAcknowledgement(
      auditChannel.bytes(),
      cutCase,
      harnessToken,
    );
    await writePipe(
      child.stdio[3],
      buildCutReleaseFrame(signalAcknowledgement, harnessToken),
      true,
    );
  } catch (error) {
    if (!observation.state.closed) {
      signalGroup(child.pid, "SIGKILL");
      try {
        await settleObserved(observation, {
          clock,
          normalDeadlineNs: clock.sample(),
          termDeadlineNs: clock.sample(),
          killDeadlineNs: cursor.innerDeadlineNs - SECOND_NS,
        });
      } catch {
        // The reached-cut protocol error remains authoritative.
      }
    }
    throw error;
  }
  const result = await settleObserved(observation, {
    clock,
    normalDeadlineNs: cursor.innerDeadlineNs - 5n * SECOND_NS,
    termDeadlineNs: cursor.innerDeadlineNs - 3n * SECOND_NS,
    killDeadlineNs: cursor.innerDeadlineNs - SECOND_NS,
  });
  const terminal = parseCutTerminalResult(
    { status: result.status, stdout: result.stdout, stderr: result.stderr },
    harnessToken,
  );
  const audit = parseCutAuditStream(
    result.extra[2],
    signalAcknowledgement,
    harnessToken,
  );
  const receipt = createCutHarnessReapReceipt({
    cutCase,
    token: harnessToken,
    terminal,
    accepted,
    identity,
    audit,
    pipesEof:
      observation.stdout.ended &&
      observation.stderr.ended &&
      observation.extra.every((channel) => channel.ended),
    groupAbsent: groupAbsent(child.pid),
  });
  if (activeChild === observation) activeChild = undefined;
  return Object.freeze({ identity, receipt });
}

async function completeDockerSlot(cursor, context, operation, options = {}) {
  const token = createOwnedChildToken();
  const begin = {
    type: "begin-slot",
    operation,
    token,
    ...(options.id === undefined ? {} : { id: options.id }),
  };
  cursor = reduceCutSupervisorCursor(cursor, begin, context.clock.sample());
  const slotContext = { ...context, hardDeadlineNs: cursor.active.endNs };
  let receipt;
  if (operation === "accepted-id-absence") {
    const result = await runDockerArguments(
      slotContext,
      dockerOperationArguments("absence", { id: options.id }),
      { cleanup: true },
    );
    receipt = parseDockerAbsence(result, options.id, { operation, token });
  } else if (operation === "exact-name-census") {
    const result = await runDockerArguments(
      slotContext,
      dockerOperationArguments("exact-name-proof", {
        invocation: context.invocation,
        rowId: "root-fmt",
      }),
      { cleanup: true },
    );
    receipt = classifyDockerExactName(
      result,
      { kind: "proof", invocation: context.invocation, rowId: "root-fmt" },
      { operation, token },
    );
  } else if (operation === "label-census") {
    const result = await runDockerArguments(
      slotContext,
      dockerOperationArguments("label-census", { invocation: context.invocation }),
      { cleanup: true },
    );
    receipt = parseDockerLabelCensus(result, context.invocation, { operation, token });
  } else {
    refuse("unexpected post-reap Docker slot");
  }
  return reduceCutSupervisorCursor(
    cursor,
    {
      type: "complete-slot",
      operation,
      outcome: "pass",
      reaped: true,
      token,
      receipt,
      ...(options.id === undefined ? {} : { id: options.id }),
    },
    context.clock.sample(),
  );
}

function completeLocalSlot(cursor, operation, clock, callback) {
  cursor = reduceCutSupervisorCursor(
    cursor,
    { type: "begin-slot", operation },
    clock.sample(),
  );
  callback();
  return reduceCutSupervisorCursor(
    cursor,
    { type: "complete-slot", operation, outcome: "pass" },
    clock.sample(),
  );
}

async function emergencyCutCleanup(launch, clock, dockerAnchor, hardDeadlineNs) {
  const errors = [];
  if (launch.child !== undefined && !groupAbsent(launch.child.pid)) {
    try {
      signalGroup(launch.child.pid, "SIGKILL");
      while (!groupAbsent(launch.child.pid) && clock.sample() < hardDeadlineNs) {
        await delay(POLL_MS);
      }
      if (!groupAbsent(launch.child.pid)) refuse("failed cut process group residue");
    } catch (error) {
      errors.push(error);
    }
  }
  const context = {
    clock,
    dockerAnchor,
    hardDeadlineNs,
    invocation: launch.cleanup.invocation,
    rootPath: launch.cleanup.path,
  };
  try {
    const recovered = await exactName(
      context,
      { kind: "proof", rowId: "root-fmt" },
      "exact-name-recovery",
      true,
    );
    if (recovered.outcome === "present") await removeAndProveAbsent(context, recovered.id);
  } catch (error) {
    errors.push(error);
  }
  try {
    const exact = await exactName(
      context,
      { kind: "proof", rowId: "root-fmt" },
      "final-exact-name-census",
      true,
    );
    if (exact.outcome !== "absent") refuse("failed cut final exact-name census");
    const labels = await labelCensus(context, "final-label-census", true);
    if (labels.ids.length !== 0) refuse("failed cut final label census");
  } catch (error) {
    errors.push(error);
  }
  try {
    await runFailedPathHelper(launch.cleanup, launch.custody, clock, hardDeadlineNs);
  } catch (error) {
    errors.push(error);
  }
  try {
    settleMatchingCustody(launch.cleanup, launch.custody);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw new AggregateError(errors, "failed cut cleanup did not settle");
}

async function runCut(sourceDirectory, cutCase, clock, dockerAnchor, signal) {
  const freshToken = await prepareFreshLedgerBackedRoot({ sourceDirectory, signal });
  let launch;
  let consumed = false;
  let passed = false;
  try {
    const harnessToken = createOwnedChildToken();
    const startedAtNs = clock.sample();
    launch = cutLauncher(cutCase)(freshToken);
    consumed = true;
    let cursor = createCutSupervisorCursor({
      cutCase,
      harnessToken,
      invocation: launch.cleanup.invocation,
      sample: startedAtNs,
    });
    const observed = await observeCutHarness(launch, cursor, harnessToken, cutCase, clock);
    cursor = reduceCutSupervisorCursor(
      cursor,
      { type: "harness-reaped", receipt: observed.receipt },
      clock.sample(),
    );
    const context = {
      clock,
      dockerAnchor,
      hardDeadlineNs: cursor.postReapDeadlineNs,
      invocation: launch.cleanup.invocation,
      rootPath: launch.cleanup.path,
    };
    while (expectedCutSupervisorOperation(cursor) !== null) {
      const operation = expectedCutSupervisorOperation(cursor);
      if (operation === "accepted-id-absence") {
        cursor = await completeDockerSlot(cursor, context, operation, { id: cursor.acceptedId });
      } else if (["exact-name-census", "label-census"].includes(operation)) {
        cursor = await completeDockerSlot(cursor, context, operation);
      } else if (operation === "local-absence") {
        cursor = completeLocalSlot(cursor, operation, clock, () => {
          requireCutLocalAbsence(launch.cleanup, observed.identity);
        });
      } else if (operation === "custody") {
        cursor = completeLocalSlot(cursor, operation, clock, () => {
          settleRetainedCustody(launch.cleanup, launch.custody, clock);
        });
      } else {
        refuse("unexpected cut post-reap slot");
      }
    }
    if (cursor.phase !== "complete" || cursor.failed) refuse("cut supervisor completion");
    passed = true;
  } finally {
    if (!consumed) {
      await abandonFreshRootHandoff(freshToken);
    } else if (!passed && launch !== undefined) {
      const now = clock.sample();
      await emergencyCutCleanup(launch, clock, dockerAnchor, now + 130n * SECOND_NS);
    }
  }
}

async function main() {
  if (
    process.argv.length !== 2 ||
    realpathSync(process.cwd()) !== realpathSync(PACKAGE_DIRECTORY)
  ) {
    refuse("entry contract");
  }
  assertCleanEnvironment(process.env);
  const abortController = new globalThis.AbortController();
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => {
      if (caughtSignal !== undefined) return;
      caughtSignal = signal;
      abortController.abort();
      if (activeChild !== undefined) signalGroup(activeChild.child.pid, "SIGTERM");
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  const clock = openBootClock();
  let root;
  const runtimeState = { cleanupState: "pre-record" };
  let operationError;
  try {
    const invocation = randomBytes(32).toString("hex");
    try {
      root = createInvocationRoot(invocation);
    } catch (error) {
      root = error?.cleanupRoot;
      throw error;
    }
    writeExclusive(
      join(root.path, "INVOCATION"),
      Buffer.from(invocationRecord(root.invocation), "ascii"),
      0o600,
    );
    syncDirectory(root.path);
    runtimeState.cleanupState = "partial-acquisition";
    const initial = clock.sample();
    const constructionDeadline = initial + ACQUISITION_ACTIVE_NS + INNER_RESERVE_NS;
    const sourceRows = await stageInvocation(root, clock, constructionDeadline);
    const dockerAnchor = captureDockerAnchor(clock);
    const completed = await runAcquisitionAndMatrix(
      root,
      sourceRows,
      clock,
      dockerAnchor,
      runtimeState,
    );
    const sourceDirectory = await open(
      root.path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      for (const cutCase of CUT_CASES) {
        if (caughtSignal !== undefined) refuse("signal before cut");
        await runCut(sourceDirectory, cutCase, clock, dockerAnchor, abortController.signal);
      }
    } finally {
      await sourceDirectory.close();
    }
    if (completed.ledger.rows.length !== 4_853 || completed.localImageId.length !== 71) {
      refuse("normal proof completion evidence");
    }
  } catch (error) {
    operationError = error;
  }
  const cleanupErrors = [];
  if (root !== undefined) {
    try {
      await runPathHelper(
        root,
        runtimeState.cleanupState,
        clock,
        clock.sample() + 15n * SECOND_NS,
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    clock.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  if (operationError !== undefined || cleanupErrors.length > 0 || caughtSignal !== undefined) {
    throw new AggregateError(
      [operationError, ...cleanupErrors].filter((entry) => entry !== undefined),
      "WP-201 Docker integration failed",
      { cause: operationError },
    );
  }
  await writePipe(process.stdout, SUCCESS, false);
}

function directInvocation() {
  return process.argv[1] !== undefined &&
    pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
}

if (directInvocation()) {
  main().catch(async () => {
    process.exitCode = 1;
    try {
      await writePipe(process.stderr, REFUSAL, false);
    } catch {
      // Exit failure remains authoritative if stderr cannot be drained.
    }
  });
}
