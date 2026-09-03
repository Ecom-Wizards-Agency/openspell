import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import process from "node:process";

import { image, packageDirectory } from "./cargo.mjs";

const maximumExecutableBytes = 64 * 1024 * 1024;
const cases = Object.freeze([
  ["success", "openspell synthetic kernel proof: success complete=1 residue=0"],
  ["refusal", "openspell synthetic kernel proof: refusal recovery=1 residue=0"],
  ["timeout", "openspell synthetic kernel proof: timeout recovery=1 residue=0"],
  [
    "interruption",
    "openspell synthetic kernel proof: interruption recovery=1 residue=0",
  ],
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

function isInside(parent, candidate) {
  const relation = relative(parent, candidate);
  return relation !== "" && relation !== ".." && !relation.startsWith(`..${sep}`);
}

function buildExecutable() {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new Error("linux identity required");
  const result = run("docker", [
    "run",
    "--rm",
    "--user",
    `${uid}:${gid}`,
    "--env",
    "CARGO_HOME=/cargo",
    "--env",
    "CARGO_TARGET_DIR=/target",
    "--env",
    "TMPDIR=/target",
    "--tmpfs",
    `/cargo:rw,uid=${uid},gid=${gid},mode=0700`,
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
    "--features",
    "kernel-proof",
    "--test",
    "linux-kernel-proof",
    "--no-run",
    "--message-format=json",
  ]);
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
  return executable;
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
        "/kernel-proof",
        image,
        mode,
      ],
      { timeout: 30_000 },
    );
    if (result.status !== 0 || result.signal !== null || result.stderr !== "") {
      throw new Error("kernel proof case refused");
    }
    if (result.stdout.trim() !== expected) throw new Error("kernel proof summary mismatch");
  } finally {
    run("docker", ["rm", "--force", name]);
  }
  const inspection = run("docker", ["inspect", name]);
  if (inspection.status === 0) throw new Error("disposable container remained");
}

try {
  if (process.argv.length !== 2) throw new Error("kernel proof accepts no arguments");
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
      rmSync(targetDirectory, { force: true, recursive: true });
    } catch {
      process.stderr.write("openspell synthetic kernel proof cleanup uncertain\n");
      process.exitCode = 1;
    }
  }
}
