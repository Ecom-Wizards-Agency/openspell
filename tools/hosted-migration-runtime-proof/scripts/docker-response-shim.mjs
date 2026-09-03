import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";

const maximumHeldBytes = 64 * 1024;
const releaseAttempts = 36_000;
const releaseDelayMilliseconds = 5;
const controlTimeoutMilliseconds = 10_000;
const realDocker = process.env["WP200_REAL_DOCKER"];
const cut = process.env["WP200_DOCKER_RESPONSE_CUT"];
const readyFile = process.env["WP200_DOCKER_RESPONSE_READY"];
const releaseFile = process.env["WP200_DOCKER_RESPONSE_RELEASE"];
const startAttemptFile = process.env["WP200_DOCKER_START_ATTEMPT"];
const identityFile = process.env["WP200_DOCKER_RESPONSE_IDENTITY"];
const args = process.argv.slice(2);

const heldCuts = new Set([
  "build-create",
  "image-commit",
  "case-inspect",
  "final-image-delete",
]);

function refusePostCutCaseStart() {
  if (
    cut !== "case-inspect" ||
    readyFile === undefined ||
    !existsSync(readyFile) ||
    args[0] !== "container" ||
    args[1] !== "start" ||
    args[2] !== "--attach" ||
    /^[0-9a-f]{64}$/u.test(args[3] ?? "") === false ||
    args.length !== 4
  ) {
    return;
  }
  if (startAttemptFile === undefined) process.exit(125);
  writeFileSync(startAttemptFile, "attempted\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  process.exit(125);
}

function isCandidateMutation() {
  if (cut === "build-create" || cut === "case-running") {
    const nameAt = args.indexOf("--name");
    return (
      args[0] === "container" &&
      args[1] === "create" &&
      nameAt >= 0 &&
      args[nameAt + 1]?.startsWith(
        cut === "build-create" ? "openspell-wp200-build-" : "openspell-wp200-case-",
      ) === true &&
      (cut !== "case-running" || args.at(-1) === "timeout")
    );
  }
  return (
    ((cut === "image-commit" || cut === "final-image-delete") &&
      args[0] === "container" &&
      args[1] === "commit") ||
    (cut === "case-inspect" && args[0] === "container" && args[1] === "inspect")
  );
}

function heldRunningContainerId() {
  if (
    cut !== "case-running" ||
    readyFile === undefined ||
    !existsSync(readyFile) ||
    identityFile === undefined ||
    args[0] !== "container" ||
    args[1] !== "start" ||
    args[2] !== "--attach" ||
    args.length !== 4
  ) {
    return undefined;
  }
  try {
    const identity = JSON.parse(readFileSync(identityFile, "utf8"));
    return /^[0-9a-f]{64}$/u.test(identity?.containerId ?? "") &&
      args[3] === identity.containerId
      ? identity.containerId
      : undefined;
  } catch {
    return undefined;
  }
}

function isSelectedResponse(stdout) {
  if (cut !== "case-inspect") return true;
  try {
    const records = JSON.parse(Buffer.concat(stdout).toString("utf8"));
    return (
      Array.isArray(records) &&
      records.length === 1 &&
      typeof records[0]?.Name === "string" &&
      records[0].Name.startsWith("/openspell-wp200-case-")
    );
  } catch {
    return false;
  }
}

async function holdSuccessfulResponse() {
  if (releaseFile === undefined) process.exit(125);
  for (let attempt = 0; attempt < releaseAttempts; attempt += 1) {
    if (existsSync(releaseFile)) return;
    await delay(releaseDelayMilliseconds);
  }
  process.exit(125);
}

function selectedIdentity(stdout) {
  if (cut === "build-create") {
    const containerId = Buffer.concat(stdout).toString("utf8").trim();
    return /^[0-9a-f]{64}$/u.test(containerId) ? { containerId } : undefined;
  }
  if (cut === "case-running") {
    const containerId = Buffer.concat(stdout).toString("utf8").trim();
    const commandAt = args.indexOf("--bounding-set=-all,+sys_admin,+setfcap");
    const imageId = args[commandAt - 1];
    return /^[0-9a-f]{64}$/u.test(containerId) &&
      /^sha256:[0-9a-f]{64}$/u.test(imageId ?? "")
      ? { containerId, imageId }
      : undefined;
  }
  if (cut === "image-commit" || cut === "final-image-delete") {
    const containerId = args[2];
    const imageId = Buffer.concat(stdout).toString("utf8").trim();
    return /^[0-9a-f]{64}$/u.test(containerId ?? "") &&
      /^sha256:[0-9a-f]{64}$/u.test(imageId)
      ? { containerId, imageId }
      : undefined;
  }
  try {
    const records = JSON.parse(Buffer.concat(stdout).toString("utf8"));
    return Array.isArray(records) &&
      records.length === 1 &&
      /^[0-9a-f]{64}$/u.test(records[0]?.Id ?? "") &&
      /^sha256:[0-9a-f]{64}$/u.test(records[0]?.Image ?? "")
      ? { containerId: records[0].Id, imageId: records[0].Image }
      : undefined;
  } catch {
    return undefined;
  }
}

async function publishSelectedResponse(stdout) {
  if (identityFile === undefined || readyFile === undefined) process.exit(125);
  const identity = selectedIdentity(stdout);
  if (identity === undefined) process.exit(125);
  writeFileSync(identityFile, `${JSON.stringify(identity)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  writeFileSync(readyFile, "ready\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  if (cut !== undefined && heldCuts.has(cut)) await holdSuccessfulResponse();
}

async function killHeldRunningContainer(containerId) {
  await holdSuccessfulResponse();
  const control = spawn(realDocker, ["container", "kill", containerId], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  const observed = new Promise((resolve) => {
    control.once("error", () => resolve({ status: 125, signal: null }));
    control.once("close", (status, signal) => resolve({ status, signal }));
  });
  const wait = (timeoutMilliseconds) =>
    new Promise((resolve) => {
      let finished = false;
      const finish = (result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        resolve(result);
      };
      const timeout = setTimeout(
        () => finish({ status: null, signal: null, timedOut: true }),
        timeoutMilliseconds,
      );
      void observed.then((result) => finish({ ...result, timedOut: false }));
    });
  let result = await wait(controlTimeoutMilliseconds);
  if (result.timedOut) {
    if (control.pid !== undefined) {
      try {
        process.kill(-control.pid, "SIGKILL");
      } catch {
        // The close result below remains authoritative.
      }
    }
    result = await wait(1_000);
  }
  if (result.timedOut || result.status !== 0 || result.signal !== null) process.exit(125);
}

if (realDocker === undefined || !realDocker.startsWith("/")) process.exit(125);
refusePostCutCaseStart();
const candidate = isCandidateMutation();
const runningContainerId = heldRunningContainerId();
if (
  cut === "case-running" &&
  readyFile !== undefined &&
  existsSync(readyFile) &&
  args[0] === "container" &&
  args[1] === "start" &&
  runningContainerId === undefined
) {
  process.exit(125);
}
const dockerArgs =
  cut === "case-running" && candidate
    ? [...args.slice(0, -1), "external-interruption-hold"]
    : args;
const child = spawn(realDocker, dockerArgs, {
  stdio: ["pipe", "pipe", "pipe"],
});
if (runningContainerId !== undefined) {
  void killHeldRunningContainer(runningContainerId).catch(() => process.exit(125));
}
process.stdin.pipe(child.stdin);
const heldStdout = [];
const heldStderr = [];
let heldBytes = 0;
let overflow = false;
for (const [stream, destination, held] of [
  [child.stdout, process.stdout, heldStdout],
  [child.stderr, process.stderr, heldStderr],
]) {
  if (!candidate) {
    stream.pipe(destination);
    continue;
  }
  stream.on("data", (chunk) => {
    if (!Buffer.isBuffer(chunk) || overflow) return;
    heldBytes += chunk.length;
    if (heldBytes > maximumHeldBytes) {
      overflow = true;
      child.kill("SIGKILL");
      return;
    }
    held.push(chunk);
  });
}
const result = await new Promise((resolve) => {
  child.once("error", () => resolve({ status: 125, signal: null }));
  child.once("close", (status, signal) => resolve({ status, signal }));
});
if (overflow) process.exit(125);
const selected = candidate && isSelectedResponse(heldStdout);
if (selected && result.status === 0 && result.signal === null) {
  await publishSelectedResponse(heldStdout);
}
if (candidate) {
  process.stdout.write(Buffer.concat(heldStdout));
  process.stderr.write(Buffer.concat(heldStderr));
}
if (result.signal !== null) process.kill(process.pid, result.signal);
process.exitCode = result.status ?? 125;
