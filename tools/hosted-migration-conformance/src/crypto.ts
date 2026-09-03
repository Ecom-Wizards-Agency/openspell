import {
  createHash,
  createPublicKey,
  verify as verifyEd25519,
  type KeyObject,
} from "node:crypto";

import { canonicalUnsignedLeafBytes, parseCanonicalLeaf } from "./canonical.js";
import { frozenRefusal } from "./types.js";
import type {
  ConformanceResult,
  LeafSchemaVersion,
  SignedLeafEvidence,
  SignedLeafInput,
  VerifiedSignedLeaf,
} from "./types.js";

const RAW_PUBLIC_KEY = /^[0-9a-f]{64}$/u;
const RAW_SIGNATURE = /^[0-9a-f]{128}$/u;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MAX_PUBLIC_KEYS = 8;

const signatureDomains = {
  "openspell.hosted-migration-external-window.v1":
    "openspell.hosted-migration-external-window-signature.v1",
  "openspell.hosted-migration-preparation-ticket.v1":
    "openspell.hosted-migration-preparation-ticket-signature.v1",
  "openspell.hosted-migration-preparation-no-execution-result.v1":
    "openspell.hosted-migration-preparation-no-execution-result-signature.v1",
  "openspell.hosted-migration-runtime-attestation.v1":
    "openspell.hosted-migration-runtime-attestation-signature.v1",
  "openspell.hosted-migration-terminal-exec-graph.v1":
    "openspell.hosted-migration-terminal-exec-graph-signature.v1",
  "openspell.hosted-migration-approval-grant.v1":
    "openspell.hosted-migration-approval-grant-signature.v1",
  "openspell.hosted-migration-execution-ticket.v1":
    "openspell.hosted-migration-execution-ticket-signature.v1",
  "openspell.hosted-migration-no-execution-result.v1":
    "openspell.hosted-migration-no-execution-result-signature.v1",
} as const satisfies Record<LeafSchemaVersion, string>;

export function sha256Hex(input: Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function leafSignatureDomain(schemaVersion: LeafSchemaVersion): string {
  return signatureDomains[schemaVersion];
}

function verificationKey(rawPublicKeyHex: string): KeyObject | undefined {
  if (typeof rawPublicKeyHex !== "string" || !RAW_PUBLIC_KEY.test(rawPublicKeyHex)) return undefined;
  try {
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawPublicKeyHex, "hex")]),
      format: "der",
      type: "spki",
    });
  } catch {
    return undefined;
  }
}

function signedLeafInput(value: unknown): SignedLeafInput | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2 ||
    keys[0] !== "canonicalLeafBytes" ||
    keys[1] !== "rawSignatureHex"
  ) {
    return undefined;
  }
  const bytesDescriptor = Object.getOwnPropertyDescriptor(value, "canonicalLeafBytes");
  const signatureDescriptor = Object.getOwnPropertyDescriptor(value, "rawSignatureHex");
  if (
    bytesDescriptor?.get !== undefined ||
    signatureDescriptor?.get !== undefined ||
    !(bytesDescriptor?.value instanceof Uint8Array) ||
    typeof signatureDescriptor?.value !== "string"
  ) {
    return undefined;
  }
  return {
    canonicalLeafBytes: bytesDescriptor.value,
    rawSignatureHex: signatureDescriptor.value,
  };
}

/**
 * Verifies one exact WP-197 leaf against separately supplied public evidence. A conformant result
 * is not proof that a key is trusted, a leaf is fresh or any action is authorized.
 */
export function verifySignedLeafInternal(
  input: SignedLeafInput,
  publicKeysHex: readonly string[],
): ConformanceResult<VerifiedSignedLeaf> {
  const normalizedInput = signedLeafInput(input);
  if (normalizedInput === undefined || !RAW_SIGNATURE.test(normalizedInput.rawSignatureHex)) {
    return { status: "refused", code: "invalid_leaf" };
  }
  if (!Array.isArray(publicKeysHex) || publicKeysHex.length === 0 || publicKeysHex.length > MAX_PUBLIC_KEYS) {
    return { status: "refused", code: "invalid_public_key" };
  }

  const parsed = parseCanonicalLeaf(normalizedInput.canonicalLeafBytes);
  if (parsed.status === "refused") return parsed;
  const signatureBytes = Buffer.from(normalizedInput.rawSignatureHex, "hex");
  const signatureSha256 = sha256Hex(signatureBytes);
  if (signatureSha256 !== parsed.value.leaf.detachedSignatureSha256) {
    return { status: "refused", code: "detached_signature_mismatch" };
  }

  let matchedKey: KeyObject | undefined;
  for (const publicKeyHex of publicKeysHex) {
    const key = verificationKey(publicKeyHex);
    if (key === undefined) return { status: "refused", code: "invalid_public_key" };
    if (sha256Hex(Buffer.from(publicKeyHex, "hex")) === parsed.value.leaf.issuerPublicKeySha256) {
      matchedKey = key;
    }
  }
  if (matchedKey === undefined) {
    return { status: "refused", code: "verification_key_not_found" };
  }

  const preimage = Buffer.concat([
    Buffer.from(`${leafSignatureDomain(parsed.value.leaf.schemaVersion)}\n`, "utf8"),
    canonicalUnsignedLeafBytes(parsed.value.leaf),
  ]);
  let valid: boolean;
  try {
    valid = verifyEd25519(null, preimage, matchedKey, signatureBytes);
  } catch {
    valid = false;
  }
  if (!valid) return { status: "refused", code: "invalid_signature" };

  return Object.freeze({
    status: "conformant",
    value: Object.freeze({
      leaf: parsed.value.leaf,
      canonicalLeafSha256: sha256Hex(parsed.value.canonicalLeafBytes),
      rawSignatureSha256: signatureSha256,
    }),
  });
}

export function verifySignedLeaf(
  input: SignedLeafInput,
  publicKeysHex: readonly string[],
): ConformanceResult<SignedLeafEvidence> {
  try {
    const verified = verifySignedLeafInternal(input, publicKeysHex);
    if (verified.status === "refused") return frozenRefusal(verified.code);
    return Object.freeze({
      status: "conformant",
      value: Object.freeze({
        schemaVersion: verified.value.leaf.schemaVersion,
        canonicalLeafSha256: verified.value.canonicalLeafSha256,
        rawSignatureSha256: verified.value.rawSignatureSha256,
      }),
    });
  } catch {
    return frozenRefusal("invalid_leaf");
  }
}
