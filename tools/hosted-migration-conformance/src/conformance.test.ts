import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  type KeyObject,
} from "node:crypto";

import { describe, expect, it } from "vitest";

import * as oracle from "./index.js";
import {
  derivePhaseSessionTag,
  verifyApplyTranscript,
  verifyPreparationTranscript,
  verifyRuntimeAttestationChain,
  verifySignedLeaf,
} from "./index.js";
import { leafSignatureDomain } from "./crypto.js";
import type {
  ApprovalGrantLeaf,
  ExecutionTicketLeaf,
  ExternalWindowLeaf,
  LeafSchemaVersion,
  SignedLeafInput,
} from "./index.js";

const OPERATION_ID = "a".repeat(64);
const AUTHORIZATION_NONCE = "b".repeat(64);
const TARGET = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const DIGEST_E = "e".repeat(64);
const DIGEST_F = "f".repeat(64);
const FRONT_CONTROLLER_SHA256 =
  "3cfb10e8cb7b8cb4d6807117865a2a39891178ec83f4d0c86ac49f633d2c43f4";
const DELEGATE_SHA256 = "1530ee645cea869f6a440782b1732ede4b57d7646fea8494b8db1c59370e5eb1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const fixtureKeyObject = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from("01".repeat(32), "hex"),
  ]),
  format: "der",
  type: "pkcs8",
});
const publicDer = createPublicKey(fixtureKeyObject).export({ format: "der", type: "spki" });
const publicKeyHex = Buffer.from(publicDer).subarray(-32).toString("hex");
const launcherKeyObject = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from("02".repeat(32), "hex"),
  ]),
  format: "der",
  type: "pkcs8",
});
const launcherPublicDer = createPublicKey(launcherKeyObject).export({
  format: "der",
  type: "spki",
});
const launcherPublicKeyHex = Buffer.from(launcherPublicDer).subarray(-32).toString("hex");

const TEST_DOMAINS = {
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

function testSha(input: Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

const issuerPublicKeySha256 = testSha(Buffer.from(publicKeyHex, "hex"));
const launcherPublicKeySha256 = testSha(Buffer.from(launcherPublicKeyHex, "hex"));

function signedLeaf(
  unsignedLeaf: Record<string, unknown>,
  key?: KeyObject,
  domain = TEST_DOMAINS[unsignedLeaf.schemaVersion as LeafSchemaVersion],
): SignedLeafInput {
  const signingKey =
    key ??
    (unsignedLeaf.issuerPublicKeySha256 === launcherPublicKeySha256
      ? launcherKeyObject
      : fixtureKeyObject);
  const unsignedBytes = encoder.encode(`${JSON.stringify(unsignedLeaf, null, 2)}\n`);
  const rawSignatureHex = sign(
    null,
    Buffer.concat([Buffer.from(`${domain}\n`, "utf8"), unsignedBytes]),
    signingKey,
  ).toString("hex");
  const completeLeaf = {
    ...unsignedLeaf,
    detachedSignatureSha256: testSha(Buffer.from(rawSignatureHex, "hex")),
  };
  return {
    canonicalLeafBytes: encoder.encode(`${JSON.stringify(completeLeaf, null, 2)}\n`),
    rawSignatureHex,
  };
}

function unwrap<T>(result: { status: "conformant"; value: T } | { status: "refused" }): T {
  if (result.status === "refused") throw new Error("fixture unexpectedly refused");
  return result.value;
}

function preparationTicketUnsigned(phase: "history_fetch" | "dry_run") {
  return {
    schemaVersion: "openspell.hosted-migration-preparation-ticket.v1",
    ticketNonce: phase === "history_fetch" ? "1".repeat(64) : "2".repeat(64),
    operationId: OPERATION_ID,
    authorizationNonce: AUTHORIZATION_NONCE,
    phase,
    writeCapability: false,
    targetFingerprint: TARGET,
    targetSelectionSha256: DIGEST_D,
    officialSourceEvidenceSha256: DIGEST_E,
    nativeRuntimeIdentitySha256: DIGEST_F,
    childSandboxPolicySha256: DIGEST_D,
    phaseExecTopologyPolicySha256: DIGEST_E,
    childCgroupPolicySha256: DIGEST_F,
    phaseInvocationEvidenceSha256: phase === "history_fetch" ? DIGEST_D : DIGEST_E,
    issuedAt: "2026-09-03T12:00:00Z",
    expiresAt: "2026-09-03T12:15:00Z",
    state: "prepared",
    issuerPublicKeySha256,
  } as const;
}

function runtimeAttestationUnsigned(
  phase: "history_fetch" | "dry_run" | "apply",
  authorizationSha256: string,
  execOrdinal: number,
) {
  return {
    schemaVersion: "openspell.hosted-migration-runtime-attestation.v1",
    phase,
    operationId: OPERATION_ID,
    authorizationNonce: AUTHORIZATION_NONCE,
    phaseAuthorizationKind:
      phase === "apply" ? "apply_execution_ticket" : "preparation_ticket",
    phaseAuthorizationSha256: authorizationSha256,
    phaseExecTopologyPolicySha256: DIGEST_E,
    childCgroupPolicySha256: DIGEST_F,
    childCgroupEvidenceSha256: DIGEST_D,
    execOrdinal,
    processPid: 456 + execOrdinal,
    processStart: `${123_456 + execOrdinal}`,
    parentPid: execOrdinal === 1 ? 455 : 457,
    parentStart: execOrdinal === 1 ? "123455" : "123457",
    executableRelativePath:
      execOrdinal === 1 ? "usr/local/libexec/supabase" : "usr/local/libexec/supabase-go",
    executableSha256: execOrdinal === 1 ? FRONT_CONTROLLER_SHA256 : DELEGATE_SHA256,
    namespaceRootDevice: 3,
    namespaceRootInode: 4,
    mapsManifestSha256: DIGEST_F,
    runtimeUid: 200,
    runtimeGid: 200,
    noNewPrivileges: true,
    dumpable: false,
    coreLimitBytes: 0,
    effectiveCapabilities: [],
    permittedCapabilities: [],
    inheritableCapabilities: [],
    ambientCapabilities: [],
    procPolicySha256: DIGEST_D,
    egressPolicySha256: DIGEST_E,
    observedAt:
      phase === "apply"
        ? `2026-09-03T12:0${6 + execOrdinal}:00.000Z`
        : `2026-09-03T12:0${execOrdinal}:00.000Z`,
    rootLauncherIdentitySha256: DIGEST_F,
    issuerPublicKeySha256: launcherPublicKeySha256,
  } as const;
}

function terminalUnsigned(
  phase: "history_fetch" | "dry_run" | "apply",
  authorizationSha256: string,
  chainValues: readonly string[],
) {
  return {
    schemaVersion: "openspell.hosted-migration-terminal-exec-graph.v1",
    phase,
    operationId: OPERATION_ID,
    authorizationNonce: AUTHORIZATION_NONCE,
    phaseAuthorizationKind:
      phase === "apply" ? "apply_execution_ticket" : "preparation_ticket",
    phaseAuthorizationSha256: authorizationSha256,
    phaseExecTopologyPolicySha256: DIGEST_E,
    boundChainPrefixSha256: chainValues.at(-1) as string,
    boundObservedExecCount: chainValues.length,
    terminalChainSha256: chainValues.at(-1) as string,
    terminalObservedExecCount: chainValues.length,
    terminalGraphState: "closed",
    childCgroupEmpty: true,
    taggedSessionCount: 0,
    observedAt: "2026-09-03T12:10:00.000Z",
    rootLauncherIdentitySha256: DIGEST_F,
    issuerPublicKeySha256: launcherPublicKeySha256,
  } as const;
}

function chainValues(attestations: readonly SignedLeafInput[]): string[] {
  const domain = Buffer.from(
    "openspell.hosted-migration-runtime-attestation-chain.v1\0",
    "ascii",
  );
  let previous = Buffer.alloc(32);
  return attestations.map((attestation, index) => {
    const ordinal = Buffer.alloc(4);
    ordinal.writeUInt32BE(index + 1);
    previous = createHash("sha256")
      .update(domain)
      .update(ordinal)
      .update(previous)
      .update(Buffer.from(testSha(attestation.canonicalLeafBytes), "hex"))
      .digest();
    return previous.toString("hex");
  });
}

function completePreparation(phase: "history_fetch" | "dry_run") {
  const preparationTicketLeaf = signedLeaf(preparationTicketUnsigned(phase));
  const ticketDigest = testSha(preparationTicketLeaf.canonicalLeafBytes);
  const attestationLeaves = [signedLeaf(runtimeAttestationUnsigned(phase, ticketDigest, 1))];
  const chains = chainValues(attestationLeaves);
  const terminalGraphLeaf = signedLeaf(terminalUnsigned(phase, ticketDigest, chains));
  return { preparationTicketLeaf, attestationLeaves, terminalGraphLeaf, chains };
}

function approvalGrantUnsigned() {
  return {
    schemaVersion: "openspell.hosted-migration-approval-grant.v1",
    operationId: OPERATION_ID,
    authorizationNonce: AUTHORIZATION_NONCE,
    targetFingerprint: TARGET,
    targetSelectionSha256: DIGEST_D,
    envelopeSha256: DIGEST_E,
    externalExclusiveWindowGeneration: 7,
    externalExclusiveWindowEvidenceSha256: DIGEST_F,
    officialSourceEvidenceSha256: DIGEST_D,
    nativeRuntimeIdentitySha256: DIGEST_E,
    childSandboxPolicySha256: DIGEST_F,
    phaseExecTopologyPolicySha256: DIGEST_E,
    childCgroupPolicySha256: DIGEST_F,
    applyInvocationEvidenceSha256: DIGEST_D,
    issuedAt: "2026-09-03T12:05:00Z",
    expiresAt: "2026-09-03T12:15:00Z",
    authenticatedOperatorIdentitySha256: DIGEST_E,
    osAuthenticationSessionSha256: DIGEST_F,
    authenticatedAt: "2026-09-03T12:04:00Z",
    state: "approved",
    issuerPublicKeySha256,
  } as const;
}

function executionTicketUnsigned(grant: SignedLeafInput) {
  const grantLeaf = JSON.parse(decoder.decode(grant.canonicalLeafBytes)) as ApprovalGrantLeaf;
  return {
    schemaVersion: "openspell.hosted-migration-execution-ticket.v1",
    approvalGrantSha256: testSha(grant.canonicalLeafBytes),
    approvalGrantSignatureSha256: testSha(Buffer.from(grant.rawSignatureHex, "hex")),
    ticketNonce: "3".repeat(64),
    operationId: grantLeaf.operationId,
    authorizationNonce: grantLeaf.authorizationNonce,
    targetFingerprint: grantLeaf.targetFingerprint,
    targetSelectionSha256: grantLeaf.targetSelectionSha256,
    envelopeSha256: grantLeaf.envelopeSha256,
    externalExclusiveWindowGeneration: grantLeaf.externalExclusiveWindowGeneration,
    externalExclusiveWindowEvidenceSha256: grantLeaf.externalExclusiveWindowEvidenceSha256,
    officialSourceEvidenceSha256: grantLeaf.officialSourceEvidenceSha256,
    nativeRuntimeIdentitySha256: grantLeaf.nativeRuntimeIdentitySha256,
    childSandboxPolicySha256: grantLeaf.childSandboxPolicySha256,
    phaseExecTopologyPolicySha256: grantLeaf.phaseExecTopologyPolicySha256,
    childCgroupPolicySha256: grantLeaf.childCgroupPolicySha256,
    applyInvocationEvidenceSha256: grantLeaf.applyInvocationEvidenceSha256,
    consumedAt: "2026-09-03T12:06:00Z",
    expiresAt: grantLeaf.expiresAt,
    state: "consumed",
    issuerPublicKeySha256,
  } as const;
}

function completeApply() {
  const approvalGrantLeaf = signedLeaf(approvalGrantUnsigned());
  const executionTicketLeaf = signedLeaf(executionTicketUnsigned(approvalGrantLeaf));
  const ticketDigest = testSha(executionTicketLeaf.canonicalLeafBytes);
  const attestationLeaves = [
    signedLeaf(runtimeAttestationUnsigned("apply", ticketDigest, 1)),
    signedLeaf(runtimeAttestationUnsigned("apply", ticketDigest, 2)),
  ];
  const chains = chainValues(attestationLeaves);
  const terminalGraphLeaf = signedLeaf(terminalUnsigned("apply", ticketDigest, chains));
  return { approvalGrantLeaf, executionTicketLeaf, attestationLeaves, terminalGraphLeaf, chains };
}

function preparationNoExecutionLeaf(
  preparationTicketLeaf: SignedLeafInput,
  reasonCode:
    | "preparation_ticket_expired"
    | "preparation_invariant_failed"
    | "preparation_launcher_rejected_before_execution" = "preparation_invariant_failed",
  observedAt = "2026-09-03T12:10:00.000Z",
): SignedLeafInput {
  return signedLeaf({
    schemaVersion: "openspell.hosted-migration-preparation-no-execution-result.v1",
    preparationTicketSha256: testSha(preparationTicketLeaf.canonicalLeafBytes),
    ticketNonce: "1".repeat(64),
    operationId: OPERATION_ID,
    authorizationNonce: AUTHORIZATION_NONCE,
    phase: "history_fetch",
    writeCapability: false,
    targetFingerprint: TARGET,
    rootPhaseJournalGeneration: 2,
    reasonCode,
    priorState: "prepared",
    terminalState: "terminal_no_spawn",
    executingTransitionCount: 0,
    namespaceCreationCount: 0,
    cgroupCreationCount: 0,
    childCreationCount: 0,
    pidfdCreationCount: 0,
    phaseSessionCount: 0,
    zeroPhaseSessionEvidenceSha256: DIGEST_D,
    targetQuarantineEvidenceSha256: DIGEST_E,
    observedAt,
    issuerPublicKeySha256,
  });
}

function applyNoExecutionLeaf(
  apply: ReturnType<typeof completeApply>,
  reasonCode: "pre_spawn_invariant_failed" | "ticket_expired" | "launcher_rejected_before_execution" =
    "pre_spawn_invariant_failed",
  observedAt = "2026-09-03T12:10:00.000Z",
): SignedLeafInput {
  return signedLeaf({
    schemaVersion: "openspell.hosted-migration-no-execution-result.v1",
    approvalGrantSha256: testSha(apply.approvalGrantLeaf.canonicalLeafBytes),
    executionTicketSha256: testSha(apply.executionTicketLeaf.canonicalLeafBytes),
    ticketNonce: "3".repeat(64),
    operationId: OPERATION_ID,
    authorizationNonce: AUTHORIZATION_NONCE,
    targetFingerprint: TARGET,
    rootJournalGeneration: 2,
    reasonCode,
    priorState: "consumed",
    terminalState: "terminal_no_spawn",
    executingTransitionCount: 0,
    namespaceCreationCount: 0,
    cgroupCreationCount: 0,
    childCreationCount: 0,
    pidfdCreationCount: 0,
    applySessionCount: 0,
    zeroApplySessionEvidenceSha256: DIGEST_D,
    targetQuarantineEvidenceSha256: DIGEST_E,
    externalExclusiveWindowGeneration: 7,
    externalExclusiveWindowEvidenceSha256: DIGEST_F,
    observedAt,
    issuerPublicKeySha256,
  });
}

function allFamilyInputs(): SignedLeafInput[] {
  const preparation = completePreparation("history_fetch");
  const apply = completeApply();
  return [
    signedLeaf(externalWindowUnsigned()),
    preparation.preparationTicketLeaf,
    preparationNoExecutionLeaf(preparation.preparationTicketLeaf),
    preparation.attestationLeaves[0] as SignedLeafInput,
    apply.terminalGraphLeaf,
    apply.approvalGrantLeaf,
    apply.executionTicketLeaf,
    applyNoExecutionLeaf(apply),
  ];
}

function resignLeaf(
  input: SignedLeafInput,
  changes: Readonly<Record<string, unknown>>,
): SignedLeafInput {
  const complete = JSON.parse(decoder.decode(input.canonicalLeafBytes)) as Record<string, unknown>;
  const { detachedSignatureSha256: _detachedSignatureSha256, ...unsigned } = complete;
  return signedLeaf({ ...unsigned, ...changes });
}

const STRUCTURAL_ONLY_FIELDS = new Set([
  "schemaVersion",
  "state",
  "excludedActorClasses",
  "writeCapability",
  "priorState",
  "terminalState",
  "executingTransitionCount",
  "namespaceCreationCount",
  "cgroupCreationCount",
  "childCreationCount",
  "pidfdCreationCount",
  "phaseSessionCount",
  "applySessionCount",
  "phaseAuthorizationKind",
  "noNewPrivileges",
  "dumpable",
  "coreLimitBytes",
  "effectiveCapabilities",
  "permittedCapabilities",
  "inheritableCapabilities",
  "ambientCapabilities",
  "terminalGraphState",
  "childCgroupEmpty",
  "taggedSessionCount",
]);

function schemaValidAlternate(field: string, value: unknown): unknown {
  if (STRUCTURAL_ONLY_FIELDS.has(field)) return undefined;
  if (field === "phase") {
    return value === "history_fetch" ? "dry_run" : value === "dry_run" ? "history_fetch" : undefined;
  }
  if (field === "reasonCode") {
    return value === "preparation_invariant_failed"
      ? "preparation_ticket_expired"
      : value === "pre_spawn_invariant_failed"
        ? "ticket_expired"
        : undefined;
  }
  if (field === "executableRelativePath") {
    return value === "usr/local/libexec/supabase"
      ? "usr/local/libexec/supabase-go"
      : "usr/local/libexec/supabase";
  }
  if (field === "boundObservedExecCount") {
    return typeof value === "number" && value > 1 ? value - 1 : undefined;
  }
  if (field === "issuerPublicKeySha256") {
    return value === launcherPublicKeySha256 ? issuerPublicKeySha256 : launcherPublicKeySha256;
  }
  if (typeof value === "number") return value > 0 ? value + 1 : undefined;
  if (typeof value !== "string") return undefined;
  if (/^[0-9a-f]{64}$/u.test(value)) return value === "9".repeat(64) ? "8".repeat(64) : "9".repeat(64);
  if (/^[0-9a-f]{40}$/u.test(value)) return value === "9".repeat(40) ? "8".repeat(40) : "9".repeat(40);
  if (/^\d{4}-\d{2}-\d{2}T/u.test(value)) {
    return new Date(Date.parse(value) + 1_000).toISOString();
  }
  return `${value}1`;
}

function structurallyInvalidAlternate(value: unknown): unknown {
  if (typeof value === "boolean") return !value;
  if (typeof value === "number") return value === 0 ? 1 : 0;
  return null;
}

function externalWindowUnsigned() {
  return {
    schemaVersion: "openspell.hosted-migration-external-window.v1",
    operationId: OPERATION_ID,
    authorizationNonce: AUTHORIZATION_NONCE,
    targetFingerprint: TARGET,
    generation: 7,
    state: "held",
    excludedActorClasses: ["agent_brokers", "manual_cli", "other_hosts", "scheduled_jobs"],
    actorRosterSha256: DIGEST_D,
    credentialInventorySha256: DIGEST_E,
    issuerRevision: "1".repeat(40),
    issuerPublicKeySha256,
    acquiredAt: "2026-09-03T12:00:00.000Z",
    expiresAt: "2026-09-03T12:15:00.000Z",
  } as const;
}

describe("exact WP-197 leaf bytes and signatures", () => {
  it("pins an independent external-window byte and signature vector", () => {
    const input = signedLeaf(externalWindowUnsigned());
    const expectedUnsigned = `{
  "schemaVersion": "openspell.hosted-migration-external-window.v1",
  "operationId": "${OPERATION_ID}",
  "authorizationNonce": "${AUTHORIZATION_NONCE}",
  "targetFingerprint": "${TARGET}",
  "generation": 7,
  "state": "held",
  "excludedActorClasses": [
    "agent_brokers",
    "manual_cli",
    "other_hosts",
    "scheduled_jobs"
  ],
  "actorRosterSha256": "${DIGEST_D}",
  "credentialInventorySha256": "${DIGEST_E}",
  "issuerRevision": "${"1".repeat(40)}",
  "issuerPublicKeySha256": "${issuerPublicKeySha256}",
  "acquiredAt": "2026-09-03T12:00:00.000Z",
  "expiresAt": "2026-09-03T12:15:00.000Z"
}
`;
    const signatureDigest = testSha(Buffer.from(input.rawSignatureHex, "hex"));
    const expectedComplete = expectedUnsigned.replace(
      "\n}\n",
      `,\n  "detachedSignatureSha256": "${signatureDigest}"\n}\n`,
    );
    expect(decoder.decode(input.canonicalLeafBytes)).toBe(expectedComplete);
    expect(input.rawSignatureHex).toBe(
      "b64e4ada621fa1749bc86dd28eddfb1933c1a47b853fd2b1f2d73dd43c4b8c28a71bebf9817a22bcdd085cf88f2fee5bf8cc06eefccc8fade6f56138e33c040f",
    );
    expect(verifySignedLeaf(input, [publicKeyHex]).status).toBe("conformant");
  });

  it("uses every exact WP-197 domain and verifies all eight leaf families", () => {
    const domains = new Set<string>();
    for (const input of allFamilyInputs()) {
      const verified = unwrap(verifySignedLeaf(input, [publicKeyHex, launcherPublicKeyHex]));
      const expectedDomain = TEST_DOMAINS[verified.schemaVersion];
      expect(leafSignatureDomain(verified.schemaVersion)).toBe(expectedDomain);
      domains.add(expectedDomain);
      const complete = JSON.parse(decoder.decode(input.canonicalLeafBytes)) as Record<
        string,
        unknown
      >;
      const { detachedSignatureSha256: _detachedSignatureSha256, ...unsigned } = complete;
      const wrongDomain =
        verified.schemaVersion === "openspell.hosted-migration-external-window.v1"
          ? TEST_DOMAINS["openspell.hosted-migration-approval-grant.v1"]
          : TEST_DOMAINS["openspell.hosted-migration-external-window.v1"];
      const issuerIsLauncher = unsigned.issuerPublicKeySha256 === launcherPublicKeySha256;
      const signer = issuerIsLauncher ? launcherKeyObject : fixtureKeyObject;
      const verificationKey = issuerIsLauncher ? launcherPublicKeyHex : publicKeyHex;
      expect(verifySignedLeaf(signedLeaf(unsigned, signer, wrongDomain), [verificationKey])).toEqual(
        {
          status: "refused",
          code: "invalid_signature",
        },
      );
    }
    expect(domains.size).toBe(8);
  });

  it("refuses mutation of every signed field across all eight leaf families", () => {
    for (const input of allFamilyInputs()) {
      const parsed = JSON.parse(decoder.decode(input.canonicalLeafBytes)) as Record<string, unknown>;
      const schemaVersion = parsed.schemaVersion as string;
      for (const [field, current] of Object.entries(parsed).slice(0, -1)) {
        const validAlternate = schemaValidAlternate(field, current);
        const changed = validAlternate ?? structurallyInvalidAlternate(current);
        const mutated = { ...parsed, [field]: changed };
        const mutatedInput = {
          canonicalLeafBytes: encoder.encode(`${JSON.stringify(mutated, null, 2)}\n`),
          rawSignatureHex: input.rawSignatureHex,
        };
        expect(
          verifySignedLeaf(mutatedInput, [publicKeyHex, launcherPublicKeyHex]).status,
          `${schemaVersion}.${field}`,
        ).toBe("refused");

        if (validAlternate !== undefined) {
          const { detachedSignatureSha256: _detachedSignatureSha256, ...unsigned } = mutated;
          const signer =
            unsigned.issuerPublicKeySha256 === launcherPublicKeySha256
              ? launcherKeyObject
              : fixtureKeyObject;
          const expectedKey = signer === launcherKeyObject ? launcherPublicKeyHex : publicKeyHex;
          expect(
            verifySignedLeaf(signedLeaf(unsigned, signer), [expectedKey]).status,
            `schema-valid ${schemaVersion}.${field}`,
          ).toBe("conformant");
        }
      }
    }
  });

  it("refuses detached-signature, raw-signature, key and cross-domain substitution", () => {
    const input = signedLeaf(externalWindowUnsigned());
    const parsed = JSON.parse(decoder.decode(input.canonicalLeafBytes)) as ExternalWindowLeaf;
    const changedRaw = `${input.rawSignatureHex[0] === "0" ? "1" : "0"}${input.rawSignatureHex.slice(1)}`;
    expect(verifySignedLeaf({ ...input, rawSignatureHex: changedRaw }, [publicKeyHex])).toEqual({
      status: "refused",
      code: "detached_signature_mismatch",
    });
    const changedLeaf = {
      ...parsed,
      detachedSignatureSha256: testSha(Buffer.from(changedRaw, "hex")),
    };
    expect(
      verifySignedLeaf(
        {
          canonicalLeafBytes: encoder.encode(`${JSON.stringify(changedLeaf, null, 2)}\n`),
          rawSignatureHex: changedRaw,
        },
        [publicKeyHex],
      ),
    ).toEqual({ status: "refused", code: "invalid_signature" });
    expect(verifySignedLeaf(input, ["02".repeat(32)])).toEqual({
      status: "refused",
      code: "verification_key_not_found",
    });
    expect(verifySignedLeaf(input, ["bad-key"])).toEqual({
      status: "refused",
      code: "invalid_public_key",
    });
    expect(verifySignedLeaf({ ...input, rawSignatureHex: "0" }, [publicKeyHex])).toEqual({
      status: "refused",
      code: "invalid_leaf",
    });
    const wrongDomain = signedLeaf(
      externalWindowUnsigned(),
      fixtureKeyObject,
      TEST_DOMAINS["openspell.hosted-migration-approval-grant.v1"],
    );
    expect(verifySignedLeaf(wrongDomain, [publicKeyHex])).toEqual({
      status: "refused",
      code: "invalid_signature",
    });
  });
});

describe("prototype-independent canonical verification", () => {
  it("does not invoke inherited stateful toJSON during parse or signature verification", () => {
    const input = signedLeaf(externalWindowUnsigned());
    let calls = 0;
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value() {
        calls += 1;
        return calls === 1 ? { targetFingerprint: "9".repeat(64) } : this;
      },
    });
    try {
      expect(verifySignedLeaf(input, [publicKeyHex]).status).toBe("conformant");
      expect(calls).toBe(0);
    } finally {
      delete (Object.prototype as { toJSON?: unknown }).toJSON;
    }
  });

  it("matches JSON escaping without invoking object serialization hooks", () => {
    const ticket = signedLeaf(preparationTicketUnsigned("history_fetch"));
    const digest = testSha(ticket.canonicalLeafBytes);
    const input = signedLeaf({
      ...runtimeAttestationUnsigned("history_fetch", digest, 1),
      processStart: '12"\\34',
    });
    expect(verifySignedLeaf(input, [launcherPublicKeyHex]).status).toBe("conformant");
  });

  it("does not invoke outer input accessors", () => {
    const input = signedLeaf(externalWindowUnsigned());
    let calls = 0;
    const accessorInput = Object.defineProperties(
      {},
      {
        canonicalLeafBytes: {
          enumerable: true,
          get() {
            calls += 1;
            return input.canonicalLeafBytes;
          },
        },
        rawSignatureHex: { enumerable: true, value: input.rawSignatureHex },
      },
    );
    expect(verifySignedLeaf(accessorInput as SignedLeafInput, [publicKeyHex]).status).toBe("refused");
    expect(calls).toBe(0);
  });

  it("snapshots shared input bytes and returns frozen digest-bound data", () => {
    const input = signedLeaf(externalWindowUnsigned());
    const shared = new Uint8Array(new SharedArrayBuffer(input.canonicalLeafBytes.byteLength));
    shared.set(input.canonicalLeafBytes);
    const verification = verifySignedLeaf(
      { canonicalLeafBytes: shared, rawSignatureHex: input.rawSignatureHex },
      [publicKeyHex],
    );
    const result = unwrap(verification);
    const digest = result.canonicalLeafSha256;
    shared.fill(0);
    expect(result.canonicalLeafSha256).toBe(digest);
    expect(Object.isFrozen(verification)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.keys(result).sort()).toEqual([
      "canonicalLeafSha256",
      "rawSignatureSha256",
      "schemaVersion",
    ]);
  });

  it("freezes every public structured success result", () => {
    const tag = derivePhaseSessionTag(OPERATION_ID, AUTHORIZATION_NONCE, "history_fetch");
    expect(Object.isFrozen(tag)).toBe(true);

    const preparation = completePreparation("history_fetch");
    const chain = verifyRuntimeAttestationChain(
      preparation.attestationLeaves,
      [launcherPublicKeyHex],
    );
    expect(chain.status).toBe("conformant");
    expect(Object.isFrozen(chain)).toBe(true);
    if (chain.status === "conformant") expect(Object.isFrozen(chain.value)).toBe(true);

    const preparationResult = verifyPreparationTranscript({
      preparationTicketLeaf: preparation.preparationTicketLeaf,
      attestationLeaves: preparation.attestationLeaves,
      terminalGraphLeaf: preparation.terminalGraphLeaf,
      publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
    });
    expect(preparationResult.status).toBe("conformant");
    expect(Object.isFrozen(preparationResult)).toBe(true);
    if (preparationResult.status === "conformant") {
      expect(Object.isFrozen(preparationResult.value)).toBe(true);
    }

    const apply = completeApply();
    const applyResult = verifyApplyTranscript({
      approvalGrantLeaf: apply.approvalGrantLeaf,
      executionTicketLeaf: apply.executionTicketLeaf,
      attestationLeaves: apply.attestationLeaves,
      terminalGraphLeaf: apply.terminalGraphLeaf,
      publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
    });
    expect(applyResult.status).toBe("conformant");
    expect(Object.isFrozen(applyResult)).toBe(true);
    if (applyResult.status === "conformant") expect(Object.isFrozen(applyResult.value)).toBe(true);
  });

  it("contains stateful input exceptions and freezes every public refusal", () => {
    const canary = "PRIVATE-THROWING-INPUT-CANARY";
    const throwingObject = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error(canary);
        },
      },
    );
    class ThrowingBytes extends Uint8Array {
      override get byteLength(): number {
        throw new Error(canary);
      }
    }
    const throwingArray = new Proxy([] as SignedLeafInput[], {
      get(target, property, receiver) {
        if (property === "length") throw new Error(canary);
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const refusals = [
      derivePhaseSessionTag("bad", "bad", "bad"),
      verifySignedLeaf(throwingObject as SignedLeafInput, [publicKeyHex]),
      verifySignedLeaf(
        { canonicalLeafBytes: new ThrowingBytes(1), rawSignatureHex: "0".repeat(128) },
        [publicKeyHex],
      ),
      verifyRuntimeAttestationChain(throwingArray, [launcherPublicKeyHex]),
      verifyPreparationTranscript(
        throwingObject as Parameters<typeof verifyPreparationTranscript>[0],
      ),
      verifyApplyTranscript(throwingObject as Parameters<typeof verifyApplyTranscript>[0]),
    ];
    for (const result of refusals) {
      expect(result.status).toBe("refused");
      expect(Object.isFrozen(result)).toBe(true);
      expect(JSON.stringify(result)).not.toContain(canary);
    }
  });
});

describe("canonical refusal and bounded failures", () => {
  it.each([
    "missing LF",
    "extra LF",
    "leading whitespace",
    "reordered keys",
    "duplicate key",
    "extra key",
    "missing key",
    "wrong type",
    "alternate unicode escape",
    "escaped control character",
    "external time without milliseconds",
    "invalid external millisecond instant",
    "invalid UTF-8",
    "byte order mark",
  ])("refuses %s", (mutation) => {
    const input = signedLeaf(externalWindowUnsigned());
    const text = decoder.decode(input.canonicalLeafBytes);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    let bytes: Uint8Array;
    switch (mutation) {
      case "missing LF":
        bytes = input.canonicalLeafBytes.slice(0, -1);
        break;
      case "extra LF":
        bytes = encoder.encode(`${text}\n`);
        break;
      case "leading whitespace":
        bytes = encoder.encode(` ${text}`);
        break;
      case "reordered keys": {
        const entries = Object.entries(parsed);
        entries.reverse();
        bytes = encoder.encode(`${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`);
        break;
      }
      case "duplicate key":
        bytes = encoder.encode(
          text.replace(
            '  "schemaVersion": "openspell.hosted-migration-external-window.v1",',
            '  "schemaVersion": "openspell.hosted-migration-external-window.v1",\n  "schemaVersion": "openspell.hosted-migration-external-window.v1",',
          ),
        );
        break;
      case "extra key":
        bytes = encoder.encode(`${JSON.stringify({ ...parsed, extra: true }, null, 2)}\n`);
        break;
      case "missing key": {
        const { expiresAt: _expiresAt, ...missing } = parsed;
        bytes = encoder.encode(`${JSON.stringify(missing, null, 2)}\n`);
        break;
      }
      case "wrong type":
        bytes = encoder.encode(`${JSON.stringify({ ...parsed, generation: "7" }, null, 2)}\n`);
        break;
      case "alternate unicode escape":
        bytes = encoder.encode(text.replace(`"${OPERATION_ID}"`, `"\\u0061${"a".repeat(63)}"`));
        break;
      case "escaped control character":
        bytes = encoder.encode(
          text.replace(`"issuerRevision": "${"1".repeat(40)}"`, `"issuerRevision": "\\u000a${"1".repeat(39)}"`),
        );
        break;
      case "external time without milliseconds":
        bytes = encoder.encode(text.replace("2026-09-03T12:00:00.000Z", "2026-09-03T12:00:00Z"));
        break;
      case "invalid external millisecond instant":
        bytes = encoder.encode(
          text.replace("2026-09-03T12:00:00.000Z", "2026-13-99T99:99:99.999Z"),
        );
        break;
      case "invalid UTF-8":
        bytes = Uint8Array.of(0xff, 0xfe);
        break;
      case "byte order mark":
        bytes = Uint8Array.of(0xef, 0xbb, 0xbf, ...input.canonicalLeafBytes);
        break;
      default:
        throw new Error("unknown mutation");
    }
    expect(
      verifySignedLeaf({ canonicalLeafBytes: bytes, rawSignatureHex: input.rawSignatureHex }, [
        publicKeyHex,
      ]).status,
    ).toBe("refused");
  });

  it("never echoes privacy canaries", () => {
    const canary = "PRIVATE-TARGET-CANARY-DO-NOT-ECHO";
    const result = verifySignedLeaf(
      { canonicalLeafBytes: encoder.encode(`{"${canary}":true}\n`), rawSignatureHex: "0".repeat(128) },
      [publicKeyHex],
    );
    expect(result.status).toBe("refused");
    expect(JSON.stringify(result)).not.toContain(canary);
  });
});

describe("session tags and one-based raw-byte attestation chains", () => {
  it.each([
    ["history_fetch", "os-wp197-cli-ef6f56ea72a408d830ee647a7929fd9e45cdd17ddff6b77e"],
    ["dry_run", "os-wp197-cli-05634ad0b93ceb22a6b6035c1511f096f9c2ce7b54c536b9"],
    ["apply", "os-wp197-cli-6af59de5838eefb504219d75a90aec06fbe9d7878fb74ce6"],
  ] as const)("derives the %s golden tag", (phase, expected) => {
    expect(derivePhaseSessionTag(OPERATION_ID, AUTHORIZATION_NONCE, phase)).toEqual({
      status: "conformant",
      value: expected,
    });
  });

  it.each([
    ["short operation id", "a".repeat(63), AUTHORIZATION_NONCE, "apply"],
    ["uppercase operation id", "A".repeat(64), AUTHORIZATION_NONCE, "apply"],
    ["short authorization nonce", OPERATION_ID, "b".repeat(63), "apply"],
    ["uppercase authorization nonce", OPERATION_ID, "B".repeat(64), "apply"],
    ["unknown phase", OPERATION_ID, AUTHORIZATION_NONCE, "preview"],
  ] as const)("refuses a %s", (_label, operationId, authorizationNonce, phase) => {
    expect(derivePhaseSessionTag(operationId, authorizationNonce, phase)).toEqual({
      status: "refused",
      code: "invalid_session_tag",
    });
  });

  it("closes a two-leaf one-based raw-byte chain", () => {
    const ticket = signedLeaf(preparationTicketUnsigned("history_fetch"));
    const digest = testSha(ticket.canonicalLeafBytes);
    const leaves = [
      signedLeaf(runtimeAttestationUnsigned("history_fetch", digest, 1)),
      signedLeaf(runtimeAttestationUnsigned("history_fetch", digest, 2)),
    ];
    expect(verifyRuntimeAttestationChain(leaves, [launcherPublicKeyHex])).toEqual({
      status: "conformant",
      value: {
        terminalChainSha256: "58e339dfceae1b2f7ad1e4c36094f3a3c5d4ae6283de4ca07de54ce5d7d279c7",
        terminalObservedExecCount: 2,
      },
    });
    const chains = chainValues(leaves);
    const ordinal = Buffer.alloc(4);
    ordinal.writeUInt32BE(2);
    const wrongHexFold = createHash("sha256")
      .update(Buffer.from("openspell.hosted-migration-runtime-attestation-chain.v1\0", "ascii"))
      .update(ordinal)
      .update(chains[0] as string, "utf8")
      .update(testSha(leaves[1]?.canonicalLeafBytes as Uint8Array), "utf8")
      .digest("hex");
    expect(chains[1]).not.toBe(wrongHexFold);
  });

  it("refuses zero-based, gaps, duplicates, reorder and cross-authorization splice", () => {
    const ticket = signedLeaf(preparationTicketUnsigned("history_fetch"));
    const digest = testSha(ticket.canonicalLeafBytes);
    const first = signedLeaf(runtimeAttestationUnsigned("history_fetch", digest, 1));
    const second = signedLeaf(runtimeAttestationUnsigned("history_fetch", digest, 2));
    const zero = signedLeaf(runtimeAttestationUnsigned("history_fetch", digest, 0));
    const gap = signedLeaf(runtimeAttestationUnsigned("history_fetch", digest, 3));
    const splice = signedLeaf(
      runtimeAttestationUnsigned("history_fetch", "9".repeat(64), 2),
    );
    for (const leaves of [[zero], [second], [first, first], [second, first], [first, gap], [first, splice]]) {
      expect(verifyRuntimeAttestationChain(leaves, [launcherPublicKeyHex]).status).toBe("refused");
    }
  });

  it("refuses reversed, disconnected or identity-changing two-binary graphs", () => {
    const ticket = signedLeaf(preparationTicketUnsigned("history_fetch"));
    const digest = testSha(ticket.canonicalLeafBytes);
    const first = signedLeaf(runtimeAttestationUnsigned("history_fetch", digest, 1));
    const reversedFirst = signedLeaf({
      ...runtimeAttestationUnsigned("history_fetch", digest, 1),
      executableRelativePath: "usr/local/libexec/supabase-go",
    });
    const disconnected = signedLeaf({
      ...runtimeAttestationUnsigned("history_fetch", digest, 2),
      parentPid: 999,
    });
    const changedNamespace = signedLeaf({
      ...runtimeAttestationUnsigned("history_fetch", digest, 2),
      namespaceRootInode: 999,
    });
    const changedUid = signedLeaf({
      ...runtimeAttestationUnsigned("history_fetch", digest, 2),
      runtimeUid: 201,
    });
    const selfParentFront = signedLeaf({
      ...runtimeAttestationUnsigned("history_fetch", digest, 1),
      parentPid: 457,
      parentStart: "123457",
    });
    const selfParentDelegate = signedLeaf({
      ...runtimeAttestationUnsigned("history_fetch", digest, 2),
      processPid: 457,
    });
    const changedFrontHash = signedLeaf({
      ...runtimeAttestationUnsigned("history_fetch", digest, 1),
      executableSha256: "9".repeat(64),
    });
    const changedDelegateHash = signedLeaf({
      ...runtimeAttestationUnsigned("history_fetch", digest, 2),
      executableSha256: "9".repeat(64),
    });
    const parentCycleFront = signedLeaf({
      ...runtimeAttestationUnsigned("history_fetch", digest, 1),
      parentPid: 458,
      parentStart: "123458",
    });
    for (const leaves of [
      [reversedFirst],
      [first, disconnected],
      [first, changedNamespace],
      [first, changedUid],
      [selfParentFront],
      [first, selfParentDelegate],
      [changedFrontHash],
      [first, changedDelegateHash],
      [parentCycleFront, signedLeaf(runtimeAttestationUnsigned("history_fetch", digest, 2))],
    ]) {
      expect(verifyRuntimeAttestationChain(leaves, [launcherPublicKeyHex]).status).toBe("refused");
    }
  });
});

describe("phase lifecycle reduction", () => {
  it("closes terminal preparation and apply paths", () => {
    const preparation = completePreparation("history_fetch");
    expect(
      verifyPreparationTranscript({
        preparationTicketLeaf: preparation.preparationTicketLeaf,
        attestationLeaves: preparation.attestationLeaves,
        terminalGraphLeaf: preparation.terminalGraphLeaf,
        publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
      }).status,
    ).toBe("conformant");
    const apply = completeApply();
    const result = unwrap(
      verifyApplyTranscript({
        approvalGrantLeaf: apply.approvalGrantLeaf,
        executionTicketLeaf: apply.executionTicketLeaf,
        attestationLeaves: apply.attestationLeaves,
        terminalGraphLeaf: apply.terminalGraphLeaf,
        publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
      }),
    );
    expect(result).toEqual({
      phase: "apply",
      state: "terminal_graph_present",
      signedLeafCount: 5,
      terminalChainSha256: apply.chains[1],
    });
  });

  it("accepts the separately keyed launcher attestation and terminal graph", () => {
    const preparationTicketLeaf = signedLeaf(preparationTicketUnsigned("history_fetch"));
    const ticketDigest = testSha(preparationTicketLeaf.canonicalLeafBytes);
    const attestationLeaves = [
      signedLeaf(
        {
          ...runtimeAttestationUnsigned("history_fetch", ticketDigest, 1),
          issuerPublicKeySha256: launcherPublicKeySha256,
        },
        launcherKeyObject,
      ),
    ];
    const chains = chainValues(attestationLeaves);
    const terminalGraphLeaf = signedLeaf(
      {
        ...terminalUnsigned("history_fetch", ticketDigest, chains),
        issuerPublicKeySha256: launcherPublicKeySha256,
      },
      launcherKeyObject,
    );
    expect(
      verifyPreparationTranscript({
        preparationTicketLeaf,
        attestationLeaves,
        terminalGraphLeaf,
        publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
      }).status,
    ).toBe("conformant");
  });

  it("refuses a terminal graph signed by a different launcher authority", () => {
    const preparationTicketLeaf = signedLeaf(preparationTicketUnsigned("history_fetch"));
    const ticketDigest = testSha(preparationTicketLeaf.canonicalLeafBytes);
    const attestationLeaves = [
      signedLeaf(
        {
          ...runtimeAttestationUnsigned("history_fetch", ticketDigest, 1),
          issuerPublicKeySha256: launcherPublicKeySha256,
        },
        launcherKeyObject,
      ),
    ];
    const terminalGraphLeaf = signedLeaf(
      {
        ...terminalUnsigned("history_fetch", ticketDigest, chainValues(attestationLeaves)),
        issuerPublicKeySha256,
      },
      fixtureKeyObject,
    );
    expect(
      verifyPreparationTranscript({
        preparationTicketLeaf,
        attestationLeaves,
        terminalGraphLeaf,
        publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
      }),
    ).toEqual({ status: "refused", code: "binding_mismatch" });
  });

  it("refuses root-authority reuse as the launcher for preparation and apply", () => {
    const preparationTicketLeaf = signedLeaf(preparationTicketUnsigned("history_fetch"));
    const preparationTicketDigest = testSha(preparationTicketLeaf.canonicalLeafBytes);
    const preparationAttestations = [
      signedLeaf(
        {
          ...runtimeAttestationUnsigned("history_fetch", preparationTicketDigest, 1),
          issuerPublicKeySha256,
        },
        fixtureKeyObject,
      ),
    ];
    const preparationTerminal = signedLeaf(
      {
        ...terminalUnsigned(
          "history_fetch",
          preparationTicketDigest,
          chainValues(preparationAttestations),
        ),
        issuerPublicKeySha256,
      },
      fixtureKeyObject,
    );
    expect(
      verifyPreparationTranscript({
        preparationTicketLeaf,
        attestationLeaves: preparationAttestations,
        terminalGraphLeaf: preparationTerminal,
        publicKeysHex: [publicKeyHex],
      }),
    ).toEqual({ status: "refused", code: "binding_mismatch" });

    const apply = completeApply();
    const ticketDigest = testSha(apply.executionTicketLeaf.canonicalLeafBytes);
    const applyAttestations = [
      signedLeaf(
        {
          ...runtimeAttestationUnsigned("apply", ticketDigest, 1),
          issuerPublicKeySha256,
        },
        fixtureKeyObject,
      ),
    ];
    const applyTerminal = signedLeaf(
      {
        ...terminalUnsigned("apply", ticketDigest, chainValues(applyAttestations)),
        issuerPublicKeySha256,
      },
      fixtureKeyObject,
    );
    expect(
      verifyApplyTranscript({
        approvalGrantLeaf: apply.approvalGrantLeaf,
        executionTicketLeaf: apply.executionTicketLeaf,
        attestationLeaves: applyAttestations,
        terminalGraphLeaf: applyTerminal,
        publicKeysHex: [publicKeyHex],
      }),
    ).toEqual({ status: "refused", code: "binding_mismatch" });
  });

  it("requires the complete two-binary chain in the bound prefix", () => {
    const apply = completeApply();
    const complete = JSON.parse(
      decoder.decode(apply.terminalGraphLeaf.canonicalLeafBytes),
    ) as Record<string, unknown>;
    const { detachedSignatureSha256: _detachedSignatureSha256, ...unsigned } = complete;
    const underBound = signedLeaf({
      ...unsigned,
      boundChainPrefixSha256: apply.chains[0],
      boundObservedExecCount: 1,
    });
    expect(
      verifyApplyTranscript({
        approvalGrantLeaf: apply.approvalGrantLeaf,
        executionTicketLeaf: apply.executionTicketLeaf,
        attestationLeaves: apply.attestationLeaves,
        terminalGraphLeaf: underBound,
        publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
      }),
    ).toEqual({ status: "refused", code: "binding_mismatch" });
  });

  it("refuses execution evidence before authorization or first observed after expiry", () => {
    const preparationTicketLeaf = signedLeaf(preparationTicketUnsigned("history_fetch"));
    const preparationDigest = testSha(preparationTicketLeaf.canonicalLeafBytes);
    for (const observedAt of [
      "2026-09-03T11:59:59.000Z",
      "2026-09-03T12:15:00.000Z",
      "2026-09-03T12:16:00.000Z",
    ]) {
      const attestationLeaf = signedLeaf({
        ...runtimeAttestationUnsigned("history_fetch", preparationDigest, 1),
        observedAt,
      });
      expect(
        verifyPreparationTranscript({
          preparationTicketLeaf,
          attestationLeaves: [attestationLeaf],
          publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
        }),
      ).toEqual({ status: "refused", code: "binding_mismatch" });
    }

    const apply = completeApply();
    const applyDigest = testSha(apply.executionTicketLeaf.canonicalLeafBytes);
    for (const observedAt of [
      "2026-09-03T12:05:59.000Z",
      "2026-09-03T12:15:00.000Z",
      "2026-09-03T12:16:00.000Z",
    ]) {
      const attestationLeaf = signedLeaf({
        ...runtimeAttestationUnsigned("apply", applyDigest, 1),
        observedAt,
      });
      expect(
        verifyApplyTranscript({
          approvalGrantLeaf: apply.approvalGrantLeaf,
          executionTicketLeaf: apply.executionTicketLeaf,
          attestationLeaves: [attestationLeaf],
          publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
        }),
      ).toEqual({ status: "refused", code: "binding_mismatch" });
    }
  });

  it("reports ticket, grant and incomplete evidence without journal-state claims", () => {
    const preparationTicketLeaf = signedLeaf(preparationTicketUnsigned("history_fetch"));
    expect(
      unwrap(
        verifyPreparationTranscript({
          preparationTicketLeaf,
          attestationLeaves: [],
          publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
        }),
      ).state,
    ).toBe("preparation_ticket_only");
    const approvalGrantLeaf = signedLeaf(approvalGrantUnsigned());
    expect(
      unwrap(
        verifyApplyTranscript({
          approvalGrantLeaf,
          attestationLeaves: [],
          publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
        }),
      ).state,
    ).toBe("grant_only");
    const executionTicketLeaf = signedLeaf(executionTicketUnsigned(approvalGrantLeaf));
    expect(
      unwrap(
        verifyApplyTranscript({
          approvalGrantLeaf,
          executionTicketLeaf,
          attestationLeaves: [],
          publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
        }),
      ).state,
    ).toBe("execution_ticket_only");
    const digest = testSha(preparationTicketLeaf.canonicalLeafBytes);
    expect(
      unwrap(
        verifyPreparationTranscript({
          preparationTicketLeaf,
          attestationLeaves: [
            signedLeaf(runtimeAttestationUnsigned("history_fetch", digest, 1)),
          ],
          publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
        }),
      ).state,
    ).toBe("incomplete_execution_evidence");
  });

  it("closes exact preparation and apply no-spawn results", () => {
    const preparationTicketLeaf = signedLeaf(preparationTicketUnsigned("history_fetch"));
    const preparationNoExecution = signedLeaf({
      schemaVersion: "openspell.hosted-migration-preparation-no-execution-result.v1",
      preparationTicketSha256: testSha(preparationTicketLeaf.canonicalLeafBytes),
      ticketNonce: "1".repeat(64),
      operationId: OPERATION_ID,
      authorizationNonce: AUTHORIZATION_NONCE,
      phase: "history_fetch",
      writeCapability: false,
      targetFingerprint: TARGET,
      rootPhaseJournalGeneration: 2,
      reasonCode: "preparation_invariant_failed",
      priorState: "prepared",
      terminalState: "terminal_no_spawn",
      executingTransitionCount: 0,
      namespaceCreationCount: 0,
      cgroupCreationCount: 0,
      childCreationCount: 0,
      pidfdCreationCount: 0,
      phaseSessionCount: 0,
      zeroPhaseSessionEvidenceSha256: DIGEST_D,
      targetQuarantineEvidenceSha256: DIGEST_E,
      observedAt: "2026-09-03T12:10:00.000Z",
      issuerPublicKeySha256,
    });
    expect(
      unwrap(
        verifyPreparationTranscript({
          preparationTicketLeaf,
          attestationLeaves: [],
          noExecutionResultLeaf: preparationNoExecution,
          publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
        }),
      ).state,
    ).toBe("terminal_no_spawn_result_present");

    const apply = completeApply();
    const noExecutionResultLeaf = signedLeaf({
      schemaVersion: "openspell.hosted-migration-no-execution-result.v1",
      approvalGrantSha256: testSha(apply.approvalGrantLeaf.canonicalLeafBytes),
      executionTicketSha256: testSha(apply.executionTicketLeaf.canonicalLeafBytes),
      ticketNonce: "3".repeat(64),
      operationId: OPERATION_ID,
      authorizationNonce: AUTHORIZATION_NONCE,
      targetFingerprint: TARGET,
      rootJournalGeneration: 2,
      reasonCode: "pre_spawn_invariant_failed",
      priorState: "consumed",
      terminalState: "terminal_no_spawn",
      executingTransitionCount: 0,
      namespaceCreationCount: 0,
      cgroupCreationCount: 0,
      childCreationCount: 0,
      pidfdCreationCount: 0,
      applySessionCount: 0,
      zeroApplySessionEvidenceSha256: DIGEST_D,
      targetQuarantineEvidenceSha256: DIGEST_E,
      externalExclusiveWindowGeneration: 7,
      externalExclusiveWindowEvidenceSha256: DIGEST_F,
      observedAt: "2026-09-03T12:10:00.000Z",
      issuerPublicKeySha256,
    });
    expect(
      unwrap(
        verifyApplyTranscript({
          approvalGrantLeaf: apply.approvalGrantLeaf,
          executionTicketLeaf: apply.executionTicketLeaf,
          attestationLeaves: [],
          noExecutionResultLeaf,
          publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
        }),
      ).state,
    ).toBe("terminal_no_spawn_result_present");
  });

  it("requires expired no-spawn reasons to be observed at or after expiry", () => {
    const preparationTicketLeaf = signedLeaf(preparationTicketUnsigned("history_fetch"));
    expect(
      verifyPreparationTranscript({
        preparationTicketLeaf,
        attestationLeaves: [],
        noExecutionResultLeaf: preparationNoExecutionLeaf(
          preparationTicketLeaf,
          "preparation_ticket_expired",
          "2026-09-03T12:10:00.000Z",
        ),
        publicKeysHex: [publicKeyHex],
      }),
    ).toEqual({ status: "refused", code: "binding_mismatch" });
    expect(
      verifyPreparationTranscript({
        preparationTicketLeaf,
        attestationLeaves: [],
        noExecutionResultLeaf: preparationNoExecutionLeaf(
          preparationTicketLeaf,
          "preparation_ticket_expired",
          "2026-09-03T12:16:00.000Z",
        ),
        publicKeysHex: [publicKeyHex],
      }).status,
    ).toBe("conformant");

    const apply = completeApply();
    expect(
      verifyApplyTranscript({
        approvalGrantLeaf: apply.approvalGrantLeaf,
        executionTicketLeaf: apply.executionTicketLeaf,
        attestationLeaves: [],
        noExecutionResultLeaf: applyNoExecutionLeaf(
          apply,
          "ticket_expired",
          "2026-09-03T12:10:00.000Z",
        ),
        publicKeysHex: [publicKeyHex],
      }),
    ).toEqual({ status: "refused", code: "binding_mismatch" });
    expect(
      verifyApplyTranscript({
        approvalGrantLeaf: apply.approvalGrantLeaf,
        executionTicketLeaf: apply.executionTicketLeaf,
        attestationLeaves: [],
        noExecutionResultLeaf: applyNoExecutionLeaf(
          apply,
          "ticket_expired",
          "2026-09-03T12:16:00.000Z",
        ),
        publicKeysHex: [publicKeyHex],
      }).status,
    ).toBe("conformant");
  });

  it("closes every legal evidence-presence state and refuses illegal transition shapes", () => {
    const preparation = completePreparation("history_fetch");
    const apply = completeApply();
    expect(
      unwrap(
        verifyApplyTranscript({
          approvalGrantLeaf: apply.approvalGrantLeaf,
          executionTicketLeaf: apply.executionTicketLeaf,
          attestationLeaves: [apply.attestationLeaves[0] as SignedLeafInput],
          publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
        }),
      ).state,
    ).toBe("incomplete_execution_evidence");

    const illegal = [
      verifyPreparationTranscript({
        preparationTicketLeaf: preparation.preparationTicketLeaf,
        attestationLeaves: [],
        terminalGraphLeaf: preparation.terminalGraphLeaf,
        publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
      }),
      verifyPreparationTranscript({
        preparationTicketLeaf: preparation.preparationTicketLeaf,
        attestationLeaves: preparation.attestationLeaves,
        noExecutionResultLeaf: preparationNoExecutionLeaf(preparation.preparationTicketLeaf),
        publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
      }),
      verifyPreparationTranscript({
        preparationTicketLeaf: preparation.preparationTicketLeaf,
        attestationLeaves: [],
        noExecutionResultLeaf: applyNoExecutionLeaf(apply),
        publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
      }),
      verifyApplyTranscript({
        approvalGrantLeaf: apply.approvalGrantLeaf,
        attestationLeaves: apply.attestationLeaves,
        publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
      }),
      verifyApplyTranscript({
        approvalGrantLeaf: apply.approvalGrantLeaf,
        attestationLeaves: [],
        noExecutionResultLeaf: applyNoExecutionLeaf(apply),
        publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
      }),
    ];
    expect(illegal.map((result) => result.status)).toEqual([
      "refused",
      "refused",
      "refused",
      "refused",
      "refused",
    ]);
  });

  it("refuses cross-bound preparation and apply evidence fields", () => {
    const preparation = completePreparation("history_fetch");
    const preparationDigest = testSha(preparation.preparationTicketLeaf.canonicalLeafBytes);
    const preparationBindingChanges = {
      operationId: "9".repeat(64),
      authorizationNonce: "8".repeat(64),
      phase: "dry_run",
      phaseAuthorizationSha256: "7".repeat(64),
      phaseExecTopologyPolicySha256: "6".repeat(64),
      childCgroupPolicySha256: "5".repeat(64),
    };
    const baseAttestation = signedLeaf(
      runtimeAttestationUnsigned("history_fetch", preparationDigest, 1),
    );
    for (const [field, value] of Object.entries(preparationBindingChanges)) {
      expect(
        verifyPreparationTranscript({
          preparationTicketLeaf: preparation.preparationTicketLeaf,
          attestationLeaves: [resignLeaf(baseAttestation, { [field]: value })],
          publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
        }).status,
        `preparation attestation ${field}`,
      ).toBe("refused");
    }

    const apply = completeApply();
    const repeatedTicketChanges = {
      approvalGrantSha256: "9".repeat(64),
      approvalGrantSignatureSha256: "8".repeat(64),
      operationId: "7".repeat(64),
      authorizationNonce: "6".repeat(64),
      targetFingerprint: "5".repeat(64),
      targetSelectionSha256: "4".repeat(64),
      envelopeSha256: "3".repeat(64),
      externalExclusiveWindowGeneration: 8,
      externalExclusiveWindowEvidenceSha256: "2".repeat(64),
      officialSourceEvidenceSha256: "1".repeat(64),
      nativeRuntimeIdentitySha256: "9".repeat(64),
      childSandboxPolicySha256: "8".repeat(64),
      phaseExecTopologyPolicySha256: "7".repeat(64),
      childCgroupPolicySha256: "6".repeat(64),
      applyInvocationEvidenceSha256: "5".repeat(64),
      expiresAt: "2026-09-03T12:15:01.000Z",
      issuerPublicKeySha256: launcherPublicKeySha256,
    };
    for (const [field, value] of Object.entries(repeatedTicketChanges)) {
      expect(
        verifyApplyTranscript({
          approvalGrantLeaf: apply.approvalGrantLeaf,
          executionTicketLeaf: resignLeaf(apply.executionTicketLeaf, { [field]: value }),
          attestationLeaves: [],
          publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
        }).status,
        `grant/ticket ${field}`,
      ).toBe("refused");
    }

    const noExecution = applyNoExecutionLeaf(apply);
    const noExecutionBindingChanges = {
      approvalGrantSha256: "9".repeat(64),
      executionTicketSha256: "8".repeat(64),
      ticketNonce: "7".repeat(64),
      operationId: "6".repeat(64),
      authorizationNonce: "5".repeat(64),
      targetFingerprint: "4".repeat(64),
      externalExclusiveWindowGeneration: 8,
      externalExclusiveWindowEvidenceSha256: "3".repeat(64),
      issuerPublicKeySha256: launcherPublicKeySha256,
    };
    for (const [field, value] of Object.entries(noExecutionBindingChanges)) {
      expect(
        verifyApplyTranscript({
          approvalGrantLeaf: apply.approvalGrantLeaf,
          executionTicketLeaf: apply.executionTicketLeaf,
          attestationLeaves: [],
          noExecutionResultLeaf: resignLeaf(noExecution, { [field]: value }),
          publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
        }).status,
        `no-execution ${field}`,
      ).toBe("refused");
    }
  });

  it("refuses cross-binding, ambiguous evidence and arbitrary aggregate envelope claims", () => {
    const preparation = completePreparation("history_fetch");
    expect(
      verifyPreparationTranscript({
        preparationTicketLeaf: preparation.preparationTicketLeaf,
        attestationLeaves: preparation.attestationLeaves,
        terminalGraphLeaf: preparation.terminalGraphLeaf,
        noExecutionResultLeaf: preparation.terminalGraphLeaf,
        publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
      }),
    ).toEqual({ status: "refused", code: "ambiguous_evidence" });

    const apply = completeApply();
    const parsedTicket = JSON.parse(
      decoder.decode(apply.executionTicketLeaf.canonicalLeafBytes),
    ) as ExecutionTicketLeaf;
    const changedTicket = signedLeaf({
      ...parsedTicket,
      envelopeSha256: "9".repeat(64),
      detachedSignatureSha256: undefined,
    });
    expect(
      verifyApplyTranscript({
        approvalGrantLeaf: apply.approvalGrantLeaf,
        executionTicketLeaf: changedTicket,
        attestationLeaves: apply.attestationLeaves,
        terminalGraphLeaf: apply.terminalGraphLeaf,
        publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
      }),
    ).toEqual({ status: "refused", code: "binding_mismatch" });

    expect("verifySupervisorTranscript" in oracle).toBe(false);
  });

  it("refuses more than the exact two-process topology before cryptographic work", () => {
    const ticket = signedLeaf(preparationTicketUnsigned("history_fetch"));
    const malformed = Array.from({ length: 3 }, () => ({
      canonicalLeafBytes: encoder.encode("not-json"),
      rawSignatureHex: "0".repeat(128),
    }));
    expect(
      verifyPreparationTranscript({
        preparationTicketLeaf: ticket,
        attestationLeaves: malformed,
        publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
      }),
    ).toEqual({ status: "refused", code: "input_limit_exceeded" });
  });

  it("refuses transcript bytes above the aggregate cap before crypto", () => {
    const ticket = signedLeaf(preparationTicketUnsigned("history_fetch"));
    const malformed = Array.from({ length: 2 }, () => ({
      canonicalLeafBytes: new Uint8Array(3 * 1_024 * 1_024),
      rawSignatureHex: "0".repeat(128),
    }));
    expect(
      verifyPreparationTranscript({
        preparationTicketLeaf: ticket,
        attestationLeaves: malformed,
        publicKeysHex: [publicKeyHex, launcherPublicKeyHex],
      }),
    ).toEqual({ status: "refused", code: "input_limit_exceeded" });
  });
});
