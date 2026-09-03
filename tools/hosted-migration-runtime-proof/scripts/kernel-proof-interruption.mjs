import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";

const wrapper = fileURLToPath(new URL("./kernel-proof.mjs", import.meta.url));
const dockerResponseShim = fileURLToPath(
  new URL("./docker-response-shim.mjs", import.meta.url),
);
const maximumOutputBytes = 64 * 1024;
const setupObservationAttempts = 120_000;
const observationDelayMilliseconds = 5;
const exitTimeoutMilliseconds = 180_000;
const forcedExitTimeoutMilliseconds = 180_000;
const forcedKillTimeoutMilliseconds = 30_000;
const emergencyCleanupTimeoutMilliseconds = 120_000;
const finalCleanupObservationTimeoutMilliseconds = 30 * 60_000;
const watcherExitTimeoutMilliseconds = 10_000;

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

function docker(args) {
  const result = spawnSync(realDocker, args, {
    encoding: "utf8",
    maxBuffer: maximumOutputBytes,
    timeout: 10_000,
  });
  if (result.error !== undefined) throw new Error("interruption proof Docker operation failed");
  return result;
}

function requireDocker(result) {
  if (result.status !== 0 || result.signal !== null || result.stderr !== "") {
    throw new Error("interruption proof Docker operation refused");
  }
}

function listExact(filter, format) {
  const result = docker([
    "container",
    "ls",
    "--all",
    "--no-trunc",
    "--filter",
    filter,
    "--format",
    format,
  ]);
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

function inspectContainer(id) {
  const inspection = docker(["container", "inspect", id]);
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

async function observeContainer(prefix, requiredStatus) {
  for (let attempt = 0; attempt < setupObservationAttempts; attempt += 1) {
    const ids = listExact(`name=^/${prefix}`, "{{.ID}}");
    if (ids.length === 1 && /^[0-9a-f]{64}$/u.test(ids[0])) {
      let record;
      try {
        record = inspectContainer(ids[0]);
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
        (prefix === "openspell-wp200-build-" &&
          status === requiredStatus &&
          targetVolumes.length === 1) ||
        (prefix === "openspell-wp200-stage-" &&
          status === requiredStatus &&
          record.HostConfig?.Privileged === false) ||
        (prefix === "openspell-wp200-case-" &&
          status === requiredStatus &&
          record.HostConfig?.Privileged === true);
      if (exactPhase) return record;
    }
    if (ids.length > 1) throw new Error("interruption proof container ambiguity");
    await delay(observationDelayMilliseconds);
  }
  throw new Error("interruption proof checkpoint unavailable");
}

function dockerIds(args) {
  const result = docker(args);
  requireDocker(result);
  return result.stdout.split("\n").filter(Boolean);
}

async function observeCommittedImage(record) {
  const match = /^\/openspell-wp200-stage-([0-9a-f-]{36})$/u.exec(record.Name);
  if (match === null) throw new Error("interruption proof stage identity refused");
  const tag = `openspell-wp200-recovery:${match[1]}`;
  for (let attempt = 0; attempt < setupObservationAttempts; attempt += 1) {
    const result = docker([
      "image",
      "ls",
      "--all",
      "--no-trunc",
      "--quiet",
      "--filter",
      `reference=${tag}`,
    ]);
    requireDocker(result);
    const ids = result.stdout.split("\n").filter(Boolean);
    if (ids.length === 1 && /^sha256:[0-9a-f]{64}$/u.test(ids[0])) return ids[0];
    if (ids.length > 1) throw new Error("interruption proof image ambiguity");
    await delay(observationDelayMilliseconds);
  }
  throw new Error("interruption proof image checkpoint unavailable");
}

function prepareResponseCut(cut) {
  if (cut !== "build-create" && cut !== "image-commit" && cut !== "case-inspect") {
    throw new Error("interruption proof response cut refused");
  }
  const directory = mkdtempSync(join(tmpdir(), "openspell-wp200-docker-cut-"));
  const launcher = join(directory, "docker");
  const ready = join(directory, "ready");
  const release = join(directory, "release");
  const startAttempt = join(directory, "start-attempt");
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
      },
    });
  } catch (error) {
    rmSync(directory, { force: true, recursive: true });
    throw error;
  }
}

async function awaitResponseHeld(cut, child) {
  for (let attempt = 0; attempt < setupObservationAttempts; attempt += 1) {
    if (existsSync(cut.ready) && !existsSync(cut.release)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("interruption proof response holder exited");
    }
    await delay(observationDelayMilliseconds);
  }
  throw new Error("interruption proof held response unavailable");
}

function releaseResponse(cut) {
  if (!existsSync(cut.release)) {
    writeFileSync(cut.release, "release\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }
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

async function ensureChildExit(child, observedExit, terminal) {
  if (terminal !== undefined && !terminal.timedOut) return terminal;
  if (!childIsRunning(child)) {
    return waitForObservedExit(observedExit, forcedExitTimeoutMilliseconds);
  }
  signalProcessGroup(child, "SIGTERM");
  let stopped = await waitForObservedExit(observedExit, forcedExitTimeoutMilliseconds);
  if (!stopped.timedOut || !childIsRunning(child)) return stopped;
  signalProcessGroup(child, "SIGKILL");
  stopped = await waitForObservedExit(observedExit, forcedKillTimeoutMilliseconds);
  return stopped;
}

function proveCapturedObjectsAbsent(record, imageId) {
  const containers = dockerIds([
    "container",
    "ls",
    "--all",
    "--no-trunc",
    "--format",
    "{{.ID}}",
  ]);
  if (containers.includes(record.Id)) {
    throw new Error("interruption proof captured container remained");
  }
  const volumes = dockerIds(["volume", "ls", "--quiet"]);
  for (const mount of record.Mounts ?? []) {
    if (mount.Type !== "volume" || !/^[0-9a-f]{64}$/u.test(mount.Name)) continue;
    if (volumes.includes(mount.Name)) {
      throw new Error("interruption proof anonymous volume remained");
    }
  }
  const expectedImage = capturedDerivedImage(record, imageId);
  if (expectedImage !== undefined) {
    const images = dockerIds(["image", "ls", "--all", "--no-trunc", "--quiet"]);
    if (images.includes(expectedImage)) {
      throw new Error("interruption proof derived image remained");
    }
  }
}

function capturedDerivedImage(record, imageId) {
  const expectedImage = imageId ?? record.Image;
  return /^sha256:[0-9a-f]{64}$/u.test(expectedImage) &&
    (imageId !== undefined || record.Name.startsWith("/openspell-wp200-case-"))
    ? expectedImage
    : undefined;
}

function attemptDockerCleanup(args) {
  try {
    docker(args);
  } catch {
    // A later exact-state check decides whether another bounded attempt is required.
  }
}

async function recoverCapturedObjects(record, imageId) {
  if (
    !/^[0-9a-f]{64}$/u.test(record.Id) ||
    !/^\/openspell-wp200-(?:build|stage|case)-/u.test(record.Name)
  ) {
    throw new Error("interruption proof recovery identity refused");
  }
  const volumeNames = (record.Mounts ?? [])
    .filter(
      (mount) => mount.Type === "volume" && /^[0-9a-f]{64}$/u.test(mount.Name),
    )
    .map((mount) => mount.Name);
  const expectedImage = capturedDerivedImage(record, imageId);
  const deadline = Date.now() + emergencyCleanupTimeoutMilliseconds;
  do {
    attemptDockerCleanup(["container", "rm", "--force", "--volumes", record.Id]);
    for (const volumeName of volumeNames) {
      attemptDockerCleanup(["volume", "rm", volumeName]);
    }
    if (expectedImage !== undefined) {
      attemptDockerCleanup(["image", "rm", "--no-prune", expectedImage]);
    }
    try {
      proveCapturedObjectsAbsent(record, imageId);
      return;
    } catch {
      await delay(250);
    }
  } while (Date.now() < deadline);
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

async function proveSignal(signal, prefix, responseCutName, observeImage = false) {
  proveGlobalResidueAbsent();
  let responseCut;
  let child;
  let stdout;
  let stderr;
  let observedExit;
  let record;
  let imageId;
  let terminal;
  let forbiddenStartObserved = false;
  let primaryTimedOut;
  let forcedExitUsed = false;
  try {
    responseCut =
      responseCutName === undefined ? undefined : prepareResponseCut(responseCutName);
    child = spawn(process.execPath, [wrapper], {
      detached: true,
      env: responseCut?.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    observedExit = observeChildExit(child);
    stdout = collectBounded(child.stdout);
    stderr = collectBounded(child.stderr);
    if (responseCut !== undefined) await awaitResponseHeld(responseCut, child);
    record = await observeContainer(prefix, responseCut === undefined ? "running" : "created");
    if (observeImage) imageId = await observeCommittedImage(record);
    if (!signalProcessGroup(child, signal)) {
      throw new Error("interruption proof signal refused");
    }
    if (responseCut !== undefined) releaseResponse(responseCut);
    terminal = await waitForObservedExit(observedExit);
    primaryTimedOut = terminal.timedOut;
  } finally {
    try {
      if (responseCut !== undefined) releaseResponse(responseCut);
      if (child !== undefined && observedExit !== undefined) {
        forcedExitUsed = terminal?.timedOut === true;
        terminal = await ensureChildExit(child, observedExit, terminal);
      }
    } finally {
      if (responseCut !== undefined) {
        forbiddenStartObserved = existsSync(responseCut.startAttempt);
        removeResponseCut(responseCut);
      }
    }
  }
  if (forcedExitUsed && record !== undefined) {
    await recoverCapturedObjects(record, imageId);
  }
  proveCapturedObjectsAbsent(record, imageId);
  proveGlobalResidueAbsent();
  if (
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
    stderr() !== "openspell synthetic kernel proof refused\n"
  ) {
    throw new Error("interruption proof refusal mismatch");
  }
}

async function proveFinalCleanupSignal() {
  proveGlobalResidueAbsent();
  const child = spawn(process.execPath, [wrapper], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const observedExit = observeChildExit(child);
  const stdout = collectBounded(child.stdout);
  const stderr = collectBounded(child.stderr);
  let terminal;
  let primaryTimedOut;
  let forcedExitUsed;
  let watcher;
  let watcherExit;
  let watcherForcedExit = false;
  let watcherTerminal;
  let record;
  let imageId;
  try {
    record = await observeContainer("openspell-wp200-stage-", "created");
    imageId = await observeCommittedImage(record);
    const deletion = waitForImageDelete(imageId);
    watcher = deletion.watcher;
    watcherExit = deletion.observedExit;
    await deletion.deleted;
    if (!signalProcessGroup(child, "SIGINT")) {
      throw new Error("interruption proof signal refused");
    }
    terminal = await waitForObservedExit(observedExit);
    primaryTimedOut = terminal.timedOut;
  } finally {
    if (watcher !== undefined && watcherExit !== undefined) {
      const stoppedWatcher = await stopEventWatcher(watcher, watcherExit);
      watcherForcedExit = stoppedWatcher.forced;
      watcherTerminal = stoppedWatcher.terminal;
    }
    forcedExitUsed = terminal?.timedOut === true;
    terminal = await ensureChildExit(child, observedExit, terminal);
  }
  if (forcedExitUsed) await recoverCapturedObjects(record, imageId);
  proveCapturedObjectsAbsent(record, imageId);
  proveGlobalResidueAbsent();
  if (
    primaryTimedOut ||
    forcedExitUsed ||
    watcherForcedExit ||
    watcherTerminal === undefined ||
    watcherTerminal.timedOut ||
    watcherTerminal.spawnFailed ||
    terminal.timedOut ||
    terminal.spawnFailed ||
    terminal.code === 0 ||
    terminal.signal !== null ||
    stdout() !== "" ||
    stderr() !== "openspell synthetic kernel proof refused\n"
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
  await proveSignal("SIGTERM", "openspell-wp200-case-");
  await proveFinalCleanupSignal();
  process.stdout.write(
    "openspell synthetic kernel proof: interruption-cuts=5 signals=2 residue=0\n",
  );
} catch {
  process.stderr.write("openspell synthetic interruption proof refused\n");
  process.exitCode = 1;
}
