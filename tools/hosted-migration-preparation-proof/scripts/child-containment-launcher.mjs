import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import {
  closeSync,
  createReadStream,
  readFileSync,
  readdirSync,
  rmdirSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";

const RELEASE_FRAME = Buffer.from("openspell.wp201.child-release.v1\n", "ascii");
const SIGNAL_PREFIX = "openspell.wp201.child-signal.v1 ";
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function exactIntegerEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(value)) process.exit(125);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 3) process.exit(125);
  return parsed;
}

const childDirectoryFd = exactIntegerEnvironment("OPEN_SPELL_WP201_CHILD_DIRECTORY_FD");
const childEventsFd = exactIntegerEnvironment("OPEN_SPELL_WP201_CHILD_EVENTS_FD");
const childKillFd = exactIntegerEnvironment("OPEN_SPELL_WP201_CHILD_KILL_FD");
const childProcsFd = exactIntegerEnvironment("OPEN_SPELL_WP201_CHILD_PROCS_FD");
const controlFd = exactIntegerEnvironment("OPEN_SPELL_WP201_CHILD_CONTROL_FD");
const lifetimeFd = exactIntegerEnvironment("OPEN_SPELL_WP201_CHILD_LIFETIME_FD");
const parentDirectoryFd = exactIntegerEnvironment("OPEN_SPELL_WP201_CHILD_PARENT_DIRECTORY_FD");
const parentProcsFd = exactIntegerEnvironment("OPEN_SPELL_WP201_CHILD_PARENT_PROCS_FD");
const releaseFd = exactIntegerEnvironment("OPEN_SPELL_WP201_CHILD_RELEASE_FD");
const statusFd = exactIntegerEnvironment("OPEN_SPELL_WP201_CHILD_STATUS_FD");
const childName = process.env.OPEN_SPELL_WP201_CHILD_NAME;
const nonce = process.env.OPEN_SPELL_WP201_CHILD_NONCE;
const encodedSpec = process.env.OPEN_SPELL_WP201_CHILD_SPEC;
if (
  typeof childName !== "string" ||
  !/^openspell-wp201-child-[0-9a-f]{64}$/u.test(childName) ||
  typeof nonce !== "string" ||
  !/^[0-9a-f]{64}$/u.test(nonce) ||
  typeof encodedSpec !== "string"
) {
  process.exit(125);
}

const childPath = `/proc/self/fd/${childDirectoryFd}`;
const parentRelativePath = `/proc/self/fd/${parentDirectoryFd}/${childName}`;
let cleanupStarted = false;
let payload;
let payloadResult = { code: 125, signal: null };
let payloadStarted = false;
let releaseAccepted = false;
let pollTimer;

function status(line) {
  const bytes = Buffer.from(`${line}\n`, "utf8");
  writeSync(statusFd, bytes, 0, bytes.length, null);
}

function removeDescendants(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = join(path, entry.name);
    removeDescendants(nested);
    rmdirSync(nested);
  }
}

function populated() {
  const text = readFileSync(`/proc/self/fd/${childEventsFd}`, "ascii");
  const match = /^populated (?<value>[01])\nfrozen [01]\n$/u.exec(text);
  if (match?.groups?.value === undefined) throw new Error("invalid cgroup.events");
  return match.groups.value === "1";
}

function onlyGuardianRemains() {
  const procs = readFileSync(`${childPath}/cgroup.procs`, "ascii");
  if (procs !== `${process.pid}\n`) return false;
  const descendants = [];
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const nested = join(path, entry.name);
      descendants.push(nested);
      visit(nested);
    }
  };
  visit(childPath);
  return descendants.every((path) => {
    const events = readFileSync(`${path}/cgroup.events`, "ascii");
    return /^populated 0\nfrozen [01]\n$/u.test(events);
  });
}

function closeQuietly(descriptor) {
  try {
    closeSync(descriptor);
  } catch {
    // A cleanup failure becomes the guardian's non-zero terminal result.
  }
}

function terminate(result) {
  clearTimeout(pollTimer);
  const encoded = Buffer.from(JSON.stringify({
    code: Number.isSafeInteger(result.code) ? result.code : null,
    signal: typeof result.signal === "string" ? result.signal : null,
  }), "utf8").toString("base64url");
  status(`openspell.wp201.child-result.v1 ${nonce} ${encoded}`);
  process.kill(process.pid, "SIGKILL");
}

function evacuateAndRemove({ emergency, result }) {
  if (cleanupStarted) return;
  cleanupStarted = true;
  clearTimeout(pollTimer);
  try {
    const zero = Buffer.from("0\n", "ascii");
    writeSync(parentProcsFd, zero, 0, zero.length, null);
    if (emergency && populated()) {
      const kill = Buffer.from("1", "ascii");
      writeSync(childKillFd, kill, 0, kill.length, null);
    }
    const deadline = process.hrtime.bigint() + 5_000_000_000n;
    while (populated()) {
      if (process.hrtime.bigint() >= deadline) throw new Error("guardian cgroup drain timeout");
      Atomics.wait(sleepCell, 0, 0, 1);
    }
    removeDescendants(parentRelativePath);
    closeQuietly(childProcsFd);
    closeQuietly(childKillFd);
    closeQuietly(childEventsFd);
    closeQuietly(childDirectoryFd);
    rmdirSync(parentRelativePath);
    status(`openspell.wp201.child-evacuated.v1 ${nonce}`);
    terminate(result);
  } catch {
    terminate({ code: 125, signal: null });
  }
}

function emergencyCleanup() {
  evacuateAndRemove({ emergency: true, result: { code: 125, signal: null } });
}

function scheduleNormalCleanup() {
  if (cleanupStarted) return;
  try {
    if (onlyGuardianRemains()) {
      evacuateAndRemove({ emergency: false, result: payloadResult });
      return;
    }
  } catch {
    emergencyCleanup();
    return;
  }
  pollTimer = setTimeout(scheduleNormalCleanup, 10);
  pollTimer.unref();
}

function boundedSpawnError(error) {
  const record = { message: String(error?.message ?? "contained payload spawn failed").slice(0, 512) };
  for (const name of ["code", "errno", "path", "syscall"]) {
    const value = error?.[name];
    if (typeof value === "string") record[name] = value.slice(0, 256);
    else if (typeof value === "number" && Number.isSafeInteger(value)) record[name] = value;
  }
  return Buffer.from(JSON.stringify(record), "utf8").toString("base64url");
}

function startPayload(spec) {
  if (cleanupStarted) return;
  payloadStarted = true;
  try {
    payload = spawn(spec.executable, spec.arguments, {
      cwd: spec.cwd,
      detached: false,
      env: spec.env,
      stdio: Array.from({ length: spec.stdioLength }, () => "inherit"),
    });
  } catch (error) {
    status(`openspell.wp201.child-spawn-error.v1 ${nonce} ${boundedSpawnError(error)}`);
    payloadResult = { code: 127, signal: null };
    scheduleNormalCleanup();
    return;
  }
  payload.once("error", (error) => {
    status(`openspell.wp201.child-spawn-error.v1 ${nonce} ${boundedSpawnError(error)}`);
    payloadResult = { code: 127, signal: null };
  });
  payload.once("spawn", () => {
    status(`openspell.wp201.child-payload.v1 ${nonce} ${payload.pid}`);
  });
  payload.once("close", (code, signal) => {
    payloadResult = { code: code ?? 127, signal };
    scheduleNormalCleanup();
  });
}

function parseSpec() {
  let spec;
  try {
    spec = JSON.parse(Buffer.from(encodedSpec, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid payload spec encoding");
  }
  if (
    spec === null ||
    typeof spec !== "object" ||
    Array.isArray(spec) ||
    typeof spec.executable !== "string" ||
    !Array.isArray(spec.arguments) ||
    !spec.arguments.every((value) => typeof value === "string") ||
    typeof spec.cwd !== "string" ||
    spec.env === null ||
    typeof spec.env !== "object" ||
    Array.isArray(spec.env) ||
    !Number.isSafeInteger(spec.stdioLength) ||
    spec.stdioLength < 3
  ) {
    throw new Error("invalid payload spec");
  }
  return spec;
}

for (const name of Object.keys(process.env)) {
  if (name.startsWith("OPEN_SPELL_WP201_CHILD_")) delete process.env[name];
}

process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});

try {
  const zero = Buffer.from("0\n", "ascii");
  writeSync(childProcsFd, zero, 0, zero.length, null);
  if (readFileSync(`${childPath}/cgroup.procs`, "ascii") !== `${process.pid}\n`) {
    throw new Error("guardian self-adoption mismatch");
  }
  status(`openspell.wp201.child-adopted.v1 ${nonce}`);
} catch {
  process.exit(125);
}

const release = createReadStream(null, { fd: releaseFd });
const control = createReadStream(null, { fd: controlFd });
const lifetime = createReadStream(null, { fd: lifetimeFd });
let releaseBytes = Buffer.alloc(0);
let controlBytes = Buffer.alloc(0);

lifetime.once("end", emergencyCleanup);
lifetime.once("error", emergencyCleanup);
release.on("data", (chunk) => {
  releaseBytes = Buffer.concat([releaseBytes, Buffer.from(chunk)]);
  if (releaseBytes.length > RELEASE_FRAME.length) emergencyCleanup();
});
release.once("error", emergencyCleanup);
release.once("end", () => {
  if (cleanupStarted) return;
  if (!releaseBytes.equals(RELEASE_FRAME)) {
    emergencyCleanup();
    return;
  }
  releaseAccepted = true;
  let spec;
  try {
    spec = parseSpec();
  } catch {
    emergencyCleanup();
    return;
  }
  startPayload(spec);
});

control.on("data", (chunk) => {
  controlBytes = Buffer.concat([controlBytes, Buffer.from(chunk)]);
  if (controlBytes.length > 256) emergencyCleanup();
  for (;;) {
    const newline = controlBytes.indexOf(0x0a);
    if (newline < 0) break;
    const line = controlBytes.subarray(0, newline).toString("ascii");
    controlBytes = controlBytes.subarray(newline + 1);
    if (!line.startsWith(SIGNAL_PREFIX)) {
      emergencyCleanup();
      return;
    }
    const signal = line.slice(SIGNAL_PREFIX.length);
    if (signal !== "SIGINT" && signal !== "SIGTERM") {
      emergencyCleanup();
      return;
    }
    if (!releaseAccepted || !payloadStarted) {
      emergencyCleanup();
      return;
    }
    try {
      process.kill(-process.pid, signal);
    } catch {
      emergencyCleanup();
      return;
    }
  }
});
control.once("error", emergencyCleanup);
