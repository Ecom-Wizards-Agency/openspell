import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

const packageRoots = Object.freeze([
  "tools/hosted-migration-preparation-proof",
  "tools/hosted-migration-root-authority",
  "tools/hosted-migration-runtime-proof",
]);

const fixedCompileTimeInputs = new Set([
  "tools/hosted-migration-root-authority/src/grant-ticket-v1.golden.json",
  "tools/hosted-migration-root-authority/src/preparation-policy-v1.golden.json",
  "tools/hosted-migration-root-authority/src/transition-v1.golden.json",
  "tools/hosted-migration-runtime-proof/fixtures/wp199-grant-ticket-v1.golden.json",
]);

const utf8 = new TextDecoder("utf-8", { fatal: true });
const indexRecordPattern = /^(?<mode>[0-9]{6}) (?<object>[0-9a-f]{40}|[0-9a-f]{64}) (?<stage>[0-3])\t(?<path>[^\r\n\0]+)$/u;
const includeMacroNamePattern = /\binclude_(?:bytes|str)\b/gu;
const exactIncludeLiteralPattern =
  /^include_(?:bytes|str)!\(\s*"(?<path>[A-Za-z0-9._+@/-]+)"\s*\)/u;

const fixedSourceObjects = new Map([
  ["tools/hosted-migration-preparation-proof/Cargo.lock", "071a248ec762232d1f4c6cbd12b5f2c200ed9cc5"],
  ["tools/hosted-migration-preparation-proof/Cargo.toml", "ae51db494f8993980de400f147dfdaec4edac04d"],
  ["tools/hosted-migration-preparation-proof/rust-toolchain.toml", "3caff2a7c8054117b0c69401d38fbb47ba2241a2"],
  ["tools/hosted-migration-preparation-proof/src/lib.rs", "c17e470ef9bf45c7f0e9fb92b3972e575667cff9"],
  ["tools/hosted-migration-root-authority/Cargo.lock", "b90437c9cb4fa0096bd043704e73c0089c01ef89"],
  ["tools/hosted-migration-root-authority/Cargo.toml", "b836aa485a81064156cd4ee4801af2f28bbce4f6"],
  ["tools/hosted-migration-root-authority/rust-toolchain.toml", "3caff2a7c8054117b0c69401d38fbb47ba2241a2"],
  ["tools/hosted-migration-root-authority/src/authority_registry.rs", "d8c1ad93f8d3f7f1c2cefcd46f076741a68c607f"],
  ["tools/hosted-migration-root-authority/src/authority_registry_tests.rs", "2bc2416f00b255ce48121d71b4470d5c481a5329"],
  ["tools/hosted-migration-root-authority/src/canonical.rs", "1e76e4032fda57f1fd295184d49e461eecfa0393"],
  ["tools/hosted-migration-root-authority/src/corruption_tests.rs", "5433d0add00d0b8a1c970b1a688cd00c27bcd17d"],
  ["tools/hosted-migration-root-authority/src/cross_version_tests.rs", "f6704a0503f31dc14f2e0e2583ec26612bdad607"],
  ["tools/hosted-migration-root-authority/src/crypto.rs", "225528242e861ddec841f74461edc5c3dce06182"],
  ["tools/hosted-migration-root-authority/src/grant-ticket-v1.golden.json", "b81971ff9ac4f28477b17645682ef9d1e63aab7f"],
  ["tools/hosted-migration-root-authority/src/ipc.rs", "34ba15f85e6ec318081517191f04e5c974b728e9"],
  ["tools/hosted-migration-root-authority/src/journal.rs", "53dde98a770c3b21369478b1f3a175da15f372b4"],
  ["tools/hosted-migration-root-authority/src/journal/storage.rs", "6a531478729fd71afb76572b405176262718a842"],
  ["tools/hosted-migration-root-authority/src/lib.rs", "13992f6b0439374977357692e733bdd3fb6e5962"],
  ["tools/hosted-migration-root-authority/src/mutation_tests.rs", "e0868fa95ce23cfe86a8f4ac64bbbeba9d875deb"],
  ["tools/hosted-migration-root-authority/src/policy_matrix_tests.rs", "64c7a8810a2a4d8944aa95af700a6bf1c5912803"],
  ["tools/hosted-migration-root-authority/src/preparation-policy-v1.golden.json", "88cb0c664d52075ada10e5f42f76bc8cf6394296"],
  ["tools/hosted-migration-root-authority/src/preparation_v2.rs", "9fd8c5aeb7948ce0135d3654b30260dce699d988"],
  ["tools/hosted-migration-root-authority/src/preparation_v2_tests.rs", "3efa8df77cc3f0474cfc0aa88824c1608e037b08"],
  ["tools/hosted-migration-root-authority/src/protocol.rs", "772e0042826f0d83133bc17ce0ba43ad3c391eb5"],
  ["tools/hosted-migration-root-authority/src/records.rs", "1e81b2cf04809f159e99e283e87dbad205cd0656"],
  ["tools/hosted-migration-root-authority/src/state.rs", "91b3a88d6f96eebe46fb92fee942fcf68033dcef"],
  ["tools/hosted-migration-root-authority/src/super_lock.rs", "cfca6c7adae9dd06977c096c189880accef56d6c"],
  ["tools/hosted-migration-root-authority/src/tests.rs", "6be415c9e37987ef8d6af62e22b3fabdc5c8d759"],
  ["tools/hosted-migration-root-authority/src/transition-v1.golden.json", "8d1c53e2370da3a564c9ef24a95a1b443fe6a712"],
  ["tools/hosted-migration-runtime-proof/Cargo.lock", "4ad71a62f833d593e035ca2b5514f283ce7d4611"],
  ["tools/hosted-migration-runtime-proof/Cargo.toml", "50deecb5d06aa0de59e3c4286e811d326b1ce244"],
  ["tools/hosted-migration-runtime-proof/fixtures/wp199-grant-ticket-v1.golden.json", "b81971ff9ac4f28477b17645682ef9d1e63aab7f"],
  ["tools/hosted-migration-runtime-proof/rust-toolchain.toml", "3caff2a7c8054117b0c69401d38fbb47ba2241a2"],
  ["tools/hosted-migration-runtime-proof/src/archive.rs", "5f054336aa77fdee941457dfebff8809290593b8"],
  ["tools/hosted-migration-runtime-proof/src/canonical.rs", "15097b3e3bf09c3fcb54e98c6000dcec89116af5"],
  ["tools/hosted-migration-runtime-proof/src/elf.rs", "a2ce02073396d128dc93f8e66551ad2226bf2c8f"],
  ["tools/hosted-migration-runtime-proof/src/lib.rs", "5e450125a9f5b9bda8ab604ad18d646ca6f1133d"],
  ["tools/hosted-migration-runtime-proof/src/linux_abi.rs", "7aa3b29a8d4b4c75f6bee97697a6aee2485f46b3"],
  ["tools/hosted-migration-runtime-proof/src/linux_kernel_tests.rs", "19b06c4e4e5ec1585c76f3bde3b244008f1ec948"],
  ["tools/hosted-migration-runtime-proof/src/machine.rs", "4e7e6c408f3313a09f8bb8517dc60a1adfb4d408"],
  ["tools/hosted-migration-runtime-proof/src/model_tests.rs", "0205c330cb3baf7bb1dc2ef806e28229d9b46c96"],
  ["tools/hosted-migration-runtime-proof/src/policy.rs", "d5f03c59c9580e960f2805d248aeb23c56975f8c"],
  ["tools/hosted-migration-runtime-proof/src/provenance.rs", "aea0d2b7315579e141a2655e40669dda43947ca0"],
  ["tools/hosted-migration-runtime-proof/src/provenance_tests.rs", "45cc353e2d26e9bc75e7648da04f4eca992334f0"],
  ["tools/hosted-migration-runtime-proof/src/ticket.rs", "8c637c40570282cefd26fba4f84cffec03d2b89f"],
]);

const fixedSourceDirectories = Object.freeze([
  "source",
  "source/tools",
  "source/tools/hosted-migration-preparation-proof",
  "source/tools/hosted-migration-preparation-proof/src",
  "source/tools/hosted-migration-root-authority",
  "source/tools/hosted-migration-root-authority/src",
  "source/tools/hosted-migration-root-authority/src/journal",
  "source/tools/hosted-migration-runtime-proof",
  "source/tools/hosted-migration-runtime-proof/fixtures",
  "source/tools/hosted-migration-runtime-proof/src",
]);

const SOURCE_REGULAR_FILE_BYTES = 1_281_104;

export const SOURCE_ROOTS = packageRoots;
export const SOURCE_FILE_COUNT = fixedSourceObjects.size;
export const SOURCE_DIRECTORY_COUNT = fixedSourceDirectories.length;
export const SOURCE_FILE_BYTES = SOURCE_REGULAR_FILE_BYTES;

function acceptedSourcePath(path) {
  for (const root of packageRoots) {
    if (["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"].some(
      (name) => path === `${root}/${name}`,
    )) {
      return true;
    }
    if (path.startsWith(`${root}/src/`) && path.endsWith(".rs")) return true;
  }
  return fixedCompileTimeInputs.has(path);
}

function compareBytes(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

function requireExactSourceRecords(records) {
  if (!Array.isArray(records) || records.length !== SOURCE_FILE_COUNT) {
    throw new Error("source input count mismatch");
  }
  const seen = new Set();
  for (const record of records) {
    if (
      record === null ||
      typeof record !== "object" ||
      typeof record.path !== "string" ||
      typeof record.object !== "string" ||
      seen.has(record.path) ||
      fixedSourceObjects.get(record.path) !== record.object
    ) {
      throw new Error("source input identity mismatch");
    }
    seen.add(record.path);
  }
  for (const path of fixedSourceObjects.keys()) {
    if (!seen.has(path)) throw new Error("missing fixed source input");
  }
}

function gitBlobObjectId(bytes, hexadecimalLength) {
  const algorithm = hexadecimalLength === 40 ? "sha1" : "sha256";
  const header = Buffer.from(`blob ${bytes.length}\0`, "ascii");
  return createHash(algorithm).update(header).update(bytes).digest("hex");
}

function exactSourceBytes(records, sourceBytesByPath) {
  requireExactSourceRecords(records);
  if (!(sourceBytesByPath instanceof Map) || sourceBytesByPath.size !== records.length) {
    throw new Error("source byte inventory mismatch");
  }
  for (const path of sourceBytesByPath.keys()) {
    if (!fixedSourceObjects.has(path)) throw new Error("extra source bytes");
  }

  const exact = new Map();
  let totalBytes = 0;
  for (const { object, path } of records) {
    const supplied = sourceBytesByPath.get(path);
    if (!(supplied instanceof Uint8Array)) throw new Error("missing source bytes");
    const bytes = Buffer.from(supplied);
    if (gitBlobObjectId(bytes, object.length) !== object) {
      throw new Error("source bytes do not match indexed object");
    }
    totalBytes += bytes.length;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > SOURCE_REGULAR_FILE_BYTES) {
      throw new Error("source byte count mismatch");
    }
    exact.set(path, bytes);
  }
  if (totalBytes !== SOURCE_REGULAR_FILE_BYTES) {
    throw new Error("source byte count mismatch");
  }
  return exact;
}

export function parseSourceIndex(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error("git index bytes required");
  if (bytes.length === 0 || bytes.at(-1) !== 0) throw new Error("unterminated git index inventory");
  const records = [];
  const seen = new Set();
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index === start) throw new Error("empty git index record");
    const record = utf8.decode(bytes.subarray(start, index));
    start = index + 1;
    const match = indexRecordPattern.exec(record);
    if (match?.groups === undefined) throw new Error("malformed git index record");
    const { mode, object, stage, path } = match.groups;
    if (
      mode === undefined ||
      object === undefined ||
      stage === undefined ||
      path === undefined
    ) {
      throw new Error("malformed git index fields");
    }
    if (stage !== "0") throw new Error("non-stage-zero source input");
    if (seen.has(path)) throw new Error("duplicate source input");
    seen.add(path);
    if (!acceptedSourcePath(path)) continue;
    const expectedObject = fixedSourceObjects.get(path);
    if (expectedObject === undefined) throw new Error("extra source input");
    if (mode !== "100644") throw new Error("source input mode is not 100644");
    if (object !== expectedObject) throw new Error("source input object mismatch");
    records.push(Object.freeze({ object, path }));
  }
  records.sort((left, right) => compareBytes(left.path, right.path));
  requireExactSourceRecords(records);
  return Object.freeze(records);
}

export function assertCompileTimeInputs(records, sourceBytesByPath) {
  const selected = new Set(records.map(({ path }) => path));
  const referenced = new Set();
  for (const { path } of records) {
    if (!path.endsWith(".rs")) continue;
    const bytes = sourceBytesByPath.get(path);
    if (!(bytes instanceof Uint8Array)) throw new Error("missing source bytes");
    const source = utf8.decode(bytes);
    const sourceDirectory = path.slice(0, path.lastIndexOf("/"));
    for (const macro of source.matchAll(includeMacroNamePattern)) {
      const offset = macro.index;
      if (offset === undefined) throw new Error("invalid compile-time include position");
      const match = exactIncludeLiteralPattern.exec(source.slice(offset));
      if (match?.groups === undefined) {
        throw new Error("unsupported compile-time include form");
      }
      const relative = match.groups.path;
      if (relative === undefined || relative.startsWith("/") || relative.includes("//")) {
        throw new Error("invalid compile-time include literal");
      }
      const components = [...sourceDirectory.split("/"), ...relative.split("/")];
      const normalized = [];
      for (const component of components) {
        if (component === ".") continue;
        if (component === "..") {
          if (normalized.length === 0) throw new Error("compile-time include escapes package");
          normalized.pop();
        } else {
          normalized.push(component);
        }
      }
      const target = normalized.join("/");
      if (!selected.has(target)) throw new Error("untracked compile-time include input");
      referenced.add(target);
    }
  }
  for (const path of fixedCompileTimeInputs) {
    if (!selected.has(path)) throw new Error("missing fixed compile-time input");
  }
  return Object.freeze([...referenced].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))));
}

function sourceDirectoryRows(records) {
  const directories = new Set(["source"]);
  for (const { path } of records) {
    let slash = path.lastIndexOf("/");
    while (slash !== -1) {
      directories.add(`source/${path.slice(0, slash)}`);
      slash = path.lastIndexOf("/", slash - 1);
    }
  }
  const ordered = [...directories].sort(compareBytes);
  if (
    ordered.length !== fixedSourceDirectories.length ||
    ordered.some((path, index) => path !== fixedSourceDirectories[index])
  ) {
    throw new Error("source directory inventory mismatch");
  }
  return ordered.map((path) => `D\t0555\t${path}\n`);
}

export function buildSourceLedger(records, sourceBytesByPath) {
  const exactBytes = exactSourceBytes(records, sourceBytesByPath);
  assertCompileTimeInputs(records, exactBytes);
  const rows = sourceDirectoryRows(records);
  for (const { path } of records) {
    const bytes = exactBytes.get(path);
    if (bytes === undefined) throw new Error("source byte identity lost");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    rows.push(`S\t0444\t${bytes.length}\t${sha256}\t${path}\n`);
  }
  rows.sort((left, right) => {
    const leftKey = left.slice(0, left.indexOf("\n"));
    const rightKey = right.slice(0, right.indexOf("\n"));
    const leftPath = leftKey.slice(leftKey.lastIndexOf("\t") + 1);
    const rightPath = rightKey.slice(rightKey.lastIndexOf("\t") + 1);
    return compareBytes(`${left[0]}\t${leftPath}`, `${right[0]}\t${rightPath}`);
  });
  const ledgerRows = rows.join("");
  return Object.freeze({
    files: SOURCE_FILE_COUNT,
    directories: SOURCE_DIRECTORY_COUNT,
    regularFileBytes: SOURCE_REGULAR_FILE_BYTES,
    records: SOURCE_FILE_COUNT + SOURCE_DIRECTORY_COUNT,
    ledgerRows,
  });
}

export function verifySourceLedger(records, sourceBytesByPath, candidateBytes) {
  if (!(candidateBytes instanceof Uint8Array)) {
    throw new Error("source ledger bytes required");
  }
  const expected = buildSourceLedger(records, sourceBytesByPath);
  if (!Buffer.from(candidateBytes).equals(Buffer.from(expected.ledgerRows, "utf8"))) {
    throw new Error("source ledger byte mismatch");
  }
  return expected;
}
