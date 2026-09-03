import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { verifySignedLeaf } from "@wizard-ads/hosted-migration-conformance";
import { describe, expect, it } from "vitest";

interface GoldenSignedRecord {
  readonly canonicalBytes: readonly number[];
  readonly rawSignatureBytes: readonly number[];
}

interface GoldenCorpus {
  readonly schemaVersion: 1;
  readonly publicKeyBytes: readonly number[];
  readonly approvalGrant: GoldenSignedRecord;
  readonly executionTicket: GoldenSignedRecord;
}

const corpus = JSON.parse(
  readFileSync(new URL("grant-ticket-v1.golden.json", import.meta.url), "utf8"),
) as GoldenCorpus;
const decoder = new TextDecoder("utf-8", { fatal: true });

function bytes(input: readonly number[], expectedLength?: number): Uint8Array {
  expect(input.length).toBe(expectedLength ?? input.length);
  expect(input.length).toBeGreaterThan(0);
  expect(input.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)).toBe(true);
  return Uint8Array.from(input);
}

function sha256Hex(input: Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

function parseCanonical(input: Uint8Array): Record<string, unknown> {
  const text = decoder.decode(input);
  const parsed = JSON.parse(text) as Record<string, unknown>;
  expect(`${JSON.stringify(parsed, null, 2)}\n`).toBe(text);
  return parsed;
}

function verifyGolden(
  record: GoldenSignedRecord,
  expectedSchema: string,
  publicKeyHex: string,
): Record<string, unknown> {
  const canonicalLeafBytes = bytes(record.canonicalBytes);
  const rawSignature = bytes(record.rawSignatureBytes, 64);
  const result = verifySignedLeaf(
    { canonicalLeafBytes, rawSignatureHex: Buffer.from(rawSignature).toString("hex") },
    [publicKeyHex],
  );
  expect(result.status).toBe("conformant");
  if (result.status !== "conformant") throw new Error(`oracle refusal: ${result.code}`);
  expect(result.value).toEqual({
    schemaVersion: expectedSchema,
    canonicalLeafSha256: sha256Hex(canonicalLeafBytes),
    rawSignatureSha256: sha256Hex(rawSignature),
  });
  return parseCanonical(canonicalLeafBytes);
}

describe("WP-198 and WP-199 grant/ticket cross-oracle corpus", () => {
  it("accepts both immutable synthetic vectors with their exact canonical bytes and signatures", () => {
    expect(corpus.schemaVersion).toBe(1);
    const publicKeyHex = Buffer.from(bytes(corpus.publicKeyBytes, 32)).toString("hex");
    const grant = verifyGolden(
      corpus.approvalGrant,
      "openspell.hosted-migration-approval-grant.v1",
      publicKeyHex,
    );
    const ticket = verifyGolden(
      corpus.executionTicket,
      "openspell.hosted-migration-execution-ticket.v1",
      publicKeyHex,
    );

    expect(ticket.approvalGrantSha256).toBe(
      sha256Hex(bytes(corpus.approvalGrant.canonicalBytes)),
    );
    expect(ticket.approvalGrantSignatureSha256).toBe(
      sha256Hex(bytes(corpus.approvalGrant.rawSignatureBytes, 64)),
    );
    expect(ticket.expiresAt).toBe(grant.expiresAt);
    for (const key of [
      "operationId",
      "authorizationNonce",
      "targetFingerprint",
      "targetSelectionSha256",
      "envelopeSha256",
      "externalExclusiveWindowGeneration",
      "externalExclusiveWindowEvidenceSha256",
      "officialSourceEvidenceSha256",
      "nativeRuntimeIdentitySha256",
      "childSandboxPolicySha256",
      "phaseExecTopologyPolicySha256",
      "childCgroupPolicySha256",
      "applyInvocationEvidenceSha256",
      "issuerPublicKeySha256",
    ]) {
      expect(ticket[key], key).toBe(grant[key]);
    }
  });

  it("refuses one-byte signed-field, signature-digest and key-pin mutations", () => {
    const publicKeyHex = Buffer.from(bytes(corpus.publicKeyBytes, 32)).toString("hex");
    const canonicalLeafBytes = bytes(corpus.approvalGrant.canonicalBytes);
    const rawSignature = bytes(corpus.approvalGrant.rawSignatureBytes, 64);
    const signatureHex = Buffer.from(rawSignature).toString("hex");

    const fieldMutation = new Uint8Array(canonicalLeafBytes);
    const operationPrefix = Buffer.from('  "operationId": "', "utf8");
    const operationOffset = Buffer.from(fieldMutation).indexOf(operationPrefix) + operationPrefix.length;
    expect(operationOffset).toBeGreaterThan(operationPrefix.length - 1);
    fieldMutation[operationOffset] = fieldMutation[operationOffset] === 0x31 ? 0x30 : 0x31;
    expect(
      verifySignedLeaf({ canonicalLeafBytes: fieldMutation, rawSignatureHex: signatureHex }, [
        publicKeyHex,
      ]),
    ).toEqual({ status: "refused", code: "invalid_signature" });

    const signatureMutation = new Uint8Array(rawSignature);
    signatureMutation[0] = (signatureMutation[0] ?? 0) ^ 1;
    expect(
      verifySignedLeaf(
        {
          canonicalLeafBytes,
          rawSignatureHex: Buffer.from(signatureMutation).toString("hex"),
        },
        [publicKeyHex],
      ),
    ).toEqual({ status: "refused", code: "detached_signature_mismatch" });

    const wrongKey = new Uint8Array(bytes(corpus.publicKeyBytes, 32));
    wrongKey[0] = (wrongKey[0] ?? 0) ^ 1;
    expect(
      verifySignedLeaf({ canonicalLeafBytes, rawSignatureHex: signatureHex }, [
        Buffer.from(wrongKey).toString("hex"),
      ]),
    ).toEqual({ status: "refused", code: "verification_key_not_found" });
  });
});
