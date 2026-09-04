import { basename, dirname, join } from "node:path";

export const DOCKER_BINARY = "/usr/bin/docker";
export const DOCKER_SOCKET = "/var/run/docker.sock";
export const DOCKER_ENDPOINT = `unix://${DOCKER_SOCKET}`;
export const INVOCATION_PREFIX = "openspell-wp201-root-proof-";
export const INVOCATION_LABEL = "com.openspell.wp201.invocation";
export const ROLE_LABEL = "com.openspell.wp201.role";
export const ACQUISITION_ROLE = "dependency-acquisition-v1";
export const PROOF_ROLE = "root-bridge-proof-v1";
export const IMAGE =
  "docker.io/library/rust:1.97.1-bookworm@sha256:0e2bcaef56d041a486784e54104a81aebe0da44bd03019bd70bc0401e42e4a97";
export const ACQUISITION_CONTROLLER_SHA256 =
  "72290e827399c5e6eb4c597312a65fbd6402c2d8ad87993c7e336a27f6d48258";
export const PROOF_CONTROLLER_SHA256 =
  "914feaa7cece86e66a81a4dd8595d7efc2ae2e7be241d6190aee97c5c213bfcb";

export const ROW_IDS = Object.freeze([
  "root-fmt",
  "root-check-none",
  "root-clippy-none",
  "root-rustdoc-none",
  "root-test-none",
  "root-check-internal",
  "root-clippy-internal",
  "root-rustdoc-internal",
  "root-test-internal",
  "runtime-fmt",
  "runtime-check-none",
  "runtime-clippy-none",
  "runtime-rustdoc-none",
  "runtime-test-none",
  "runtime-check-internal",
  "runtime-clippy-internal",
  "runtime-rustdoc-internal",
  "runtime-test-internal",
  "runtime-check-all",
  "runtime-clippy-all",
  "runtime-rustdoc-all",
  "runtime-test-all",
  "coordinator-fmt",
  "coordinator-check",
  "coordinator-clippy",
  "coordinator-rustdoc",
  "coordinator-test",
  "root-positive",
]);

export const REFUSED_ENVIRONMENT_NAMES = Object.freeze([
  "TMPDIR",
  "TMP",
  "TEMP",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_API_VERSION",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "REGISTRY_AUTH_FILE",
  "DOCKER_AUTH_CONFIG",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "CDPATH",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_SYSTEM",
]);

const invocationPattern = /^[0-9a-f]{64}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const decimalPattern = /^(?:0|[1-9][0-9]*)$/u;
const rowIdSet = new Set(ROW_IDS);

const acquisitionBootstrap =
  `test "$(/usr/bin/sha256sum /input/control.sh)" = "${ACQUISITION_CONTROLLER_SHA256}  /input/control.sh"; ` +
  "exec /bin/bash --noprofile --norc -euo pipefail /input/control.sh";

const proofBootstrap =
  `test "$(/usr/bin/sha256sum /input/control.sh)" = "${PROOF_CONTROLLER_SHA256}  /input/control.sh"; ` +
  'test "$(/usr/bin/sha256sum /input/vendor-ledger.v1)" = "$1  /input/vendor-ledger.v1"; ' +
  'exec /bin/bash --noprofile --norc -euo pipefail /input/control.sh "$2"';

function requireInvocation(value) {
  if (typeof value !== "string" || !invocationPattern.test(value)) {
    throw new Error("invalid WP-201 invocation identity");
  }
  return value;
}

function requireDecimal(value, label) {
  const text = String(value);
  if (!decimalPattern.test(text)) throw new Error(`invalid ${label}`);
  return text;
}

function requireInvocationDirectory(directory, invocation) {
  if (typeof directory !== "string" || directory.includes("\0")) {
    throw new Error("invalid WP-201 invocation directory");
  }
  if (!["/tmp", "/var/tmp"].includes(dirname(directory))) {
    throw new Error("invalid WP-201 invocation parent");
  }
  if (basename(directory) !== `${INVOCATION_PREFIX}${invocation}`) {
    throw new Error("WP-201 invocation path identity mismatch");
  }
  return directory;
}

export function assertCleanEnvironment(environment) {
  for (const name of REFUSED_ENVIRONMENT_NAMES) {
    if (Object.hasOwn(environment, name)) throw new Error("refused ambient environment");
  }
}

export function acquisitionContainerName(invocation) {
  return `openspell-wp201-${requireInvocation(invocation)}-acquisition`;
}

export function proofContainerName(invocation, rowId) {
  requireInvocation(invocation);
  if (!rowIdSet.has(rowId)) throw new Error("invalid WP-201 proof row");
  return `openspell-wp201-${invocation}-proof-${rowId}`;
}

export function invocationRecord(invocation) {
  return `openspell.wp201.invocation.v1\n${requireInvocation(invocation)}\n`;
}

export function dockerEnvironment(invocationDirectory) {
  return Object.freeze({
    HOME: join(invocationDirectory, "docker/home"),
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
  });
}

export function dockerPrefix(invocationDirectory) {
  return [
    DOCKER_BINARY,
    "--host",
    DOCKER_ENDPOINT,
    "--config",
    join(invocationDirectory, "docker/config"),
  ];
}

function commonCreate(invocation, role, name) {
  return [
    "--platform",
    "linux/amd64",
    "--pull",
    "never",
    "--label",
    `${INVOCATION_LABEL}=${invocation}`,
    "--label",
    `${ROLE_LABEL}=${role}`,
    "--name",
    name,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--security-opt",
    "seccomp=builtin",
    "--security-opt",
    "apparmor=docker-default",
    "--ipc",
    "private",
    "--cgroupns",
    "private",
    "--userns",
    "host",
    "--runtime",
    "runc",
    "--restart",
    "no",
    "--init=false",
    "--log-driver",
    "none",
  ];
}

export function acquisitionCreateArguments(options) {
  const invocation = requireInvocation(options.invocation);
  const root = requireInvocationDirectory(options.invocationDirectory, invocation);
  const uid = requireDecimal(options.uid, "uid");
  const gid = requireDecimal(options.gid, "gid");
  const source = join(root, "source");
  const controller = join(root, "control/acquisition.sh");
  return Object.freeze([
    "container",
    "create",
    ...commonCreate(invocation, ACQUISITION_ROLE, acquisitionContainerName(invocation)),
    "--hostname",
    "wp201-acquisition",
    "--user",
    `${uid}:${gid}`,
    "--network",
    "bridge",
    "--pids-limit",
    "128",
    "--memory",
    "2g",
    "--memory-swap",
    "2g",
    "--cpus",
    "2",
    "--ulimit",
    "nofile=1024:1024",
    "--shm-size",
    "256m",
    "--mount",
    `type=bind,src=${source},dst=/input/source,readonly,bind-propagation=rprivate,bind-recursive=readonly`,
    "--mount",
    `type=bind,src=${controller},dst=/input/control.sh,readonly,bind-propagation=rprivate`,
    "--tmpfs",
    `/output:rw,nodev,nosuid,exec,size=1073741824,mode=0700,uid=${uid},gid=${gid}`,
    "--tmpfs",
    `/tmp:rw,nodev,nosuid,noexec,size=1073741824,mode=0700,uid=${uid},gid=${gid}`,
    "--tmpfs",
    `/wp201-home:rw,nodev,nosuid,noexec,size=16777216,mode=0700,uid=${uid},gid=${gid}`,
    "--workdir",
    "/tmp",
    "--entrypoint",
    "/usr/bin/env",
    IMAGE,
    "-i",
    "PATH=/usr/local/cargo/bin:/usr/bin:/bin",
    "HOME=/wp201-home",
    "CARGO_HOME=/output/cargo-home",
    "TMPDIR=/tmp",
    "RUSTUP_HOME=/usr/local/rustup",
    "RUSTUP_NO_UPDATE_CHECK=1",
    "CARGO_TERM_COLOR=never",
    "LANG=C",
    "LC_ALL=C",
    "/bin/bash",
    "--noprofile",
    "--norc",
    "-euo",
    "pipefail",
    "-c",
    acquisitionBootstrap,
    "wp201-acquisition-bootstrap",
  ]);
}

export function proofCreateArguments(options) {
  const invocation = requireInvocation(options.invocation);
  const root = requireInvocationDirectory(options.invocationDirectory, invocation);
  const rowId = options.rowId;
  if (!rowIdSet.has(rowId)) throw new Error("invalid WP-201 proof row");
  const ledgerSha256 = options.ledgerSha256;
  if (typeof ledgerSha256 !== "string" || !digestPattern.test(ledgerSha256)) {
    throw new Error("invalid WP-201 ledger identity");
  }
  return Object.freeze([
    "container",
    "create",
    "--interactive",
    ...commonCreate(invocation, PROOF_ROLE, proofContainerName(invocation, rowId)),
    "--hostname",
    "wp201-proof",
    "--user",
    "0:0",
    "--network",
    "none",
    "--pids-limit",
    "512",
    "--memory",
    "6g",
    "--memory-swap",
    "6g",
    "--cpus",
    "4",
    "--ulimit",
    "nofile=1024:1024",
    "--ulimit",
    "nproc=512:512",
    "--shm-size",
    "2g",
    "--mount",
    `type=bind,src=${join(root, "source")},dst=/input/source,readonly,bind-propagation=rprivate,bind-recursive=readonly`,
    "--mount",
    `type=bind,src=${join(root, "acquisition/vendor")},dst=/input/vendor,readonly,bind-propagation=rprivate,bind-recursive=readonly`,
    "--mount",
    `type=bind,src=${join(root, "acquisition/toolchain")},dst=/input/toolchain,readonly,bind-propagation=rprivate,bind-recursive=readonly`,
    "--mount",
    `type=bind,src=${join(root, "acquisition/vendor-ledger.v1")},dst=/input/vendor-ledger.v1,readonly,bind-propagation=rprivate`,
    "--mount",
    `type=bind,src=${join(root, "control/proof.sh")},dst=/input/control.sh,readonly,bind-propagation=rprivate`,
    "--mount",
    `type=bind,src=${join(root, "control/hostname")},dst=/etc/hostname,readonly,bind-propagation=rprivate`,
    "--mount",
    `type=bind,src=${join(root, "control/hosts")},dst=/etc/hosts,readonly,bind-propagation=rprivate`,
    "--mount",
    `type=bind,src=${join(root, "control/resolv.conf")},dst=/etc/resolv.conf,readonly,bind-propagation=rprivate`,
    "--tmpfs",
    "/cargo:rw,nodev,nosuid,noexec,size=268435456,mode=0700",
    "--tmpfs",
    "/target:rw,nodev,nosuid,exec,size=4294967296,mode=0700",
    "--tmpfs",
    "/tmp:rw,nodev,nosuid,noexec,size=1073741824,mode=0700",
    "--tmpfs",
    "/fixtures:rw,nodev,nosuid,noexec,size=2147483648,mode=0700",
    "--tmpfs",
    "/wp201-home:rw,nodev,nosuid,noexec,size=16777216,mode=0700",
    "--workdir",
    "/tmp",
    "--entrypoint",
    "/usr/bin/env",
    IMAGE,
    "-i",
    "PATH=/usr/local/cargo/bin:/usr/bin:/bin",
    "HOME=/wp201-home",
    "CARGO_HOME=/cargo",
    "CARGO_TARGET_DIR=/target/current",
    "TMPDIR=/fixtures",
    "RUSTUP_HOME=/input/toolchain",
    "RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu",
    "RUSTUP_NO_UPDATE_CHECK=1",
    "CARGO_NET_OFFLINE=true",
    "CARGO_TERM_COLOR=never",
    "LANG=C",
    "LC_ALL=C",
    "/bin/bash",
    "--noprofile",
    "--norc",
    "-euo",
    "pipefail",
    "-c",
    proofBootstrap,
    "wp201-proof-bootstrap",
    ledgerSha256,
    rowId,
  ]);
}

export function dockerOperationArguments(kind, options) {
  const invocation = requireInvocation(options.invocation);
  switch (kind) {
    case "context-name":
      return Object.freeze(["context", "show"]);
    case "context-endpoint":
      return Object.freeze([
        "context",
        "inspect",
        "default",
        "--format",
        "{{json .Endpoints.docker.Host}}",
      ]);
    case "api-support":
      return Object.freeze(["version", "--format", "{{json .}}"]);
    case "label-census":
      return Object.freeze([
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        `label=${INVOCATION_LABEL}=${invocation}`,
        "--format",
        "{{.ID}}",
      ]);
    case "remove":
      if (!invocationPattern.test(options.id ?? "")) throw new Error("invalid container ID");
      return Object.freeze(["container", "rm", "--force", "--volumes", options.id]);
    case "absence":
    case "inspect":
      if (!invocationPattern.test(options.id ?? "")) throw new Error("invalid container ID");
      return Object.freeze(["container", "inspect", options.id]);
    default:
      throw new Error("unsupported Docker operation");
  }
}

export function createCleanupCursor(ids) {
  const unique = [...new Set(ids)];
  if (unique.length > 2 || unique.some((id) => !invocationPattern.test(id))) {
    throw new Error("invalid cleanup custody set");
  }
  return Object.freeze({
    ids: Object.freeze(unique.map((id) => Object.freeze({ id, state: "remove-1" }))),
    preliminaryCensus: false,
    closeSent: false,
    watcherReaped: false,
    finalCensus: false,
    pathCleanup: false,
  });
}

export function advanceIdCleanup(entry, operation, outcome) {
  const expected = {
    "remove-1": "remove-1",
    "absence-1": "absence-1",
    "remove-2": "remove-2",
    "absence-2": "absence-2",
  }[entry.state];
  if (operation !== expected) throw new Error("cleanup operation replay or reorder");
  if (operation === "remove-1") return Object.freeze({ id: entry.id, state: "absence-1" });
  if (operation === "absence-1") {
    return Object.freeze({
      id: entry.id,
      state: outcome === "absent" ? "absent" : "remove-2",
    });
  }
  if (operation === "remove-2") return Object.freeze({ id: entry.id, state: "absence-2" });
  return Object.freeze({ id: entry.id, state: outcome === "absent" ? "absent" : "failed" });
}
