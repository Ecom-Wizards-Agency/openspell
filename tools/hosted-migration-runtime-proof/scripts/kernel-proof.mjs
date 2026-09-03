import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import { basename } from "node:path";
import process from "node:process";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import { image, packageDirectory } from "./cargo.mjs";

const maximumExecutableBytes = 64 * 1024 * 1024;
const maximumOutputBytes = 16 * 1024 * 1024;
const buildTimeoutMilliseconds = 120_000;
const caseTimeoutMilliseconds = 30_000;
const cleanupTimeoutMilliseconds = 10_000;
const rustToolchain = ["1.97.1", "x86_64", "unknown", "linux", "gnu"].join("-");
const adapterFaultSummary =
  "openspell synthetic kernel proof: adapter-fault recovery=1 residue=0";
const adapterLossSummary =
  "openspell synthetic kernel proof: adapter-loss recovery=1 residue=0";
const tracerDeathSummary =
  "openspell synthetic kernel proof: tracer-death exitkill=1 residue=0";
const recoveryImageRepository = ["openspell", "wp200", "recovery"].join("-");
const cases = Object.freeze([
  ["success", "openspell synthetic kernel proof: success complete=1 residue=0"],
  ["refusal", "openspell synthetic kernel proof: refusal recovery=1 residue=0"],
  ["timeout", "openspell synthetic kernel proof: timeout recovery=1 residue=0"],
  [
    "interruption",
    "openspell synthetic kernel proof: interruption recovery=1 residue=0",
  ],
  [
    "unexpected-event",
    "openspell synthetic kernel proof: unexpected-event recovery=1 residue=0",
  ],
  ["fault-intent", adapterFaultSummary],
  ["fault-namespace", adapterFaultSummary],
  ["fault-cgroup", adapterFaultSummary],
  ["fault-spawn", adapterFaultSummary],
  ["fault-leader-attest", adapterFaultSummary],
  ["fault-bootstrap", adapterFaultSummary],
  ["lost-resume-one", adapterLossSummary],
  ["lost-resume-two", adapterLossSummary],
  ["lost-drain", adapterLossSummary],
  ["lost-empty-cgroup", adapterLossSummary],
  ["lost-terminal-proof", adapterLossSummary],
  ["tracer-death-stopped", tracerDeathSummary],
  ["tracer-death-mixed", tracerDeathSummary],
  ["tracer-death-resumed", tracerDeathSummary],
]);

class CleanupUncertain extends Error {}

let derivedImageId;
let recoveryImageTag;
let unresolvedImageCreation = false;
let cleanupUncertain = false;
let interrupted = false;
let phaseChannelFailed = false;
const phaseFileDescriptor =
  process.env["WP200_KERNEL_PROOF_PHASE_FD"] === "3" ? 3 : undefined;

function publishTestPhase(phase) {
  if (phaseFileDescriptor === undefined) return;
  try {
    writeSync(phaseFileDescriptor, `${phase}\n`);
  } catch {
    phaseChannelFailed = true;
  }
}

const recordInterruption = () => {
  interrupted = true;
  publishTestPhase("signal-observed");
};
process.on("SIGINT", recordInterruption);
process.on("SIGTERM", recordInterruption);

function refuseInterruption() {
  if (interrupted || phaseChannelFailed) throw new Error("kernel proof interrupted");
}

async function interruptionCheckpoint() {
  await yieldToEventLoop();
  refuseInterruption();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    detached: true,
    encoding: "utf8",
    maxBuffer: maximumOutputBytes,
    ...options,
  });
  if (result.error !== undefined) throw new Error("kernel proof operation failed");
  return result;
}

function createContainer(args, options = {}) {
  const result = spawnSync("docker", ["container", "create", "--pull", "never", ...args], {
    detached: true,
    encoding: "utf8",
    maxBuffer: maximumOutputBytes,
    ...options,
  });
  const candidate = result.stdout?.trim();
  const containerId = /^[0-9a-f]{64}$/u.test(candidate) ? candidate : undefined;
  return Object.freeze({ containerId, unresolvedCreation: containerId === undefined, result });
}

function commitImage(containerId, tag) {
  const result = spawnSync("docker", ["container", "commit", containerId, tag], {
    detached: true,
    encoding: "utf8",
    maxBuffer: maximumOutputBytes,
    timeout: cleanupTimeoutMilliseconds,
  });
  const candidate = result.stdout?.trim();
  const imageId = /^sha256:[0-9a-f]{64}$/u.test(candidate) ? candidate : undefined;
  return Object.freeze({ imageId, unresolvedCreation: imageId === undefined, result });
}

function requireSuccessful(result, message) {
  if (result.status !== 0 || result.signal !== null || result.stderr !== "") {
    throw new Error(message);
  }
}

function requireSuccessfulBinary(result, message) {
  if (
    result.status !== 0 ||
    result.signal !== null ||
    !Buffer.isBuffer(result.stdout) ||
    !Buffer.isBuffer(result.stderr) ||
    result.stderr.length !== 0
  ) {
    throw new Error(message);
  }
}

function requireCreatedContainer(created) {
  const { containerId, result } = created;
  if (
    result.error !== undefined ||
    containerId === undefined ||
    result.stdout.trim() !== containerId
  ) {
    throw new Error("exact container id required");
  }
  requireSuccessful(result, "container creation failed");
}

function inspectContainer(name) {
  const result = run("docker", ["container", "inspect", name], {
    timeout: cleanupTimeoutMilliseconds,
  });
  requireSuccessful(result, "container inspection failed");
  let records;
  try {
    records = JSON.parse(result.stdout);
  } catch {
    throw new Error("container inspection failed");
  }
  if (!Array.isArray(records) || records.length !== 1) {
    throw new Error("exact container inspection required");
  }
  return records[0];
}

function proveContainerAbsentUnchecked(
  name,
  knownId,
  knownVolumes = [],
  requireKnownVolume = false,
  unresolvedCreation = false,
) {
  if (knownId !== undefined && !/^[0-9a-f]{64}$/u.test(knownId)) {
    throw new Error("container cleanup uncertain");
  }
  if (knownId !== undefined) {
    run("docker", ["container", "rm", "--force", "--volumes", knownId], {
      timeout: cleanupTimeoutMilliseconds,
    });
  }
  const listing = run(
    "docker",
    [
      "container",
      "ls",
      "--all",
      "--no-trunc",
      "--filter",
      `name=^/${name}$`,
      "--format",
      "{{.Names}}",
    ],
    { timeout: cleanupTimeoutMilliseconds },
  );
  if (
    listing.status !== 0 ||
    listing.signal !== null ||
    listing.stderr !== "" ||
    listing.stdout !== ""
  ) {
    throw new Error("container cleanup uncertain");
  }
  if (knownId !== undefined) {
    const ids = run(
      "docker",
      ["container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"],
      { timeout: cleanupTimeoutMilliseconds },
    );
    if (
      ids.status !== 0 ||
      ids.signal !== null ||
      ids.stderr !== "" ||
      ids.stdout.split("\n").includes(knownId)
    ) {
      throw new Error("container cleanup uncertain");
    }
  }
  for (const volume of knownVolumes) {
    if (!/^[0-9a-f]{64}$/u.test(volume)) throw new Error("volume cleanup uncertain");
    const volumes = run("docker", ["volume", "ls", "--quiet"], {
      timeout: cleanupTimeoutMilliseconds,
    });
    if (
      volumes.status !== 0 ||
      volumes.signal !== null ||
      volumes.stderr !== "" ||
      volumes.stdout.split("\n").includes(volume)
    ) {
      throw new Error("volume cleanup uncertain");
    }
  }
  if (requireKnownVolume && knownVolumes.length !== 1) {
    throw new Error("volume cleanup uncertain");
  }
  if (unresolvedCreation) throw new Error("container cleanup uncertain");
}

function proveContainerAbsent(...args) {
  try {
    proveContainerAbsentUnchecked(...args);
  } catch {
    throw new CleanupUncertain();
  }
}

function captureAnonymousTargetVolume(containerId) {
  const container = inspectContainer(containerId);
  const targets = (container.Mounts ?? []).filter(
    (mount) => mount.Type === "volume" && mount.Destination === "/target",
  );
  if (
    targets.length !== 1 ||
    !/^[0-9a-f]{64}$/u.test(targets[0].Name) ||
    targets[0].RW !== true
  ) {
    throw new Error("exact anonymous target volume required");
  }
  return targets[0].Name;
}

function inspectImage(reference) {
  const result = run("docker", ["image", "inspect", reference], {
    timeout: cleanupTimeoutMilliseconds,
  });
  requireSuccessful(result, "image inspection failed");
  let records;
  try {
    records = JSON.parse(result.stdout);
  } catch {
    throw new Error("image inspection failed");
  }
  if (!Array.isArray(records) || records.length !== 1) {
    throw new Error("exact image inspection required");
  }
  return records[0];
}

function proveTagAbsent(tag) {
  const listing = run(
    "docker",
    [
      "image",
      "ls",
      "--all",
      "--no-trunc",
      "--quiet",
      "--filter",
      `reference=${tag}`,
    ],
    { timeout: cleanupTimeoutMilliseconds },
  );
  if (
    listing.status !== 0 ||
    listing.signal !== null ||
    listing.stderr !== "" ||
    listing.stdout !== ""
  ) {
    throw new Error("image cleanup uncertain");
  }
}

function proveImageAbsentUnchecked(id, tag, unresolvedCreation = false) {
  if (id !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(id)) {
    throw new Error("image cleanup uncertain");
  }
  if (id !== undefined) {
    run("docker", ["image", "rm", "--no-prune", id], {
      timeout: cleanupTimeoutMilliseconds,
    });
  }
  const listing = run("docker", ["image", "ls", "--all", "--no-trunc", "--quiet"], {
    timeout: cleanupTimeoutMilliseconds,
  });
  if (
    listing.status !== 0 ||
    listing.signal !== null ||
    listing.stderr !== "" ||
    (id !== undefined && listing.stdout.split("\n").includes(id))
  ) {
    throw new Error("image cleanup uncertain");
  }
  if (tag !== undefined) proveTagAbsent(tag);
  if (unresolvedCreation) throw new Error("image cleanup uncertain");
}

function proveImageAbsent(...args) {
  try {
    proveImageAbsentUnchecked(...args);
  } catch {
    throw new CleanupUncertain();
  }
}

function hasNoConfiguredMounts(value) {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

async function buildArtifact(baseImageId) {
  const name = `openspell-wp200-build-${randomUUID()}`;
  let containerId;
  let targetVolume;
  let unresolvedCreation = false;
  try {
    const created = createContainer(
      [
        "--name",
        name,
        "--read-only",
        "--env",
        "CARGO_HOME=/cargo",
        "--env",
        "CARGO_TARGET_DIR=/target",
        "--env",
        "TMPDIR=/target",
        "--env",
        `RUSTUP_TOOLCHAIN=${rustToolchain}`,
        "--env",
        "CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS=-C target-feature=+crt-static",
        "--tmpfs",
        "/cargo:rw,mode=0700",
        "--tmpfs",
        "/usr/local/rustup/tmp:rw,mode=0700",
        "--mount",
        "type=volume,destination=/target,volume-nocopy",
        "--mount",
        `type=bind,src=${packageDirectory},dst=/workspace,readonly`,
        "--workdir",
        "/workspace",
        baseImageId,
        "cargo",
        "test",
        "--locked",
        "--target",
        "x86_64-unknown-linux-gnu",
        "--features",
        "kernel-proof",
        "--test",
        "linux-kernel-proof",
        "--no-run",
        "--message-format=json",
      ],
      { timeout: buildTimeoutMilliseconds },
    );
    unresolvedCreation = created.unresolvedCreation;
    containerId = created.containerId;
    if (containerId !== undefined) targetVolume = captureAnonymousTargetVolume(containerId);
    requireCreatedContainer(created);
    await interruptionCheckpoint();
    const result = startCreatedContainer(containerId, buildTimeoutMilliseconds, true);
    await interruptionCheckpoint();

    let records;
    try {
      records = result.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      throw new Error("kernel proof build record refused");
    }
    const artifacts = records.filter(
      (record) =>
        record.reason === "compiler-artifact" &&
        record.target?.name === "linux-kernel-proof" &&
        typeof record.executable === "string",
    );
    if (artifacts.length !== 1) throw new Error("exact kernel executable required");
    const insideTarget = artifacts[0].executable;
    if (
      !insideTarget.startsWith("/target/") ||
      insideTarget.length > 4096 ||
      insideTarget
        .slice("/target/".length)
        .split("/")
        .some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error("isolated artifact required");
    }
    const copied = run(
      "docker",
      ["container", "cp", `${containerId}:${insideTarget}`, "-"],
      {
        encoding: null,
        maxBuffer: maximumExecutableBytes + 2048,
        timeout: cleanupTimeoutMilliseconds,
      },
    );
    requireSuccessfulBinary(copied, "exact executable extraction failed");
    await interruptionCheckpoint();
    const bytes = extractSingleFileArchive(copied.stdout, basename(insideTarget));
    verifyStaticExecutable(bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (!/^[0-9a-f]{64}$/u.test(digest)) {
      throw new Error("executable digest unavailable");
    }
    return Object.freeze({ bytes, digest });
  } finally {
    proveContainerAbsent(
      name,
      containerId,
      targetVolume === undefined ? [] : [targetVolume],
      containerId !== undefined,
      unresolvedCreation,
    );
  }
}

function parseTarOctal(header, offset, length) {
  const field = header.subarray(offset, offset + length).toString("ascii");
  if (!/^[0-7]+(?:\0| )+$/u.test(field)) throw new Error("exact artifact archive required");
  const value = Number.parseInt(field.replace(/[\0 ]+$/u, ""), 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("exact artifact archive required");
  }
  return value;
}

function extractSingleFileArchive(archive, expectedName) {
  if (
    !Buffer.isBuffer(archive) ||
    archive.length < 1536 ||
    archive.length % 512 !== 0 ||
    !/^[A-Za-z0-9._-]+$/u.test(expectedName)
  ) {
    throw new Error("exact artifact archive required");
  }
  const header = archive.subarray(0, 512);
  const nameEnd = header.indexOf(0, 0);
  const name = header.subarray(0, nameEnd < 0 ? 100 : nameEnd).toString("ascii");
  const size = parseTarOctal(header, 124, 12);
  const storedChecksum = parseTarOctal(header, 148, 8);
  const checksumHeader = Buffer.from(header);
  checksumHeader.fill(0x20, 148, 156);
  const actualChecksum = checksumHeader.reduce((sum, value) => sum + value, 0);
  const paddedSize = Math.ceil(size / 512) * 512;
  if (
    name !== expectedName ||
    header[156] !== 0x30 ||
    header.subarray(257, 263).toString("ascii") !== "ustar\0" ||
    size <= 0 ||
    size > maximumExecutableBytes ||
    storedChecksum !== actualChecksum ||
    archive.length !== 512 + paddedSize + 1024 ||
    archive.subarray(512 + size).some((value) => value !== 0)
  ) {
    throw new Error("exact artifact archive required");
  }
  return Buffer.from(archive.subarray(512, 512 + size));
}

function verifyStaticExecutable(bytes) {
  if (
    bytes.length < 64 ||
    bytes[0] !== 0x7f ||
    bytes.subarray(1, 4).toString("ascii") !== "ELF" ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes.readUInt16LE(16) !== 3 ||
    bytes.readUInt16LE(18) !== 62
  ) {
    throw new Error("fixed static PIE ELF64 x86-64 executable required");
  }
  const programOffset = Number(bytes.readBigUInt64LE(32));
  const programEntryBytes = bytes.readUInt16LE(54);
  const programCount = bytes.readUInt16LE(56);
  if (
    !Number.isSafeInteger(programOffset) ||
    programEntryBytes !== 56 ||
    programCount === 0 ||
    programCount > 128 ||
    programOffset + programEntryBytes * programCount > bytes.length
  ) {
    throw new Error("bounded ELF program headers required");
  }
  let loadCount = 0;
  for (let index = 0; index < programCount; index += 1) {
    const type = bytes.readUInt32LE(programOffset + index * programEntryBytes);
    if (type === 3) throw new Error("static executable required");
    if (type === 1) loadCount += 1;
  }
  if (loadCount === 0) throw new Error("loadable executable required");
}

function writeTarText(header, offset, length, value) {
  const bytes = Buffer.from(value, "ascii");
  if (bytes.length > length) throw new Error("bounded staging record required");
  bytes.copy(header, offset);
}

function writeTarOctal(header, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length !== length - 1) throw new Error("bounded staging record required");
  writeTarText(header, offset, length, `${encoded}\0`);
}

function makeArtifactArchive(bytes) {
  const header = Buffer.alloc(512);
  writeTarText(header, 0, 100, "kernel-proof");
  writeTarOctal(header, 100, 8, 0o555);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, bytes.length);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  writeTarText(header, 257, 6, "ustar\0");
  writeTarText(header, 263, 2, "00");
  const checksum = header.reduce((sum, value) => sum + value, 0);
  writeTarText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512);
  return Buffer.concat([header, bytes, padding, Buffer.alloc(1024)]);
}

function verifyImageLineage(base, derived) {
  const baseLayers = base.RootFS?.Layers;
  const derivedLayers = derived.RootFS?.Layers;
  if (
    base.Id === derived.Id ||
    !Array.isArray(baseLayers) ||
    !Array.isArray(derivedLayers) ||
    derivedLayers.length !== baseLayers.length + 1 ||
    !baseLayers.every((layer, index) => derivedLayers[index] === layer) ||
    !hasNoConfiguredMounts(derived.Config?.Volumes)
  ) {
    throw new Error("exact derived image required");
  }
}

async function stageProofImage(artifact, base) {
  const operationId = randomUUID();
  const stageName = `openspell-wp200-stage-${operationId}`;
  let stageId;
  let unresolvedCreation = false;
  recoveryImageTag = `${recoveryImageRepository}:${operationId}`;
  if (!/^sha256:[0-9a-f]{64}$/u.test(base.Id)) {
    throw new Error("content addressed base image required");
  }
  proveTagAbsent(recoveryImageTag);
  try {
    const create = createContainer(
      [
        "--name",
        stageName,
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--entrypoint",
        "/usr/bin/false",
        base.Id,
      ],
      { timeout: cleanupTimeoutMilliseconds },
    );
    unresolvedCreation = create.unresolvedCreation;
    stageId = create.containerId;
    requireCreatedContainer(create);
    await interruptionCheckpoint();
    const stage = inspectContainer(stageId);
    if (
      stage.Image !== base.Id ||
      stage.State?.Status !== "created" ||
      stage.HostConfig?.NetworkMode !== "none" ||
      stage.HostConfig?.ReadonlyRootfs !== false ||
      stage.HostConfig?.Privileged !== false ||
      stage.HostConfig?.Binds !== null ||
      !hasNoConfiguredMounts(stage.HostConfig?.Mounts) ||
      !Array.isArray(stage.Mounts) ||
      stage.Mounts.length !== 0
    ) {
      throw new Error("isolated staging container required");
    }
    const copied = run("docker", ["container", "cp", "-", `${stageId}:/`], {
      input: makeArtifactArchive(artifact.bytes),
      timeout: cleanupTimeoutMilliseconds,
    });
    requireSuccessful(copied, "exact executable staging failed");
    await interruptionCheckpoint();

    const committed = commitImage(stageId, recoveryImageTag);
    unresolvedImageCreation = committed.unresolvedCreation;
    derivedImageId = committed.imageId;
    requireSuccessful(committed.result, "content addressed image commit failed");
    if (derivedImageId === undefined) throw new Error("exact committed image required");
    await interruptionCheckpoint();
    const derived = inspectImage(derivedImageId);
    if (
      derived.Id !== derivedImageId ||
      derived.RepoTags?.length !== 1 ||
      derived.RepoTags[0] !== recoveryImageTag
    ) {
      throw new Error("exact committed image required");
    }
    verifyImageLineage(base, derived);
    return derivedImageId;
  } finally {
    proveContainerAbsent(stageName, stageId, [], false, unresolvedCreation);
  }
}

function inspectIsolatedContainer(record, imageId, privileged) {
  const host = record.HostConfig;
  if (
    record.Image !== imageId ||
    record.Config?.Image !== imageId ||
    record.State?.Status !== "created" ||
    !hasNoConfiguredMounts(record.Config?.Volumes) ||
    host?.NetworkMode !== "none" ||
    host?.ReadonlyRootfs !== true ||
    host?.Privileged !== privileged ||
    host?.Binds !== null ||
    !hasNoConfiguredMounts(host?.Mounts) ||
    !Array.isArray(record.Mounts) ||
    record.Mounts.length !== 0
  ) {
    throw new Error("isolated proof container required");
  }
}

function startCreatedContainer(containerId, timeout, allowStderr = false) {
  const result = run("docker", ["container", "start", "--attach", containerId], { timeout });
  if (
    result.status !== 0 ||
    result.signal !== null ||
    (!allowStderr && result.stderr !== "")
  ) {
    throw new Error("kernel proof container refused");
  }
  const terminal = inspectContainer(containerId);
  if (
    terminal.State?.Status !== "exited" ||
    terminal.State?.ExitCode !== 0 ||
    terminal.State?.OOMKilled !== false ||
    terminal.State?.Dead !== false ||
    terminal.State?.Error !== ""
  ) {
    throw new Error("exact terminal container state required");
  }
  return result;
}

function runCreatedContainer(containerId, expected, timeout) {
  const result = startCreatedContainer(containerId, timeout);
  if (result.stdout !== expected) throw new Error("kernel proof summary mismatch");
}

async function verifyImageArtifact(imageId, digest) {
  const name = `openspell-wp200-verify-${randomUUID()}`;
  let containerId;
  let unresolvedCreation = false;
  try {
    const create = createContainer(
      [
        "--name",
        name,
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "8",
        "--memory",
        "64m",
        "--cpus",
        "0.25",
        "--user",
        "65534:65534",
        "--entrypoint",
        "/usr/bin/sha256sum",
        imageId,
        "/kernel-proof",
      ],
      { timeout: cleanupTimeoutMilliseconds },
    );
    unresolvedCreation = create.unresolvedCreation;
    containerId = create.containerId;
    requireCreatedContainer(create);
    await interruptionCheckpoint();
    const record = inspectContainer(containerId);
    inspectIsolatedContainer(record, imageId, false);
    if (
      record.HostConfig?.PidsLimit !== 8 ||
      record.HostConfig?.Memory !== 64 * 1024 * 1024 ||
      record.HostConfig?.NanoCpus !== 250_000_000 ||
      record.Config?.User !== "65534:65534"
    ) {
      throw new Error("bounded image verification required");
    }
    await interruptionCheckpoint();
    runCreatedContainer(containerId, `${digest}  /kernel-proof\n`, caseTimeoutMilliseconds);
  } finally {
    proveContainerAbsent(name, containerId, [], false, unresolvedCreation);
  }
}

async function runCase(imageId, mode, expected) {
  const name = `openspell-wp200-case-${randomUUID()}`;
  let containerId;
  let unresolvedCreation = false;
  try {
    const create = createContainer(
      [
        "--name",
        name,
        "--privileged",
        "--network",
        "none",
        "--read-only",
        "--cgroupns",
        "private",
        "--pids-limit",
        "32",
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,mode=0700",
        "--workdir",
        "/tmp",
        "--entrypoint",
        "/usr/bin/setpriv",
        imageId,
        "--bounding-set=-all,+sys_admin,+setfcap",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--no-new-privs",
        "/kernel-proof",
        mode,
      ],
      { timeout: cleanupTimeoutMilliseconds },
    );
    unresolvedCreation = create.unresolvedCreation;
    containerId = create.containerId;
    requireCreatedContainer(create);
    await interruptionCheckpoint();
    const record = inspectContainer(containerId);
    inspectIsolatedContainer(record, imageId, true);
    if (
      record.HostConfig?.CgroupnsMode !== "private" ||
      record.HostConfig?.PidsLimit !== 32 ||
      record.HostConfig?.Memory !== 512 * 1024 * 1024 ||
      record.HostConfig?.NanoCpus !== 1_000_000_000 ||
      record.HostConfig?.Tmpfs?.["/tmp"] !== "rw,nosuid,nodev,noexec,mode=0700"
    ) {
      throw new Error("bounded privileged proof container required");
    }
    await interruptionCheckpoint();
    runCreatedContainer(containerId, `${expected}\n`, caseTimeoutMilliseconds);
  } finally {
    proveContainerAbsent(name, containerId, [], false, unresolvedCreation);
  }
}

let successSummary;
try {
  if (process.argv.length !== 2) throw new Error("kernel proof accepts no arguments");
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("linux x64 proof host required");
  }
  const base = inspectImage(image);
  if (!/^sha256:[0-9a-f]{64}$/u.test(base.Id)) {
    throw new Error("content addressed base image required");
  }
  const artifact = await buildArtifact(base.Id);
  await interruptionCheckpoint();
  const imageId = await stageProofImage(artifact, base);
  await interruptionCheckpoint();
  await verifyImageArtifact(imageId, artifact.digest);
  await interruptionCheckpoint();

  for (const [mode, expected] of cases) {
    await runCase(imageId, mode, expected);
    await interruptionCheckpoint();
  }
  await verifyImageArtifact(imageId, artifact.digest);
  await interruptionCheckpoint();
  successSummary =
    `openspell synthetic kernel proof: cases=${cases.length} residue=0 ` +
    `sha256=${artifact.digest}\n`;
  publishTestPhase("cases-complete");
  if (phaseChannelFailed) throw new Error("kernel proof phase channel failed");
} catch (error) {
  if (error instanceof CleanupUncertain) cleanupUncertain = true;
  process.stderr.write("openspell synthetic kernel proof refused\n");
  process.exitCode = 1;
} finally {
  if (derivedImageId !== undefined || recoveryImageTag !== undefined) {
    try {
      proveImageAbsent(derivedImageId, recoveryImageTag, unresolvedImageCreation);
      derivedImageId = undefined;
      recoveryImageTag = undefined;
      unresolvedImageCreation = false;
    } catch {
      cleanupUncertain = true;
      process.exitCode = 1;
    }
  }
}
try {
  await interruptionCheckpoint();
} catch {
  if (process.exitCode !== 1) {
    process.stderr.write("openspell synthetic kernel proof refused\n");
  }
  process.exitCode = 1;
}
process.off("SIGINT", recordInterruption);
process.off("SIGTERM", recordInterruption);
if (cleanupUncertain) {
  process.stderr.write("openspell synthetic kernel proof cleanup uncertain\n");
}
if (process.exitCode !== 1 && successSummary !== undefined) {
  process.stdout.write(successSummary);
}
