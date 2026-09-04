import { basename, dirname, join } from "node:path";

export const DOCKER_BINARY = "/usr/bin/docker";
export const DOCKER_SOCKET = "/var/run/docker.sock";
export const DOCKER_ENDPOINT = `unix://${DOCKER_SOCKET}`;
export const INVOCATION_PREFIX = "openspell-wp201-root-proof-";
export const INVOCATION_LABEL = "com.openspell.wp201.invocation";
export const ROLE_LABEL = "com.openspell.wp201.role";
export const ACQUISITION_ROLE = "dependency-acquisition-v1";
export const PROOF_ROLE = "root-bridge-proof-v1";
const RUST_REPOSITORY = "docker.io/library/rust";
const IMAGE_INDEX_DIGEST = [
  "sha256:",
  "0e2bcaef56d041a4",
  "86784e54104a81ae",
  "be0da44bd03019bd",
  "70bc0401e42e4a97",
].join("");
const AMD64_MANIFEST_DIGEST = [
  "sha256:",
  "408fe88047cef61a",
  "2087653b0c5255fa",
  "51c0f2d6d94ddedd",
  "7a2562a9b91a46f6",
].join("");
export const IMAGE = `${RUST_REPOSITORY}:1.97.1-bookworm@${IMAGE_INDEX_DIGEST}`;
export const PLATFORM_MANIFEST_REFERENCE =
  `${RUST_REPOSITORY}@${AMD64_MANIFEST_DIGEST}`;
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

const rustupToolchain = [
  "RUSTUP_TOOLCHAIN=1.97.1",
  "-x86_64-unknown-linux-gnu",
].join("");

function fixedTmpfs(target, execution, size, identity = []) {
  return [
    `${target}:rw`,
    "nodev",
    "nosuid",
    execution,
    `size=${size}`,
    "mode=0700",
    ...identity,
  ].join(",");
}

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

export function dockerEnvironment(invocation, invocationDirectory) {
  const root = requireInvocationDirectory(
    invocationDirectory,
    requireInvocation(invocation),
  );
  return Object.freeze({
    HOME: join(root, "docker/home"),
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
  });
}

export function dockerPrefix(invocation, invocationDirectory) {
  const root = requireInvocationDirectory(
    invocationDirectory,
    requireInvocation(invocation),
  );
  return Object.freeze([
    DOCKER_BINARY,
    "--host",
    DOCKER_ENDPOINT,
    "--config",
    join(root, "docker/config"),
  ]);
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
    fixedTmpfs("/output", "exec", "1073741824", [`uid=${uid}`, `gid=${gid}`]),
    "--tmpfs",
    fixedTmpfs("/tmp", "noexec", "1073741824", [`uid=${uid}`, `gid=${gid}`]),
    "--tmpfs",
    fixedTmpfs("/wp201-home", "noexec", "16777216", [
      `uid=${uid}`,
      `gid=${gid}`,
    ]),
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
    fixedTmpfs("/cargo", "noexec", "268435456"),
    "--tmpfs",
    fixedTmpfs("/target", "exec", "4294967296"),
    "--tmpfs",
    fixedTmpfs("/tmp", "noexec", "1073741824"),
    "--tmpfs",
    fixedTmpfs("/fixtures", "noexec", "2147483648"),
    "--tmpfs",
    fixedTmpfs("/wp201-home", "noexec", "16777216"),
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
    rustupToolchain,
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

function requireContainerId(value) {
  if (typeof value !== "string" || !invocationPattern.test(value)) {
    throw new Error("invalid container ID");
  }
  return value;
}

function requireOperationOptions(options, allowed) {
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => !allowed.includes(key))
  ) {
    throw new Error("invalid Docker operation options");
  }
  return options;
}

export function dockerOperationArguments(kind, options = {}) {
  switch (kind) {
    case "context-name": {
      requireOperationOptions(options, []);
      return Object.freeze(["context", "show"]);
    }
    case "context-endpoint": {
      requireOperationOptions(options, []);
      return Object.freeze([
        "context",
        "inspect",
        "default",
        "--format",
        "{{json .Endpoints.docker.Host}}",
      ]);
    }
    case "api-support": {
      requireOperationOptions(options, []);
      return Object.freeze(["version", "--format", "{{json .}}"]);
    }
    case "platform-manifest": {
      requireOperationOptions(options, []);
      return Object.freeze(["manifest", "inspect", PLATFORM_MANIFEST_REFERENCE]);
    }
    case "cached-image": {
      requireOperationOptions(options, []);
      return Object.freeze([
        "image",
        "inspect",
        "--platform",
        "linux/amd64",
        IMAGE,
      ]);
    }
    case "image-pull": {
      requireOperationOptions(options, []);
      return Object.freeze([
        "image",
        "pull",
        "--platform",
        "linux/amd64",
        IMAGE,
      ]);
    }
    case "label-census": {
      requireOperationOptions(options, ["invocation"]);
      const invocation = requireInvocation(options.invocation);
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
    }
    case "exact-name-acquisition": {
      requireOperationOptions(options, ["invocation"]);
      return Object.freeze([
        "container",
        "inspect",
        acquisitionContainerName(options.invocation),
      ]);
    }
    case "exact-name-proof": {
      requireOperationOptions(options, ["invocation", "rowId"]);
      return Object.freeze([
        "container",
        "inspect",
        proofContainerName(options.invocation, options.rowId),
      ]);
    }
    case "inspect":
    case "absence": {
      requireOperationOptions(options, ["id"]);
      return Object.freeze(["container", "inspect", requireContainerId(options.id)]);
    }
    case "acquisition-start-attach": {
      requireOperationOptions(options, ["id"]);
      return Object.freeze([
        "container",
        "start",
        "--attach",
        requireContainerId(options.id),
      ]);
    }
    case "proof-start-attach": {
      requireOperationOptions(options, ["id"]);
      return Object.freeze([
        "container",
        "start",
        "--attach",
        "--interactive",
        requireContainerId(options.id),
      ]);
    }
    case "remove": {
      requireOperationOptions(options, ["id"]);
      return Object.freeze([
        "container",
        "rm",
        "--force",
        "--volumes",
        requireContainerId(options.id),
      ]);
    }
    default:
      throw new Error("unsupported Docker operation");
  }
}

export const CLEANUP_RESERVE_NS = 160_000_000_000n;

const SECOND_NS = 1_000_000_000n;
const CREATE_SLOT_NS = 15n * SECOND_NS;
const SHARED_SLOT_NS = 10n * SECOND_NS;
const DOCKER_SLOT_NS = 10n * SECOND_NS;
const WATCHER_SLOT_NS = 10n * SECOND_NS;
const PATH_HELPER_SLOT_NS = 10n * SECOND_NS;
const PARENT_ABSENCE_SLOT_NS = 5n * SECOND_NS;
const SCHEDULING_RESERVE_NS = 10n * SECOND_NS;
const cleanupCursors = new WeakSet();
const bootTimeSamples = new WeakSet();
const childTokens = new WeakSet();
const usedChildTokens = new WeakSet();
const terminalIdStates = new Set(["absent", "failed"]);
const removeOutcomes = new Set(["removed", "error", "ambiguous", "hung"]);
const absenceOutcomes = new Set(["absent", "present", "error", "ambiguous", "hung"]);
const otherChildOutcomes = new Set(["complete", "error", "ambiguous", "hung"]);
const otherChildOperations = new Set([
  "context-name",
  "context-endpoint",
  "api-support",
  "platform-manifest",
  "cached-image",
  "image-pull",
  "configuration-inspect",
  "start-attach",
]);

export function createBootTimeSample(nanoseconds) {
  if (typeof nanoseconds !== "bigint" || nanoseconds < 0n) {
    throw new Error("invalid CLOCK_BOOTTIME sample");
  }
  const sample = Object.freeze({ nanoseconds });
  bootTimeSamples.add(sample);
  return sample;
}

export function createOwnedChildToken() {
  const token = Object.freeze(Object.create(null));
  childTokens.add(token);
  return token;
}

function freezeMaybe(value) {
  return value === null ? null : Object.freeze({ ...value });
}

function freezeCleanupCursor(cursor) {
  const active =
    cursor.active === null
      ? null
      : Object.freeze({
          ...cursor.active,
          result: freezeMaybe(cursor.active.result),
          window: freezeMaybe(cursor.active.window),
        });
  const frozen = Object.freeze({
    ...cursor,
    ids: Object.freeze(cursor.ids.map((entry) => Object.freeze({ ...entry }))),
    finalIds: Object.freeze(
      cursor.finalIds.map((entry) => Object.freeze({ ...entry })),
    ),
    revocation: Object.freeze({ ...cursor.revocation }),
    sharedSlot: Object.freeze({ ...cursor.sharedSlot }),
    create: Object.freeze({ ...cursor.create }),
    watcher: Object.freeze({
      ...cursor.watcher,
      event: freezeMaybe(cursor.watcher.event),
      window: freezeMaybe(cursor.watcher.window),
    }),
    preliminary: Object.freeze({ ...cursor.preliminary }),
    active,
  });
  cleanupCursors.add(frozen);
  return frozen;
}

function requireCleanupCursor(cursor) {
  if (!cleanupCursors.has(cursor)) throw new Error("invalid cleanup cursor");
  return cursor;
}

function requireSample(sample) {
  if (!bootTimeSamples.has(sample)) throw new Error("unbranded CLOCK_BOOTTIME sample");
  return sample.nanoseconds;
}

function requireFreshChildToken(token) {
  if (!childTokens.has(token)) throw new Error("unbranded owned child token");
  if (usedChildTokens.has(token)) throw new Error("owned child token replay");
}

function stampCursor(cursor, sample) {
  const nowNs = requireSample(sample);
  if (nowNs < cursor.lastBootNs) throw new Error("CLOCK_BOOTTIME regressed");
  if (nowNs >= cursor.hardDeadlineNs) throw new Error("cleanup hard deadline reached");
  return {
    cursor: freezeCleanupCursor({
      ...cursor,
      lastBootNs: nowNs,
      sequence: cursor.sequence + 1,
    }),
    nowNs,
  };
}

function pendingId(entries) {
  return entries.find((entry) => !terminalIdStates.has(entry.state));
}

function normalizeIdPhase(cursor) {
  if (cursor.phase === "initial-ids" && pendingId(cursor.ids) === undefined) {
    return {
      ...cursor,
      phase: cursor.watcher.ready ? "preliminary-census" : "final-census",
    };
  }
  if (cursor.phase === "final-ids" && pendingId(cursor.finalIds) === undefined) {
    return { ...cursor, phase: "final-census" };
  }
  return cursor;
}

function remainingIdOperations(entry) {
  return {
    "remove-1": 4n,
    "absence-1": 3n,
    "remove-2": 2n,
    "absence-2": 1n,
    absent: 0n,
    failed: 0n,
  }[entry.state];
}

function remainingKnownIdSlots(cursor) {
  return [...cursor.ids, ...cursor.finalIds].reduce(
    (total, entry) => total + remainingIdOperations(entry),
    0n,
  );
}

function possibleLateEventSlots(cursor) {
  if (
    cursor.watcher.eofObserved ||
    cursor.watcher.reaped ||
    !cursor.watcher.ready ||
    cursor.watcher.eventCount !== 0 ||
    cursor.ids.length + cursor.finalIds.length >= 2
  ) {
    return 0n;
  }
  return 4n;
}

function suffixAfterOperation(cursor, operation) {
  const terminalTail =
    DOCKER_SLOT_NS +
    PATH_HELPER_SLOT_NS +
    PARENT_ABSENCE_SLOT_NS +
    SCHEDULING_RESERVE_NS;
  if (["remove-1", "absence-1", "remove-2", "absence-2"].includes(operation)) {
    const remaining = remainingKnownIdSlots(cursor) - 1n;
    if (remaining < 0n) throw new Error("invalid cleanup ID budget");
    if (cursor.phase === "initial-ids") {
      return (
        (remaining + possibleLateEventSlots(cursor)) * DOCKER_SLOT_NS +
        DOCKER_SLOT_NS +
        WATCHER_SLOT_NS +
        terminalTail
      );
    }
    if (cursor.phase === "final-ids") {
      return remaining * DOCKER_SLOT_NS + terminalTail;
    }
    throw new Error("ID cleanup outside ID phase");
  }
  if (operation === "preliminary-census") {
    const futureIds = remainingKnownIdSlots(cursor) + possibleLateEventSlots(cursor);
    return futureIds * DOCKER_SLOT_NS + WATCHER_SLOT_NS + terminalTail;
  }
  if (operation === "send-close" || operation === "settle-watcher") {
    const futureIds = remainingKnownIdSlots(cursor) + possibleLateEventSlots(cursor);
    return futureIds * DOCKER_SLOT_NS + terminalTail;
  }
  if (operation === "final-census") {
    return PATH_HELPER_SLOT_NS + PARENT_ABSENCE_SLOT_NS + SCHEDULING_RESERVE_NS;
  }
  if (operation === "path-helper") {
    return PARENT_ABSENCE_SLOT_NS + SCHEDULING_RESERVE_NS;
  }
  if (operation === "parent-absence") return SCHEDULING_RESERVE_NS;
  if (operation === "name-recovery") {
    return 8n * DOCKER_SLOT_NS + DOCKER_SLOT_NS + WATCHER_SLOT_NS + terminalTail;
  }
  throw new Error("invalid cleanup operation budget");
}

function makeWindow(cursor, nowNs, kind, budgetNs, normalNs, termNs, suffixNs) {
  const suffixCap = cursor.hardDeadlineNs - suffixNs;
  const endNs = nowNs + budgetNs < suffixCap ? nowNs + budgetNs : suffixCap;
  if (endNs <= nowNs) throw new Error("cleanup suffix reserve exhausted");
  return Object.freeze({
    kind,
    startNs: nowNs,
    normalEndNs: nowNs + normalNs < endNs ? nowNs + normalNs : endNs,
    termEndNs: nowNs + termNs < endNs ? nowNs + termNs : endNs,
    endNs,
    reservedSuffixNs: suffixNs,
  });
}

function operationWindow(cursor, operation, nowNs) {
  const suffixNs = suffixAfterOperation(cursor, operation);
  if (operation === "path-helper") {
    return makeWindow(
      cursor,
      nowNs,
      "path-helper",
      PATH_HELPER_SLOT_NS,
      4n * SECOND_NS,
      7n * SECOND_NS,
      suffixNs,
    );
  }
  if (operation === "parent-absence") {
    return makeWindow(
      cursor,
      nowNs,
      "parent-absence",
      PARENT_ABSENCE_SLOT_NS,
      PARENT_ABSENCE_SLOT_NS,
      PARENT_ABSENCE_SLOT_NS,
      suffixNs,
    );
  }
  if (operation === "send-close") {
    return makeWindow(
      cursor,
      nowNs,
      "watcher",
      WATCHER_SLOT_NS,
      5n * SECOND_NS,
      8n * SECOND_NS,
      suffixNs,
    );
  }
  return makeWindow(
    cursor,
    nowNs,
    operation === "preliminary-census" || operation === "final-census"
      ? "census"
      : operation === "name-recovery"
        ? "shared"
        : "docker",
    DOCKER_SLOT_NS,
    5n * SECOND_NS,
    7n * SECOND_NS,
    suffixNs,
  );
}

function latchWindow(cursor, nowNs, origin) {
  if (origin === "create") {
    return makeWindow(
      cursor,
      nowNs,
      "create",
      CREATE_SLOT_NS,
      5n * SECOND_NS,
      10n * SECOND_NS,
      145n * SECOND_NS,
    );
  }
  const suffixNs =
    origin === "cleanup"
      ? suffixAfterOperation(cursor, cursor.active.operation)
      : 135n * SECOND_NS;
  return makeWindow(
    cursor,
    nowNs,
    "shared",
    SHARED_SLOT_NS,
    5n * SECOND_NS,
    7n * SECOND_NS,
    suffixNs,
  );
}

export function createCleanupCursor(options) {
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).sort().join("\n") !==
      ["activeDeadlineNs", "createIssued", "hardDeadlineNs", "ids", "sample", "watcherReady"]
        .sort()
        .join("\n")
  ) {
    throw new Error("invalid cleanup cursor options");
  }
  const initialSample = requireSample(options.sample);
  if (
    typeof options.activeDeadlineNs !== "bigint" ||
    typeof options.hardDeadlineNs !== "bigint" ||
    options.activeDeadlineNs < initialSample ||
    options.hardDeadlineNs - options.activeDeadlineNs !== CLEANUP_RESERVE_NS ||
    initialSample >= options.hardDeadlineNs
  ) {
    throw new Error("invalid cleanup deadline relation");
  }
  if (
    typeof options.createIssued !== "boolean" ||
    typeof options.watcherReady !== "boolean"
  ) {
    throw new Error("invalid cleanup lifecycle state");
  }
  if (!Array.isArray(options.ids)) throw new Error("invalid cleanup custody set");
  const unique = [...new Set(options.ids)];
  if (unique.length > 1 || unique.some((id) => !invocationPattern.test(id))) {
    throw new Error("invalid cleanup custody set");
  }
  if (!options.createIssued && unique.length !== 0) {
    throw new Error("container custody without an issued create");
  }
  if (!options.watcherReady && (options.createIssued || unique.length !== 0)) {
    throw new Error("container custody without an event watcher");
  }
  const needsRecovery = options.createIssued && unique.length === 0;
  return freezeCleanupCursor({
    phase: !options.watcherReady
      ? "final-census"
      : needsRecovery
        ? "name-recovery"
        : unique.length === 0
          ? "preliminary-census"
          : "initial-ids",
    sequence: 0,
    lastBootNs: initialSample,
    activeDeadlineNs: options.activeDeadlineNs,
    hardDeadlineNs: options.hardDeadlineNs,
    failed: needsRecovery,
    revocation: { latched: false, cause: null, atNs: null },
    sharedSlot: { state: "available", owner: null },
    create: {
      issued: options.createIssued,
      settled: options.createIssued,
      responseId: unique[0] ?? null,
      recovery: needsRecovery ? "eligible" : "unneeded",
    },
    ids: unique.map((id) => ({ id, state: "remove-1" })),
    finalIds: [],
    active: null,
    preliminary: { launchedSequence: null, result: null, deferredId: null },
    watcher: {
      ready: options.watcherReady,
      closeSent: false,
      eofObserved: false,
      reaped: false,
      eventCount: 0,
      event: null,
      window: null,
      stage: "settle",
      capReached: false,
    },
    finalCensus: false,
    pathCleanup: false,
    parentAbsence: false,
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
  if (operation.startsWith("remove-") && !removeOutcomes.has(outcome)) {
    throw new Error("invalid cleanup removal outcome");
  }
  if (operation.startsWith("absence-") && !absenceOutcomes.has(outcome)) {
    throw new Error("invalid cleanup absence outcome");
  }
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

export function expectedCleanupOperation(cursor) {
  requireCleanupCursor(cursor);
  if (cursor.active !== null) {
    return Object.freeze({
      operation: cursor.active.operation,
      ...(cursor.active.id === undefined ? {} : { id: cursor.active.id }),
    });
  }
  if (cursor.phase === "complete") return null;
  if (cursor.phase === "initial-ids" || cursor.phase === "final-ids") {
    const entries = cursor.phase === "initial-ids" ? cursor.ids : cursor.finalIds;
    const entry = pendingId(entries);
    if (entry === undefined) throw new Error("unnormalized cleanup cursor");
    return Object.freeze({ operation: entry.state, id: entry.id });
  }
  const operation = {
    "name-recovery": "name-recovery",
    "preliminary-census": "preliminary-census",
    close: "send-close",
    watcher: "settle-watcher",
    "final-census": "final-census",
    "path-helper": "path-helper",
    "parent-absence": "parent-absence",
  }[cursor.phase];
  if (operation === undefined) throw new Error("invalid cleanup phase");
  return Object.freeze({ operation });
}

function validateRows(rows) {
  if (
    !Array.isArray(rows) ||
    rows.length > 2 ||
    rows.some((id) => typeof id !== "string" || !invocationPattern.test(id)) ||
    new Set(rows).size !== rows.length
  ) {
    return null;
  }
  return rows;
}

function classifyPreliminaryCensus(cursor, rows) {
  const valid = validateRows(rows);
  if (valid === null) return Object.freeze({ outcome: "uncertain", deferredId: null });
  if (valid.length === 0) return Object.freeze({ outcome: "empty", deferredId: null });
  const event = cursor.watcher.event;
  if (
    valid.length === 1 &&
    cursor.create.issued &&
    cursor.watcher.eventCount === 1 &&
    event !== null &&
    cursor.preliminary.launchedSequence !== null &&
    event.sequence > cursor.preliminary.launchedSequence &&
    valid[0] === event.id
  ) {
    return Object.freeze({ outcome: "deferred", deferredId: event.id });
  }
  return Object.freeze({ outcome: "uncertain", deferredId: null });
}

function requireActiveTime(cursor, nowNs) {
  if (cursor.active.window === null) {
    if (nowNs >= cursor.activeDeadlineNs) throw new Error("active operation deadline reached");
    return;
  }
  if (nowNs >= cursor.active.window.endNs) throw new Error("cleanup operation deadline reached");
  if (
    nowNs >= cursor.active.window.termEndNs &&
    cursor.active.stage !== "kill"
  ) {
    throw new Error("cleanup child missing KILL transition");
  }
  if (
    nowNs >= cursor.active.window.normalEndNs &&
    cursor.active.stage === "settle"
  ) {
    throw new Error("cleanup child missing TERM transition");
  }
}

function beginOwnedChild(cursor, transition, nowNs) {
  if (cursor.revocation.latched) throw new Error("child start after cleanup latch");
  if (nowNs >= cursor.activeDeadlineNs) throw new Error("active operation deadline reached");
  if (cursor.active !== null) throw new Error("owned child already active");
  requireFreshChildToken(transition.token);
  if (transition.origin !== "create" && transition.origin !== "other") {
    throw new Error("invalid owned child origin");
  }
  if (transition.origin === "create") {
    if (
      transition.operation !== "create" ||
      cursor.create.issued ||
      cursor.ids.length !== 0 ||
      cursor.finalIds.length !== 0 ||
      cursor.watcher.eventCount !== 0 ||
      !cursor.watcher.ready
    ) {
      throw new Error("create replay or substitution");
    }
  } else {
    if (!otherChildOperations.has(transition.operation)) {
      throw new Error("invalid owned Docker child");
    }
    if (cursor.create.recovery === "eligible") {
      throw new Error("owned child while create recovery is unresolved");
    }
  }
  usedChildTokens.add(transition.token);
  return freezeCleanupCursor({
    ...cursor,
    create:
      transition.origin === "create"
        ? { ...cursor.create, issued: true, settled: false, recovery: "unneeded" }
        : cursor.create,
    active: {
      token: transition.token,
      origin: transition.origin,
      operation: transition.operation,
      result: null,
      window: null,
      stage: "settle",
      reaped: false,
      reapedAtNs: null,
      capReached: false,
      requiresReap: true,
    },
    lastBootNs: nowNs,
  });
}

function beginCleanupOperation(cursor, transition, nowNs) {
  if (!cursor.revocation.latched) {
    throw new Error("cleanup operation before revocation latch");
  }
  if (cursor.active !== null) throw new Error("cleanup operation already active");
  requireFreshChildToken(transition.token);
  const expected = expectedCleanupOperation(cursor);
  if (expected === null || transition.operation !== expected.operation) {
    throw new Error("cleanup operation replay or reorder");
  }
  if (expected.id === undefined) {
    if (transition.id !== undefined) throw new Error("unexpected cleanup operation ID");
  } else if (transition.id !== expected.id) {
    throw new Error("cleanup operation ID mismatch");
  }
  if (transition.operation === "name-recovery") {
    if (
      cursor.sharedSlot.state !== "available" ||
      cursor.create.recovery !== "eligible" ||
      cursor.ids.length !== 0 ||
      cursor.finalIds.length !== 0 ||
      cursor.watcher.eventCount !== 0 ||
      !cursor.watcher.ready ||
      cursor.watcher.eofObserved ||
      cursor.watcher.reaped
    ) {
      throw new Error("name recovery has no shared-slot authority");
    }
  }
  let window;
  let stage = "settle";
  let capReached = false;
  if (transition.operation === "settle-watcher") {
    if (cursor.watcher.window === null) throw new Error("watcher slot was not opened");
    window = cursor.watcher.window;
    stage = cursor.watcher.stage;
    capReached = cursor.watcher.capReached;
  } else {
    window = operationWindow(cursor, transition.operation, nowNs);
  }
  const requiresReap = !["send-close", "parent-absence"].includes(
    transition.operation,
  );
  const claimedShared = transition.operation === "name-recovery";
  const watcher =
    transition.operation === "send-close"
      ? { ...cursor.watcher, window }
      : cursor.watcher;
  const preliminary =
    transition.operation === "preliminary-census"
      ? { ...cursor.preliminary, launchedSequence: cursor.sequence }
      : cursor.preliminary;
  usedChildTokens.add(transition.token);
  return freezeCleanupCursor({
    ...cursor,
    failed:
      cursor.failed ||
      (transition.operation === "settle-watcher" && nowNs >= window.endNs),
    sharedSlot: claimedShared
      ? { state: "claimed", owner: "name-recovery" }
      : cursor.sharedSlot,
    watcher,
    preliminary,
    active: {
      token: transition.token,
      origin: "cleanup",
      operation: expected.operation,
      ...(expected.id === undefined ? {} : { id: expected.id }),
      result: null,
      window,
      stage,
      reaped: false,
      reapedAtNs: null,
      capReached,
      requiresReap,
      settledByShared: false,
    },
  });
}

function validateCleanupResult(cursor, transition) {
  const operation = cursor.active.operation;
  if (operation === "preliminary-census") {
    return classifyPreliminaryCensus(cursor, transition.rows);
  }
  if (operation === "final-census") {
    const rows = validateRows(transition.rows);
    return Object.freeze({
      outcome: rows === null ? "failed" : rows.length === 0 ? "empty" : "nonempty",
    });
  }
  if (operation === "name-recovery") {
    const allowed = new Set(["absent", "error", "ambiguous", "hung", "invalid", "found"]);
    if (!allowed.has(transition.outcome)) throw new Error("invalid name recovery result");
    if (transition.outcome === "found") {
      return Object.freeze({ outcome: "found", id: requireContainerId(transition.id) });
    }
    if (transition.id !== undefined) throw new Error("unexpected recovery identity");
    return Object.freeze({ outcome: transition.outcome });
  }
  const allowed = {
    "remove-1": removeOutcomes,
    "absence-1": absenceOutcomes,
    "remove-2": removeOutcomes,
    "absence-2": absenceOutcomes,
    "send-close": new Set(["sent", "failed"]),
    "settle-watcher": new Set(["reaped", "failed"]),
    "path-helper": new Set(["complete", "failed"]),
    "parent-absence": new Set(["absent", "present", "failed"]),
  }[operation];
  if (allowed === undefined || !allowed.has(transition.outcome)) {
    throw new Error("invalid cleanup operation result");
  }
  if (
    operation === "settle-watcher" &&
    transition.outcome === "reaped" &&
    !cursor.watcher.eofObserved
  ) {
    throw new Error("watcher reaped before event EOF");
  }
  return Object.freeze({ outcome: transition.outcome });
}

function recordResult(cursor, transition, nowNs) {
  if (cursor.active === null || cursor.active.result !== null) {
    throw new Error("cleanup result replay or reorder");
  }
  if (transition.token !== cursor.active.token) {
    throw new Error("owned child result token mismatch");
  }
  requireActiveTime(cursor, nowNs);
  let result;
  if (cursor.active.origin === "create") {
    if (transition.outcome === "created") {
      result = Object.freeze({ outcome: "created", id: requireContainerId(transition.id) });
    } else if (["error", "ambiguous", "hung"].includes(transition.outcome)) {
      if (transition.id !== undefined) throw new Error("unexpected create identity");
      result = Object.freeze({ outcome: transition.outcome });
    } else {
      throw new Error("invalid create result");
    }
  } else if (cursor.active.origin === "other") {
    if (!otherChildOutcomes.has(transition.outcome)) {
      throw new Error("invalid owned Docker result");
    }
    result = Object.freeze({ outcome: transition.outcome });
  } else {
    result = validateCleanupResult(cursor, transition);
  }
  const recorded = freezeCleanupCursor({
    ...cursor,
    active: { ...cursor.active, result },
  });
  const ordinaryFailure =
    (cursor.active.origin === "create" && result.outcome !== "created") ||
    (cursor.active.origin === "other" && result.outcome !== "complete");
  return ordinaryFailure && !cursor.revocation.latched
    ? latchCleanup(recorded, { cause: "failure" }, nowNs)
    : recorded;
}

function expireActive(cursor, transition, nowNs) {
  if (
    cursor.active === null ||
    cursor.active.window === null ||
    cursor.active.capReached ||
    nowNs < cursor.active.window.endNs
  ) {
    throw new Error("cleanup operation has not reached its cap");
  }
  if (transition.token !== cursor.active.token) {
    throw new Error("owned child expiry token mismatch");
  }
  if (
    cursor.active.window.termEndNs < cursor.active.window.endNs &&
    cursor.active.stage !== "kill"
  ) {
    throw new Error("cleanup child reached cap without KILL");
  }
  return freezeCleanupCursor({
    ...cursor,
    failed: true,
    watcher:
      cursor.active.operation === "send-close" ||
      cursor.active.operation === "settle-watcher"
        ? { ...cursor.watcher, stage: cursor.active.stage, capReached: true }
        : cursor.watcher,
    active: { ...cursor.active, capReached: true },
  });
}

function observeOwnedChildReap(cursor, transition, nowNs) {
  if (
    cursor.active === null ||
    !cursor.active.requiresReap ||
    cursor.active.reaped
  ) {
    throw new Error("no unreaped owned child");
  }
  if (transition.token !== cursor.active.token) {
    throw new Error("owned child reap token mismatch");
  }
  const { window } = cursor.active;
  if (window !== null) {
    if (nowNs >= window.endNs && window.termEndNs < window.endNs) {
      if (cursor.active.stage !== "kill") {
        throw new Error("cleanup child reaped at cap without KILL");
      }
    } else if (nowNs >= window.termEndNs && cursor.active.stage !== "kill") {
      throw new Error("cleanup child reaped without KILL");
    } else if (nowNs >= window.normalEndNs && cursor.active.stage === "settle") {
      throw new Error("cleanup child reaped without TERM");
    }
  } else if (nowNs >= cursor.activeDeadlineNs) {
    throw new Error("normal child reaped after active deadline");
  }
  if (
    cursor.active.operation === "settle-watcher" &&
    !cursor.watcher.eofObserved
  ) {
    throw new Error("watcher reaped before event EOF");
  }
  const late = window !== null && nowNs >= window.endNs;
  return freezeCleanupCursor({
    ...cursor,
    failed: cursor.failed || late,
    watcher:
      cursor.active.operation === "settle-watcher"
        ? {
            ...cursor.watcher,
            stage: cursor.active.stage,
            capReached: cursor.active.capReached || late,
            reaped: true,
          }
        : cursor.watcher,
    active: {
      ...cursor.active,
      reaped: true,
      reapedAtNs: nowNs,
      capReached: cursor.active.capReached || late,
    },
  });
}

function timeoutResult(active) {
  if (active.origin === "create" || active.origin === "other") {
    return Object.freeze({ outcome: "hung" });
  }
  if (
    ["remove-1", "absence-1", "remove-2", "absence-2", "name-recovery"].includes(
      active.operation,
    )
  ) {
    return Object.freeze({ outcome: "hung" });
  }
  if (active.operation === "preliminary-census") {
    return Object.freeze({ outcome: "uncertain", deferredId: null });
  }
  return Object.freeze({ outcome: "failed" });
}

function replaceId(entries, id, operation, outcome) {
  let replaced = false;
  const result = entries.map((entry) => {
    if (entry.id !== id) return entry;
    if (replaced) throw new Error("duplicate cleanup identity");
    replaced = true;
    return advanceIdCleanup(entry, operation, outcome);
  });
  if (!replaced) throw new Error("cleanup operation identity lost");
  return result;
}

function addCustodiedId(cursor, id, collection) {
  const known = [...cursor.ids, ...cursor.finalIds].some((entry) => entry.id === id);
  if (known) return cursor;
  if (cursor.ids.length + cursor.finalIds.length >= 2) {
    return { ...cursor, failed: true };
  }
  return {
    ...cursor,
    [collection]: [...cursor[collection], { id, state: "remove-1" }],
  };
}

function spendSharedSlot(cursor) {
  if (cursor.sharedSlot.state !== "claimed") return cursor.sharedSlot;
  return { state: "spent", owner: cursor.sharedSlot.owner };
}

function advanceCreate(cursor) {
  const result = cursor.active.result;
  let advanced = {
    ...cursor,
    active: null,
    create: {
      ...cursor.create,
      settled: true,
      responseId: result.outcome === "created" ? result.id : null,
    },
  };
  if (result.outcome === "created") {
    advanced = addCustodiedId(advanced, result.id, "ids");
  }
  const hasCustody =
    advanced.ids.length + advanced.finalIds.length > 0 ||
    advanced.watcher.eventCount === 1;
  if (!hasCustody && advanced.sharedSlot.state === "available") {
    return freezeCleanupCursor({
      ...advanced,
      phase: "name-recovery",
      create: { ...advanced.create, recovery: "eligible" },
    });
  }
  return freezeCleanupCursor(
    normalizeIdPhase({
      ...advanced,
      phase:
        advanced.ids.length === 0
          ? advanced.watcher.ready
            ? "preliminary-census"
            : "final-census"
          : "initial-ids",
      create: { ...advanced.create, recovery: "unneeded" },
      failed:
        advanced.failed ||
        result.outcome !== "created" ||
        !hasCustody ||
        (result.outcome === "created" &&
          advanced.watcher.event !== null &&
          advanced.watcher.event.id !== result.id),
    }),
  );
}

function terminalIdentityAgreement(cursor) {
  if (!cursor.create.issued) {
    return cursor.create.responseId === null && cursor.watcher.eventCount === 0;
  }
  return (
    cursor.create.responseId !== null &&
    cursor.watcher.eventCount === 1 &&
    cursor.watcher.event !== null &&
    cursor.watcher.event.id === cursor.create.responseId
  );
}

function advanceRecordedOperation(cursor) {
  if (cursor.active === null) {
    throw new Error("cleanup operation is not active");
  }
  if (cursor.active.requiresReap && !cursor.active.reaped) {
    throw new Error("cleanup operation child is not reaped");
  }
  if (cursor.active.result === null && !cursor.active.capReached) {
    throw new Error("cleanup operation has no recorded result");
  }
  const active =
    cursor.active.result === null
      ? { ...cursor.active, result: timeoutResult(cursor.active) }
      : cursor.active;
  const settled = { ...cursor, active };
  if (active.origin === "create") return advanceCreate(settled);
  if (active.origin === "other") {
    return freezeCleanupCursor({
      ...settled,
      active: null,
      sharedSlot: spendSharedSlot(settled),
      failed: settled.failed || active.result.outcome !== "complete",
    });
  }

  const { id, operation, result } = active;
  const common = {
    ...settled,
    active: null,
    sharedSlot: active.settledByShared
      ? spendSharedSlot(settled)
      : settled.sharedSlot,
  };
  if (id !== undefined) {
    const collection = settled.phase === "initial-ids" ? "ids" : "finalIds";
    if (settled.phase !== "initial-ids" && settled.phase !== "final-ids") {
      throw new Error("ID cleanup outside ID phase");
    }
    const entries = replaceId(settled[collection], id, operation, result.outcome);
    const advancedEntry = entries.find((entry) => entry.id === id);
    return freezeCleanupCursor(
      normalizeIdPhase({
        ...common,
        [collection]: entries,
        failed: settled.failed || advancedEntry.state === "failed",
      }),
    );
  }

  switch (operation) {
    case "name-recovery": {
      let advanced = {
        ...common,
        sharedSlot: spendSharedSlot(settled),
        create: { ...settled.create, recovery: "attempted" },
      };
      if (result.outcome === "found") advanced = addCustodiedId(advanced, result.id, "ids");
      return freezeCleanupCursor(
        normalizeIdPhase({
          ...advanced,
          phase: advanced.ids.length === 0 ? "preliminary-census" : "initial-ids",
          failed:
            advanced.failed ||
            result.outcome !== "found" ||
            (settled.watcher.event !== null &&
              result.outcome === "found" &&
              settled.watcher.event.id !== result.id),
          create: {
            ...advanced.create,
            recovery: result.outcome === "found" ? "attempted" : "uncertain",
          },
        }),
      );
    }
    case "preliminary-census":
      return freezeCleanupCursor({
        ...common,
        phase: "close",
        preliminary: {
          ...settled.preliminary,
          result: result.outcome,
          deferredId: result.deferredId ?? null,
        },
        failed: settled.failed || result.outcome === "uncertain",
      });
    case "send-close":
      return freezeCleanupCursor({
        ...common,
        phase: "watcher",
        watcher: {
          ...settled.watcher,
          closeSent: result.outcome === "sent",
          stage: active.stage,
          capReached: active.capReached,
        },
        failed:
          settled.failed ||
          result.outcome !== "sent" ||
          (settled.watcher.window !== null &&
            settled.lastBootNs >= settled.watcher.window.endNs),
      });
    case "settle-watcher":
      return freezeCleanupCursor(
        normalizeIdPhase({
          ...common,
          phase: "final-ids",
          failed:
            settled.failed ||
            result.outcome !== "reaped" ||
            !settled.watcher.eofObserved ||
            !settled.watcher.reaped,
        }),
      );
    case "final-census":
      return freezeCleanupCursor({
        ...common,
        phase: "path-helper",
        finalCensus: result.outcome === "empty",
        failed: settled.failed || result.outcome !== "empty",
      });
    case "path-helper":
      return freezeCleanupCursor({
        ...common,
        phase: "parent-absence",
        pathCleanup: result.outcome === "complete",
        failed: settled.failed || result.outcome !== "complete",
      });
    case "parent-absence":
      return freezeCleanupCursor({
        ...common,
        phase: "complete",
        parentAbsence: result.outcome === "absent",
        failed:
          settled.failed ||
          result.outcome !== "absent" ||
          !terminalIdentityAgreement(settled),
      });
    default:
      throw new Error("cleanup operation cannot advance");
  }
}

function latchCleanup(cursor, transition, nowNs) {
  if (!["normal", "signal", "deadline", "failure"].includes(transition.cause)) {
    throw new Error("invalid cleanup latch cause");
  }
  if (transition.cause === "deadline" && nowNs < cursor.activeDeadlineNs) {
    throw new Error("early active-deadline latch");
  }
  if (transition.cause === "normal" && nowNs >= cursor.activeDeadlineNs) {
    throw new Error("normal cleanup after active deadline");
  }
  if (transition.cause === "normal" && cursor.active !== null) {
    throw new Error("normal cleanup entered with an active child");
  }
  if (
    cursor.revocation.latched &&
    (cursor.revocation.cause !== "normal" || transition.cause === "normal")
  ) {
    return freezeCleanupCursor(cursor);
  }
  let active = cursor.active;
  let sharedSlot = cursor.sharedSlot;
  if (active !== null && !active.reaped) {
    if (active.origin === "create") {
      active = { ...active, window: latchWindow(cursor, nowNs, "create") };
    } else {
      if (
        sharedSlot.state === "claimed" &&
        sharedSlot.owner === "name-recovery" &&
        active.operation === "name-recovery"
      ) {
        active = { ...active, settledByShared: true };
      } else if (sharedSlot.state === "available") {
        sharedSlot = { state: "claimed", owner: "active-child" };
        active = {
          ...active,
          window: latchWindow(cursor, nowNs, active.origin),
          settledByShared: true,
        };
      } else {
        active = { ...active, settledByShared: false };
      }
    }
  }
  return freezeCleanupCursor({
    ...cursor,
    failed: cursor.failed || transition.cause !== "normal",
    revocation: { latched: true, cause: transition.cause, atNs: nowNs },
    sharedSlot,
    active,
  });
}

function advanceActiveStage(cursor, transition, nowNs) {
  if (
    cursor.active === null ||
    cursor.active.window === null ||
    cursor.active.reaped ||
    cursor.active.capReached
  ) {
    throw new Error("no live cleanup child stage");
  }
  if (transition.token !== cursor.active.token) {
    throw new Error("owned child stage token mismatch");
  }
  const { window } = cursor.active;
  if (transition.stage === "term") {
    if (
      cursor.active.stage !== "settle" ||
      nowNs < window.normalEndNs
    ) {
      throw new Error("invalid cleanup TERM transition");
    }
  } else if (transition.stage === "kill") {
    if (
      cursor.active.stage !== "term" ||
      nowNs < window.termEndNs
    ) {
      throw new Error("invalid cleanup KILL transition");
    }
  } else {
    throw new Error("invalid cleanup child stage");
  }
  return freezeCleanupCursor({
    ...cursor,
    watcher:
      cursor.active.operation === "send-close" ||
      cursor.active.operation === "settle-watcher"
        ? { ...cursor.watcher, stage: transition.stage }
        : cursor.watcher,
    active: { ...cursor.active, stage: transition.stage },
  });
}

function adoptEventId(cursor, transition) {
  const id = requireContainerId(transition.id);
  if (
    !cursor.watcher.ready ||
    cursor.watcher.eofObserved ||
    cursor.watcher.reaped ||
    ["final-ids", "final-census", "path-helper", "parent-absence", "complete"].includes(
      cursor.phase,
    )
  ) {
    throw new Error("event arrived outside watcher READY-to-EOF interval");
  }
  if (cursor.watcher.eventCount !== 0) {
    return freezeCleanupCursor({
      ...cursor,
      failed: true,
      watcher: { ...cursor.watcher, eventCount: cursor.watcher.eventCount + 1 },
    });
  }

  const event = {
    id,
    sequence: cursor.sequence,
    atNs: cursor.lastBootNs,
  };
  const watcher = { ...cursor.watcher, eventCount: 1, event };
  if (!cursor.create.issued) {
    return latchCleanup(
      freezeCleanupCursor({ ...cursor, watcher, failed: true }),
      { cause: "failure" },
      cursor.lastBootNs,
    );
  }
  const known = [...cursor.ids, ...cursor.finalIds].some((entry) => entry.id === id);
  const cancelsIdleRecovery = cursor.phase === "name-recovery" && cursor.active === null;
  const responseMismatch =
    cursor.create.responseId !== null && cursor.create.responseId !== id;
  if (known) {
    return freezeCleanupCursor({
      ...cursor,
      watcher,
      failed: cursor.failed || responseMismatch,
      ...(cancelsIdleRecovery
        ? {
            phase: "initial-ids",
            create: { ...cursor.create, recovery: "unneeded" },
          }
        : {}),
    });
  }
  if (cursor.ids.length + cursor.finalIds.length >= 2) {
    return freezeCleanupCursor({ ...cursor, watcher, failed: true });
  }

  const entry = { id, state: "remove-1" };
  if (cursor.active?.origin === "create" || cursor.phase === "initial-ids") {
    return freezeCleanupCursor({
      ...cursor,
      watcher,
      ids: [...cursor.ids, entry],
      failed: cursor.failed || responseMismatch,
    });
  }
  if (cursor.phase === "preliminary-census" && cursor.active === null) {
    return freezeCleanupCursor({
      ...cursor,
      phase: "initial-ids",
      watcher,
      ids: [...cursor.ids, entry],
      failed: cursor.failed || responseMismatch,
    });
  }
  if (cursor.phase === "name-recovery") {
    return freezeCleanupCursor({
      ...cursor,
      watcher,
      ids: [...cursor.ids, entry],
      failed: cursor.failed || responseMismatch,
      ...(cancelsIdleRecovery
        ? {
            phase: "initial-ids",
            create: { ...cursor.create, recovery: "unneeded" },
          }
        : {}),
    });
  }
  return freezeCleanupCursor({
    ...cursor,
    watcher,
    finalIds: [...cursor.finalIds, entry],
    failed: cursor.failed || responseMismatch,
  });
}

function observeWatcherEof(cursor) {
  if (
    cursor.watcher.eofObserved ||
    cursor.watcher.reaped ||
    cursor.phase !== "watcher" ||
    cursor.active?.operation !== "settle-watcher"
  ) {
    throw new Error("invalid watcher EOF transition");
  }
  return freezeCleanupCursor({
    ...cursor,
    watcher: {
      ...cursor.watcher,
      eofObserved: true,
    },
    failed: cursor.failed || !cursor.watcher.closeSent,
  });
}

export function reduceCleanupCursor(cursor, transition, sample) {
  requireCleanupCursor(cursor);
  if (
    transition === null ||
    typeof transition !== "object" ||
    Array.isArray(transition)
  ) {
    throw new Error("invalid cleanup transition");
  }
  const stamped = stampCursor(cursor, sample);
  switch (transition.type) {
    case "begin-child":
      return beginOwnedChild(stamped.cursor, transition, stamped.nowNs);
    case "latch":
      return latchCleanup(stamped.cursor, transition, stamped.nowNs);
    case "watcher-event":
      return adoptEventId(stamped.cursor, transition);
    case "watcher-eof":
      return observeWatcherEof(stamped.cursor);
    case "begin-operation":
      return beginCleanupOperation(stamped.cursor, transition, stamped.nowNs);
    case "advance-child-stage":
      return advanceActiveStage(stamped.cursor, transition, stamped.nowNs);
    case "expire-active":
      return expireActive(stamped.cursor, transition, stamped.nowNs);
    case "observe-reap":
      return observeOwnedChildReap(stamped.cursor, transition, stamped.nowNs);
    case "record-result":
      return recordResult(stamped.cursor, transition, stamped.nowNs);
    case "advance":
      return advanceRecordedOperation(stamped.cursor);
    default:
      throw new Error("unsupported cleanup transition");
  }
}
