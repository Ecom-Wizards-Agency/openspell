import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import process from "node:process";

import { image, packageDirectory } from "./cargo.mjs";

const maximumExecutableBytes = 64 * 1024 * 1024;
const buildTimeoutMilliseconds = 120_000;
const caseTimeoutMilliseconds = 30_000;
const cleanupTimeoutMilliseconds = 10_000;
const rustToolchain = ["1.97.1", "x86_64", "unknown", "linux", "gnu"].join("-");
const adapterFaultSummary =
  "openspell synthetic kernel proof: adapter-fault recovery=1 residue=0";
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
  ["fault-custody", adapterFaultSummary],
  ["fault-exec", adapterFaultSummary],
  ["fault-protection", adapterFaultSummary],
  ["tracer-death", "openspell synthetic kernel proof: tracer-death exitkill=1 residue=0"],
]);
let targetDirectory;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error !== undefined) throw new Error("kernel proof operation failed");
  return result;
}

function proveContainerAbsent(name) {
  run("docker", ["container", "rm", "--force", name], {
    timeout: cleanupTimeoutMilliseconds,
  });
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
}

function isInside(parent, candidate) {
  const relation = relative(parent, candidate);
  return relation !== "" && relation !== ".." && !relation.startsWith(`..${sep}`);
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
  if (result.status !== 0) throw new Error("kernel proof build failed");

  const artifacts = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter(
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
  verifyStaticExecutable(readFileSync(executable));
  return executable;
}

function verifyStaticExecutable(bytes) {
  if (
    bytes.length < 64 ||
    bytes[0] !== 0x7f ||
    bytes.subarray(1, 4).toString("ascii") !== "ELF" ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes.readUInt16LE(18) !== 62
  ) {
    throw new Error("fixed ELF64 x86-64 executable required");
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

function digestExecutable(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function runCase(executable, mode, expected) {
  const name = `openspell-wp200-${randomUUID()}`;
  try {
    const result = run(
      "docker",
      [
        "run",
        "--name",
        name,
        "--rm",
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
        "--mount",
        `type=bind,src=${executable},dst=/kernel-proof,readonly`,
        "--workdir",
        "/tmp",
        "--entrypoint",
        "/usr/bin/setpriv",
        image,
        "--bounding-set=-all,+sys_admin,+setfcap",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--no-new-privs",
        "/kernel-proof",
        mode,
      ],
      { timeout: caseTimeoutMilliseconds },
    );
    if (result.status !== 0 || result.signal !== null || result.stderr !== "") {
      throw new Error("kernel proof case refused");
    }
    if (result.stdout.trim() !== expected) throw new Error("kernel proof summary mismatch");
  } finally {
    proveContainerAbsent(name);
  }
}

function removeTargetDirectory() {
  const temporaryRoot = realpathSync("/tmp");
  const resolved = realpathSync(targetDirectory);
  const metadata = lstatSync(resolved);
  if (
    resolved !== targetDirectory ||
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
  if (removal.status !== 0 || removal.signal !== null || removal.stderr !== "") {
    throw new Error("kernel proof build cleanup uncertain");
  }
  try {
    lstatSync(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
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
  const executableDigest = digestExecutable(executable);
  if (!/^[0-9a-f]{64}$/u.test(executableDigest)) throw new Error("executable digest unavailable");
  for (const [mode, expected] of cases) await runCase(executable, mode, expected);
  if (digestExecutable(executable) !== executableDigest) {
    throw new Error("kernel executable changed");
  }
  process.stdout.write(
    `openspell synthetic kernel proof: cases=${cases.length} residue=0 sha256=${executableDigest}\n`,
  );
} catch {
  process.stderr.write("openspell synthetic kernel proof refused\n");
  process.exitCode = 1;
} finally {
  if (targetDirectory !== undefined) {
    try {
      removeTargetDirectory();
    } catch {
      process.stderr.write("openspell synthetic kernel proof cleanup uncertain\n");
      process.exitCode = 1;
    }
  }
}
