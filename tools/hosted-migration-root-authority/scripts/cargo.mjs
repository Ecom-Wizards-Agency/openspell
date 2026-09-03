import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const image = [
  "docker.io/library/rust:1.97.1-bookworm@sha256:",
  "0e2bcaef56d041a486784e54104a81ae",
  "be0da44bd03019bd70bc0401e42e4a97",
].join("");

const commands = Object.freeze({
  check:
    "cargo fmt --all -- --check && cargo check --locked --all-targets --all-features && cargo clippy --locked --all-targets --all-features -- -D warnings",
  test: "cargo test --locked --all-targets --all-features",
});

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: packageDirectory,
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function hasPinnedLocalToolchain() {
  const rustc = spawnSync("rustc", ["--version"], {
    cwd: packageDirectory,
    encoding: "utf8",
  });
  const cargo = spawnSync("cargo", ["--version"], {
    cwd: packageDirectory,
    encoding: "utf8",
  });
  return (
    rustc.status === 0 &&
    rustc.stdout.startsWith("rustc 1.97.1 ") &&
    cargo.status === 0 &&
    cargo.stdout.startsWith("cargo 1.97.1 ")
  );
}

export function runCargo(mode) {
  const script = commands[mode];
  if (script === undefined) throw new Error("unsupported cargo mode");

  if (hasPinnedLocalToolchain()) {
    run("bash", ["-c", script]);
    return;
  }

  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new Error("linux uid/gid required");
  run("docker", [
    "run",
    "--rm",
    "--user",
    `${uid}:${gid}`,
    "--env",
    "CARGO_HOME=/cargo",
    "--env",
    "CARGO_TARGET_DIR=/target",
    "--tmpfs",
    `/cargo:rw,uid=${uid},gid=${gid},mode=0700`,
    "--tmpfs",
    `/target:rw,exec,uid=${uid},gid=${gid},mode=0700`,
    "--volume",
    `${packageDirectory}:/workspace:ro`,
    "--workdir",
    "/workspace",
    image,
    "bash",
    "-c",
    script,
  ]);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === invokedPath) {
  const [mode, ...rest] = process.argv.slice(2);
  if (rest.length !== 0 || (mode !== "check" && mode !== "test")) {
    throw new Error("usage: node scripts/cargo.mjs check|test");
  }
  runCargo(mode);
}
