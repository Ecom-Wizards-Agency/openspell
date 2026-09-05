import { Buffer } from "node:buffer";
import { basename, dirname, join } from "node:path";
import { TextDecoder } from "node:util";

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

export const CUT_CASES = Object.freeze([
  "before-issue",
  "after-daemon-accept-before-delivery",
  "after-parent-custody-before-start",
]);
export const CUT_ACTIVE_NS = 900_000_000_000n;
export const CUT_INNER_CLEANUP_NS = 160_000_000_000n;
export const CUT_POST_REAP_NS = 50_000_000_000n;
export const CUT_OUTER_RESERVE_NS = 210_000_000_000n;
export const FAILED_CUT_TEARDOWN_NS = 130_000_000_000n;

const cutCaseSet = new Set(CUT_CASES);
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });
const MAXIMUM_JSON_DEPTH = 64;
const MAXIMUM_JSON_NODES = 131_072;
const INDEX_DIGEST = IMAGE.slice(IMAGE.lastIndexOf("@") + 1);
const CONFIG_DIGEST =
  "sha256:897e260d0a1a5a5146433bdb73f62bd84f5f47e846d3485e5f70f63912b5917d";
const MANIFEST_DIGEST = PLATFORM_MANIFEST_REFERENCE.slice(
  PLATFORM_MANIFEST_REFERENCE.lastIndexOf("@") + 1,
);
const MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
const CONFIG_MEDIA_TYPE = "application/vnd.oci.image.config.v1+json";
const LAYER_MEDIA_TYPE = "application/vnd.oci.image.layer.v1.tar+gzip";
const MANIFEST_SIZE = 1_940;
const CONFIG_SIZE = 4_547;
const PLATFORM_MANIFEST_ANNOTATIONS = Object.freeze([
  ["com.docker.official-images.bashbrew.arch", "amd64"],
  [
    "org.opencontainers.image.base.digest",
    "sha256:" + "f1695dea7f56437da0208aee8a6e473c" + "ec40a04864233ac5a344c5ee4b4f1d7e",
  ],
  ["org.opencontainers.image.base.name", "buildpack-deps:bookworm"],
  ["org.opencontainers.image.created", "2026-08-10T22:41:20Z"],
  [
    "org.opencontainers.image.revision",
    "5ba8fc7544e1880d0fc5" + "f56e9f11081082057dc2",
  ],
  [
    "org.opencontainers.image.source",
    "https://github.com/rust-lang/docker-rust.git#" +
      "5ba8fc7544e1880d0fc5" +
      "f56e9f11081082057dc2" +
      ":stable/bookworm",
  ],
  ["org.opencontainers.image.url", "https://hub.docker.com/_/rust"],
  ["org.opencontainers.image.version", "1-bookworm"],
]);
const LAYER_DESCRIPTORS = Object.freeze([
  ["sha256:3af9207d37990175f61d5ce9faa0c7373ffcd2d6da1b6ba0a9ca9d61f8f47cc9", 48_497_091],
  ["sha256:6b02178232c403d8a6d5b460ad955daba177c38e178ed7dd417e5c4d748e948d", 24_044_139],
  ["sha256:c5a4625b533197abb25ea2a32be06c59c984d97c3c2dc9952e0b76f2e81ee0d2", 64_408_267],
  ["sha256:d32ed818f20fae825717c40dbc77cd4ed4bcefad6ba95a83f8c4f3c1f8631c31", 211_659_733],
  ["sha256:a6c1a23a6280781f0cf3b6b3a43fc59462763953c4285dd4addc7d4963cc923f", 217_852_857],
]);
const ROOTFS_DIFF_IDS = Object.freeze([
  "sha256:63ecca237e30aca8ae79232ae01dddab7d8b42302f654f343f7cc7ddae60d57c",
  "sha256:e62aadfda549a23e76f5bb43a9a5c652f9e7312aba9edf5c1411f7d0aed54eed",
  "sha256:3acdb7d9b7ebcd7f62d99a996099a57b8367821f4d9a3f4b52239934425a7b98",
  "sha256:b33c96ad984974239102a1fe15e6427a3510f13aa320227b371c10bb40063356",
  "sha256:0bfd9a65e13cc2726159178398201f52cd4e5bd1c187584f6953c839438af7d5",
]);
const IMAGE_ENVIRONMENT = Object.freeze([
  "PATH=/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "RUSTUP_HOME=/usr/local/rustup",
  "CARGO_HOME=/usr/local/cargo",
  "RUST_VERSION=1.97.1",
]);
const IMAGE_SOURCE_LABEL = "https://github.com/rust-lang/docker-rust";
const JSON_STRING = Symbol("json-number-token");
const exactNameReceipts = new WeakSet();
const labelCensusReceipts = new WeakSet();
const removeReceipts = new WeakSet();
const absenceReceipts = new WeakSet();
const containerInspectionReceipts = new WeakSet();
const usedDockerObservationReceipts = new WeakSet();

function requireDockerReceiptProvenance(provenance, operations) {
  exactObjectKeys(provenance, ["token", "operation"], "Docker receipt provenance");
  if (!childTokens.has(provenance.token) || !operations.includes(provenance.operation)) {
    throw new Error("invalid Docker receipt provenance");
  }
  return provenance;
}

function freezeDockerReceipt(receipts, value, provenance, operations) {
  const source = requireDockerReceiptProvenance(provenance, operations);
  return freezeReceipt(receipts, {
    ...value,
    token: source.token,
    operation: source.operation,
  });
}

function freezeReceipt(receipts, value) {
  const receipt = Object.freeze(value);
  receipts.add(receipt);
  return receipt;
}

function requireCutCase(value) {
  if (!cutCaseSet.has(value)) throw new Error("invalid WP-201 cut case");
  return value;
}

function byteBuffer(value, label) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new Error(`invalid ${label} bytes`);
  }
  return Buffer.from(value);
}

function exactObjectKeys(value, expected, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\n") !== [...expected].sort().join("\n")
  ) {
    throw new Error(`invalid ${label} shape`);
  }
  return value;
}

function requireDockerResult(result, stdoutCap, stderrCap) {
  exactObjectKeys(result, ["status", "stdout", "stderr"], "Docker result");
  if (!Number.isInteger(result.status)) throw new Error("invalid Docker status");
  const stdout = byteBuffer(result.stdout, "Docker stdout");
  const stderr = byteBuffer(result.stderr, "Docker stderr");
  if (stdout.length > stdoutCap || stderr.length > stderrCap) {
    throw new Error("Docker output cap exceeded");
  }
  return { status: result.status, stdout, stderr };
}

class StrictJsonDecoder {
  constructor(text) {
    this.text = text;
    this.offset = 0;
    this.nodes = 0;
  }

  decode() {
    const value = this.parseValue(0);
    if (this.offset !== this.text.length) throw new Error("JSON trailing bytes");
    return value;
  }

  countNode() {
    this.nodes += 1;
    if (this.nodes > MAXIMUM_JSON_NODES) throw new Error("JSON node cap");
  }

  skipWhitespace() {
    while (
      [" ", "\t", "\r", "\n"].includes(this.text[this.offset])
    ) {
      this.offset += 1;
    }
  }

  parseValue(depth) {
    if (depth > MAXIMUM_JSON_DEPTH) throw new Error("JSON depth cap");
    this.skipWhitespace();
    const next = this.text[this.offset];
    if (next === "{") return this.parseObject(depth);
    if (next === "[") return this.parseArray(depth);
    if (next === '"') return this.parseString();
    if (next === "t") return this.parseLiteral("true", true);
    if (next === "f") return this.parseLiteral("false", false);
    if (next === "n") return this.parseLiteral("null", null);
    return this.parseNumber();
  }

  parseObject(depth) {
    this.countNode();
    this.offset += 1;
    const result = new Map();
    this.skipWhitespace();
    if (this.text[this.offset] === "}") {
      this.offset += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.offset] !== '"') throw new Error("JSON object key");
      const key = this.parseString();
      if (result.has(key)) throw new Error("JSON duplicate key");
      this.skipWhitespace();
      if (this.text[this.offset] !== ":") throw new Error("JSON object colon");
      this.offset += 1;
      result.set(key, this.parseValue(depth + 1));
      this.skipWhitespace();
      if (this.text[this.offset] === "}") {
        this.offset += 1;
        return result;
      }
      if (this.text[this.offset] !== ",") throw new Error("JSON object comma");
      this.offset += 1;
    }
  }

  parseArray(depth) {
    this.countNode();
    this.offset += 1;
    const result = [];
    this.skipWhitespace();
    if (this.text[this.offset] === "]") {
      this.offset += 1;
      return result;
    }
    for (;;) {
      result.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      if (this.text[this.offset] === "]") {
        this.offset += 1;
        return result;
      }
      if (this.text[this.offset] !== ",") throw new Error("JSON array comma");
      this.offset += 1;
    }
  }

  parseString() {
    this.countNode();
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.text.length) {
      const code = this.text.charCodeAt(this.offset);
      if (code === 0x22) {
        this.offset += 1;
        return JSON.parse(this.text.slice(start, this.offset));
      }
      if (code < 0x20) throw new Error("JSON string control");
      if (code !== 0x5c) {
        this.offset += 1;
        continue;
      }
      this.offset += 1;
      const escape = this.text[this.offset];
      if ('"\\/bfnrt'.includes(escape)) {
        this.offset += 1;
        continue;
      }
      if (
        escape !== "u" ||
        !/^[0-9a-fA-F]{4}$/u.test(this.text.slice(this.offset + 1, this.offset + 5))
      ) {
        throw new Error("JSON string escape");
      }
      this.offset += 5;
    }
    throw new Error("JSON string EOF");
  }

  parseLiteral(token, value) {
    this.countNode();
    if (!this.text.startsWith(token, this.offset)) throw new Error("JSON literal");
    this.offset += token.length;
    return value;
  }

  parseNumber() {
    this.countNode();
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
      this.text.slice(this.offset),
    );
    if (match === null) throw new Error("JSON number");
    this.offset += match[0].length;
    return Object.freeze({ [JSON_STRING]: match[0] });
  }
}

function decodeJsonLine(bytes, root) {
  if (bytes.length < 2 || bytes.at(-1) !== 0x0a) {
    throw new Error("JSON line framing");
  }
  let text;
  try {
    text = fatalUtf8.decode(bytes.subarray(0, -1));
  } catch {
    throw new Error("JSON UTF-8");
  }
  const decoded = new StrictJsonDecoder(text).decode();
  if (root === "object" && !(decoded instanceof Map)) throw new Error("JSON object root");
  if (root === "array" && !Array.isArray(decoded)) throw new Error("JSON array root");
  return decoded;
}

function mapValue(object, key) {
  if (!(object instanceof Map) || !object.has(key)) throw new Error(`missing ${key}`);
  return object.get(key);
}

function exactMapKeys(object, keys, label) {
  if (
    !(object instanceof Map) ||
    [...object.keys()].sort().join("\n") !== [...keys].sort().join("\n")
  ) {
    throw new Error(`invalid ${label} keys`);
  }
  return object;
}

function numberToken(value, label) {
  if (value === null || typeof value !== "object" || value[JSON_STRING] === undefined) {
    throw new Error(`invalid ${label}`);
  }
  return value[JSON_STRING];
}

function safeInteger(value, label) {
  const token = numberToken(value, label);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(token)) throw new Error(`invalid ${label}`);
  const result = Number(token);
  if (!Number.isSafeInteger(result)) throw new Error(`invalid ${label}`);
  return result;
}

function stringValue(value, label) {
  if (typeof value !== "string") throw new Error(`invalid ${label}`);
  return value;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function equalArray(actual, expected, label) {
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) {
    throw new Error(`invalid ${label}`);
  }
}

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

function requireZeroSuccess(result, stdoutCap, stderrCap) {
  const parsed = requireDockerResult(result, stdoutCap, stderrCap);
  if (parsed.status !== 0 || parsed.stderr.length !== 0) {
    throw new Error("Docker operation did not succeed exactly");
  }
  return parsed.stdout;
}

export function parseDockerContextName(result) {
  const stdout = requireZeroSuccess(result, 64, 0);
  if (!stdout.equals(Buffer.from("default\n", "ascii"))) {
    throw new Error("Docker context mismatch");
  }
  return "default";
}

export function parseDockerContextEndpoint(result) {
  const stdout = requireZeroSuccess(result, 4_096, 0);
  if (!stdout.equals(Buffer.from(`"${DOCKER_ENDPOINT}"\n`, "ascii"))) {
    throw new Error("Docker endpoint mismatch");
  }
  return DOCKER_ENDPOINT;
}

export function parseDockerApiSupport(result) {
  const stdout = requireZeroSuccess(result, 16 * 1024, 0);
  const root = decodeJsonLine(stdout, "object");
  const clientKeys = [
    "Platform",
    "Version",
    "ApiVersion",
    "DefaultAPIVersion",
    "GitCommit",
    "GoVersion",
    "Os",
    "Arch",
    "BuildTime",
    "Context",
  ];
  const client = exactMapKeys(mapValue(root, "Client"), clientKeys, "Docker client tuple");
  const server = mapValue(root, "Server");
  for (const [key, expected] of Object.entries({
    Platform: "Docker Engine - Community",
    Version: "29.7.2",
    ApiVersion: "1.55",
    DefaultAPIVersion: "1.55",
    GitCommit: "a7dcaa6",
    GoVersion: "go1.26.5",
    Os: "linux",
    Arch: "amd64",
    BuildTime: "Wed Aug  5 18:28:40 2026",
    Context: "default",
  })) {
    if (key === "Platform") {
      const platform = mapValue(client, key);
      exactMapKeys(platform, ["Name"], "Docker client platform");
      if (stringValue(mapValue(platform, "Name"), "client platform") !== expected) {
        throw new Error("Docker client tuple mismatch");
      }
    } else if (stringValue(mapValue(client, key), `client ${key}`) !== expected) {
      throw new Error("Docker client tuple mismatch");
    }
  }
  const serverApi = stringValue(mapValue(server, "ApiVersion"), "server API version");
  const match = /^(?<major>0|[1-9][0-9]{0,2})\.(?<minor>0|[1-9][0-9]{0,2})$/u.exec(serverApi);
  if (
    match?.groups === undefined ||
    BigInt(match.groups.major) !== 1n ||
    BigInt(match.groups.minor) < 49n
  ) {
    throw new Error("Docker server API is too old");
  }
  return Object.freeze({ clientApiVersion: "1.55", serverApiVersion: serverApi });
}

function requireDescriptor(value, expected, label, allowAnnotations = false) {
  const keys = allowAnnotations && value instanceof Map && value.has("annotations")
    ? ["mediaType", "digest", "size", "platform", "annotations"]
    : expected.platform === undefined
      ? ["mediaType", "digest", "size"]
      : ["mediaType", "digest", "size", "platform"];
  exactMapKeys(value, keys, label);
  if (
    stringValue(mapValue(value, "mediaType"), `${label} media type`) !== expected.mediaType ||
    stringValue(mapValue(value, "digest"), `${label} digest`) !== expected.digest ||
    safeInteger(mapValue(value, "size"), `${label} size`) !== expected.size
  ) {
    throw new Error(`invalid ${label}`);
  }
  if (expected.platform !== undefined) {
    const platform = exactMapKeys(mapValue(value, "platform"), ["architecture", "os"], `${label} platform`);
    if (
      stringValue(mapValue(platform, "architecture"), `${label} architecture`) !== "amd64" ||
      stringValue(mapValue(platform, "os"), `${label} OS`) !== "linux"
    ) {
      throw new Error(`invalid ${label} platform`);
    }
  }
  if (value.has("annotations")) {
    const annotations = mapValue(value, "annotations");
    if (!(annotations instanceof Map) || annotations.size > 32) {
      throw new Error(`invalid ${label} annotations`);
    }
    for (const [key, annotation] of annotations) {
      if (
        typeof key !== "string" ||
        typeof annotation !== "string" ||
        Buffer.byteLength(key) > 4_096 ||
        Buffer.byteLength(annotation) > 4_096
      ) {
        throw new Error(`invalid ${label} annotations`);
      }
    }
  }
}

export function parseDockerPlatformManifest(result) {
  const stdout = requireZeroSuccess(result, 1024 * 1024, 1024 * 1024);
  const manifest = exactMapKeys(
    decodeJsonLine(stdout, "object"),
    ["schemaVersion", "mediaType", "config", "layers", "annotations"],
    "platform manifest",
  );
  if (
    safeInteger(mapValue(manifest, "schemaVersion"), "manifest schema") !== 2 ||
    stringValue(mapValue(manifest, "mediaType"), "manifest media type") !== MANIFEST_MEDIA_TYPE
  ) {
    throw new Error("platform manifest identity mismatch");
  }
  requireDescriptor(
    mapValue(manifest, "config"),
    { mediaType: CONFIG_MEDIA_TYPE, digest: CONFIG_DIGEST, size: CONFIG_SIZE },
    "manifest config",
  );
  const layers = mapValue(manifest, "layers");
  if (!Array.isArray(layers) || layers.length !== LAYER_DESCRIPTORS.length) {
    throw new Error("manifest layer count mismatch");
  }
  for (const [index, [digest, size]] of LAYER_DESCRIPTORS.entries()) {
    requireDescriptor(
      layers[index],
      { mediaType: LAYER_MEDIA_TYPE, digest, size },
      `manifest layer ${index}`,
    );
  }
  const annotations = exactMapKeys(
    mapValue(manifest, "annotations"),
    PLATFORM_MANIFEST_ANNOTATIONS.map(([key]) => key),
    "platform manifest annotations",
  );
  for (const [key, expected] of PLATFORM_MANIFEST_ANNOTATIONS) {
    if (stringValue(mapValue(annotations, key), `manifest annotation ${key}`) !== expected) {
      throw new Error("platform manifest annotation mismatch");
    }
  }
  return Object.freeze({ manifestDigest: MANIFEST_DIGEST, configDigest: CONFIG_DIGEST });
}

function normalizeRepositoryDigest(value) {
  const suffix = `@${INDEX_DIGEST}`;
  if (!value.endsWith(suffix)) return null;
  const repository = value.slice(0, -suffix.length);
  return ["rust", "library/rust", "docker.io/library/rust", "index.docker.io/library/rust"].includes(repository)
    ? `docker.io/library/rust${suffix}`
    : null;
}

function requireImageConfig(value) {
  exactMapKeys(value, ["Env", "Cmd", "Labels"], "image Config");
  equalArray(stringArray(mapValue(value, "Env"), "image Env"), IMAGE_ENVIRONMENT, "image Env");
  equalArray(stringArray(mapValue(value, "Cmd"), "image Cmd"), ["bash"], "image Cmd");
  const labels = exactMapKeys(
    mapValue(value, "Labels"),
    ["org.opencontainers.image.source"],
    "image Labels",
  );
  if (mapValue(labels, "org.opencontainers.image.source") !== IMAGE_SOURCE_LABEL) {
    throw new Error("image source label mismatch");
  }
}

function requireRootFs(value) {
  exactMapKeys(value, ["Type", "Layers"], "image RootFS");
  if (mapValue(value, "Type") !== "layers") throw new Error("image RootFS type mismatch");
  equalArray(stringArray(mapValue(value, "Layers"), "rootfs layers"), ROOTFS_DIFF_IDS, "rootfs layers");
}

function requireImageObject(image) {
  const id = stringValue(mapValue(image, "Id"), "image ID");
  const repositoryDigests = stringArray(mapValue(image, "RepoDigests"), "image RepoDigests");
  const normalized = repositoryDigests.map(normalizeRepositoryDigest).filter((entry) => entry !== null);
  if (normalized.length !== 1 || new Set(normalized).size !== 1) {
    throw new Error("image repository digest mismatch");
  }
  if (
    mapValue(image, "Os") !== "linux" ||
    mapValue(image, "Architecture") !== "amd64"
  ) {
    throw new Error("image platform mismatch");
  }
  requireRootFs(mapValue(image, "RootFS"));
  requireImageConfig(mapValue(image, "Config"));
  const descriptor = image.get("Descriptor");
  if (descriptor === undefined || descriptor === null) {
    if (id !== CONFIG_DIGEST) throw new Error("classic image identity mismatch");
    return Object.freeze({ localImageId: id, store: "classic" });
  }
  if (id !== MANIFEST_DIGEST) throw new Error("containerd image identity mismatch");
  requireDescriptor(
    descriptor,
    {
      mediaType: MANIFEST_MEDIA_TYPE,
      digest: MANIFEST_DIGEST,
      size: MANIFEST_SIZE,
      platform: true,
    },
    "image descriptor",
    true,
  );
  return Object.freeze({ localImageId: id, store: "containerd" });
}

export function classifyDockerCachedImage(result) {
  const parsed = requireDockerResult(result, 1024 * 1024, 1024 * 1024);
  const missing = Buffer.from(
    `Error response from daemon: No such image: rust:1.97.1-bookworm@${INDEX_DIGEST}\n`,
    "ascii",
  );
  if (
    parsed.status === 1 &&
    parsed.stdout.equals(Buffer.from("[]\n", "ascii")) &&
    parsed.stderr.equals(missing)
  ) {
    return Object.freeze({ outcome: "missing" });
  }
  if (parsed.status !== 0 || parsed.stderr.length !== 0) {
    throw new Error("unclassified cached-image result");
  }
  const values = decodeJsonLine(parsed.stdout, "array");
  if (values.length !== 1 || !(values[0] instanceof Map)) {
    throw new Error("invalid cached-image response");
  }
  return Object.freeze({ outcome: "present", ...requireImageObject(values[0]) });
}

export function parseDockerLabelCensus(result, invocation, provenance) {
  const censusInvocation = requireInvocation(invocation);
  const source = requireDockerReceiptProvenance(
    provenance,
    ["label-census", "final-label-census"],
  );
  const stdout = requireZeroSuccess(result, 1024 * 1024, 0);
  if (stdout.length === 0) {
    return freezeDockerReceipt(labelCensusReceipts, {
      invocation: censusInvocation,
      ids: Object.freeze([]),
    }, source, [source.operation]);
  }
  if (stdout.at(-1) !== 0x0a) throw new Error("label census framing");
  const rows = fatalUtf8.decode(stdout.subarray(0, -1)).split("\n");
  if (rows.some((id) => !invocationPattern.test(id)) || new Set(rows).size !== rows.length) {
    throw new Error("invalid label census");
  }
  return freezeDockerReceipt(labelCensusReceipts, {
    invocation: censusInvocation,
    ids: Object.freeze(rows),
  }, source, [source.operation]);
}

function requireClosedTarget(options) {
  exactObjectKeys(options, ["kind", "invocation", ...(options?.kind === "proof" ? ["rowId"] : [])], "container target");
  const invocation = requireInvocation(options.invocation);
  if (options.kind === "acquisition") {
    return Object.freeze({
      name: acquisitionContainerName(invocation),
      role: ACQUISITION_ROLE,
    });
  }
  if (options.kind === "proof") {
    return Object.freeze({
      name: proofContainerName(invocation, options.rowId),
      role: PROOF_ROLE,
    });
  }
  throw new Error("invalid container target kind");
}

function exactContainerNotFound(name) {
  return Buffer.from(`Error response from daemon: No such container: ${name}\n`, "ascii");
}

export function classifyDockerExactName(result, options, provenance) {
  const target = requireClosedTarget(options);
  const source = requireDockerReceiptProvenance(
    provenance,
    [
      "exact-name-acquisition",
      "exact-name-proof",
      "exact-name-recovery",
      "exact-name-census",
      "final-exact-name-census",
      "accepted-id-validation",
    ],
  );
  const receiptIdentity = {
    kind: options.kind,
    invocation: options.invocation,
    rowId: options.kind === "proof" ? options.rowId : null,
    name: target.name,
    role: target.role,
  };
  const parsed = requireDockerResult(result, 1024 * 1024, 1024 * 1024);
  if (
    parsed.status === 1 &&
    parsed.stdout.equals(Buffer.from("[]\n", "ascii")) &&
    parsed.stderr.equals(exactContainerNotFound(target.name))
  ) {
    return freezeDockerReceipt(
      exactNameReceipts,
      { outcome: "absent", ...receiptIdentity },
      source,
      [source.operation],
    );
  }
  if (parsed.status !== 0 || parsed.stderr.length !== 0) {
    throw new Error("unclassified exact-name result");
  }
  const values = decodeJsonLine(parsed.stdout, "array");
  if (values.length !== 1 || !(values[0] instanceof Map)) {
    throw new Error("invalid exact-name inspection");
  }
  const id = requireContainerIdentity(values[0], options, target);
  return freezeDockerReceipt(
    exactNameReceipts,
    { outcome: "present", id, ...receiptIdentity },
    source,
    [source.operation],
  );
}

export function parseDockerCreatedId(result) {
  const classified = classifyDockerCreateResult(result);
  if (!classified.success || classified.custodyId === null) {
    throw new Error("Docker create did not succeed exactly");
  }
  return classified.custodyId;
}

export function classifyDockerCreateResult(result) {
  exactObjectKeys(result, ["status", "stdout", "stderr"], "Docker create result");
  if (result.status !== null && !Number.isInteger(result.status)) {
    throw new Error("invalid Docker create status");
  }
  const parsed = {
    status: result.status,
    stdout: byteBuffer(result.stdout, "Docker create stdout"),
    stderr: byteBuffer(result.stderr, "Docker create stderr"),
  };
  if (parsed.stdout.length > 4_096 || parsed.stderr.length > 4_096) {
    throw new Error("Docker create output cap exceeded");
  }
  let text;
  try {
    text = fatalUtf8.decode(parsed.stdout);
  } catch {
    text = undefined;
  }
  const custodyId = /^[0-9a-f]{64}\n$/u.test(text) ? text.slice(0, -1) : null;
  return Object.freeze({
    custodyId,
    response:
      custodyId !== null
        ? "bound"
        : parsed.stdout.length === 0
          ? "missing"
          : "malformed",
    success:
      parsed.status === 0 && parsed.stderr.length === 0 && custodyId !== null,
  });
}

export function parseDockerRemove(result, id, provenance) {
  requireContainerId(id);
  const stdout = requireZeroSuccess(result, 4_096, 4_096);
  if (!stdout.equals(Buffer.from(`${id}\n`, "ascii"))) {
    throw new Error("invalid remove response");
  }
  return freezeDockerReceipt(
    removeReceipts,
    { outcome: "removed", id },
    provenance,
    ["remove", "remove-1", "remove-2"],
  );
}

export function parseDockerAbsence(result, id, provenance) {
  requireContainerId(id);
  const parsed = requireDockerResult(result, 1024 * 1024, 1024 * 1024);
  if (
    parsed.status !== 1 ||
    !parsed.stdout.equals(Buffer.from("[]\n", "ascii")) ||
    !parsed.stderr.equals(exactContainerNotFound(id))
  ) {
    throw new Error("container absence not proved");
  }
  return freezeDockerReceipt(
    absenceReceipts,
    { outcome: "absent", id },
    provenance,
    ["absence", "accepted-id-absence", "absence-1", "absence-2"],
  );
}

function expectedContainerCommand(options) {
  const arguments_ = options.kind === "acquisition"
    ? acquisitionCreateArguments({
        invocation: options.invocation,
        invocationDirectory: options.invocationDirectory,
        uid: options.uid,
        gid: options.gid,
      })
    : proofCreateArguments({
        invocation: options.invocation,
        invocationDirectory: options.invocationDirectory,
        rowId: options.rowId,
        ledgerSha256: options.ledgerSha256,
      });
  const imageIndex = arguments_.indexOf(IMAGE);
  if (imageIndex < 0) throw new Error("image missing from create vector");
  return arguments_.slice(imageIndex + 1);
}

function normalizedTmpfs(target, execution, size, identity = []) {
  return fixedTmpfs(target, execution, size, identity).slice(target.length + 1);
}

function expectedContainerHostConfiguration(options) {
  const root = options.invocationDirectory;
  const proof = options.kind === "proof";
  const bindMounts = proof
    ? [
        [join(root, "source"), "/input/source", true],
        [join(root, "acquisition/vendor"), "/input/vendor", true],
        [join(root, "acquisition/toolchain"), "/input/toolchain", true],
        [join(root, "acquisition/vendor-ledger.v1"), "/input/vendor-ledger.v1", false],
        [join(root, "control/proof.sh"), "/input/control.sh", false],
        [join(root, "control/hostname"), "/etc/hostname", false],
        [join(root, "control/hosts"), "/etc/hosts", false],
        [join(root, "control/resolv.conf"), "/etc/resolv.conf", false],
      ]
    : [
        [join(root, "source"), "/input/source", true],
        [join(root, "control/acquisition.sh"), "/input/control.sh", false],
      ];
  const tmpfs = proof
    ? [
        ["/cargo", normalizedTmpfs("/cargo", "noexec", "268435456")],
        ["/target", normalizedTmpfs("/target", "exec", "4294967296")],
        ["/tmp", normalizedTmpfs("/tmp", "noexec", "1073741824")],
        ["/fixtures", normalizedTmpfs("/fixtures", "noexec", "2147483648")],
        ["/wp201-home", normalizedTmpfs("/wp201-home", "noexec", "16777216")],
      ]
    : [
        [
          "/output",
          normalizedTmpfs("/output", "exec", "1073741824", [
            `uid=${String(options.uid)}`,
            `gid=${String(options.gid)}`,
          ]),
        ],
        [
          "/tmp",
          normalizedTmpfs("/tmp", "noexec", "1073741824", [
            `uid=${String(options.uid)}`,
            `gid=${String(options.gid)}`,
          ]),
        ],
        [
          "/wp201-home",
          normalizedTmpfs("/wp201-home", "noexec", "16777216", [
            `uid=${String(options.uid)}`,
            `gid=${String(options.gid)}`,
          ]),
        ],
      ];
  return Object.freeze({
    networkMode: proof ? "none" : "bridge",
    pidsLimit: proof ? 512 : 128,
    memory: proof ? 6_442_450_944 : 2_147_483_648,
    nanoCpus: proof ? 4_000_000_000 : 2_000_000_000,
    shmSize: proof ? 2_147_483_648 : 268_435_456,
    ulimits: proof
      ? [["nofile", 1_024, 1_024], ["nproc", 512, 512]]
      : [["nofile", 1_024, 1_024]],
    bindMounts,
    tmpfs,
  });
}

function requireEmptyMap(value, label) {
  if (!(value instanceof Map) || value.size !== 0) throw new Error(`invalid ${label}`);
}

function requireEmptyArray(value, label) {
  if (!Array.isArray(value) || value.length !== 0) throw new Error(`invalid ${label}`);
}

const HOST_CONFIG_KEYS = Object.freeze([
  "Binds", "ContainerIDFile", "LogConfig", "NetworkMode", "PortBindings", "RestartPolicy",
  "AutoRemove", "VolumeDriver", "VolumesFrom", "ConsoleSize", "CapAdd", "CapDrop",
  "CgroupnsMode", "Dns", "DnsOptions", "DnsSearch", "ExtraHosts", "GroupAdd", "IpcMode",
  "Cgroup", "Links", "OomScoreAdj", "PidMode", "Privileged", "PublishAllPorts",
  "ReadonlyRootfs", "SecurityOpt", "Tmpfs", "UTSMode", "UsernsMode", "ShmSize", "Runtime",
  "Isolation", "CpuShares", "Memory", "NanoCpus", "CgroupParent", "BlkioWeight",
  "BlkioWeightDevice", "BlkioDeviceReadBps", "BlkioDeviceWriteBps", "BlkioDeviceReadIOps",
  "BlkioDeviceWriteIOps", "CpuPeriod", "CpuQuota", "CpuRealtimePeriod", "CpuRealtimeRuntime",
  "CpusetCpus", "CpusetMems", "Devices", "DeviceCgroupRules", "DeviceRequests",
  "MemoryReservation", "MemorySwap", "MemorySwappiness", "OomKillDisable", "PidsLimit",
  "Ulimits", "CpuCount", "CpuPercent", "IOMaximumIOps", "IOMaximumBandwidth", "Mounts",
  "MaskedPaths", "ReadonlyPaths", "Init",
]);

const DEFAULT_MASKED_PATHS = Object.freeze([
  "/proc/acpi", "/proc/asound", "/proc/interrupts", "/proc/kcore", "/proc/keys",
  "/proc/latency_stats", "/proc/sched_debug", "/proc/scsi", "/proc/timer_list",
  "/proc/timer_stats", "/sys/devices/virtual/powercap", "/sys/firmware",
]);

const DEFAULT_READONLY_PATHS = Object.freeze([
  "/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger",
]);

function requireContainerHostConfiguration(container, options) {
  const host = exactMapKeys(mapValue(container, "HostConfig"), HOST_CONFIG_KEYS, "container HostConfig");
  const expected = expectedContainerHostConfiguration(options);
  for (const [field, value] of Object.entries({
    NetworkMode: expected.networkMode,
    ReadonlyRootfs: true,
    Privileged: false,
    IpcMode: "private",
    CgroupnsMode: "private",
    PidMode: "",
    UTSMode: "",
    UsernsMode: "host",
    Runtime: "runc",
    Init: false,
    AutoRemove: false,
    PublishAllPorts: false,
    ContainerIDFile: "",
    VolumeDriver: "",
    Cgroup: "",
    Isolation: "",
    CgroupParent: "",
    CpusetCpus: "",
    CpusetMems: "",
  })) {
    if (mapValue(host, field) !== value) throw new Error(`container HostConfig ${field} mismatch`);
  }
  if (
    mapValue(host, "Binds") !== null ||
    mapValue(host, "CapAdd") !== null ||
    mapValue(host, "GroupAdd") !== null ||
    mapValue(host, "VolumesFrom") !== null ||
    mapValue(host, "Dns") !== null ||
    mapValue(host, "ExtraHosts") !== null ||
    mapValue(host, "Links") !== null ||
    mapValue(host, "DeviceCgroupRules") !== null ||
    mapValue(host, "DeviceRequests") !== null ||
    mapValue(host, "MemorySwappiness") !== null
  ) {
    throw new Error("container HostConfig forbidden authority");
  }
  const expectedOomKillDisable = options.state === "created" ? false : null;
  if (mapValue(host, "OomKillDisable") !== expectedOomKillDisable) {
    throw new Error("container HostConfig OomKillDisable mismatch");
  }
  const devices = mapValue(host, "Devices");
  if (!Array.isArray(devices) || devices.length !== 0) {
    throw new Error("container HostConfig devices mismatch");
  }
  requireEmptyMap(mapValue(host, "PortBindings"), "container PortBindings");
  for (const field of [
    "DnsOptions", "DnsSearch", "BlkioWeightDevice", "BlkioDeviceReadBps",
    "BlkioDeviceWriteBps", "BlkioDeviceReadIOps", "BlkioDeviceWriteIOps",
  ]) {
    requireEmptyArray(mapValue(host, field), `container ${field}`);
  }
  const consoleSize = mapValue(host, "ConsoleSize");
  if (
    !Array.isArray(consoleSize) ||
    consoleSize.length !== 2 ||
    consoleSize.some((entry, index) => safeInteger(entry, `console size ${index}`) !== 0)
  ) {
    throw new Error("container ConsoleSize mismatch");
  }
  equalArray(stringArray(mapValue(host, "CapDrop"), "container CapDrop"), ["ALL"], "container CapDrop");
  equalArray(
    stringArray(mapValue(host, "SecurityOpt"), "container SecurityOpt"),
    ["no-new-privileges", "seccomp=builtin", "apparmor=docker-default"],
    "container SecurityOpt",
  );
  const restart = exactMapKeys(
    mapValue(host, "RestartPolicy"),
    ["Name", "MaximumRetryCount"],
    "container RestartPolicy",
  );
  if (
    mapValue(restart, "Name") !== "no" ||
    safeInteger(mapValue(restart, "MaximumRetryCount"), "restart retry count") !== 0
  ) {
    throw new Error("container RestartPolicy mismatch");
  }
  const log = exactMapKeys(mapValue(host, "LogConfig"), ["Type", "Config"], "container LogConfig");
  if (mapValue(log, "Type") !== "none") throw new Error("container LogConfig mismatch");
  requireEmptyMap(mapValue(log, "Config"), "container LogConfig options");
  for (const [field, value] of Object.entries({
    PidsLimit: expected.pidsLimit,
    Memory: expected.memory,
    MemorySwap: expected.memory,
    NanoCpus: expected.nanoCpus,
    ShmSize: expected.shmSize,
    OomScoreAdj: 0,
    CpuShares: 0,
    BlkioWeight: 0,
    CpuPeriod: 0,
    CpuQuota: 0,
    CpuRealtimePeriod: 0,
    CpuRealtimeRuntime: 0,
    MemoryReservation: 0,
    CpuCount: 0,
    CpuPercent: 0,
    IOMaximumIOps: 0,
    IOMaximumBandwidth: 0,
  })) {
    if (safeInteger(mapValue(host, field), `container ${field}`) !== value) {
      throw new Error(`container HostConfig ${field} mismatch`);
    }
  }
  equalArray(
    stringArray(mapValue(host, "MaskedPaths"), "container MaskedPaths"),
    DEFAULT_MASKED_PATHS,
    "container MaskedPaths",
  );
  equalArray(
    stringArray(mapValue(host, "ReadonlyPaths"), "container ReadonlyPaths"),
    DEFAULT_READONLY_PATHS,
    "container ReadonlyPaths",
  );
  const ulimits = mapValue(host, "Ulimits");
  if (!Array.isArray(ulimits) || ulimits.length !== expected.ulimits.length) {
    throw new Error("container Ulimits mismatch");
  }
  for (const [index, [name, hard, soft]] of expected.ulimits.entries()) {
    const ulimit = exactMapKeys(ulimits[index], ["Name", "Hard", "Soft"], `container Ulimit ${index}`);
    if (
      mapValue(ulimit, "Name") !== name ||
      safeInteger(mapValue(ulimit, "Hard"), `container Ulimit ${index} hard`) !== hard ||
      safeInteger(mapValue(ulimit, "Soft"), `container Ulimit ${index} soft`) !== soft
    ) {
      throw new Error("container Ulimits mismatch");
    }
  }
  const tmpfs = mapValue(host, "Tmpfs");
  if (!(tmpfs instanceof Map) || tmpfs.size !== expected.tmpfs.length) {
    throw new Error("container Tmpfs mismatch");
  }
  for (const [target, settings] of expected.tmpfs) {
    if (mapValue(tmpfs, target) !== settings) throw new Error("container Tmpfs mismatch");
  }
  const mounts = mapValue(host, "Mounts");
  if (!Array.isArray(mounts) || mounts.length !== expected.bindMounts.length) {
    throw new Error("container configured mounts mismatch");
  }
  for (const [index, [source, target, recursiveReadOnly]] of expected.bindMounts.entries()) {
    const mount = exactMapKeys(
      mounts[index],
      ["Type", "Source", "Target", "ReadOnly", "BindOptions"],
      `container mount ${index}`,
    );
    if (
      mapValue(mount, "Type") !== "bind" ||
      mapValue(mount, "Source") !== source ||
      mapValue(mount, "Target") !== target ||
      mapValue(mount, "ReadOnly") !== true
    ) {
      throw new Error("container configured mount mismatch");
    }
    const bindOptions = exactMapKeys(
      mapValue(mount, "BindOptions"),
      recursiveReadOnly ? ["Propagation", "ReadOnlyForceRecursive"] : ["Propagation"],
      `container mount ${index} bind options`,
    );
    if (
      mapValue(bindOptions, "Propagation") !== "rprivate" ||
      (recursiveReadOnly && mapValue(bindOptions, "ReadOnlyForceRecursive") !== true)
    ) {
      throw new Error("container configured mount options mismatch");
    }
  }
}

function requireContainerIdentity(container, options, target = requireClosedTarget(options)) {
  const id = requireContainerId(stringValue(mapValue(container, "Id"), "container ID"));
  if (mapValue(container, "Name") !== `/${target.name}`) {
    throw new Error("container name mismatch");
  }
  const config = exactMapKeys(
    mapValue(container, "Config"),
    [
      "Hostname", "Domainname", "User", "AttachStdin", "AttachStdout", "AttachStderr", "Tty",
      "OpenStdin", "StdinOnce", "Env", "Cmd", "Image", "Volumes", "WorkingDir", "Entrypoint",
      "Labels",
    ],
    "container Config",
  );
  if (mapValue(config, "Image") !== IMAGE) throw new Error("configured image mismatch");
  if (mapValue(config, "Volumes") !== null) throw new Error("configured volumes mismatch");
  if (mapValue(config, "Domainname") !== "") throw new Error("container domain mismatch");
  const labels = exactMapKeys(
    mapValue(config, "Labels"),
    [INVOCATION_LABEL, ROLE_LABEL, "org.opencontainers.image.source"],
    "container labels",
  );
  if (
    mapValue(labels, INVOCATION_LABEL) !== options.invocation ||
    mapValue(labels, ROLE_LABEL) !== target.role ||
    mapValue(labels, "org.opencontainers.image.source") !== IMAGE_SOURCE_LABEL
  ) {
    throw new Error("container label mismatch");
  }
  return id;
}

function requireStorePairing(container, localImageId) {
  const imageId = stringValue(mapValue(container, "Image"), "container image ID");
  const descriptor = container.get("ImageManifestDescriptor");
  if (localImageId === CONFIG_DIGEST) {
    if (imageId !== CONFIG_DIGEST || (descriptor !== undefined && descriptor !== null)) {
      throw new Error("classic container image pairing mismatch");
    }
    return "classic";
  }
  if (localImageId !== MANIFEST_DIGEST || imageId !== INDEX_DIGEST) {
    throw new Error("containerd container image pairing mismatch");
  }
  requireDescriptor(
    descriptor,
    { mediaType: MANIFEST_MEDIA_TYPE, digest: MANIFEST_DIGEST, size: MANIFEST_SIZE, platform: true },
    "container image descriptor",
    true,
  );
  return "containerd";
}

export function parseDockerContainerInspection(result, options, provenance) {
  const expectedKeys = [
    "kind",
    "invocation",
    "invocationDirectory",
    "localImageId",
    "state",
    ...(options?.kind === "acquisition" ? ["uid", "gid"] : ["rowId", "ledgerSha256"]),
  ];
  exactObjectKeys(options, expectedKeys, "container inspection options");
  const target = requireClosedTarget(
    options.kind === "proof"
      ? { kind: options.kind, invocation: options.invocation, rowId: options.rowId }
      : { kind: options.kind, invocation: options.invocation },
  );
  requireInvocationDirectory(options.invocationDirectory, options.invocation);
  if (![CONFIG_DIGEST, MANIFEST_DIGEST].includes(options.localImageId)) {
    throw new Error("invalid local image identity");
  }
  if (!['created', 'exited-zero'].includes(options.state)) {
    throw new Error("invalid requested container state");
  }
  const stdout = requireZeroSuccess(result, 1024 * 1024, 1024 * 1024);
  const values = decodeJsonLine(stdout, "array");
  if (values.length !== 1 || !(values[0] instanceof Map)) {
    throw new Error("invalid container inspection response");
  }
  const container = values[0];
  const id = requireContainerIdentity(container, options, target);
  const store = requireStorePairing(container, options.localImageId);
  requireContainerHostConfiguration(container, options);
  const config = mapValue(container, "Config");
  if (
    mapValue(config, "Entrypoint") === null ||
    !Array.isArray(mapValue(config, "Entrypoint"))
  ) {
    throw new Error("container entrypoint mismatch");
  }
  equalArray(stringArray(mapValue(config, "Entrypoint"), "container entrypoint"), ["/usr/bin/env"], "container entrypoint");
  equalArray(stringArray(mapValue(config, "Cmd"), "container command"), expectedContainerCommand(options), "container command");
  equalArray(stringArray(mapValue(config, "Env"), "container environment"), IMAGE_ENVIRONMENT, "container environment");
  if (mapValue(config, "WorkingDir") !== "/tmp") throw new Error("container workdir mismatch");
  const proof = options.kind === "proof";
  const expectedUser = proof ? "0:0" : `${String(options.uid)}:${String(options.gid)}`;
  const expectedHostname = proof ? "wp201-proof" : "wp201-acquisition";
  if (
    mapValue(config, "User") !== expectedUser ||
    mapValue(config, "Hostname") !== expectedHostname
  ) {
    throw new Error("container user or hostname mismatch");
  }
  for (const [field, expected] of Object.entries({
    AttachStdin: proof,
    OpenStdin: proof,
    StdinOnce: proof,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  })) {
    if (mapValue(config, field) !== expected) throw new Error(`container ${field} mismatch`);
  }
  if (safeInteger(mapValue(container, "RestartCount"), "restart count") !== 0) {
    throw new Error("container restart count mismatch");
  }
  const state = mapValue(container, "State");
  if (!(state instanceof Map)) throw new Error("invalid container State");
  const expectedState = options.state === "created"
    ? { Status: "created", Running: false, Restarting: false, Paused: false, Dead: false, OOMKilled: false, ExitCode: 0, Error: "", Pid: 0 }
    : { Status: "exited", Running: false, Restarting: false, Paused: false, Dead: false, OOMKilled: false, ExitCode: 0, Error: "", Pid: 0 };
  for (const [field, expected] of Object.entries(expectedState)) {
    const actual = mapValue(state, field);
    const normalized = typeof expected === "number" ? safeInteger(actual, `state ${field}`) : actual;
    if (normalized !== expected) throw new Error(`container state ${field} mismatch`);
  }
  return freezeDockerReceipt(
    containerInspectionReceipts,
    {
      id,
      store,
      state: options.state,
      kind: options.kind,
      invocation: options.invocation,
      role: target.role,
      name: target.name,
      rowId: options.kind === "proof" ? options.rowId : null,
    },
    provenance,
    ["inspect", "configuration-inspect", "accepted-id-validation", "exact-name-recovery"],
  );
}

export function parseDockerEventReadyFrame(bytes) {
  const value = byteBuffer(bytes, "event READY");
  if (!value.equals(Buffer.from("openspell.wp201.docker-event-ready.v1\n", "ascii"))) {
    throw new Error("invalid event READY frame");
  }
  return true;
}

export function parseDockerEventIdFrame(bytes) {
  const value = fatalUtf8.decode(byteBuffer(bytes, "event ID"));
  const match = /^openspell\.wp201\.docker-event-id\.v1\n(?<id>[0-9a-f]{64})\n$/u.exec(value);
  if (match?.groups === undefined) throw new Error("invalid event ID frame");
  return match.groups.id;
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

const cutTerminalReceipts = new WeakSet();
const cutAcceptedReceipts = new WeakSet();
const cutSignalAcknowledgementReceipts = new WeakSet();
const cutSignalAcknowledgementsByToken = new WeakMap();
const usedCutSignalAcknowledgementReceipts = new WeakSet();
const cutAuditReceipts = new WeakSet();
const cutHarnessReapReceipts = new WeakSet();
const usedCutHarnessReapReceipts = new WeakSet();

function requireKnownChildToken(token, label) {
  if (!childTokens.has(token)) throw new Error(`invalid ${label} process token`);
  return token;
}

export function parseCutTerminalResult(result, token) {
  const processToken = requireKnownChildToken(token, "cut terminal");
  exactObjectKeys(result, ["status", "stdout", "stderr"], "cut terminal result");
  if (result.status !== 73) throw new Error("cut terminal status mismatch");
  const stdout = byteBuffer(result.stdout, "cut terminal stdout");
  const stderr = byteBuffer(result.stderr, "cut terminal stderr");
  if (stdout.length > 64 || stderr.length > 128) {
    throw new Error("cut terminal output cap exceeded");
  }
  if (stdout.length !== 0) throw new Error("cut terminal stdout mismatch");
  if (!stderr.equals(Buffer.from("openspell.wp201.interrupted-before-start.v1\n", "ascii"))) {
    throw new Error("cut terminal stderr mismatch");
  }
  return freezeReceipt(cutTerminalReceipts, {
    token: processToken,
    status: 73,
    interruptedBeforeStart: true,
  });
}

export function parseCutAcceptedIdFrame(bytes, cutCase, token) {
  const acceptedCase = requireCutCase(cutCase);
  const processToken = requireKnownChildToken(token, "cut accepted-ID");
  const input = byteBuffer(bytes, "cut accepted ID");
  if (input.length > 128) throw new Error("cut accepted-ID frame cap");
  let value;
  try {
    value = fatalUtf8.decode(input);
  } catch {
    throw new Error("cut accepted-ID UTF-8");
  }
  const match = /^openspell\.wp201\.real-cut-accepted-id\.v1\n(?<value>none|[0-9a-f]{64})\n$/u.exec(value);
  if (match?.groups === undefined) throw new Error("invalid cut accepted-ID frame");
  const accepted = match.groups.value === "none" ? null : match.groups.value;
  if ((cutCase === "before-issue") !== (accepted === null)) {
    throw new Error("cut accepted-ID case mismatch");
  }
  return freezeReceipt(cutAcceptedReceipts, {
    token: processToken,
    cutCase: acceptedCase,
    acceptedId: accepted,
  });
}

const cutIdentities = new WeakSet();

export function parseCutIdentityFrame(bytes, token) {
  const processToken = requireKnownChildToken(token, "cut identity");
  const value = byteBuffer(bytes, "cut identity");
  if (value.length > 320) throw new Error("cut identity frame cap");
  let text;
  try {
    text = fatalUtf8.decode(value);
  } catch {
    throw new Error("cut identity UTF-8");
  }
  const lines = text.split("\n");
  if (
    lines.length !== 11 ||
    lines[0] !== "openspell.wp201.real-cut-identity.v2" ||
    lines[10] !== ""
  ) {
    throw new Error("invalid cut identity frame");
  }
  const cutCase = requireCutCase(lines[1]);
  if (!invocationPattern.test(lines[2])) throw new Error("invalid cut invocation");
  if (!["tmp", "var-tmp"].includes(lines[3])) throw new Error("invalid cut parent");
  for (const [index, label] of [
    [4, "directory device"],
    [5, "directory inode"],
    [6, "directory mount ID"],
    [8, "watcher PID"],
    [9, "watcher start time"],
  ]) {
    if (!/^(?:0|[1-9][0-9]{0,19})$/u.test(lines[index])) {
      throw new Error(`invalid cut ${label}`);
    }
  }
  if (!digestPattern.test(lines[7])) throw new Error("invalid cut ledger digest");
  const identity = Object.freeze({
    token: processToken,
    cutCase,
    invocation: lines[2],
    parent: lines[3],
    directoryDevice: lines[4],
    directoryInode: lines[5],
    directoryMountId: lines[6],
    ledgerSha256: lines[7],
    watcherPid: lines[8],
    watcherStartTime: lines[9],
  });
  cutIdentities.add(identity);
  return identity;
}

export function requireCutIdentityAgreement(identity, expected) {
  if (!cutIdentities.has(identity)) throw new Error("unparsed cut identity");
  exactObjectKeys(
    expected,
    [
      "cutCase",
      "invocation",
      "parent",
      "directoryDevice",
      "directoryInode",
      "directoryMountId",
      "ledgerSha256",
    ],
    "cut identity expectation",
  );
  for (const key of Object.keys(expected)) {
    if (identity?.[key] !== expected[key]) throw new Error("cut identity mismatch");
  }
  return identity;
}

export function parseCutSignalAcknowledgement(bytes, cutCase, token) {
  const acknowledgedCase = requireCutCase(cutCase);
  const processToken = requireKnownChildToken(token, "cut signal acknowledgment");
  if (cutSignalAcknowledgementsByToken.has(processToken)) {
    throw new Error("cut signal acknowledgment token replay");
  }
  const value = byteBuffer(bytes, "cut signal acknowledgment");
  if (value.length !== 155 || value.at(-1) !== 0x0a) {
    throw new Error("cut signal acknowledgment framing");
  }
  let text;
  try {
    text = fatalUtf8.decode(value);
  } catch {
    throw new Error("cut signal acknowledgment UTF-8");
  }
  const match = /^openspell\.wp201\.real-cut-audit-open\.v1\nopenspell\.wp201\.real-cut-signal-latched\.v2\nSIGTERM\n(?<challenge>[0-9a-f]{64})\n$/u.exec(text);
  if (match?.groups?.challenge === undefined) {
    throw new Error("invalid cut signal acknowledgment");
  }
  const receipt = freezeReceipt(cutSignalAcknowledgementReceipts, {
    token: processToken,
    cutCase: acknowledgedCase,
    signalLatched: true,
    challenge: match.groups.challenge,
  });
  cutSignalAcknowledgementsByToken.set(processToken, receipt);
  return receipt;
}

export function buildCutReleaseFrame(acknowledgement, token) {
  const processToken = requireKnownChildToken(token, "cut release");
  if (
    !cutSignalAcknowledgementReceipts.has(acknowledgement) ||
    cutSignalAcknowledgementsByToken.get(processToken) !== acknowledgement ||
    usedCutSignalAcknowledgementReceipts.has(acknowledgement) ||
    acknowledgement.token !== processToken
  ) {
    throw new Error("invalid cut signal acknowledgment receipt");
  }
  const frame = Buffer.from(
    `openspell.wp201.real-cut-release.v2\n${acknowledgement.cutCase}\n${acknowledgement.challenge}\n`,
    "ascii",
  );
  if (frame.length > 160) throw new Error("cut release frame cap");
  usedCutSignalAcknowledgementReceipts.add(acknowledgement);
  return frame;
}

export function parseCutAuditStream(bytes, acknowledgement, token) {
  const processToken = requireKnownChildToken(token, "cut audit");
  if (
    !cutSignalAcknowledgementReceipts.has(acknowledgement) ||
    cutSignalAcknowledgementsByToken.get(processToken) !== acknowledgement ||
    !usedCutSignalAcknowledgementReceipts.has(acknowledgement) ||
    acknowledgement.token !== processToken
  ) {
    throw new Error("invalid cut audit acknowledgment receipt");
  }
  const value = byteBuffer(bytes, "cut audit");
  if (value.length === 0 || value.length > 512 || value.at(-1) !== 0x0a) {
    throw new Error("cut audit framing");
  }
  let text;
  try {
    text = fatalUtf8.decode(value);
  } catch {
    throw new Error("cut audit UTF-8");
  }
  const lines = text.slice(0, -1).split("\n");
  const frames = [];
  for (let index = 0; index < lines.length;) {
    const magic = lines[index];
    if (
      [
        "openspell.wp201.real-cut-audit-open.v1",
        "openspell.wp201.real-cut-audit-close.v1",
        "openspell.wp201.real-cut-forbidden-create.v1",
        "openspell.wp201.real-cut-forbidden-config-inspect.v1",
        "openspell.wp201.real-cut-forbidden-start-attach.v1",
      ].includes(magic)
    ) {
      frames.push(Object.freeze({ magic }));
      index += 1;
      continue;
    }
    if (magic === "openspell.wp201.real-cut-signal-latched.v2") {
      if (
        lines[index + 1] !== "SIGTERM" ||
        !digestPattern.test(lines[index + 2]) ||
        lines[index + 2] !== acknowledgement.challenge
      ) {
        throw new Error("cut audit signal mismatch");
      }
      frames.push(Object.freeze({ magic, signal: "SIGTERM" }));
      index += 3;
      continue;
    }
    if (magic === "openspell.wp201.real-cut-start-attach.v1") {
      const role = lines[index + 1];
      const id = lines[index + 2];
      if (![ACQUISITION_ROLE, PROOF_ROLE].includes(role) || !invocationPattern.test(id)) {
        throw new Error("invalid cut audit start frame");
      }
      frames.push(Object.freeze({ magic, role, id }));
      index += 3;
      continue;
    }
    throw new Error("unknown cut audit frame");
  }
  const expected = [
    "openspell.wp201.real-cut-audit-open.v1",
    "openspell.wp201.real-cut-signal-latched.v2",
    "openspell.wp201.real-cut-audit-close.v1",
  ];
  if (
    frames.length !== expected.length ||
    frames.some((frame, index) => frame.magic !== expected[index])
  ) {
    throw new Error("cut audit terminal sequence mismatch");
  }
  return freezeReceipt(cutAuditReceipts, {
    token: processToken,
    open: true,
    signalLatched: true,
    close: true,
    dispatches: 0,
  });
}

export function createCutHarnessReapReceipt(options) {
  exactObjectKeys(
    options,
    ["cutCase", "token", "terminal", "accepted", "identity", "audit", "structural"],
    "cut harness reap receipt options",
  );
  const cutCase = requireCutCase(options.cutCase);
  const processToken = requireKnownChildToken(options.token, "cut harness reap");
  if (options.structural === null || typeof options.structural !== "object") {
    throw new Error("invalid cut harness structure");
  }
  exactObjectKeys(
    options.structural,
    options.structural.kind === "not-created"
      ? ["kind"]
      : ["kind", "releaseWriterClosed", "eof", "groupAbsent"],
    "cut harness structure",
  );
  const notCreated = options.structural.kind === "not-created";
  let structural;
  if (!notCreated) {
    if (options.structural.kind !== "reaped") throw new Error("invalid cut harness structure kind");
    if (options.structural.eof === null || typeof options.structural.eof !== "object") {
      throw new Error("invalid cut harness EOF structure");
    }
    exactObjectKeys(
      options.structural.eof,
      ["stdout", "stderr", "identity", "accepted", "audit"],
      "cut harness EOF structure",
    );
    if (
      options.structural.releaseWriterClosed !== true ||
      options.structural.groupAbsent !== true ||
      Object.values(options.structural.eof).some((value) => value !== true)
    ) {
      throw new Error("cut harness not fully reaped");
    }
    structural = Object.freeze({
      kind: "reaped",
      releaseWriterClosed: true,
      eof: Object.freeze({
        stdout: true,
        stderr: true,
        identity: true,
        accepted: true,
        audit: true,
      }),
      groupAbsent: true,
    });
  } else {
    structural = Object.freeze({ kind: "not-created" });
  }
  for (const [receipt, receipts, label] of [
    [options.terminal, cutTerminalReceipts, "terminal"],
    [options.accepted, cutAcceptedReceipts, "accepted-ID"],
    [options.identity, cutIdentities, "identity"],
    [options.audit, cutAuditReceipts, "audit"],
  ]) {
    if (receipt !== null && !receipts.has(receipt)) {
      throw new Error(`unparsed cut ${label} receipt`);
    }
    if (receipt !== null && receipt.token !== processToken) {
      throw new Error("mixed cut harness process receipts");
    }
  }
  if (
    (options.accepted !== null && options.accepted.cutCase !== cutCase) ||
    (options.identity !== null && options.identity.cutCase !== cutCase)
  ) {
    throw new Error("cut harness receipt case mismatch");
  }
  if (
    notCreated &&
    [options.terminal, options.accepted, options.identity, options.audit].some(
      (receipt) => receipt !== null,
    )
  ) {
    throw new Error("not-created cut harness cannot carry process receipts");
  }
  const valid =
    !notCreated &&
    options.terminal !== null &&
    options.accepted !== null &&
    options.identity !== null &&
    options.audit !== null;
  return freezeReceipt(cutHarnessReapReceipts, {
    token: processToken,
    cutCase,
    valid,
    invocation: options.identity?.invocation ?? null,
    acceptedId: options.accepted?.acceptedId ?? null,
    structural,
  });
}

const watcherCustodies = new WeakSet();

function freezeWatcherCustody(value) {
  const result = Object.freeze({ ...value });
  watcherCustodies.add(result);
  return result;
}

export function createPreReadyWatcherCustody(options) {
  exactObjectKeys(
    options,
    ["token", "sample", "activeDeadlineNs", "hardDeadlineNs"],
    "pre-READY watcher options",
  );
  requireFreshChildToken(options.token);
  const nowNs = requireSample(options.sample);
  if (
    typeof options.activeDeadlineNs !== "bigint" ||
    typeof options.hardDeadlineNs !== "bigint" ||
    options.hardDeadlineNs - options.activeDeadlineNs !== CLEANUP_RESERVE_NS ||
    nowNs >= options.activeDeadlineNs
  ) {
    throw new Error("invalid pre-READY watcher deadlines");
  }
  usedChildTokens.add(options.token);
  return freezeWatcherCustody({
    token: options.token,
    phase: "opening",
    lastBootNs: nowNs,
    activeDeadlineNs: options.activeDeadlineNs,
    hardDeadlineNs: options.hardDeadlineNs,
    cleanupWindow: null,
    stage: "settle",
    failed: false,
    reaped: false,
  });
}

export function reducePreReadyWatcherCustody(custody, transition, sample) {
  if (!watcherCustodies.has(custody)) throw new Error("invalid pre-READY watcher custody");
  if (transition === null || typeof transition !== "object" || Array.isArray(transition)) {
    throw new Error("invalid pre-READY watcher transition");
  }
  const nowNs = requireSample(sample);
  if (nowNs < custody.lastBootNs || nowNs >= custody.hardDeadlineNs) {
    throw new Error("pre-READY watcher deadline");
  }
  if (transition.type === "ready") {
    exactObjectKeys(transition, ["type"], "watcher READY transition");
    if (custody.phase !== "opening" || nowNs >= custody.activeDeadlineNs) {
      throw new Error("invalid watcher READY transition");
    }
    return freezeWatcherCustody({ ...custody, phase: "ready", lastBootNs: nowNs });
  }
  if (transition.type === "latch") {
    exactObjectKeys(transition, ["type"], "watcher latch transition");
    if (custody.phase !== "opening" || custody.cleanupWindow !== null) {
      throw new Error("invalid watcher latch transition");
    }
    const reservedTail = 35n * SECOND_NS;
    const endCap = custody.hardDeadlineNs - reservedTail;
    const endNs = nowNs + SHARED_SLOT_NS < endCap ? nowNs + SHARED_SLOT_NS : endCap;
    if (endNs <= nowNs) throw new Error("pre-READY watcher suffix exhausted");
    return freezeWatcherCustody({
      ...custody,
      phase: "settling",
      lastBootNs: nowNs,
      failed: true,
      cleanupWindow: Object.freeze({
        normalEndNs: nowNs + 5n * SECOND_NS < endNs ? nowNs + 5n * SECOND_NS : endNs,
        termEndNs: nowNs + 7n * SECOND_NS < endNs ? nowNs + 7n * SECOND_NS : endNs,
        endNs,
      }),
    });
  }
  if (transition.type === "advance-stage") {
    exactObjectKeys(transition, ["type", "stage"], "watcher stage transition");
    if (custody.phase !== "settling" || custody.cleanupWindow === null) {
      throw new Error("invalid watcher stage transition");
    }
    if (
      transition.stage === "term" &&
      custody.stage === "settle" &&
      nowNs >= custody.cleanupWindow.normalEndNs
    ) {
      return freezeWatcherCustody({ ...custody, stage: "term", lastBootNs: nowNs });
    }
    if (
      transition.stage === "kill" &&
      custody.stage === "term" &&
      nowNs >= custody.cleanupWindow.termEndNs
    ) {
      return freezeWatcherCustody({ ...custody, stage: "kill", lastBootNs: nowNs });
    }
    throw new Error("invalid watcher stage transition");
  }
  if (transition.type === "reap") {
    exactObjectKeys(transition, ["type"], "watcher reap transition");
    if (
      custody.phase !== "settling" ||
      custody.cleanupWindow === null ||
      nowNs >= custody.cleanupWindow.endNs ||
      (nowNs >= custody.cleanupWindow.termEndNs && custody.stage !== "kill") ||
      (nowNs >= custody.cleanupWindow.normalEndNs && custody.stage === "settle")
    ) {
      throw new Error("invalid watcher reap transition");
    }
    return freezeWatcherCustody({
      ...custody,
      phase: "reaped",
      lastBootNs: nowNs,
      reaped: true,
    });
  }
  throw new Error("unsupported pre-READY watcher transition");
}

const cutSupervisors = new WeakSet();
const POST_REAP_SLOTS = Object.freeze([
  Object.freeze({ operation: "accepted-id-absence", kind: "docker", budgetNs: 10n * SECOND_NS }),
  Object.freeze({ operation: "exact-name-census", kind: "docker", budgetNs: 10n * SECOND_NS }),
  Object.freeze({ operation: "label-census", kind: "docker", budgetNs: 10n * SECOND_NS }),
  Object.freeze({ operation: "local-absence", kind: "local", budgetNs: 5n * SECOND_NS }),
  Object.freeze({ operation: "custody", kind: "local", budgetNs: 10n * SECOND_NS }),
]);
const FAILED_TEARDOWN_SLOTS = Object.freeze([
  Object.freeze({ operation: "accepted-id-validation", kind: "docker", budgetNs: 10n * SECOND_NS }),
  Object.freeze({ operation: "exact-name-recovery", kind: "docker", budgetNs: 10n * SECOND_NS }),
  Object.freeze({ operation: "remove-1", kind: "docker", budgetNs: 10n * SECOND_NS }),
  Object.freeze({ operation: "absence-1", kind: "docker", budgetNs: 10n * SECOND_NS }),
  Object.freeze({ operation: "remove-2", kind: "docker", budgetNs: 10n * SECOND_NS }),
  Object.freeze({ operation: "absence-2", kind: "docker", budgetNs: 10n * SECOND_NS }),
  Object.freeze({ operation: "final-exact-name-census", kind: "docker", budgetNs: 10n * SECOND_NS }),
  Object.freeze({ operation: "final-label-census", kind: "docker", budgetNs: 10n * SECOND_NS }),
  Object.freeze({ operation: "failed-path-helper", kind: "helper", budgetNs: 10n * SECOND_NS }),
  Object.freeze({ operation: "parent-absence", kind: "local", budgetNs: 5n * SECOND_NS }),
  Object.freeze({ operation: "descriptor-settlement", kind: "local", budgetNs: 10n * SECOND_NS }),
]);

function freezeCutSupervisor(value) {
  const result = Object.freeze({
    ...value,
    slots: Object.freeze(value.slots),
    active: value.active === null ? null : Object.freeze({ ...value.active }),
  });
  cutSupervisors.add(result);
  return result;
}

function remainingSlotBudget(slots, index) {
  return slots.slice(index).reduce((total, slot) => total + slot.budgetNs, 0n);
}

export function createCutSupervisorCursor(options) {
  exactObjectKeys(
    options,
    ["cutCase", "harnessToken", "invocation", "sample"],
    "cut supervisor options",
  );
  const startedAtNs = requireSample(options.sample);
  requireFreshChildToken(options.harnessToken);
  usedChildTokens.add(options.harnessToken);
  return freezeCutSupervisor({
    cutCase: requireCutCase(options.cutCase),
    harnessToken: options.harnessToken,
    invocation: requireInvocation(options.invocation),
    startedAtNs,
    lastBootNs: startedAtNs,
    activeDeadlineNs: startedAtNs + CUT_ACTIVE_NS,
    innerDeadlineNs: startedAtNs + CUT_ACTIVE_NS + CUT_INNER_CLEANUP_NS,
    outerDeadlineNs: startedAtNs + CUT_ACTIVE_NS + CUT_OUTER_RESERVE_NS,
    postReapStartNs: null,
    postReapDeadlineNs: null,
    postReapBudgetNs: null,
    phase: "harness",
    harnessReaped: false,
    acceptedId: null,
    adoptedId: null,
    absenceProved: false,
    failed: false,
    residue: false,
    slots: Object.freeze([]),
    slotIndex: 0,
    active: null,
    teardownDeadlineNs: null,
  });
}

export function expectedCutSupervisorOperation(cursor) {
  if (!cutSupervisors.has(cursor)) throw new Error("invalid cut supervisor cursor");
  if (!["post-reap", "failed-teardown"].includes(cursor.phase) || cursor.active !== null) return null;
  return cursor.slots[cursor.slotIndex]?.operation ?? null;
}

function beginCutSlot(cursor, transition, nowNs) {
  if (cursor.active !== null) throw new Error("cut supervisor slot already active");
  const slot = cursor.slots[cursor.slotIndex];
  if (slot === undefined || transition.operation !== slot.operation) {
    throw new Error("cut supervisor slot reorder");
  }
  const idBound = new Set([
    "accepted-id-validation",
    "accepted-id-absence",
    "remove-1",
    "absence-1",
    "remove-2",
    "absence-2",
  ]).has(slot.operation);
  const expectedKeys = slot.kind === "local"
    ? ["type", "operation"]
    : ["type", "operation", "token", ...(idBound ? ["id"] : [])];
  exactObjectKeys(transition, expectedKeys, "cut supervisor begin-slot");
  if (slot.kind !== "local") {
    const targetId = ["accepted-id-validation", "accepted-id-absence"].includes(slot.operation)
      ? cursor.acceptedId
      : idBound
        ? cursor.adoptedId
        : null;
    if (idBound && (targetId === null || transition.id !== targetId)) {
      throw new Error("cut supervisor cleanup identity mismatch");
    }
    if (slot.operation === "accepted-id-validation" && cursor.acceptedId === null) {
      throw new Error("accepted-ID validation is inapplicable");
    }
    if (slot.operation === "exact-name-recovery" && cursor.adoptedId !== null) {
      throw new Error("exact-name recovery is inapplicable");
    }
    if (["remove-2", "absence-2"].includes(slot.operation) && cursor.absenceProved) {
      throw new Error("second cleanup attempt is inapplicable");
    }
    requireFreshChildToken(transition.token);
    usedChildTokens.add(transition.token);
  }
  const schedulingReserve = cursor.phase === "post-reap" ? 5n * SECOND_NS : 25n * SECOND_NS;
  const deadline = cursor.phase === "post-reap"
    ? cursor.postReapDeadlineNs
    : cursor.teardownDeadlineNs;
  const suffix = remainingSlotBudget(cursor.slots, cursor.slotIndex + 1) + schedulingReserve;
  const cap = deadline - suffix;
  const endNs = nowNs + slot.budgetNs < cap ? nowNs + slot.budgetNs : cap;
  if (endNs <= nowNs) throw new Error("cut supervisor suffix exhausted");
  return freezeCutSupervisor({
    ...cursor,
    lastBootNs: nowNs,
    active: {
      ...slot,
      ...(slot.kind === "local"
        ? {}
        : { token: transition.token, ...(idBound ? { id: transition.id } : {}) }),
      stage: "settle",
      normalEndNs: nowNs + (slot.kind === "helper" ? 4n : 5n) * SECOND_NS < endNs
        ? nowNs + (slot.kind === "helper" ? 4n : 5n) * SECOND_NS
        : endNs,
      termEndNs: nowNs + 7n * SECOND_NS < endNs ? nowNs + 7n * SECOND_NS : endNs,
      endNs,
    },
  });
}

function advanceSettledCutSlot(cursor, nowNs, failed, updates = {}) {
  const nextIndex = cursor.slotIndex + 1;
  const complete = nextIndex === cursor.slots.length;
  return freezeCutSupervisor({
    ...cursor,
    ...updates,
    lastBootNs: nowNs,
    failed: cursor.failed || failed,
    slotIndex: nextIndex,
    active: null,
    phase: failed && cursor.phase === "post-reap"
      ? "failed-ready"
      : complete
        ? cursor.phase === "post-reap"
          ? "complete"
          : cursor.residue
            ? "failed-residue"
            : "failed-complete"
        : cursor.phase,
  });
}

function validateCutSlotReceipt(cursor, transition) {
  const operation = cursor.active.operation;
  const pass = transition.outcome === "pass";
  const receipt = transition.receipt;
  if (
    receipt !== null &&
    (receipt.token !== cursor.active.token ||
      receipt.operation !== operation ||
      usedDockerObservationReceipts.has(receipt))
  ) {
    throw new Error("Docker observation receipt provenance mismatch or replay");
  }
  const validProofNameReceipt =
    exactNameReceipts.has(receipt) &&
    receipt.kind === "proof" &&
    receipt.invocation === cursor.invocation &&
    receipt.role === PROOF_ROLE &&
    receipt.name === proofContainerName(cursor.invocation, "root-fmt") &&
    receipt.rowId === "root-fmt";
  if (operation === "accepted-id-validation") {
    if (
      pass &&
      validProofNameReceipt &&
      receipt.outcome === "present" &&
      receipt.id === cursor.acceptedId
    ) {
      return { adoptedId: receipt.id, absenceProved: false };
    }
    if (!pass && receipt === null) return {};
    throw new Error("invalid accepted-ID validation receipt");
  }
  if (operation === "exact-name-recovery") {
    if (pass && validProofNameReceipt && receipt.outcome === "present") {
      return { adoptedId: receipt.id, absenceProved: false };
    }
    if (pass && validProofNameReceipt && receipt.outcome === "absent") return {};
    if (!pass && (receipt === null || validProofNameReceipt)) return {};
    throw new Error("invalid exact-name recovery receipt");
  }
  if (["accepted-id-absence", "absence-1", "absence-2"].includes(operation)) {
    if (
      pass &&
      absenceReceipts.has(receipt) &&
      receipt.id === cursor.active.id
    ) {
      return operation === "accepted-id-absence" ? {} : { absenceProved: true };
    }
    if (!pass && receipt === null) return {};
    throw new Error("invalid Docker absence receipt");
  }
  if (["remove-1", "remove-2"].includes(operation)) {
    if (pass && removeReceipts.has(receipt) && receipt.id === cursor.active.id) return {};
    if (!pass && receipt === null) return {};
    throw new Error("invalid Docker removal receipt");
  }
  if (["exact-name-census", "final-exact-name-census"].includes(operation)) {
    if (pass && validProofNameReceipt && receipt.outcome === "absent") return {};
    if (!pass && (receipt === null || validProofNameReceipt)) return {};
    throw new Error("invalid exact-name census receipt");
  }
  if (["label-census", "final-label-census"].includes(operation)) {
    const validLabelReceipt =
      labelCensusReceipts.has(receipt) && receipt.invocation === cursor.invocation;
    if (pass && validLabelReceipt && receipt.ids.length === 0) return {};
    if (!pass && (receipt === null || validLabelReceipt)) return {};
    throw new Error("invalid label census receipt");
  }
  throw new Error("unexpected Docker receipt operation");
}

function completeCutSlot(cursor, transition, nowNs) {
  if (cursor.active === null || transition.operation !== cursor.active.operation) {
    throw new Error("no matching cut supervisor slot");
  }
  const docker = cursor.active.kind === "docker";
  const idBound = Object.hasOwn(cursor.active, "id");
  const expectedKeys = cursor.active.kind === "local"
    ? ["type", "operation", "outcome"]
    : [
        "type",
        "operation",
        "outcome",
        "reaped",
        "token",
        ...(docker ? ["receipt"] : []),
        ...(idBound ? ["id"] : []),
      ];
  exactObjectKeys(transition, expectedKeys, "cut supervisor complete-slot");
  if (!["pass", "fail"].includes(transition.outcome)) {
    throw new Error("invalid cut supervisor outcome");
  }
  if (cursor.active.kind !== "local") {
    if (transition.token !== cursor.active.token) {
      throw new Error("cut supervisor child identity mismatch");
    }
    if (idBound && transition.id !== cursor.active.id) {
      throw new Error("cut supervisor cleanup identity mismatch");
    }
    if (typeof transition.reaped !== "boolean") {
      throw new Error("invalid cut supervisor reap result");
    }
    if (!transition.reaped) {
      throw new Error("unreaped cut supervisor child cannot release cleanup authority");
    }
  }
  if (nowNs >= cursor.active.endNs) throw new Error("cut supervisor slot cap");
  if (
    cursor.active.kind !== "local" &&
    ((nowNs >= cursor.active.termEndNs && cursor.active.stage !== "kill") ||
      (nowNs >= cursor.active.normalEndNs && cursor.active.stage === "settle"))
  ) {
    throw new Error("cut supervisor child stage missing");
  }
  const updates = docker ? validateCutSlotReceipt(cursor, transition) : {};
  if (docker && transition.receipt !== null) {
    usedDockerObservationReceipts.add(transition.receipt);
  }
  return advanceSettledCutSlot(cursor, nowNs, transition.outcome === "fail", updates);
}

function skipCutSlot(cursor, transition, nowNs) {
  exactObjectKeys(transition, ["type", "operation"], "cut supervisor skip-slot");
  if (cursor.active !== null || cursor.phase !== "failed-teardown") {
    throw new Error("invalid cut supervisor skip");
  }
  const slot = cursor.slots[cursor.slotIndex];
  if (slot === undefined || slot.operation !== transition.operation) {
    throw new Error("cut supervisor slot reorder");
  }
  const allowed =
    (slot.operation === "accepted-id-validation" && cursor.acceptedId === null) ||
    (slot.operation === "exact-name-recovery" && cursor.adoptedId !== null) ||
    (["remove-1", "absence-1"].includes(slot.operation) && cursor.adoptedId === null) ||
    (["remove-2", "absence-2"].includes(slot.operation) &&
      (cursor.adoptedId === null || cursor.absenceProved));
  if (!allowed) throw new Error("cut supervisor slot cannot skip");
  return advanceSettledCutSlot(cursor, nowNs, false);
}

function expireCutSlot(cursor, transition, nowNs) {
  if (cursor.active === null || cursor.active.kind === "local") {
    throw new Error("no expirable cut supervisor slot");
  }
  const expectedKeys = [
    "type",
    "operation",
    "token",
    ...(Object.hasOwn(cursor.active, "id") ? ["id"] : []),
  ];
  exactObjectKeys(transition, expectedKeys, "cut supervisor expire-slot");
  if (
    transition.operation !== cursor.active.operation ||
    transition.token !== cursor.active.token ||
    (Object.hasOwn(cursor.active, "id") && transition.id !== cursor.active.id)
  ) {
    throw new Error("invalid cut supervisor expiry target");
  }
  if (cursor.active.stage !== "kill" || nowNs < cursor.active.endNs) {
    throw new Error("cut supervisor slot has not expired after KILL");
  }
  if (cursor.active.kind !== "local") {
    if (cursor.phase === "post-reap") {
      return freezeCutSupervisor({
        ...cursor,
        active: null,
        failed: true,
        lastBootNs: nowNs,
        phase: "failed-ready",
        residue: true,
      });
    }
    const descriptorIndex = cursor.slots.findIndex(
      (slot) => slot.operation === "descriptor-settlement",
    );
    if (cursor.phase === "failed-teardown" && descriptorIndex >= 0) {
      return freezeCutSupervisor({
        ...cursor,
        active: null,
        failed: true,
        lastBootNs: nowNs,
        residue: true,
        slotIndex: descriptorIndex,
      });
    }
    return freezeCutSupervisor({
      ...cursor,
      active: null,
      failed: true,
      lastBootNs: nowNs,
      phase: "failed-residue",
      residue: true,
    });
  }
  return advanceSettledCutSlot(cursor, nowNs, true);
}

function abortCutSlot(cursor, transition, nowNs) {
  if (cursor.active === null || cursor.active.kind === "local") {
    throw new Error("no abortable cut supervisor slot");
  }
  const idBound = Object.hasOwn(cursor.active, "id");
  exactObjectKeys(
    transition,
    ["type", "operation", "token", "reaped", ...(idBound ? ["id"] : [])],
    "cut supervisor abort-slot",
  );
  if (
    transition.operation !== cursor.active.operation ||
    transition.token !== cursor.active.token ||
    (idBound && transition.id !== cursor.active.id)
  ) {
    throw new Error("invalid cut supervisor abort target");
  }
  if (typeof transition.reaped !== "boolean") {
    throw new Error("invalid cut supervisor abort reap result");
  }
  if (transition.reaped) {
    if (nowNs < cursor.active.endNs) {
      throw new Error("reaped cut supervisor slot cannot abort before its cap");
    }
    return advanceSettledCutSlot(cursor, nowNs, true);
  }
  if (cursor.phase === "post-reap") {
    return freezeCutSupervisor({
      ...cursor,
      active: null,
      failed: true,
      lastBootNs: nowNs,
      phase: "failed-ready",
      residue: true,
    });
  }
  const descriptorIndex = cursor.slots.findIndex(
    (slot) => slot.operation === "descriptor-settlement",
  );
  if (cursor.phase === "failed-teardown" && descriptorIndex >= 0) {
    return freezeCutSupervisor({
      ...cursor,
      active: null,
      failed: true,
      lastBootNs: nowNs,
      residue: true,
      slotIndex: descriptorIndex,
    });
  }
  return freezeCutSupervisor({
    ...cursor,
    active: null,
    failed: true,
    lastBootNs: nowNs,
    phase: "failed-residue",
    residue: true,
  });
}

export function reduceCutSupervisorCursor(cursor, transition, sample) {
  if (!cutSupervisors.has(cursor)) throw new Error("invalid cut supervisor cursor");
  if (transition === null || typeof transition !== "object" || Array.isArray(transition)) {
    throw new Error("invalid cut supervisor transition");
  }
  const nowNs = requireSample(sample);
  if (nowNs < cursor.lastBootNs) throw new Error("cut supervisor clock regressed");
  if (transition.type === "harness-failed-reaped") {
    exactObjectKeys(transition, ["type", "receipt"], "failed harness-reaped transition");
    if (
      cursor.phase !== "harness" ||
      !cutHarnessReapReceipts.has(transition.receipt) ||
      usedCutHarnessReapReceipts.has(transition.receipt) ||
      transition.receipt.token !== cursor.harnessToken ||
      transition.receipt.cutCase !== cursor.cutCase
    ) {
      throw new Error("invalid failed harness reap receipt");
    }
    usedCutHarnessReapReceipts.add(transition.receipt);
    return freezeCutSupervisor({
      ...cursor,
      lastBootNs: nowNs,
      harnessReaped: true,
      acceptedId: transition.receipt.acceptedId,
      failed: true,
      phase: "failed-ready",
    });
  }
  if (
    cursor.phase === "post-reap" &&
    (cursor.postReapDeadlineNs === null || nowNs >= cursor.postReapDeadlineNs)
  ) {
    throw new Error("cut supervisor post-reap deadline");
  }
  if (
    transition.type !== "begin-failed-teardown" &&
    cursor.phase !== "failed-teardown" &&
    nowNs >= cursor.outerDeadlineNs
  ) {
    throw new Error("cut supervisor outer deadline");
  }
  if (cursor.phase === "failed-teardown" && nowNs >= cursor.teardownDeadlineNs) {
    throw new Error("failed cut teardown deadline");
  }
  if (transition.type === "harness-reaped") {
    exactObjectKeys(transition, ["type", "receipt"], "harness-reaped transition");
    if (cursor.phase !== "harness" || nowNs >= cursor.innerDeadlineNs) {
      throw new Error("invalid harness reap transition");
    }
    if (
      !cutHarnessReapReceipts.has(transition.receipt) ||
      usedCutHarnessReapReceipts.has(transition.receipt) ||
      transition.receipt.token !== cursor.harnessToken ||
      transition.receipt.cutCase !== cursor.cutCase
    ) {
      throw new Error("invalid cut harness reap receipt");
    }
    usedCutHarnessReapReceipts.add(transition.receipt);
    const acceptedExpected = cursor.cutCase !== "before-issue";
    const valid =
      transition.receipt.valid &&
      transition.receipt.invocation === cursor.invocation &&
      acceptedExpected === (transition.receipt.acceptedId !== null);
    const slots = transition.receipt.acceptedId === null
      ? POST_REAP_SLOTS.slice(1)
      : POST_REAP_SLOTS;
    const postReapBudgetNs = transition.receipt.acceptedId === null
      ? CUT_POST_REAP_NS - 10n * SECOND_NS
      : CUT_POST_REAP_NS;
    return freezeCutSupervisor({
      ...cursor,
      lastBootNs: nowNs,
      harnessReaped: true,
      acceptedId: transition.receipt.acceptedId,
      failed: !valid,
      phase: valid ? "post-reap" : "failed-ready",
      slots,
      slotIndex: 0,
      postReapStartNs: nowNs,
      postReapDeadlineNs: nowNs + postReapBudgetNs,
      postReapBudgetNs,
    });
  }
  if (transition.type === "begin-failed-teardown") {
    exactObjectKeys(transition, ["type"], "begin failed teardown");
    if (cursor.phase !== "failed-ready" || !cursor.harnessReaped) {
      throw new Error("failed teardown before permanent failure/reap");
    }
    return freezeCutSupervisor({
      ...cursor,
      lastBootNs: nowNs,
      phase: "failed-teardown",
      slots: FAILED_TEARDOWN_SLOTS,
      slotIndex: cursor.residue ? FAILED_TEARDOWN_SLOTS.length - 1 : 0,
      active: null,
      teardownDeadlineNs: nowNs + FAILED_CUT_TEARDOWN_NS,
    });
  }
  if (transition.type === "begin-slot") return beginCutSlot(cursor, transition, nowNs);
  if (transition.type === "skip-slot") return skipCutSlot(cursor, transition, nowNs);
  if (transition.type === "advance-slot-stage") {
    exactObjectKeys(transition, ["type", "operation", "stage", "token"], "cut slot stage");
    if (
      cursor.active === null ||
      cursor.active.kind === "local" ||
      transition.operation !== cursor.active.operation ||
      transition.token !== cursor.active.token
    ) {
      throw new Error("invalid cut slot stage target");
    }
    const validTerm =
      transition.stage === "term" &&
      cursor.active.stage === "settle" &&
      nowNs >= cursor.active.normalEndNs;
    const validKill =
      transition.stage === "kill" &&
      cursor.active.stage === "term" &&
      nowNs >= cursor.active.termEndNs;
    if (!validTerm && !validKill) throw new Error("invalid cut slot stage transition");
    return freezeCutSupervisor({
      ...cursor,
      lastBootNs: nowNs,
      active: { ...cursor.active, stage: transition.stage },
    });
  }
  if (transition.type === "complete-slot") return completeCutSlot(cursor, transition, nowNs);
  if (transition.type === "expire-slot") return expireCutSlot(cursor, transition, nowNs);
  if (transition.type === "abort-slot") return abortCutSlot(cursor, transition, nowNs);
  throw new Error("unsupported cut supervisor transition");
}
