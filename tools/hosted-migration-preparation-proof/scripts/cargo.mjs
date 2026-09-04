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

export const SOURCE_ROOTS = packageRoots;
export const SOURCE_FILE_COUNT = 45;

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
    if (mode !== "100644") throw new Error("source input mode is not 100644");
    records.push(Object.freeze({ object, path }));
  }
  if (records.length !== SOURCE_FILE_COUNT) throw new Error("source input count mismatch");
  records.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
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
import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
