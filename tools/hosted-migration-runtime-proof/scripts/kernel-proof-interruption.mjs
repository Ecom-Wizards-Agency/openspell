import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";

import { image } from "./cargo.mjs";

const wrapper = fileURLToPath(new URL("./kernel-proof.mjs", import.meta.url));
const dockerResponseShim = fileURLToPath(
  new URL("./docker-response-shim.mjs", import.meta.url),
);
const maximumOutputBytes = 64 * 1024;
const setupObservationTimeoutMilliseconds = 10 * 60_000;
const observationDelayMilliseconds = 5;
const exitTimeoutMilliseconds = 180_000;
const forcedExitTimeoutMilliseconds = 180_000;
const forcedKillTimeoutMilliseconds = 30_000;
const emergencyCleanupTimeoutMilliseconds = 120_000;
const finalCleanupObservationTimeoutMilliseconds = 60 * 60_000;
const watcherExitTimeoutMilliseconds = 10_000;
const watchdogFixtureTimeoutMilliseconds = 100;
const watchdogFixtureReadyTimeoutMilliseconds = 10_000;
const ownedClientStopReserveMilliseconds = 1_250;
const recoveryImageRepository = ["openspell", "wp200", "recovery"].join("-");

function remainingOperationTime(deadline) {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error("interruption proof deadline exhausted");
  return Math.min(10_000, Math.ceil(remaining));
}

function resolveDocker() {
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, "docker");
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Continue through the fixed PATH search.
    }
  }
  throw new Error("interruption proof Docker executable unavailable");
}

const realDocker = resolveDocker();

function rawDocker(args, timeoutMilliseconds = 10_000) {
  return spawnSync(realDocker, args, {
    encoding: "utf8",
    maxBuffer: maximumOutputBytes,
    timeout: timeoutMilliseconds,
  });
}

function docker(args, timeoutMilliseconds = 10_000) {
  const result = rawDocker(args, timeoutMilliseconds);
  if (result.error !== undefined) throw new Error("interruption proof Docker operation failed");
  return result;
}

function requireDocker(result) {
  if (
    result.error !== undefined ||
    result.status !== 0 ||
    result.signal !== null ||
    result.stderr !== ""
  ) {
    throw new Error("interruption proof Docker operation refused");
  }
}

function listExact(filter, format, timeoutMilliseconds) {
  const result = docker([
    "container",
    "ls",
    "--all",
    "--no-trunc",
    "--filter",
    filter,
    "--format",
    format,
  ], timeoutMilliseconds);
  requireDocker(result);
  return result.stdout.split("\n").filter(Boolean);
}

function proveGlobalResidueAbsent() {
  const containers = listExact("name=openspell-wp200-", "{{.ID}}");
  const images = docker([
    "image",
    "ls",
    "--all",
    "--no-trunc",
    "--quiet",
    "--filter",
    "reference=openspell-wp200-recovery:*",
  ]);
  requireDocker(images);
  const responseCuts = readdirSync(tmpdir()).filter((name) =>
    name.startsWith("openspell-wp200-docker-cut-"),
  );
  if (
    containers.length !== 0 ||
    images.stdout.split("\n").filter(Boolean).length !== 0 ||
    responseCuts.length !== 0
  ) {
    throw new Error("interruption proof residue present");
  }
}

function inspectContainer(id, timeoutMilliseconds) {
  const inspection = docker(["container", "inspect", id], timeoutMilliseconds);
  requireDocker(inspection);
  let records;
  try {
    records = JSON.parse(inspection.stdout);
  } catch {
    throw new Error("interruption proof inspection refused");
  }
  if (!Array.isArray(records) || records.length !== 1 || records[0].Id !== id) {
    throw new Error("interruption proof exact container required");
  }
  return records[0];
}

async function observeContainer(containerId, prefix, requiredStatus) {
  const deadline = performance.now() + setupObservationTimeoutMilliseconds;
  while (performance.now() < deadline) {
    let record;
    try {
      record = inspectContainer(containerId, remainingOperationTime(deadline));
    } catch {
      await delay(observationDelayMilliseconds);
      continue;
    }
    const status = record.State?.Status;
    const targetVolumes = (record.Mounts ?? []).filter(
      (mount) =>
        mount.Type === "volume" &&
        mount.Destination === "/target" &&
        /^[0-9a-f]{64}$/u.test(mount.Name),
    );
    const exactPhase =
      record.Name.startsWith(`/${prefix}`) &&
      ((prefix === "openspell-wp200-build-" &&
        status === requiredStatus &&
        targetVolumes.length === 1) ||
        (prefix === "openspell-wp200-stage-" &&
          status === requiredStatus &&
          record.HostConfig?.Privileged === false) ||
        (prefix === "openspell-wp200-case-" &&
          status === requiredStatus &&
          record.HostConfig?.Privileged === true &&
          (requiredStatus !== "running" ||
            record.Config?.Cmd?.at(-1) === "external-interruption-hold")));
    if (exactPhase) return record;
    await delay(observationDelayMilliseconds);
  }
  throw new Error("interruption proof checkpoint unavailable");
}

function dockerIds(args, timeoutMilliseconds) {
  const result = docker(args, timeoutMilliseconds);
  requireDocker(result);
  return result.stdout.split("\n").filter(Boolean);
}

async function observeCommittedImage(imageId, record) {
  const match = /^\/openspell-wp200-stage-([0-9a-f-]{36})$/u.exec(record.Name);
  if (match === null) throw new Error("interruption proof stage identity refused");
  const tag = `openspell-wp200-recovery:${match[1]}`;
  const deadline = performance.now() + setupObservationTimeoutMilliseconds;
  while (performance.now() < deadline) {
    const result = docker(
      ["image", "inspect", imageId],
      remainingOperationTime(deadline),
    );
    requireDocker(result);
    let records;
    try {
      records = JSON.parse(result.stdout);
    } catch {
      throw new Error("interruption proof image inspection refused");
    }
    if (
      Array.isArray(records) &&
      records.length === 1 &&
      records[0].Id === imageId &&
      Array.isArray(records[0].RepoTags) &&
      records[0].RepoTags.includes(tag)
    ) {
      return imageId;
    }
    throw new Error("interruption proof image identity refused");
  }
  throw new Error("interruption proof image checkpoint unavailable");
}

function prepareResponseCut(cut) {
  if (
    cut !== "build-create" &&
    cut !== "image-commit" &&
    cut !== "case-inspect" &&
    cut !== "case-running" &&
    cut !== "final-image-delete"
  ) {
    throw new Error("interruption proof response cut refused");
  }
  const directory = mkdtempSync(join(tmpdir(), "openspell-wp200-docker-cut-"));
  const launcher = join(directory, "docker");
  const ready = join(directory, "ready");
  const release = join(directory, "release");
  const startAttempt = join(directory, "start-attempt");
  const identity = join(directory, "identity.json");
  try {
    writeFileSync(
      launcher,
      '#!/bin/sh\nexec "$WP200_NODE" "$WP200_DOCKER_SHIM" "$@"\n',
      { encoding: "utf8", flag: "wx", mode: 0o700 },
    );
    chmodSync(launcher, 0o700);
    return Object.freeze({
      directory,
      ready,
      release,
      startAttempt,
      identity,
      responseHeld: cut !== "case-running",
      releaseRequired: true,
      env: {
        ...process.env,
        PATH: `${directory}${delimiter}${process.env["PATH"] ?? ""}`,
        WP200_NODE: process.execPath,
        WP200_DOCKER_SHIM: dockerResponseShim,
        WP200_REAL_DOCKER: realDocker,
        WP200_DOCKER_RESPONSE_CUT: cut,
        WP200_DOCKER_RESPONSE_READY: ready,
        WP200_DOCKER_RESPONSE_RELEASE: release,
        WP200_DOCKER_START_ATTEMPT: startAttempt,
        WP200_DOCKER_RESPONSE_IDENTITY: identity,
        WP200_KERNEL_PROOF_PHASE_FD: "3",
      },
    });
  } catch (error) {
    rmSync(directory, { force: true, recursive: true });
    throw error;
  }
}

async function awaitResponseHeld(cut, child) {
  const deadline = performance.now() + setupObservationTimeoutMilliseconds;
  while (performance.now() < deadline) {
    if (
      existsSync(cut.ready) &&
      existsSync(cut.identity) &&
      (!cut.responseHeld || !existsSync(cut.release))
    ) {
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("interruption proof response holder exited");
    }
    await delay(observationDelayMilliseconds);
  }
  throw new Error("interruption proof held response unavailable");
}

function releaseResponse(cut) {
  if (!cut.releaseRequired) return;
  if (!existsSync(cut.release)) {
    writeFileSync(cut.release, "release\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }
}

function readResponseIdentity(cut) {
  let identity;
  try {
    identity = JSON.parse(readFileSync(cut.identity, "utf8"));
  } catch {
    throw new Error("interruption proof response identity refused");
  }
  if (
    !/^[0-9a-f]{64}$/u.test(identity?.containerId ?? "") ||
    (identity.imageId !== undefined &&
      !/^sha256:[0-9a-f]{64}$/u.test(identity.imageId))
  ) {
    throw new Error("interruption proof response identity refused");
  }
  return Object.freeze(identity);
}

function removeResponseCut(cut) {
  rmSync(cut.directory, { recursive: true });
}

function collectBounded(stream) {
  let value = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    value += chunk;
    if (value.length > maximumOutputBytes) stream.destroy();
  });
  return () => value;
}

function observeChildExit(child) {
  const streamsEnded =
    (child.stdout?.readableEnded ?? true) && (child.stderr?.readableEnded ?? true);
  if ((child.exitCode !== null || child.signalCode !== null) && streamsEnded) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
      spawnFailed: false,
      timedOut: false,
    });
  }
  return new Promise((resolve) => {
    let spawnFailed = false;
    const failed = () => {
      spawnFailed = true;
    };
    const closed = (code, signal) => {
      child.off("error", failed);
      resolve({ code, signal, spawnFailed, timedOut: false });
    };
    child.once("error", failed);
    child.once("close", closed);
  });
}

function waitForObservedExit(observedExit, timeoutMilliseconds = exitTimeoutMilliseconds) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(
      () => finish({ code: null, signal: null, spawnFailed: false, timedOut: true }),
      timeoutMilliseconds,
    );
    void observedExit.then(finish);
  });
}

function waitForObservedExitUntil(observedExit, deadline) {
  const remaining = Math.ceil(deadline - performance.now());
  return remaining <= 0
    ? Promise.resolve({
        code: null,
        signal: null,
        spawnFailed: false,
        timedOut: true,
      })
    : waitForObservedExit(observedExit, remaining);
}

function childIsRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function signalProcessGroup(child, signal) {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function ensureChildExit(
  child,
  observedExit,
  terminal,
  gracefulTimeoutMilliseconds = forcedExitTimeoutMilliseconds,
  killTimeoutMilliseconds = forcedKillTimeoutMilliseconds,
) {
  if (terminal !== undefined && !terminal.timedOut) {
    return Object.freeze({ forced: false, terminal });
  }
  if (!childIsRunning(child)) {
    return Object.freeze({
      forced: false,
      terminal: await waitForObservedExit(observedExit, gracefulTimeoutMilliseconds),
    });
  }
  signalProcessGroup(child, "SIGTERM");
  let stopped = await waitForObservedExit(observedExit, gracefulTimeoutMilliseconds);
  if (!stopped.timedOut || !childIsRunning(child)) {
    return Object.freeze({ forced: true, terminal: stopped });
  }
  signalProcessGroup(child, "SIGKILL");
  stopped = await waitForObservedExit(observedExit, killTimeoutMilliseconds);
  return Object.freeze({ forced: true, terminal: stopped });
}

async function settleChildCustody(
  child,
  observedExit,
  terminal,
  custody,
  gracefulTimeoutMilliseconds,
  killTimeoutMilliseconds,
) {
  const stopped = await ensureChildExit(
    child,
    observedExit,
    terminal,
    gracefulTimeoutMilliseconds,
    killTimeoutMilliseconds,
  );
  if (stopped.forced && custody !== undefined) {
    await recoverCapturedObjects(custody);
  }
  return stopped;
}

function expectedDerivedImage(custody) {
  return /^sha256:[0-9a-f]{64}$/u.test(custody.imageId ?? "")
    ? custody.imageId
    : undefined;
}

function proveCapturedObjectsAbsent(custody) {
  const containers = dockerIds([
    "container",
    "ls",
    "--all",
    "--no-trunc",
    "--format",
    "{{.ID}}",
  ]);
  if (containers.includes(custody.containerId)) {
    throw new Error("interruption proof captured container remained");
  }
  const volumes = dockerIds(["volume", "ls", "--quiet"]);
  if (custody.record === undefined) {
    if (
      custody.volumesBefore === undefined ||
      JSON.stringify(volumes.sort()) !== JSON.stringify(custody.volumesBefore)
    ) {
      throw new Error("interruption proof volume inventory changed");
    }
  } else {
    for (const mount of custody.record.Mounts ?? []) {
      if (mount.Type !== "volume" || !/^[0-9a-f]{64}$/u.test(mount.Name)) continue;
      if (volumes.includes(mount.Name)) {
        throw new Error("interruption proof anonymous volume remained");
      }
    }
  }
  const expectedImage = expectedDerivedImage(custody);
  if (expectedImage !== undefined) {
    const images = dockerIds(
      ["image", "ls", "--all", "--no-trunc", "--quiet"],
    );
    if (images.includes(expectedImage)) {
      throw new Error("interruption proof derived image remained");
    }
  }
}

async function runOwnedCommand(command, args, deadline, operationLimit = 10_000) {
  if (deadline - performance.now() <= ownedClientStopReserveMilliseconds) {
    throw new Error("interruption proof owned operation budget refused");
  }
  const child = spawn(command, args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const observedExit = observeChildExit(child);
  const stdout = collectBounded(child.stdout);
  const stderr = collectBounded(child.stderr);
  const operationDeadline = Math.min(
    deadline - ownedClientStopReserveMilliseconds,
    performance.now() + operationLimit,
  );
  let forced = false;
  let terminal = await waitForObservedExitUntil(observedExit, operationDeadline);
  if (terminal.timedOut && childIsRunning(child)) {
    forced = true;
    signalProcessGroup(child, "SIGTERM");
    const grace = Math.min(deadline, performance.now() + 250);
    terminal = await waitForObservedExitUntil(observedExit, grace);
  }
  if (terminal.timedOut && childIsRunning(child)) {
    signalProcessGroup(child, "SIGKILL");
    const kill = Math.min(deadline, performance.now() + 1_000);
    terminal = await waitForObservedExitUntil(observedExit, kill);
  }
  if (
    performance.now() > deadline ||
    terminal.timedOut ||
    terminal.spawnFailed ||
    childIsRunning(child)
  ) {
    throw new Error("interruption proof owned Docker deadline exhausted");
  }
  return Object.freeze({
    error: undefined,
    status: terminal.code,
    signal: terminal.signal,
    stdout: stdout(),
    stderr: stderr(),
    forced,
  });
}

function runOwnedDocker(args, deadline) {
  return runOwnedCommand(realDocker, args, deadline);
}

async function proveOwnedCommandDeadline() {
  const started = performance.now();
  const deadline = started + 2_000;
  const result = await runOwnedCommand(
    process.execPath,
    [
      "--eval",
      "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000)",
    ],
    deadline,
    500,
  );
  const elapsed = performance.now() - started;
  if (
    !result.forced ||
    result.signal !== "SIGKILL" ||
    result.stdout !== "ready\n" ||
    result.stderr !== "" ||
    elapsed < 500 ||
    elapsed > 2_000
  ) {
    throw new Error("interruption proof owned deadline mismatch");
  }
}

async function boundedDockerIds(args, deadline) {
  const result = await runOwnedDocker(args, deadline);
  requireDocker(result);
  return result.stdout.split("\n").filter(Boolean);
}

async function proveCapturedObjectsAbsentBounded(custody, deadline) {
  const containers = await boundedDockerIds(
    ["container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"],
    deadline,
  );
  if (containers.includes(custody.containerId)) {
    throw new Error("interruption proof captured container remained");
  }
  const volumes = await boundedDockerIds(["volume", "ls", "--quiet"], deadline);
  if (custody.record === undefined) {
    if (
      custody.volumesBefore === undefined ||
      JSON.stringify(volumes.sort()) !== JSON.stringify(custody.volumesBefore)
    ) {
      throw new Error("interruption proof volume inventory changed");
    }
  } else {
    for (const mount of custody.record.Mounts ?? []) {
      if (mount.Type !== "volume" || !/^[0-9a-f]{64}$/u.test(mount.Name)) continue;
      if (volumes.includes(mount.Name)) {
        throw new Error("interruption proof anonymous volume remained");
      }
    }
  }
  const expectedImage = expectedDerivedImage(custody);
  if (expectedImage !== undefined) {
    const images = await boundedDockerIds(
      ["image", "ls", "--all", "--no-trunc", "--quiet"],
      deadline,
    );
    if (images.includes(expectedImage)) {
      throw new Error("interruption proof derived image remained");
    }
  }
}

async function attemptDockerCleanup(args, deadline) {
  try {
    await runOwnedDocker(args, deadline);
  } catch {
    // A later exact-state check decides whether another bounded attempt is required.
  }
}

async function recoverCapturedObjects(custody) {
  if (
    !/^[0-9a-f]{64}$/u.test(custody.containerId) ||
    (custody.record !== undefined &&
      custody.record.Id !== custody.containerId) ||
    (custody.record === undefined && !Array.isArray(custody.volumesBefore))
  ) {
    throw new Error("interruption proof recovery identity refused");
  }
  const expectedImage = expectedDerivedImage(custody);
  const deadline = performance.now() + emergencyCleanupTimeoutMilliseconds;
  do {
    await attemptDockerCleanup(
      ["container", "rm", "--force", "--volumes", custody.containerId],
      deadline,
    );
    if (expectedImage !== undefined && performance.now() < deadline) {
      await attemptDockerCleanup(
        ["image", "rm", "--no-prune", expectedImage],
        deadline,
      );
    }
    if (performance.now() >= deadline) break;
    try {
      await proveCapturedObjectsAbsentBounded(custody, deadline);
      if (performance.now() > deadline) {
        throw new Error("interruption proof emergency cleanup deadline exhausted");
      }
      return;
    } catch {
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await delay(Math.min(250, remaining));
    }
  } while (performance.now() < deadline);
  throw new Error("interruption proof emergency cleanup refused");
}

function waitForImageDelete(imageId) {
  const since = String(Math.max(0, Math.floor(Date.now() / 1000) - 1));
  const watcher = spawn(
    realDocker,
    [
      "events",
      "--since",
      since,
      "--filter",
      "type=image",
      "--filter",
      "event=delete",
      "--format",
      "{{.Actor.ID}}",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const observedExit = observeChildExit(watcher);
  const expected = new Set([imageId, imageId.replace(/^sha256:/u, "")]);
  let buffered = "";
  const deleted = new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (error === undefined) resolve();
      else reject(error);
    };
    const timeout = setTimeout(
      () => finish(new Error("interruption proof image-delete timeout")),
      finalCleanupObservationTimeoutMilliseconds,
    );
    watcher.once("error", (error) => {
      finish(new Error("interruption proof image watcher failed", { cause: error }));
    });
    watcher.once("close", () => {
      finish(new Error("interruption proof image watcher closed"));
    });
    watcher.stdout.setEncoding("utf8");
    watcher.stdout.on("data", (chunk) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      if (!lines.some((line) => expected.has(line))) return;
      finish();
    });
  });
  return Object.freeze({ deleted, observedExit, watcher });
}

async function stopEventWatcher(watcher, observedExit) {
  watcher.kill("SIGTERM");
  let terminal = await waitForObservedExit(observedExit, watcherExitTimeoutMilliseconds);
  let forced = false;
  if (terminal.timedOut && childIsRunning(watcher)) {
    forced = true;
    watcher.kill("SIGKILL");
    terminal = await waitForObservedExit(observedExit, forcedKillTimeoutMilliseconds);
  }
  return Object.freeze({ forced, terminal });
}

function volumeInventory() {
  return dockerIds(["volume", "ls", "--quiet"]).sort();
}

async function createWatchdogFixtureContainer() {
  const name = `openspell-wp200-build-${randomUUID()}`;
  const volumesBefore = volumeInventory();
  let containerId;
  let record;
  try {
    const created = rawDocker([
      "container",
      "create",
      "--name",
      name,
      "--network",
      "none",
      "--read-only",
      "--mount",
      "type=volume,destination=/target",
      "--entrypoint",
      "/bin/true",
      image,
    ]);
    containerId = typeof created.stdout === "string" ? created.stdout.trim() : undefined;
    if (!/^[0-9a-f]{64}$/u.test(containerId)) {
      throw new Error("interruption proof watchdog container identity refused");
    }
    record = inspectContainer(containerId);
    requireDocker(created);
    return Object.freeze({ name, record });
  } catch (error) {
    if (/^[0-9a-f]{64}$/u.test(containerId ?? "")) {
      const custody = Object.freeze({ containerId, record, volumesBefore });
      await recoverCapturedObjects(custody);
      proveCapturedObjectsAbsent(custody);
    }
    proveGlobalResidueAbsent();
    throw error;
  }
}

function acquireWatchdogFixtureImage(record) {
  const tag = `${recoveryImageRepository}:${randomUUID()}`;
  const committed = rawDocker(["container", "commit", record.Id, tag]);
  const imageId =
    typeof committed.stdout === "string" ? committed.stdout.trim() : undefined;
  if (!/^sha256:[0-9a-f]{64}$/u.test(imageId ?? "") || imageId === record.Image) {
    throw new Error("interruption proof watchdog image identity refused");
  }
  return Object.freeze({ committed, imageId, tag });
}

async function proveUninspectedResponseRecovery() {
  proveGlobalResidueAbsent();
  const volumesBefore = volumeInventory();
  const name = `openspell-wp200-build-${randomUUID()}`;
  const tag = `${recoveryImageRepository}:${randomUUID()}`;
  let custody;
  let operationFailed = false;
  let proved = false;
  try {
    const created = rawDocker([
      "container",
      "create",
      "--name",
      name,
      "--network",
      "none",
      "--read-only",
      "--mount",
      "type=volume,destination=/target",
      "--entrypoint",
      "/bin/true",
      image,
    ]);
    const containerId =
      typeof created.stdout === "string" ? created.stdout.trim() : undefined;
    if (!/^[0-9a-f]{64}$/u.test(containerId ?? "")) {
      throw new Error("interruption proof uninspected container identity refused");
    }
    custody = Object.freeze({ containerId, volumesBefore });
    requireDocker(created);
    const committed = rawDocker(["container", "commit", containerId, tag]);
    const imageId =
      typeof committed.stdout === "string" ? committed.stdout.trim() : undefined;
    if (!/^sha256:[0-9a-f]{64}$/u.test(imageId ?? "")) {
      throw new Error("interruption proof uninspected image identity refused");
    }
    custody = Object.freeze({ containerId, imageId, volumesBefore });
    requireDocker(committed);
    await recoverCapturedObjects(custody);
    proveCapturedObjectsAbsent(custody);
    proveGlobalResidueAbsent();
    proved = true;
  } catch {
    operationFailed = true;
  } finally {
    if (custody !== undefined) {
      try {
        await recoverCapturedObjects(custody);
      } catch {
        operationFailed = true;
      }
    }
    try {
      proveGlobalResidueAbsent();
    } catch {
      operationFailed = true;
    }
  }
  if (operationFailed || !proved) {
    throw new Error("interruption proof uninspected recovery refused");
  }
}

function requireWatchdogFixtureImage(acquisition) {
  requireDocker(acquisition.committed);
  const inspected = docker(["image", "inspect", acquisition.imageId]);
  requireDocker(inspected);
  let records;
  try {
    records = JSON.parse(inspected.stdout);
  } catch {
    throw new Error("interruption proof watchdog image inspection refused");
  }
  if (
    !Array.isArray(records) ||
    records.length !== 1 ||
    records[0].Id !== acquisition.imageId ||
    !Array.isArray(records[0].RepoTags) ||
    !records[0].RepoTags.includes(acquisition.tag)
  ) {
    throw new Error("interruption proof watchdog image refused");
  }
}

function requireWatchdogFixtureContainer(name, record) {
  const volumes = (record.Mounts ?? []).filter(
    (mount) =>
      mount.Type === "volume" &&
      mount.Destination === "/target" &&
      /^[0-9a-f]{64}$/u.test(mount.Name),
  );
  if (
    record.Name !== `/${name}` ||
    record.State?.Status !== "created" ||
    record.HostConfig?.Privileged !== false ||
    record.HostConfig?.NetworkMode !== "none" ||
    record.HostConfig?.ReadonlyRootfs !== true ||
    volumes.length !== 1
  ) {
    throw new Error("interruption proof watchdog container refused");
  }
}
async function awaitWatchdogFixtureReady(child, output) {
  const deadline = performance.now() + watchdogFixtureReadyTimeoutMilliseconds;
  while (performance.now() < deadline) {
    if (output() === "ready\n") return;
    if (output() !== "" || !childIsRunning(child)) {
      throw new Error("interruption proof watchdog fixture refused");
    }
    await delay(observationDelayMilliseconds);
  }
  throw new Error("interruption proof watchdog fixture unavailable");
}

async function proveWatchdogRecovery() {
  proveGlobalResidueAbsent();
  let record;
  let child;
  let observedExit;
  let terminal;
  let imageId;
  let custody;
  let operationFailed = false;
  let proved = false;
  try {
    const fixture = await createWatchdogFixtureContainer();
    record = fixture.record;
    custody = Object.freeze({ containerId: record.Id, record });
    requireWatchdogFixtureContainer(fixture.name, record);
    const imageAcquisition = acquireWatchdogFixtureImage(record);
    imageId = imageAcquisition.imageId;
    custody = Object.freeze({ containerId: record.Id, imageId, record });
    requireWatchdogFixtureImage(imageAcquisition);
    child = spawn(
      process.execPath,
      [
        "--eval",
        "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000)",
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    observedExit = observeChildExit(child);
    const output = collectBounded(child.stdout);
    await awaitWatchdogFixtureReady(child, output);
    const stopped = await settleChildCustody(
      child,
      observedExit,
      undefined,
      custody,
      watchdogFixtureTimeoutMilliseconds,
      watcherExitTimeoutMilliseconds,
    );
    terminal = stopped.terminal;
    if (
      !stopped.forced ||
      terminal.timedOut ||
      terminal.spawnFailed ||
      terminal.code !== null ||
      terminal.signal !== "SIGKILL"
    ) {
      throw new Error("interruption proof watchdog force refused");
    }
    proveCapturedObjectsAbsent(custody);
    proveGlobalResidueAbsent();
    proved = true;
  } catch {
    operationFailed = true;
  } finally {
    if (child !== undefined && observedExit !== undefined && childIsRunning(child)) {
      try {
        await settleChildCustody(
          child,
          observedExit,
          terminal,
          custody,
          watchdogFixtureTimeoutMilliseconds,
          watcherExitTimeoutMilliseconds,
        );
      } catch {
        operationFailed = true;
      }
    }
    if (custody !== undefined) {
      try {
        await recoverCapturedObjects(custody);
      } catch {
        operationFailed = true;
      }
    }
    try {
      proveGlobalResidueAbsent();
    } catch {
      operationFailed = true;
    }
  }
  if (operationFailed || !proved) {
    throw new Error("interruption proof watchdog recovery refused");
  }
}

async function proveSignal(signal, prefix, responseCutName, observeImage = false) {
  proveGlobalResidueAbsent();
  const volumesBefore = volumeInventory();
  let operationFailed = false;
  let responseCut;
  let child;
  let stdout;
  let stderr;
  let phase;
  let observedExit;
  let record;
  let imageId;
  let responseIdentity;
  let custody;
  let terminal;
  let forbiddenStartObserved = false;
  let primaryTimedOut = false;
  let forcedExitUsed = false;
  try {
    responseCut =
      responseCutName === undefined ? undefined : prepareResponseCut(responseCutName);
    child = spawn(process.execPath, [wrapper], {
      detached: true,
      env: responseCut?.env,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    observedExit = observeChildExit(child);
    stdout = collectBounded(child.stdout);
    stderr = collectBounded(child.stderr);
    phase = collectBounded(child.stdio[3]);
    if (responseCut !== undefined) await awaitResponseHeld(responseCut, child);
    if (responseCut === undefined) {
      throw new Error("interruption proof response identity required");
    }
    responseIdentity = readResponseIdentity(responseCut);
    imageId = responseIdentity.imageId;
    custody = Object.freeze({
      containerId: responseIdentity.containerId,
      imageId,
      volumesBefore,
    });
    record = await observeContainer(
      responseIdentity.containerId,
      prefix,
      responseCut.responseHeld ? "created" : "running",
    );
    custody = Object.freeze({ ...custody, record });
    if (observeImage) {
      if (responseIdentity.imageId === undefined) {
        throw new Error("interruption proof image response identity required");
      }
      await observeCommittedImage(responseIdentity.imageId, record);
    }
    if (!signalProcessGroup(child, signal)) {
      throw new Error("interruption proof signal refused");
    }
    if (responseCut !== undefined) releaseResponse(responseCut);
    terminal = await waitForObservedExit(observedExit);
    primaryTimedOut = terminal.timedOut;
  } catch {
    operationFailed = true;
  } finally {
    if (
      custody === undefined &&
      responseCut !== undefined &&
      existsSync(responseCut.identity)
    ) {
      try {
        responseIdentity = readResponseIdentity(responseCut);
        imageId = responseIdentity.imageId;
        custody = Object.freeze({
          containerId: responseIdentity.containerId,
          imageId,
          volumesBefore,
        });
      } catch {
        operationFailed = true;
      }
    }
    if (responseCut !== undefined) {
      try {
        releaseResponse(responseCut);
      } catch {
        operationFailed = true;
      }
    }
    if (child !== undefined && observedExit !== undefined) {
      try {
        const stopped = await settleChildCustody(
          child,
          observedExit,
          terminal,
          custody,
        );
        forcedExitUsed ||= stopped.forced;
        terminal = stopped.terminal;
      } catch {
        operationFailed = true;
      }
    }
    if (responseCut !== undefined) {
      try {
        forbiddenStartObserved = existsSync(responseCut.startAttempt);
        removeResponseCut(responseCut);
      } catch {
        operationFailed = true;
      }
    }
  }
  if (custody !== undefined) {
    try {
      proveCapturedObjectsAbsent(custody);
    } catch {
      operationFailed = true;
    }
  }
  try {
    proveGlobalResidueAbsent();
  } catch {
    operationFailed = true;
  }
  if (
    operationFailed ||
    terminal === undefined ||
    primaryTimedOut ||
    forcedExitUsed ||
    terminal.timedOut ||
    terminal.spawnFailed ||
    terminal.code === 0 ||
    terminal.signal !== null ||
    forbiddenStartObserved ||
    stdout === undefined ||
    stderr === undefined ||
    stdout() !== "" ||
    stderr() !== "openspell synthetic kernel proof refused\n" ||
    phase === undefined ||
    phase() !== "signal-observed\n"
  ) {
    throw new Error("interruption proof refusal mismatch");
  }
}

async function proveFinalCleanupSignal() {
  proveGlobalResidueAbsent();
  const volumesBefore = volumeInventory();
  let operationFailed = false;
  let responseCut;
  let child;
  let observedExit;
  let stdout;
  let stderr;
  let phase;
  let terminal;
  let primaryTimedOut = false;
  let forcedExitUsed = false;
  let watcher;
  let watcherExit;
  let watcherForcedExit = false;
  let watcherTerminal;
  let record;
  let imageId;
  let responseIdentity;
  let custody;
  try {
    responseCut = prepareResponseCut("final-image-delete");
    child = spawn(process.execPath, [wrapper], {
      detached: true,
      env: responseCut.env,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    observedExit = observeChildExit(child);
    stdout = collectBounded(child.stdout);
    stderr = collectBounded(child.stderr);
    phase = collectBounded(child.stdio[3]);
    await awaitResponseHeld(responseCut, child);
    responseIdentity = readResponseIdentity(responseCut);
    if (responseIdentity.imageId === undefined) {
      throw new Error("interruption proof image response identity required");
    }
    imageId = responseIdentity.imageId;
    custody = Object.freeze({
      containerId: responseIdentity.containerId,
      imageId,
      volumesBefore,
    });
    record = await observeContainer(
      responseIdentity.containerId,
      "openspell-wp200-stage-",
      "created",
    );
    custody = Object.freeze({ ...custody, record });
    await observeCommittedImage(responseIdentity.imageId, record);
    const deletion = waitForImageDelete(imageId);
    watcher = deletion.watcher;
    watcherExit = deletion.observedExit;
    releaseResponse(responseCut);
    await deletion.deleted;
    if (!signalProcessGroup(child, "SIGINT")) {
      throw new Error("interruption proof signal refused");
    }
    terminal = await waitForObservedExit(observedExit);
    primaryTimedOut = terminal.timedOut;
  } catch {
    operationFailed = true;
  } finally {
    if (
      custody === undefined &&
      responseCut !== undefined &&
      existsSync(responseCut.identity)
    ) {
      try {
        responseIdentity = readResponseIdentity(responseCut);
        imageId = responseIdentity.imageId;
        custody = Object.freeze({
          containerId: responseIdentity.containerId,
          imageId,
          volumesBefore,
        });
      } catch {
        operationFailed = true;
      }
    }
    if (responseCut !== undefined) {
      try {
        releaseResponse(responseCut);
      } catch {
        operationFailed = true;
      }
    }
    if (watcher !== undefined && watcherExit !== undefined) {
      try {
        const stoppedWatcher = await stopEventWatcher(watcher, watcherExit);
        watcherForcedExit = stoppedWatcher.forced;
        watcherTerminal = stoppedWatcher.terminal;
      } catch {
        operationFailed = true;
      }
    }
    if (child !== undefined && observedExit !== undefined) {
      try {
        const stopped = await settleChildCustody(
          child,
          observedExit,
          terminal,
          custody,
        );
        forcedExitUsed ||= stopped.forced;
        terminal = stopped.terminal;
      } catch {
        operationFailed = true;
      }
    }
    if (responseCut !== undefined) {
      try {
        removeResponseCut(responseCut);
      } catch {
        operationFailed = true;
      }
    }
  }
  if (custody !== undefined) {
    try {
      proveCapturedObjectsAbsent(custody);
    } catch {
      operationFailed = true;
    }
  }
  try {
    proveGlobalResidueAbsent();
  } catch {
    operationFailed = true;
  }
  if (
    operationFailed ||
    primaryTimedOut ||
    forcedExitUsed ||
    watcherForcedExit ||
    watcherTerminal === undefined ||
    watcherTerminal.timedOut ||
    watcherTerminal.spawnFailed ||
    terminal === undefined ||
    terminal.timedOut ||
    terminal.spawnFailed ||
    terminal.code === 0 ||
    terminal.signal !== null ||
    stdout === undefined ||
    stderr === undefined ||
    stdout() !== "" ||
    stderr() !== "openspell synthetic kernel proof refused\n" ||
    phase === undefined ||
    phase() !== "cases-complete\nsignal-observed\n"
  ) {
    throw new Error("interruption proof final-cleanup refusal mismatch");
  }
}

try {
  if (process.argv.length !== 2 || process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("fixed Linux interruption proof required");
  }
  await proveSignal("SIGINT", "openspell-wp200-build-", "build-create");
  await proveSignal("SIGTERM", "openspell-wp200-stage-", "image-commit", true);
  await proveSignal("SIGINT", "openspell-wp200-case-", "case-inspect");
  await proveSignal("SIGTERM", "openspell-wp200-case-", "case-running");
  await proveFinalCleanupSignal();
  await proveWatchdogRecovery();
  await proveUninspectedResponseRecovery();
  await proveOwnedCommandDeadline();
  process.stdout.write(
    "openspell synthetic kernel proof: interruption-cuts=5 watchdog-recovery=1 uninspected-recovery=1 owned-client-deadline=1 signals=2 residue=0\n",
  );
} catch {
  process.stderr.write("openspell synthetic interruption proof refused\n");
  process.exitCode = 1;
}
