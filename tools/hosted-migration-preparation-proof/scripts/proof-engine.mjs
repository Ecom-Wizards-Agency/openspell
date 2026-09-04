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

const cleanupCursors = new WeakSet();
const terminalIdStates = new Set(["absent", "failed"]);
const removeOutcomes = new Set(["removed", "error", "ambiguous", "hung"]);
const absenceOutcomes = new Set(["absent", "present", "error", "ambiguous", "hung"]);

function freezeCleanupCursor(cursor) {
  const frozen = Object.freeze({
    ...cursor,
    ids: Object.freeze(cursor.ids.map((entry) => Object.freeze({ ...entry }))),
    finalIds: Object.freeze(
      cursor.finalIds.map((entry) => Object.freeze({ ...entry })),
    ),
    active:
      cursor.active === null ? null : Object.freeze({ ...cursor.active }),
  });
  cleanupCursors.add(frozen);
  return frozen;
}

function requireCleanupCursor(cursor) {
  if (!cleanupCursors.has(cursor)) throw new Error("invalid cleanup cursor");
  return cursor;
}

function pendingId(entries) {
  return entries.find((entry) => !terminalIdStates.has(entry.state));
}

function normalizeIdPhase(cursor) {
  if (cursor.phase === "initial-ids" && pendingId(cursor.ids) === undefined) {
    return { ...cursor, phase: "preliminary-census" };
  }
  if (cursor.phase === "final-ids" && pendingId(cursor.finalIds) === undefined) {
    return { ...cursor, phase: "final-census" };
  }
  return cursor;
}

export function createCleanupCursor(ids) {
  const unique = [...new Set(ids)];
  if (unique.length > 2 || unique.some((id) => !invocationPattern.test(id))) {
    throw new Error("invalid cleanup custody set");
  }
  return freezeCleanupCursor({
    phase: unique.length === 0 ? "preliminary-census" : "initial-ids",
    latched: false,
    failed: false,
    eventCount: 0,
    ids: Object.freeze(unique.map((id) => Object.freeze({ id, state: "remove-1" }))),
    finalIds: Object.freeze([]),
    active: null,
    preliminaryCensus: false,
    closeSent: false,
    watcherReaped: false,
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

function validateCleanupResult(operation, outcome) {
  const allowed = {
    "remove-1": removeOutcomes,
    "absence-1": absenceOutcomes,
    "remove-2": removeOutcomes,
    "absence-2": absenceOutcomes,
    "preliminary-census": new Set(["empty", "deferred-event", "uncertain"]),
    "send-close": new Set(["sent", "failed"]),
    "settle-watcher": new Set(["reaped", "failed"]),
    "final-census": new Set(["empty", "nonempty", "failed"]),
    "path-helper": new Set(["complete", "failed"]),
    "parent-absence": new Set(["absent", "present", "failed"]),
  }[operation];
  if (allowed === undefined || !allowed.has(outcome)) {
    throw new Error("invalid cleanup operation result");
  }
}

function beginCleanupOperation(cursor, transition) {
  if (cursor.active !== null) throw new Error("cleanup operation already active");
  const expected = expectedCleanupOperation(cursor);
  if (expected === null || transition.operation !== expected.operation) {
    throw new Error("cleanup operation replay or reorder");
  }
  if (expected.id === undefined) {
    if (transition.id !== undefined) throw new Error("unexpected cleanup operation ID");
  } else if (transition.id !== expected.id) {
    throw new Error("cleanup operation ID mismatch");
  }
  return freezeCleanupCursor({
    ...cursor,
    active: {
      operation: expected.operation,
      ...(expected.id === undefined ? {} : { id: expected.id }),
      result: null,
    },
  });
}

function recordCleanupResult(cursor, transition) {
  if (cursor.active === null || cursor.active.result !== null) {
    throw new Error("cleanup result replay or reorder");
  }
  validateCleanupResult(cursor.active.operation, transition.outcome);
  return freezeCleanupCursor({
    ...cursor,
    active: { ...cursor.active, result: transition.outcome },
  });
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

function advanceRecordedOperation(cursor) {
  if (cursor.active === null || cursor.active.result === null) {
    throw new Error("cleanup operation has no recorded result");
  }
  const { id, operation, result } = cursor.active;
  if (id !== undefined) {
    const collection = cursor.phase === "initial-ids" ? "ids" : "finalIds";
    if (cursor.phase !== "initial-ids" && cursor.phase !== "final-ids") {
      throw new Error("ID cleanup outside ID phase");
    }
    const entries = replaceId(cursor[collection], id, operation, result);
    const advancedEntry = entries.find((entry) => entry.id === id);
    const normalized = normalizeIdPhase({
      ...cursor,
      [collection]: entries,
      active: null,
      failed: cursor.failed || advancedEntry.state === "failed",
    });
    return freezeCleanupCursor(normalized);
  }

  switch (operation) {
    case "preliminary-census":
      return freezeCleanupCursor({
        ...cursor,
        phase: "close",
        active: null,
        preliminaryCensus: true,
        failed: cursor.failed || result === "uncertain",
      });
    case "send-close":
      return freezeCleanupCursor({
        ...cursor,
        phase: "watcher",
        active: null,
        closeSent: result === "sent",
        failed: cursor.failed || result !== "sent",
      });
    case "settle-watcher":
      return freezeCleanupCursor(
        normalizeIdPhase({
          ...cursor,
          phase: "final-ids",
          active: null,
          watcherReaped: result === "reaped",
          failed: cursor.failed || result !== "reaped",
        }),
      );
    case "final-census":
      return freezeCleanupCursor({
        ...cursor,
        phase: "path-helper",
        active: null,
        finalCensus: true,
        failed: cursor.failed || result !== "empty",
      });
    case "path-helper":
      return freezeCleanupCursor({
        ...cursor,
        phase: "parent-absence",
        active: null,
        pathCleanup: result === "complete",
        failed: cursor.failed || result !== "complete",
      });
    case "parent-absence":
      return freezeCleanupCursor({
        ...cursor,
        phase: "complete",
        active: null,
        parentAbsence: result === "absent",
        failed: cursor.failed || result !== "absent",
      });
    default:
      throw new Error("cleanup operation cannot advance");
  }
}

function adoptEventId(cursor, transition) {
  const id = requireContainerId(transition.id);
  if (!["initial-ids", "preliminary-census", "close", "watcher"].includes(cursor.phase)) {
    throw new Error("event arrived after watcher settlement");
  }
  if (cursor.eventCount !== 0) {
    return freezeCleanupCursor({
      ...cursor,
      eventCount: cursor.eventCount + 1,
      failed: true,
    });
  }

  const known = [...cursor.ids, ...cursor.finalIds].some((entry) => entry.id === id);
  if (known) {
    return freezeCleanupCursor({ ...cursor, eventCount: 1 });
  }
  if (cursor.ids.length + cursor.finalIds.length === 2) {
    return freezeCleanupCursor({ ...cursor, eventCount: 1, failed: true });
  }

  const entry = Object.freeze({ id, state: "remove-1" });
  if (cursor.phase === "initial-ids") {
    return freezeCleanupCursor({
      ...cursor,
      eventCount: 1,
      ids: [...cursor.ids, entry],
    });
  }
  if (cursor.phase === "preliminary-census" && cursor.active === null) {
    return freezeCleanupCursor({
      ...cursor,
      phase: "initial-ids",
      eventCount: 1,
      ids: [...cursor.ids, entry],
    });
  }
  return freezeCleanupCursor({
    ...cursor,
    eventCount: 1,
    finalIds: [...cursor.finalIds, entry],
  });
}

export function reduceCleanupCursor(cursor, transition) {
  requireCleanupCursor(cursor);
  if (
    transition === null ||
    typeof transition !== "object" ||
    Array.isArray(transition)
  ) {
    throw new Error("invalid cleanup transition");
  }
  switch (transition.type) {
    case "latch":
      return cursor.latched
        ? cursor
        : freezeCleanupCursor({ ...cursor, latched: true });
    case "adopt-event-id":
      return adoptEventId(cursor, transition);
    case "begin-operation":
      return beginCleanupOperation(cursor, transition);
    case "record-result":
      return recordCleanupResult(cursor, transition);
    case "advance":
      return advanceRecordedOperation(cursor);
    default:
      throw new Error("unsupported cleanup transition");
  }
}
