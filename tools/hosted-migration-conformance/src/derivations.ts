import { createHash } from "node:crypto";

import { verifySignedLeafInternal } from "./crypto.js";
import { phaseSessionTag } from "./session.js";
import { frozenRefusal } from "./types.js";
import type {
  AttestationChainEvidence,
  ConformanceResult,
  RuntimeAttestationLeaf,
  SignedLeafInput,
  VerifiedSignedLeaf,
} from "./types.js";

const CHAIN_DOMAIN = Buffer.from(
  "openspell.hosted-migration-runtime-attestation-chain.v1\0",
  "ascii",
);
const EXECUTABLE_SHA256 = {
  "usr/local/libexec/supabase":
    "3cfb10e8cb7b8cb4d6807117865a2a39891178ec83f4d0c86ac49f633d2c43f4",
  "usr/local/libexec/supabase-go":
    "1530ee645cea869f6a440782b1732ede4b57d7646fea8494b8db1c59370e5eb1",
} as const;
export const MAX_ATTESTATIONS = 2;
export const MAX_TRANSCRIPT_BYTES = 4 * 1_024 * 1_024;

interface FoldedAttestations {
  readonly evidence: AttestationChainEvidence;
  readonly chainValues: readonly string[];
}

export function derivePhaseSessionTag(
  operationId: string,
  authorizationNonce: string,
  phase: string,
): ConformanceResult<string> {
  try {
    const value = phaseSessionTag(operationId, authorizationNonce, phase);
    return value === undefined
      ? frozenRefusal("invalid_session_tag")
      : Object.freeze({ status: "conformant", value });
  } catch {
    return frozenRefusal("invalid_session_tag");
  }
}

function sameAttestationBinding(
  first: RuntimeAttestationLeaf,
  next: RuntimeAttestationLeaf,
): boolean {
  return (
    first.operationId === next.operationId &&
    first.authorizationNonce === next.authorizationNonce &&
    first.phase === next.phase &&
    first.phaseAuthorizationKind === next.phaseAuthorizationKind &&
    first.phaseAuthorizationSha256 === next.phaseAuthorizationSha256 &&
    first.phaseExecTopologyPolicySha256 === next.phaseExecTopologyPolicySha256 &&
    first.childCgroupPolicySha256 === next.childCgroupPolicySha256 &&
    first.childCgroupEvidenceSha256 === next.childCgroupEvidenceSha256 &&
    first.namespaceRootDevice === next.namespaceRootDevice &&
    first.namespaceRootInode === next.namespaceRootInode &&
    first.runtimeUid === next.runtimeUid &&
    first.runtimeGid === next.runtimeGid &&
    first.procPolicySha256 === next.procPolicySha256 &&
    first.egressPolicySha256 === next.egressPolicySha256 &&
    first.rootLauncherIdentitySha256 === next.rootLauncherIdentitySha256 &&
    first.issuerPublicKeySha256 === next.issuerPublicKeySha256
  );
}

export function boundedSignedLeaves(inputs: readonly SignedLeafInput[]): boolean {
  if (!Array.isArray(inputs) || inputs.length > MAX_ATTESTATIONS) return false;
  let totalBytes = 0;
  for (const input of inputs) {
    if (typeof input !== "object" || input === null) return false;
    const descriptor = Object.getOwnPropertyDescriptor(input, "canonicalLeafBytes");
    if (!(descriptor?.value instanceof Uint8Array)) return false;
    totalBytes += descriptor.value.byteLength;
    if (totalBytes > MAX_TRANSCRIPT_BYTES) return false;
  }
  return true;
}

export function foldVerifiedRuntimeAttestations(
  attestations: readonly VerifiedSignedLeaf<RuntimeAttestationLeaf>[],
): ConformanceResult<FoldedAttestations> {
  if (attestations.length === 0 || attestations.length > MAX_ATTESTATIONS) {
    return { status: "refused", code: "input_limit_exceeded" };
  }
  const first = attestations[0];
  if (first === undefined) return { status: "refused", code: "missing_evidence" };

  let previous = Buffer.alloc(32);
  const chainValues: string[] = [];
  for (const [index, attestation] of attestations.entries()) {
    const ordinal = index + 1;
    if (
      attestation.leaf.execOrdinal !== ordinal ||
      (ordinal === 1 &&
        attestation.leaf.executableRelativePath !== "usr/local/libexec/supabase") ||
      (ordinal === 2 &&
        attestation.leaf.executableRelativePath !== "usr/local/libexec/supabase-go") ||
      (ordinal === 2 &&
        (attestation.leaf.parentPid !== first.leaf.processPid ||
          attestation.leaf.parentStart !== first.leaf.processStart ||
          attestation.leaf.processPid === first.leaf.processPid ||
          (attestation.leaf.processPid === first.leaf.parentPid &&
            attestation.leaf.processStart === first.leaf.parentStart))) ||
      attestation.leaf.processPid === attestation.leaf.parentPid ||
      attestation.leaf.executableSha256 !==
        EXECUTABLE_SHA256[attestation.leaf.executableRelativePath] ||
      (index > 0 &&
        Date.parse(attestation.leaf.observedAt) <
          Date.parse(attestations[index - 1]?.leaf.observedAt ?? "")) ||
      !sameAttestationBinding(first.leaf, attestation.leaf)
    ) {
      return { status: "refused", code: "invalid_attestation_chain" };
    }
    const ordinalBytes = Buffer.alloc(4);
    ordinalBytes.writeUInt32BE(ordinal);
    previous = createHash("sha256")
      .update(CHAIN_DOMAIN)
      .update(ordinalBytes)
      .update(previous)
      .update(Buffer.from(attestation.canonicalLeafSha256, "hex"))
      .digest();
    chainValues.push(previous.toString("hex"));
  }

  const terminalChainSha256 = chainValues.at(-1);
  if (terminalChainSha256 === undefined) {
    return { status: "refused", code: "missing_evidence" };
  }
  return Object.freeze({
    status: "conformant",
    value: Object.freeze({
      evidence: Object.freeze({
        terminalChainSha256,
        terminalObservedExecCount: attestations.length,
      }),
      chainValues: Object.freeze(chainValues),
    }),
  });
}

function verifyRuntimeAttestationChainInternal(
  attestationLeaves: readonly SignedLeafInput[],
  publicKeysHex: readonly string[],
): ConformanceResult<AttestationChainEvidence> {
  if (
    !boundedSignedLeaves(attestationLeaves) ||
    attestationLeaves.length === 0 ||
    attestationLeaves.length > MAX_ATTESTATIONS
  ) {
    return { status: "refused", code: "input_limit_exceeded" };
  }

  const verified: VerifiedSignedLeaf<RuntimeAttestationLeaf>[] = [];
  for (const input of attestationLeaves) {
    const result = verifySignedLeafInternal(input, publicKeysHex);
    if (result.status === "refused") return result;
    if (result.value.leaf.schemaVersion !== "openspell.hosted-migration-runtime-attestation.v1") {
      return { status: "refused", code: "invalid_attestation_chain" };
    }
    verified.push(result.value as VerifiedSignedLeaf<RuntimeAttestationLeaf>);
  }
  const folded = foldVerifiedRuntimeAttestations(verified);
  return folded.status === "refused"
    ? folded
    : Object.freeze({ status: "conformant", value: folded.value.evidence });
}

/** Verifies chain-internal consistency only; root/launcher separation requires a phase transcript. */
export function verifyRuntimeAttestationChain(
  attestationLeaves: readonly SignedLeafInput[],
  publicKeysHex: readonly string[],
): ConformanceResult<AttestationChainEvidence> {
  try {
    const result = verifyRuntimeAttestationChainInternal(attestationLeaves, publicKeysHex);
    return result.status === "refused" ? frozenRefusal(result.code) : result;
  } catch {
    return frozenRefusal("invalid_attestation_chain");
  }
}
