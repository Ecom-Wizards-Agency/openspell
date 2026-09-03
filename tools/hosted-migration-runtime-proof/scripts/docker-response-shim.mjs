import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const maximumHeldBytes = 64 * 1024;
const releaseAttempts = 36_000;
const releaseDelayMilliseconds = 5;
const realDocker = process.env["WP200_REAL_DOCKER"];
const cut = process.env["WP200_DOCKER_RESPONSE_CUT"];
const readyFile = process.env["WP200_DOCKER_RESPONSE_READY"];
const releaseFile = process.env["WP200_DOCKER_RESPONSE_RELEASE"];
const args = process.argv.slice(2);

function isCandidateMutation() {
  if (cut === "build-create") {
    const nameAt = args.indexOf("--name");
    return (
      args[0] === "container" &&
      args[1] === "create" &&
      nameAt >= 0 &&
      args[nameAt + 1]?.startsWith("openspell-wp200-build-") === true
    );
  }
  return (
    (cut === "image-commit" && args[0] === "container" && args[1] === "commit") ||
    (cut === "case-inspect" && args[0] === "container" && args[1] === "inspect")
  );
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
  if (readyFile === undefined || releaseFile === undefined) process.exit(125);
  writeFileSync(readyFile, "ready\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  for (let attempt = 0; attempt < releaseAttempts; attempt += 1) {
    if (existsSync(releaseFile)) return;
    await delay(releaseDelayMilliseconds);
  }
  process.exit(125);
}

if (realDocker === undefined || !realDocker.startsWith("/")) process.exit(125);
const candidate = isCandidateMutation();
const child = spawn(realDocker, args, {
  stdio: ["pipe", "pipe", "pipe"],
});
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
  await holdSuccessfulResponse();
}
if (candidate) {
  process.stdout.write(Buffer.concat(heldStdout));
  process.stderr.write(Buffer.concat(heldStderr));
}
if (result.signal !== null) process.kill(process.pid, result.signal);
process.exitCode = result.status ?? 125;
