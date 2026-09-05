import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  rmdirSync,
  statfsSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const CGROUP_ROOT = "/sys/fs/cgroup";
const CGROUP2_MAGIC = 0x63677270n;
const ADOPTION_WAIT_NS = 5_000_000_000n;
const RELEASE_FRAME = Buffer.from("openspell.wp201.child-release.v1\n", "ascii");
const SIGNAL_FRAMES = Object.freeze({
  SIGINT: Buffer.from("openspell.wp201.child-signal.v1 SIGINT\n", "ascii"),
  SIGTERM: Buffer.from("openspell.wp201.child-signal.v1 SIGTERM\n", "ascii"),
});
const LAUNCHER = fileURLToPath(new URL("./child-containment-launcher.mjs", import.meta.url));
const childContainments = new WeakMap();
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function modeOf(status) {
  return Number(status.mode & 0o777n);
}

function exactCurrentCgroup() {
  const record = readFileSync("/proc/self/cgroup", "ascii");
  const match = /^0::(?<path>\/[A-Za-z0-9_.@/-]+)\n$/u.exec(record);
  if (
    match?.groups?.path === undefined ||
    match.groups.path.split("/").some((part) => part === "..")
  ) {
    throw new Error("invalid unified cgroup membership");
  }
  const parent = join(CGROUP_ROOT, match.groups.path.slice(1));
  if (
    realpathSync(parent) !== parent ||
    statfsSync(parent, { bigint: true }).type !== CGROUP2_MAGIC
  ) {
    throw new Error("invalid unified cgroup filesystem");
  }
  const status = lstatSync(parent, { bigint: true });
  if (
    !status.isDirectory() ||
    status.uid !== BigInt(process.getuid()) ||
    status.gid !== BigInt(process.getgid())
  ) {
    throw new Error("invalid delegated cgroup parent");
  }
  return parent;
}

function descriptorIdentity(descriptor, type, expectedMode, label) {
  const status = fstatSync(descriptor, { bigint: true });
  if (
    (type === "directory" ? !status.isDirectory() : !status.isFile()) ||
    status.uid !== BigInt(process.getuid()) ||
    status.gid !== BigInt(process.getgid()) ||
    (expectedMode !== undefined && modeOf(status) !== expectedMode)
  ) {
    throw new Error(`invalid child cgroup ${label}`);
  }
  return Object.freeze({ device: status.dev, inode: status.ino });
}

function sameIdentity(left, right) {
  return left.device === right.device && left.inode === right.inode;
}

function sameNode(path, expected) {
  const status = lstatSync(path, { bigint: true });
  return status.dev === expected.device && status.ino === expected.inode;
}

function closeDescriptor(state, name, errors) {
  const descriptor = state[name];
  if (descriptor === undefined) return;
  try {
    closeSync(descriptor);
  } catch (error) {
    errors.push(error);
  }
  try {
    fstatSync(descriptor);
    errors.push(new Error(`child containment ${name} descriptor remained open`));
  } catch (error) {
    if (error?.code !== "EBADF") errors.push(error);
  }
  state[name] = undefined;
}

function closeDescriptors(state, names, errors) {
  for (const name of names) closeDescriptor(state, name, errors);
}

function removeDescendantCgroups(path) {
  const entries = readdirSync(path, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = join(path, entry.name);
    removeDescendantCgroups(nested);
    rmdirSync(nested);
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

function createContainment() {
  const parent = exactCurrentCgroup();
  let name;
  let path;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    name = `openspell-wp201-child-${randomBytes(32).toString("hex")}`;
    path = join(parent, name);
    try {
      mkdirSync(path, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      path = undefined;
    }
  }
  if (path === undefined || name === undefined) {
    throw new Error("fresh child cgroup collision");
  }
  const state = {
    adopted: false,
    childDirectory: undefined,
    childDirectoryIdentity: undefined,
    childEvents: undefined,
    childEventsIdentity: undefined,
    childKill: undefined,
    childKillIdentity: undefined,
    childProcs: undefined,
    childProcsIdentity: undefined,
    control: undefined,
    controlError: undefined,
    lifetime: undefined,
    name,
    nonce: randomBytes(32).toString("hex"),
    parent,
    parentDirectory: undefined,
    parentDirectoryIdentity: undefined,
    parentProcs: undefined,
    parentProcsIdentity: undefined,
    path,
    payloadResult: undefined,
    payloadPid: undefined,
    release: undefined,
    releaseError: undefined,
    releaseSent: false,
    releaseSettled: false,
    settlement: undefined,
    setupError: undefined,
    status: undefined,
    statusAdopted: false,
    statusBytes: Buffer.alloc(0),
    statusEnded: false,
    statusError: undefined,
  };
  try {
    state.parentDirectory = openSync(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_CLOEXEC,
    );
    state.parentDirectoryIdentity = descriptorIdentity(
      state.parentDirectory,
      "directory",
      undefined,
      "parent directory",
    );
    state.parentProcs = openSync(
      `/proc/self/fd/${state.parentDirectory}/cgroup.procs`,
      constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC,
    );
    state.parentProcsIdentity = descriptorIdentity(
      state.parentProcs,
      "file",
      0o644,
      "parent procs",
    );
    state.childDirectory = openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_CLOEXEC,
    );
    state.childDirectoryIdentity = descriptorIdentity(
      state.childDirectory,
      "directory",
      0o700,
      "directory",
    );
    const capabilityPath = `/proc/self/fd/${state.childDirectory}`;
    state.childEvents = openSync(
      `${capabilityPath}/cgroup.events`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC,
    );
    state.childEventsIdentity = descriptorIdentity(
      state.childEvents,
      "file",
      0o444,
      "events",
    );
    state.childKill = openSync(
      `${capabilityPath}/cgroup.kill`,
      constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC,
    );
    state.childKillIdentity = descriptorIdentity(
      state.childKill,
      "file",
      0o200,
      "kill",
    );
    state.childProcs = openSync(
      `${capabilityPath}/cgroup.procs`,
      constants.O_RDWR | constants.O_NOFOLLOW | constants.O_CLOEXEC,
    );
    state.childProcsIdentity = descriptorIdentity(
      state.childProcs,
      "file",
      0o644,
      "procs",
    );
    return state;
  } catch (error) {
    const errors = [error];
    closeDescriptors(
      state,
      [
        "childProcs",
        "childKill",
        "childEvents",
        "childDirectory",
        "parentProcs",
        "parentDirectory",
      ],
      errors,
    );
    try {
      if (!pathAbsent(path)) rmdirSync(path);
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    if (errors.length === 1) throw error;
    throw new AggregateError(errors, "fresh child cgroup creation failed", { cause: error });
  }
}

function readPopulated(state) {
  const buffer = Buffer.allocUnsafe(65);
  const count = readSync(state.childEvents, buffer, 0, buffer.length, 0);
  if (count <= 0 || count >= buffer.length) throw new Error("child cgroup events cap");
  const match = /^populated (?<populated>[01])\nfrozen [01]\n$/u.exec(
    buffer.subarray(0, count).toString("ascii"),
  );
  if (match?.groups?.populated === undefined) {
    throw new Error("invalid child cgroup events");
  }
  return match.groups.populated === "1";
}

function containmentEmpty(state) {
  try {
    return !readPopulated(state);
  } catch (error) {
    if (["ENODEV", "ENOENT"].includes(error?.code) && pathAbsent(state.path)) return true;
    throw error;
  }
}

function exactMembers(state) {
  const buffer = Buffer.allocUnsafe(4_097);
  const count = readSync(state.childProcs, buffer, 0, buffer.length, 0);
  if (count < 0 || count >= buffer.length) throw new Error("child cgroup procs cap");
  const text = buffer.subarray(0, count).toString("ascii");
  if (text !== "" && !/^(?:[1-9][0-9]*\n)+$/u.test(text)) {
    throw new Error("invalid child cgroup membership list");
  }
  return text === "" ? [] : text.trimEnd().split("\n").map(Number);
}

function waitForAdoption(state, child) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    throw new Error("contained guardian PID unavailable");
  }
  const deadline = process.hrtime.bigint() + ADOPTION_WAIT_NS;
  for (;;) {
    if (readPopulated(state)) {
      const members = exactMembers(state);
      if (members.length !== 1 || members[0] !== child.pid) {
        throw new Error("contained guardian adoption identity mismatch");
      }
      state.adopted = true;
      return;
    }
    if (process.hrtime.bigint() >= deadline) {
      throw new Error("contained guardian adoption deadline expired");
    }
    Atomics.wait(sleepCell, 0, 0, 1);
  }
}

function captureStatus(state) {
  let length = 0;
  const parseLine = (line) => {
    const adopted = `openspell.wp201.child-adopted.v1 ${state.nonce}`;
    if (!state.statusAdopted) {
      if (line !== adopted) {
        state.statusError ??= new Error("contained guardian adoption frame invalid");
      } else {
        state.statusAdopted = true;
      }
      return;
    }
    const spawnPrefix = `openspell.wp201.child-spawn-error.v1 ${state.nonce} `;
    const resultPrefix = `openspell.wp201.child-result.v1 ${state.nonce} `;
    const payloadPrefix = `openspell.wp201.child-payload.v1 ${state.nonce} `;
    if (line.startsWith(spawnPrefix)) {
      try {
        const record = JSON.parse(
          Buffer.from(line.slice(spawnPrefix.length), "base64url").toString("utf8"),
        );
        if (
          record === null ||
          typeof record !== "object" ||
          Array.isArray(record) ||
          typeof record.message !== "string" ||
          record.message.length > 512
        ) {
          throw new Error("invalid payload spawn error record");
        }
        const error = new Error(record.message);
        error.name = "ContainedPayloadSpawnError";
        for (const name of ["code", "errno", "path", "syscall"]) {
          const value = record[name];
          if (typeof value === "string" && value.length <= 256) error[name] = value;
          else if (typeof value === "number" && Number.isSafeInteger(value)) error[name] = value;
        }
        state.setupError ??= error;
      } catch (error) {
        state.statusError ??= error;
      }
    } else if (line.startsWith(payloadPrefix)) {
      const value = line.slice(payloadPrefix.length);
      if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
        state.statusError ??= new Error("contained payload identity invalid");
      } else if (state.payloadPid !== undefined) {
        state.statusError ??= new Error("contained payload identity replayed");
      } else {
        state.payloadPid = Number(value);
      }
    } else if (line.startsWith(resultPrefix)) {
      try {
        const result = JSON.parse(
          Buffer.from(line.slice(resultPrefix.length), "base64url").toString("utf8"),
        );
        if (
          result === null ||
          typeof result !== "object" ||
          Array.isArray(result) ||
          (result.code !== null && !Number.isSafeInteger(result.code)) ||
          (result.signal !== null && typeof result.signal !== "string")
        ) {
          throw new Error("invalid contained payload result");
        }
        if (state.payloadResult !== undefined) {
          throw new Error("contained payload result replayed");
        }
        state.payloadResult = Object.freeze({ code: result.code, signal: result.signal });
      } catch (error) {
        state.statusError ??= error;
      }
    } else if (line !== `openspell.wp201.child-evacuated.v1 ${state.nonce}`) {
      state.statusError ??= new Error("contained guardian status frame invalid");
    }
  };
  state.status.on("data", (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 4_096) {
      state.statusError ??= new Error("contained guardian status cap");
      return;
    }
    state.statusBytes = Buffer.concat([state.statusBytes, bytes]);
    for (;;) {
      const newline = state.statusBytes.indexOf(0x0a);
      if (newline < 0) break;
      parseLine(state.statusBytes.subarray(0, newline).toString("utf8"));
      state.statusBytes = state.statusBytes.subarray(newline + 1);
    }
  });
  state.status.once("error", (error) => {
    state.statusError ??= error;
  });
  state.status.once("end", () => {
    state.statusEnded = true;
    if (state.statusBytes.length !== 0) {
      state.statusError ??= new Error("contained guardian status frame truncated");
    }
    if (!state.statusAdopted) {
      state.statusError ??= new Error("contained guardian adoption frame missing");
    }
  });
}

function sendRelease(state) {
  if (state.releaseSent || state.release === undefined) {
    throw new Error("contained child release is invalid or consumed");
  }
  state.releaseSent = true;
  state.release.once("error", (error) => {
    state.releaseError ??= error;
  });
  state.release.once("finish", () => {
    state.releaseSettled = true;
  });
  state.release.end(RELEASE_FRAME);
}

function abortRelease(state) {
  if (state.releaseSent || state.release === undefined) return;
  state.releaseSent = true;
  state.release.once("error", (error) => {
    state.releaseError ??= error;
  });
  state.release.once("close", () => {
    state.releaseSettled = true;
  });
  state.release.destroy();
}

function setupFailure(state) {
  const errors = [state.setupError, state.releaseError, state.controlError, state.statusError].filter(
    (error) => error !== undefined,
  );
  if (errors.length === 0) return undefined;
  return errors.length === 1
    ? errors[0]
    : new AggregateError(errors, "contained child setup failed", { cause: errors[0] });
}

function cleanupUnspawned(state, primary) {
  const errors = [primary];
  closeDescriptors(
    state,
    [
      "childProcs",
      "childKill",
      "childEvents",
      "childDirectory",
      "parentProcs",
      "parentDirectory",
    ],
    errors,
  );
  try {
    if (!pathAbsent(state.path)) rmdirSync(state.path);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw primary;
  throw new AggregateError(errors, "contained child spawn failed", { cause: primary });
}

export function spawnContained(spawnImplementation, executable, arguments_, options) {
  const stdio = options.stdio ?? ["ignore", "pipe", "pipe"];
  if (!Array.isArray(stdio) || stdio.length < 3) {
    throw new Error("invalid contained child stdio");
  }
  const state = createContainment();
  const releaseIndex = stdio.length;
  const statusIndex = releaseIndex + 1;
  const controlIndex = releaseIndex + 2;
  const lifetimeIndex = releaseIndex + 3;
  const childDirectoryIndex = releaseIndex + 4;
  const childProcsIndex = releaseIndex + 5;
  const parentDirectoryIndex = releaseIndex + 6;
  const parentProcsIndex = releaseIndex + 7;
  const childKillIndex = releaseIndex + 8;
  const childEventsIndex = releaseIndex + 9;
  const spec = Buffer.from(JSON.stringify({
    arguments: arguments_,
    cwd: options.cwd,
    env: options.env,
    executable,
    stdioLength: stdio.length,
  })).toString("base64url");
  let child;
  try {
    child = spawnImplementation(process.execPath, [LAUNCHER], {
      cwd: "/",
      detached: true,
      env: {
        LANG: "C",
        LC_ALL: "C",
        OPEN_SPELL_WP201_CHILD_DIRECTORY_FD: String(childDirectoryIndex),
        OPEN_SPELL_WP201_CHILD_EVENTS_FD: String(childEventsIndex),
        OPEN_SPELL_WP201_CHILD_KILL_FD: String(childKillIndex),
        OPEN_SPELL_WP201_CHILD_NAME: state.name,
        OPEN_SPELL_WP201_CHILD_NONCE: state.nonce,
        OPEN_SPELL_WP201_CHILD_PARENT_DIRECTORY_FD: String(parentDirectoryIndex),
        OPEN_SPELL_WP201_CHILD_PARENT_PROCS_FD: String(parentProcsIndex),
        OPEN_SPELL_WP201_CHILD_PROCS_FD: String(childProcsIndex),
        OPEN_SPELL_WP201_CHILD_RELEASE_FD: String(releaseIndex),
        OPEN_SPELL_WP201_CHILD_STATUS_FD: String(statusIndex),
        OPEN_SPELL_WP201_CHILD_CONTROL_FD: String(controlIndex),
        OPEN_SPELL_WP201_CHILD_LIFETIME_FD: String(lifetimeIndex),
        OPEN_SPELL_WP201_CHILD_SPEC: spec,
      },
      stdio: [
        ...stdio,
        "pipe",
        "pipe",
        "pipe",
        "pipe",
        state.childDirectory,
        state.childProcs,
        state.parentDirectory,
        state.parentProcs,
        state.childKill,
        state.childEvents,
      ],
    });
  } catch (error) {
    cleanupUnspawned(state, error);
  }
  childContainments.set(child, state);
  state.release = child.stdio[releaseIndex];
  state.status = child.stdio[statusIndex];
  state.control = child.stdio[controlIndex];
  state.lifetime = child.stdio[lifetimeIndex];
  if (
    state.release === null ||
    state.status === null ||
    state.control === null ||
    state.lifetime === null
  ) {
    state.setupError = new Error("contained guardian private pipe unavailable");
    abortRelease(state);
    state.lifetime?.destroy();
  } else {
    captureStatus(state);
    state.control.once("error", (error) => {
      state.controlError ??= error;
    });
    state.lifetime.once("error", (error) => {
      state.controlError ??= error;
    });
    child.once("exit", () => {
      state.control?.destroy();
      state.lifetime?.destroy();
    });
    try {
      waitForAdoption(state, child);
    } catch (error) {
      state.setupError = error;
      abortRelease(state);
      state.lifetime.destroy();
    }
    closeDescriptor(state, "childProcs", []);
    if (state.setupError === undefined && options.holdRelease !== true) sendRelease(state);
  }
  return child;
}

export function releaseContainedChild(child) {
  const state = childContainments.get(child);
  if (state === undefined) throw new Error("unknown contained child");
  if (state.setupError !== undefined) throw state.setupError;
  sendRelease(state);
}

export function abortContainedChild(child) {
  const state = childContainments.get(child);
  if (state === undefined) throw new Error("unknown contained child");
  abortRelease(state);
  state.lifetime?.destroy();
}

export function containedChildEmpty(child) {
  const state = childContainments.get(child);
  if (state === undefined) throw new Error("unknown contained child");
  if (state.settlement !== undefined) return state.settlement.empty;
  return containmentEmpty(state);
}

export function containedChildReleased(child) {
  const state = childContainments.get(child);
  if (state === undefined) throw new Error("unknown contained child");
  return state.releaseSettled || state.releaseError !== undefined;
}

export function containedChildSetupError(child) {
  const state = childContainments.get(child);
  if (state === undefined) throw new Error("unknown contained child");
  return setupFailure(state);
}

export function containedChildResult(child) {
  const state = childContainments.get(child);
  if (state === undefined) throw new Error("unknown contained child");
  return state.payloadResult;
}

export function containedChildPayloadPid(child) {
  const state = childContainments.get(child);
  if (state === undefined) throw new Error("unknown contained child");
  return state.payloadPid;
}

export function signalContainedChild(child, signal) {
  const state = childContainments.get(child);
  if (state === undefined) throw new Error("unknown contained child");
  if (signal === "SIGKILL") {
    if (!containmentEmpty(state)) {
      const frame = Buffer.from("1", "ascii");
      if (writeSync(state.childKill, frame, 0, frame.length, null) !== frame.length) {
        throw new Error("short child cgroup kill write");
      }
    }
    return;
  }
  const frame = SIGNAL_FRAMES[signal];
  if (frame === undefined) throw new Error("invalid contained child signal");
  if (state.control === undefined || state.control.destroyed) {
    if (containedChildEmpty(child)) return;
    throw new Error("contained guardian signal channel unavailable");
  }
  state.control.write(frame, (error) => {
    if (error !== null && error !== undefined) state.controlError ??= error;
  });
}

function scanDescriptorResidue(identities, errors) {
  let names;
  try {
    names = readdirSync("/proc/self/fd");
  } catch (error) {
    errors.push(error);
    return;
  }
  for (const name of names) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(name)) continue;
    try {
      const status = fstatSync(Number(name), { bigint: true });
      const observed = { device: status.dev, inode: status.ino };
      if (identities.some((identity) => sameIdentity(observed, identity))) {
        errors.push(new Error("child containment descriptor identity remained open"));
      }
    } catch (error) {
      if (error?.code !== "EBADF" && error?.code !== "ENOENT") errors.push(error);
    }
  }
}

export function settleContainedChild(child) {
  const state = childContainments.get(child);
  if (state === undefined) throw new Error("unknown contained child");
  if (state.settlement !== undefined) return state.settlement;
  const errors = [];
  let empty = false;
  try {
    empty = containmentEmpty(state);
    if (!empty) errors.push(new Error("child cgroup remained populated"));
  } catch (error) {
    errors.push(error);
  }
  if (!state.releaseSettled) errors.push(new Error("child release pipe did not settle"));
  if (!state.statusEnded) errors.push(new Error("contained guardian status pipe did not settle"));

  state.release?.destroy();
  state.status?.destroy();
  state.control?.destroy();
  state.lifetime?.destroy();

  const identities = [state.childDirectoryIdentity].filter(
    (identity) => identity !== undefined,
  );

  if (empty) {
    const relativePath = state.parentDirectory === undefined
      ? state.path
      : `/proc/self/fd/${state.parentDirectory}/${state.name}`;
    try {
      if (!pathAbsent(relativePath)) {
        if (!sameNode(relativePath, state.childDirectoryIdentity)) {
          errors.push(new Error("child cgroup pathname identity changed"));
        } else {
          removeDescendantCgroups(relativePath);
        }
      }
    } catch (error) {
      errors.push(error);
    }
    closeDescriptors(
      state,
      ["childProcs", "childKill", "childEvents", "childDirectory"],
      errors,
    );
    try {
      if (!pathAbsent(relativePath)) rmdirSync(relativePath);
    } catch (error) {
      errors.push(error);
    }
    try {
      if (!pathAbsent(state.path)) errors.push(new Error("child cgroup pathname remained"));
    } catch (error) {
      errors.push(error);
    }
  }
  closeDescriptors(state, ["parentProcs", "parentDirectory"], errors);
  scanDescriptorResidue(identities, errors);
  state.settlement = Object.freeze({
    empty,
    errors: Object.freeze(errors),
    settled: empty && errors.length === 0,
  });
  return state.settlement;
}
