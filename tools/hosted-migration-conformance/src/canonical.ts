import { isLeafSchemaVersion, leafKeys, validateMigrationLeaf } from "./records.js";
import type { ConformanceResult, MigrationLeaf } from "./types.js";

const MAX_LEAF_BYTES = 65_536;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface ParsedCanonicalLeaf {
  readonly leaf: MigrationLeaf;
  readonly canonicalLeafBytes: Uint8Array;
}

function quoteString(value: string): string {
  let result = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    switch (code) {
      case 0x08:
        result += "\\b";
        break;
      case 0x09:
        result += "\\t";
        break;
      case 0x0a:
        result += "\\n";
        break;
      case 0x0c:
        result += "\\f";
        break;
      case 0x0d:
        result += "\\r";
        break;
      case 0x22:
        result += '\\"';
        break;
      case 0x5c:
        result += "\\\\";
        break;
      default:
        result += code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : value[index];
    }
  }
  return `${result}"`;
}

function ownDataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
    throw new TypeError("non-data property");
  }
  return descriptor.value;
}

function serializeCanonical(value: unknown, depth: number): string {
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);
  if (typeof value === "string") return quoteString(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("noncanonical number");
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = Array.from({ length: value.length }, (_, index) =>
      serializeCanonical(ownDataValue(value, String(index)), depth + 1),
    );
    return `[\n${childIndent}${items.join(`,\n${childIndent}`)}\n${indent}]`;
  }
  if (typeof value === "object") {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) throw new TypeError("symbol key");
    const entries = (keys as string[]).map(
      (key) => `${quoteString(key)}: ${serializeCanonical(ownDataValue(value, key), depth + 1)}`,
    );
    return `{\n${childIndent}${entries.join(`,\n${childIndent}`)}\n${indent}}`;
  }
  throw new TypeError("unsupported canonical value");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value) as T;
  }
  if (typeof value === "object" && value !== null) {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "string") deepFreeze(ownDataValue(value, key));
    }
    return Object.freeze(value);
  }
  return value;
}

export function canonicalLeafBytes(leaf: MigrationLeaf): Uint8Array {
  return encoder.encode(`${serializeCanonical(leaf, 0)}\n`);
}

export function canonicalUnsignedLeafBytes(leaf: MigrationLeaf): Uint8Array {
  const keys = leafKeys[leaf.schemaVersion];
  const unsignedKeys = keys.slice(0, -1);
  const fields = unsignedKeys.map(
    (key) => `${quoteString(key)}: ${serializeCanonical(ownDataValue(leaf, key), 1)}`,
  );
  return encoder.encode(`{\n  ${fields.join(",\n  ")}\n}\n`);
}

export function parseCanonicalLeaf(input: Uint8Array): ConformanceResult<ParsedCanonicalLeaf> {
  if (!(input instanceof Uint8Array)) {
    return { status: "refused", code: "invalid_canonical_json" };
  }
  if (input.byteLength === 0 || input.byteLength > MAX_LEAF_BYTES) {
    return { status: "refused", code: "input_limit_exceeded" };
  }

  const snapshot = new Uint8Array(input);
  let text: string;
  try {
    text = decoder.decode(snapshot);
  } catch {
    return { status: "refused", code: "invalid_canonical_json" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { status: "refused", code: "invalid_canonical_json" };
  }
  const leaf = validateMigrationLeaf(parsed);
  if (leaf === undefined) {
    const descriptor =
      typeof parsed === "object" && parsed !== null
        ? Object.getOwnPropertyDescriptor(parsed, "schemaVersion")
        : undefined;
    return {
      status: "refused",
      code: isLeafSchemaVersion(descriptor?.value) ? "invalid_leaf" : "unknown_leaf_schema",
    };
  }

  let canonical: Uint8Array;
  try {
    canonical = canonicalLeafBytes(leaf);
  } catch {
    return { status: "refused", code: "invalid_leaf" };
  }
  if (!sameBytes(snapshot, canonical)) {
    return { status: "refused", code: "invalid_canonical_json" };
  }
  return {
    status: "conformant",
    value: { leaf: deepFreeze(leaf), canonicalLeafBytes: snapshot },
  };
}
