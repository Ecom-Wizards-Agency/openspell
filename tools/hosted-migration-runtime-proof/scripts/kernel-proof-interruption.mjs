import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";

const wrapper = fileURLToPath(new URL("./kernel-proof.mjs", import.meta.url));
const maximumOutputBytes = 64 * 1024;
const observationAttempts = 36_000;
const observationDelayMilliseconds = 5;
const exitTimeoutMilliseconds = 180_000;

function docker(args) {
  const result = spawnSync("docker", args, {
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
  if (containers.length !== 0 || images.stdout.split("\n").filter(Boolean).length !== 0) {
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

async function observeContainer(prefix) {
  for (let attempt = 0; attempt < observationAttempts; attempt += 1) {
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
          ["created", "running"].includes(status) &&
          targetVolumes.length === 1) ||
        (prefix === "openspell-wp200-stage-" &&
          status === "created" &&
          record.HostConfig?.Privileged === false) ||
        (prefix === "openspell-wp200-case-" &&
          status === "running" &&
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
  for (let attempt = 0; attempt < observationAttempts; attempt += 1) {
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

function collectBounded(stream) {
  let value = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    value += chunk;
    if (value.length > maximumOutputBytes) stream.destroy();
  });
  return () => value;
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("interruption proof exit timeout")),
      exitTimeoutMilliseconds);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error("interruption proof child failed", { cause: error }));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
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
  const expectedImage = imageId ?? record.Image;
  if (
    /^sha256:[0-9a-f]{64}$/u.test(expectedImage) &&
    (imageId !== undefined || record.Name.startsWith("/openspell-wp200-case-"))
  ) {
    const images = dockerIds(["image", "ls", "--all", "--no-trunc", "--quiet"]);
    if (images.includes(expectedImage)) {
      throw new Error("interruption proof derived image remained");
    }
  }
}

function waitForImageDelete(imageId) {
  const since = String(Math.max(0, Math.floor(Date.now() / 1000) - 1));
  const watcher = spawn(
    "docker",
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
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const expected = new Set([imageId, imageId.replace(/^sha256:/u, "")]);
  let buffered = "";
  const deleted = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("interruption proof image-delete timeout")),
      exitTimeoutMilliseconds,
    );
    watcher.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error("interruption proof image watcher failed", { cause: error }));
    });
    watcher.stdout.setEncoding("utf8");
    watcher.stdout.on("data", (chunk) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      if (!lines.some((line) => expected.has(line))) return;
      clearTimeout(timeout);
      resolve();
    });
  });
  return Object.freeze({ deleted, watcher });
}

async function proveSignal(signal, prefix, observeImage = false) {
  proveGlobalResidueAbsent();
  const child = spawn(process.execPath, [wrapper], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = collectBounded(child.stdout);
  const stderr = collectBounded(child.stderr);
  const exit = waitForExit(child);
  let record;
  let imageId;
  let terminal;
  try {
    record = await observeContainer(prefix);
    if (observeImage) imageId = await observeCommittedImage(record);
    process.kill(-child.pid, signal);
    terminal = await exit;
  } finally {
    if (terminal === undefined && child.exitCode === null && child.signalCode === null) {
      process.kill(-child.pid, "SIGTERM");
      terminal = await exit;
    }
  }
  if (
    terminal.code === 0 ||
    terminal.signal !== null ||
    stdout() !== "" ||
    stderr() !== "openspell synthetic kernel proof refused\n"
  ) {
    throw new Error("interruption proof refusal mismatch");
  }
  proveCapturedObjectsAbsent(record, imageId);
  proveGlobalResidueAbsent();
}

async function proveFinalCleanupSignal() {
  proveGlobalResidueAbsent();
  const child = spawn(process.execPath, [wrapper], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = collectBounded(child.stdout);
  const stderr = collectBounded(child.stderr);
  const exit = waitForExit(child);
  let terminal;
  let watcher;
  let record;
  let imageId;
  try {
    record = await observeContainer("openspell-wp200-stage-");
    imageId = await observeCommittedImage(record);
    const deletion = waitForImageDelete(imageId);
    watcher = deletion.watcher;
    await deletion.deleted;
    process.kill(-child.pid, "SIGINT");
    terminal = await exit;
  } finally {
    watcher?.kill("SIGTERM");
    if (terminal === undefined && child.exitCode === null && child.signalCode === null) {
      process.kill(-child.pid, "SIGTERM");
      terminal = await exit;
    }
  }
  if (
    terminal.code === 0 ||
    terminal.signal !== null ||
    stdout() !== "" ||
    stderr() !== "openspell synthetic kernel proof refused\n"
  ) {
    throw new Error("interruption proof final-cleanup refusal mismatch");
  }
  proveCapturedObjectsAbsent(record, imageId);
  proveGlobalResidueAbsent();
}

try {
  if (process.argv.length !== 2 || process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("fixed Linux interruption proof required");
  }
  await proveSignal("SIGINT", "openspell-wp200-build-");
  await proveSignal("SIGTERM", "openspell-wp200-stage-", true);
  await proveSignal("SIGTERM", "openspell-wp200-case-");
  await proveFinalCleanupSignal();
  process.stdout.write(
    "openspell synthetic kernel proof: interruption-cuts=4 signals=2 residue=0\n",
  );
} catch {
  process.stderr.write("openspell synthetic interruption proof refused\n");
  process.exitCode = 1;
}
