import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import process from "node:process";

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

let targetDirectory;
let derivedImageId;
let recoveryImageTag;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: maximumOutputBytes,
    ...options,
  });
  if (result.error !== undefined) throw new Error("kernel proof operation failed");
  return result;
}

function requireSuccessful(result, message) {
  if (result.status !== 0 || result.signal !== null || result.stderr !== "") {
    throw new Error(message);
  }
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

function proveContainerAbsent(name, knownId) {
  let exactId = knownId;
  if (exactId !== undefined && !/^[0-9a-f]{64}$/u.test(exactId)) {
    throw new Error("container cleanup uncertain");
  }
  if (exactId === undefined) {
    const inspection = run("docker", ["container", "inspect", name], {
      timeout: cleanupTimeoutMilliseconds,
    });
    if (inspection.status === 0 && inspection.signal === null && inspection.stderr === "") {
      let records;
      try {
        records = JSON.parse(inspection.stdout);
      } catch {
        throw new Error("container cleanup uncertain");
      }
      if (
        !Array.isArray(records) ||
        records.length !== 1 ||
        !/^[0-9a-f]{64}$/u.test(records[0].Id) ||
        records[0].Name !== `/${name}`
      ) {
        throw new Error("container cleanup uncertain");
      }
      exactId = records[0].Id;
    }
  }
  if (exactId !== undefined) {
    run("docker", ["container", "rm", "--force", "--volumes", exactId], {
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
  if (exactId !== undefined) {
    const ids = run(
      "docker",
      ["container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"],
      { timeout: cleanupTimeoutMilliseconds },
    );
    if (
      ids.status !== 0 ||
      ids.signal !== null ||
      ids.stderr !== "" ||
      ids.stdout.split("\n").includes(exactId)
    ) {
      throw new Error("container cleanup uncertain");
    }
  }
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

function proveImageAbsent(id, tag) {
  let exactId = id;
  if (exactId === undefined && tag !== undefined) {
    const inspection = run("docker", ["image", "inspect", tag], {
      timeout: cleanupTimeoutMilliseconds,
    });
    if (inspection.status === 0 && inspection.signal === null && inspection.stderr === "") {
      let records;
      try {
        records = JSON.parse(inspection.stdout);
      } catch {
        throw new Error("image cleanup uncertain");
      }
      if (
        !Array.isArray(records) ||
        records.length !== 1 ||
        !/^sha256:[0-9a-f]{64}$/u.test(records[0].Id) ||
        !records[0].RepoTags?.includes(tag)
      ) {
        throw new Error("image cleanup uncertain");
      }
      exactId = records[0].Id;
    } else {
      proveTagAbsent(tag);
      return;
    }
  }
  if (exactId !== undefined) {
    run("docker", ["image", "rm", "--force", "--no-prune", exactId], {
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
    (exactId !== undefined && listing.stdout.split("\n").includes(exactId))
  ) {
    throw new Error("image cleanup uncertain");
  }
  if (tag !== undefined) proveTagAbsent(tag);
}

function isInside(parent, candidate) {
  const relation = relative(parent, candidate);
  return relation !== "" && relation !== ".." && !relation.startsWith(`..${sep}`);
}

function hasNoConfiguredMounts(value) {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

function buildExecutable() {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new Error("linux identity required");
  const name = `openspell-wp200-build-${randomUUID()}`;
  let result;
  try {
    result = run(
      "docker",
      [
        "run",
        "--name",
        name,
        "--rm",
        "--read-only",
        "--user",
        `${uid}:${gid}`,
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
        `/cargo:rw,uid=${uid},gid=${gid},mode=0700`,
        "--tmpfs",
        `/usr/local/rustup/tmp:rw,uid=${uid},gid=${gid},mode=0700`,
        "--mount",
        `type=bind,src=${targetDirectory},dst=/target`,
        "--mount",
        `type=bind,src=${packageDirectory},dst=/workspace,readonly`,
        "--workdir",
        "/workspace",
        image,
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
  } finally {
    proveContainerAbsent(name);
  }
  if (result.status !== 0 || result.signal !== null) {
    throw new Error("kernel proof build failed");
  }

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
  if (!insideTarget.startsWith("/target/")) throw new Error("isolated artifact required");
  const executable = realpathSync(join(targetDirectory, insideTarget.slice("/target/".length)));
  const metadata = lstatSync(executable);
  if (
    !isInside(targetDirectory, executable) ||
    !metadata.isFile() ||
    metadata.size <= 0 ||
    metadata.size > maximumExecutableBytes
  ) {
    throw new Error("regular isolated executable required");
  }
  return executable;
}

function sameFile(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.uid === after.uid &&
    before.gid === after.gid &&
    before.size === after.size
  );
}

function readExactArtifact(path) {
  const pathRecord = lstatSync(path);
  if (
    !pathRecord.isFile() ||
    pathRecord.isSymbolicLink() ||
    pathRecord.size <= 0 ||
    pathRecord.size > maximumExecutableBytes
  ) {
    throw new Error("regular isolated executable required");
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC,
  );
  try {
    const openedBefore = fstatSync(descriptor);
    if (!openedBefore.isFile() || !sameFile(pathRecord, openedBefore)) {
      throw new Error("exact executable object required");
    }
    const bytes = Buffer.alloc(openedBefore.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error("exact executable bytes required");
      offset += count;
    }
    if (!sameFile(openedBefore, fstatSync(descriptor))) {
      throw new Error("stable executable object required");
    }
    verifyStaticExecutable(bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (!/^[0-9a-f]{64}$/u.test(digest)) throw new Error("executable digest unavailable");
    return Object.freeze({ bytes, digest });
  } finally {
    closeSync(descriptor);
  }
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

function stageProofImage(artifact) {
  const stageName = `openspell-wp200-stage-${randomUUID()}`;
  let stageId;
  recoveryImageTag = `openspell-wp200-recovery:${randomUUID()}`;
  const base = inspectImage(image);
  if (!/^sha256:[0-9a-f]{64}$/u.test(base.Id)) {
    throw new Error("content addressed base image required");
  }
  proveTagAbsent(recoveryImageTag);
  try {
    const create = run(
      "docker",
      [
        "container",
        "create",
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
        image,
      ],
      { timeout: cleanupTimeoutMilliseconds },
    );
    requireSuccessful(create, "staging container creation failed");
    const stage = inspectContainer(stageName);
    stageId = stage.Id;
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
    const copied = run("docker", ["container", "cp", "-", `${stageName}:/`], {
      input: makeArtifactArchive(artifact.bytes),
      timeout: cleanupTimeoutMilliseconds,
    });
    requireSuccessful(copied, "exact executable staging failed");

    const committed = run("docker", ["container", "commit", stageName, recoveryImageTag], {
      timeout: cleanupTimeoutMilliseconds,
    });
    requireSuccessful(committed, "content addressed image commit failed");
    const reportedId = committed.stdout.trim();
    const derived = inspectImage(recoveryImageTag);
    if (
      !/^sha256:[0-9a-f]{64}$/u.test(reportedId) ||
      derived.Id !== reportedId ||
      derived.RepoTags?.length !== 1 ||
      derived.RepoTags[0] !== recoveryImageTag
    ) {
      throw new Error("exact committed image required");
    }
    verifyImageLineage(base, derived);
    derivedImageId = derived.Id;
    return derivedImageId;
  } finally {
    proveContainerAbsent(stageName, stageId);
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

function runCreatedContainer(name, expected, timeout) {
  const result = run("docker", ["container", "start", "--attach", name], { timeout });
  requireSuccessful(result, "kernel proof container refused");
  if (result.stdout !== expected) throw new Error("kernel proof summary mismatch");
  const terminal = inspectContainer(name);
  if (
    terminal.State?.Status !== "exited" ||
    terminal.State?.ExitCode !== 0 ||
    terminal.State?.OOMKilled !== false ||
    terminal.State?.Dead !== false ||
    terminal.State?.Error !== ""
  ) {
    throw new Error("exact terminal container state required");
  }
}

function verifyImageArtifact(imageId, digest) {
  const name = `openspell-wp200-verify-${randomUUID()}`;
  let containerId;
  try {
    const create = run(
      "docker",
      [
        "container",
        "create",
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
    requireSuccessful(create, "image verification container creation failed");
    const record = inspectContainer(name);
    containerId = record.Id;
    inspectIsolatedContainer(record, imageId, false);
    if (
      record.HostConfig?.PidsLimit !== 8 ||
      record.HostConfig?.Memory !== 64 * 1024 * 1024 ||
      record.HostConfig?.NanoCpus !== 250_000_000 ||
      record.Config?.User !== "65534:65534"
    ) {
      throw new Error("bounded image verification required");
    }
    runCreatedContainer(name, `${digest}  /kernel-proof\n`, caseTimeoutMilliseconds);
  } finally {
    proveContainerAbsent(name, containerId);
  }
}

function runCase(imageId, mode, expected) {
  const name = `openspell-wp200-case-${randomUUID()}`;
  let containerId;
  try {
    const create = run(
      "docker",
      [
        "container",
        "create",
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
    requireSuccessful(create, "kernel proof case creation failed");
    const record = inspectContainer(name);
    containerId = record.Id;
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
    runCreatedContainer(name, `${expected}\n`, caseTimeoutMilliseconds);
  } finally {
    proveContainerAbsent(name, containerId);
  }
}

function removeTargetDirectory(directory) {
  const temporaryRoot = realpathSync("/tmp");
  const resolved = realpathSync(directory);
  const metadata = lstatSync(resolved);
  if (
    resolved !== directory ||
    !isInside(temporaryRoot, resolved) ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !resolved.split(sep).at(-1)?.startsWith("openspell-kernel-build-")
  ) {
    throw new Error("isolated cleanup target required");
  }
  const removal = run("/usr/bin/rm", ["-rf", "--", resolved], {
    timeout: cleanupTimeoutMilliseconds,
  });
  requireSuccessful(removal, "kernel proof build cleanup uncertain");
  try {
    lstatSync(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new Error("kernel proof build cleanup uncertain");
  }
  throw new Error("kernel proof build residue remained");
}

try {
  if (process.argv.length !== 2) throw new Error("kernel proof accepts no arguments");
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("linux x64 proof host required");
  }
  const temporaryRoot = realpathSync("/tmp");
  targetDirectory = mkdtempSync(join(temporaryRoot, "openspell-kernel-build-"));
  const executable = buildExecutable();
  const artifact = readExactArtifact(executable);
  const imageId = stageProofImage(artifact);
  verifyImageArtifact(imageId, artifact.digest);

  removeTargetDirectory(targetDirectory);
  targetDirectory = undefined;

  for (const [mode, expected] of cases) runCase(imageId, mode, expected);
  verifyImageArtifact(imageId, artifact.digest);
  process.stdout.write(
    `openspell synthetic kernel proof: cases=${cases.length} residue=0 sha256=${artifact.digest}\n`,
  );
} catch {
  process.stderr.write("openspell synthetic kernel proof refused\n");
  process.exitCode = 1;
} finally {
  if (derivedImageId !== undefined || recoveryImageTag !== undefined) {
    try {
      proveImageAbsent(derivedImageId, recoveryImageTag);
      derivedImageId = undefined;
      recoveryImageTag = undefined;
    } catch {
      process.stderr.write("openspell synthetic kernel proof cleanup uncertain\n");
      process.exitCode = 1;
    }
  }
  if (targetDirectory !== undefined) {
    try {
      removeTargetDirectory(targetDirectory);
      targetDirectory = undefined;
    } catch {
      process.stderr.write("openspell synthetic kernel proof cleanup uncertain\n");
      process.exitCode = 1;
    }
  }
}
