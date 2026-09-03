import { verifySignedLeafInternal } from "./crypto.js";
import {
  MAX_ATTESTATIONS,
  MAX_TRANSCRIPT_BYTES,
  boundedSignedLeaves,
  foldVerifiedRuntimeAttestations,
} from "./derivations.js";
import { frozenRefusal } from "./types.js";
import type {
  ApplyTranscriptInput,
  ApprovalGrantLeaf,
  ConformanceResult,
  ExecutionEvidenceLeaves,
  ExecutionTicketLeaf,
  MigrationLeaf,
  NoExecutionResultLeaf,
  Phase,
  PhaseAuthorizationKind,
  PhaseTranscriptEvidence,
  PreparationNoExecutionResultLeaf,
  PreparationTicketLeaf,
  PreparationTranscriptInput,
  RuntimeAttestationLeaf,
  SignedLeafInput,
  TerminalExecGraphLeaf,
  VerifiedSignedLeaf,
} from "./types.js";

interface PhaseBinding {
  readonly operationId: string;
  readonly authorizationNonce: string;
  readonly phase: Phase;
  readonly phaseAuthorizationKind: PhaseAuthorizationKind;
  readonly phaseAuthorizationSha256: string;
  readonly phaseExecTopologyPolicySha256: string;
  readonly childCgroupPolicySha256: string;
  readonly rootAuthorityIssuerPublicKeySha256: string;
  readonly authorizationNotBefore: string;
  readonly authorizationExpiresAt: string;
}

interface ReductionInput extends ExecutionEvidenceLeaves {
  readonly binding: PhaseBinding;
  readonly initialState: "preparation_ticket_only" | "execution_ticket_only";
  readonly initialSignedLeafCount: number;
  readonly publicKeysHex: readonly string[];
  readonly preparationTicket?: VerifiedSignedLeaf<PreparationTicketLeaf>;
  readonly approvalGrant?: VerifiedSignedLeaf<ApprovalGrantLeaf>;
  readonly executionTicket?: VerifiedSignedLeaf<ExecutionTicketLeaf>;
}

function conformantPhase(
  value: PhaseTranscriptEvidence,
): ConformanceResult<PhaseTranscriptEvidence> {
  return Object.freeze({ status: "conformant", value: Object.freeze(value) });
}

function ownValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.get === undefined ? descriptor?.value : undefined;
}

function hasExactInputKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.every((key) => typeof key === "string") &&
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every(
      (key) =>
        typeof key === "string" && (required.includes(key) || optional.includes(key)),
    ) &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.get === undefined && descriptor?.set === undefined;
    })
  );
}

function isSignedLeafInput(value: unknown): value is SignedLeafInput {
  return (
    hasExactInputKeys(value, ["canonicalLeafBytes", "rawSignatureHex"]) &&
    ownValue(value, "canonicalLeafBytes") instanceof Uint8Array &&
    typeof ownValue(value, "rawSignatureHex") === "string"
  );
}

function evidenceLeaves(value: unknown): value is ExecutionEvidenceLeaves {
  if (
    !hasExactInputKeys(
      value,
      ["attestationLeaves"],
      ["terminalGraphLeaf", "noExecutionResultLeaf"],
    )
  ) {
    return false;
  }
  const attestations = ownValue(value, "attestationLeaves");
  const terminal = ownValue(value, "terminalGraphLeaf");
  const noExecution = ownValue(value, "noExecutionResultLeaf");
  return (
    Array.isArray(attestations) &&
    (attestations.length > MAX_ATTESTATIONS || attestations.every(isSignedLeafInput)) &&
    (terminal === undefined || isSignedLeafInput(terminal)) &&
    (noExecution === undefined || isSignedLeafInput(noExecution))
  );
}

function inputByteLength(input: SignedLeafInput): number {
  const bytes = ownValue(input, "canonicalLeafBytes");
  return bytes instanceof Uint8Array ? bytes.byteLength : MAX_TRANSCRIPT_BYTES + 1;
}

function boundedPhaseEvidence(
  authorizationLeaves: readonly SignedLeafInput[],
  evidence: ExecutionEvidenceLeaves,
): boolean {
  if (
    !boundedSignedLeaves(evidence.attestationLeaves) ||
    evidence.attestationLeaves.length > MAX_ATTESTATIONS
  ) {
    return false;
  }
  const all = [
    ...authorizationLeaves,
    ...evidence.attestationLeaves,
    ...(evidence.terminalGraphLeaf === undefined ? [] : [evidence.terminalGraphLeaf]),
    ...(evidence.noExecutionResultLeaf === undefined ? [] : [evidence.noExecutionResultLeaf]),
  ];
  let total = 0;
  for (const input of all) {
    total += inputByteLength(input);
    if (total > MAX_TRANSCRIPT_BYTES) return false;
  }
  return true;
}

function verifyAs<T extends MigrationLeaf>(
  input: SignedLeafInput,
  keys: readonly string[],
  schemaVersion: T["schemaVersion"],
): ConformanceResult<VerifiedSignedLeaf<T>> {
  const result = verifySignedLeafInternal(input, keys);
  if (result.status === "refused") return result;
  if (result.value.leaf.schemaVersion !== schemaVersion) {
    return { status: "refused", code: "invalid_transition" };
  }
  return { status: "conformant", value: result.value as VerifiedSignedLeaf<T> };
}

function attestationMatches(leaf: RuntimeAttestationLeaf, binding: PhaseBinding): boolean {
  return (
    leaf.operationId === binding.operationId &&
    leaf.authorizationNonce === binding.authorizationNonce &&
    leaf.phase === binding.phase &&
    leaf.phaseAuthorizationKind === binding.phaseAuthorizationKind &&
    leaf.phaseAuthorizationSha256 === binding.phaseAuthorizationSha256 &&
    leaf.phaseExecTopologyPolicySha256 === binding.phaseExecTopologyPolicySha256 &&
    leaf.childCgroupPolicySha256 === binding.childCgroupPolicySha256
  );
}

function terminalMatches(leaf: TerminalExecGraphLeaf, binding: PhaseBinding): boolean {
  return (
    leaf.operationId === binding.operationId &&
    leaf.authorizationNonce === binding.authorizationNonce &&
    leaf.phase === binding.phase &&
    leaf.phaseAuthorizationKind === binding.phaseAuthorizationKind &&
    leaf.phaseAuthorizationSha256 === binding.phaseAuthorizationSha256 &&
    leaf.phaseExecTopologyPolicySha256 === binding.phaseExecTopologyPolicySha256
  );
}

function verifyAttestations(
  inputs: readonly SignedLeafInput[],
  keys: readonly string[],
): ConformanceResult<readonly VerifiedSignedLeaf<RuntimeAttestationLeaf>[]> {
  if (!boundedSignedLeaves(inputs) || inputs.length > MAX_ATTESTATIONS) {
    return { status: "refused", code: "input_limit_exceeded" };
  }
  const verified: VerifiedSignedLeaf<RuntimeAttestationLeaf>[] = [];
  for (const input of inputs) {
    const result = verifyAs<RuntimeAttestationLeaf>(
      input,
      keys,
      "openspell.hosted-migration-runtime-attestation.v1",
    );
    if (result.status === "refused") return result;
    verified.push(result.value);
  }
  return { status: "conformant", value: verified };
}

function preparationNoExecutionMatches(
  leaf: PreparationNoExecutionResultLeaf,
  ticket: VerifiedSignedLeaf<PreparationTicketLeaf>,
): boolean {
  return (
    leaf.preparationTicketSha256 === ticket.canonicalLeafSha256 &&
    leaf.ticketNonce === ticket.leaf.ticketNonce &&
    leaf.operationId === ticket.leaf.operationId &&
    leaf.authorizationNonce === ticket.leaf.authorizationNonce &&
    leaf.phase === ticket.leaf.phase &&
    leaf.writeCapability === false &&
    leaf.targetFingerprint === ticket.leaf.targetFingerprint &&
    leaf.issuerPublicKeySha256 === ticket.leaf.issuerPublicKeySha256 &&
    Date.parse(leaf.observedAt) >= Date.parse(ticket.leaf.issuedAt) &&
    (leaf.reasonCode !== "preparation_ticket_expired" ||
      Date.parse(leaf.observedAt) >= Date.parse(ticket.leaf.expiresAt))
  );
}

function applyNoExecutionMatches(
  leaf: NoExecutionResultLeaf,
  grant: VerifiedSignedLeaf<ApprovalGrantLeaf>,
  ticket: VerifiedSignedLeaf<ExecutionTicketLeaf>,
): boolean {
  return (
    leaf.approvalGrantSha256 === grant.canonicalLeafSha256 &&
    leaf.executionTicketSha256 === ticket.canonicalLeafSha256 &&
    leaf.ticketNonce === ticket.leaf.ticketNonce &&
    leaf.operationId === ticket.leaf.operationId &&
    leaf.authorizationNonce === ticket.leaf.authorizationNonce &&
    leaf.targetFingerprint === ticket.leaf.targetFingerprint &&
    leaf.externalExclusiveWindowGeneration === ticket.leaf.externalExclusiveWindowGeneration &&
    leaf.externalExclusiveWindowEvidenceSha256 ===
      ticket.leaf.externalExclusiveWindowEvidenceSha256 &&
    leaf.issuerPublicKeySha256 === ticket.leaf.issuerPublicKeySha256 &&
    Date.parse(leaf.observedAt) >= Date.parse(ticket.leaf.consumedAt) &&
    (leaf.reasonCode !== "ticket_expired" ||
      Date.parse(leaf.observedAt) >= Date.parse(ticket.leaf.expiresAt))
  );
}

function reduceExecutionEvidence(
  input: ReductionInput,
): ConformanceResult<PhaseTranscriptEvidence> {
  const hasAttestations = input.attestationLeaves.length > 0;
  const hasTerminal = input.terminalGraphLeaf !== undefined;
  const hasNoExecution = input.noExecutionResultLeaf !== undefined;
  if (hasNoExecution && (hasAttestations || hasTerminal)) {
    return { status: "refused", code: "ambiguous_evidence" };
  }
  if (hasTerminal && !hasAttestations) {
    return { status: "refused", code: "invalid_transition" };
  }

  if (hasNoExecution) {
    if (input.preparationTicket !== undefined) {
      const result = verifyAs<PreparationNoExecutionResultLeaf>(
        input.noExecutionResultLeaf as SignedLeafInput,
        input.publicKeysHex,
        "openspell.hosted-migration-preparation-no-execution-result.v1",
      );
      if (result.status === "refused") return result;
      if (!preparationNoExecutionMatches(result.value.leaf, input.preparationTicket)) {
        return { status: "refused", code: "binding_mismatch" };
      }
    } else if (input.approvalGrant !== undefined && input.executionTicket !== undefined) {
      const result = verifyAs<NoExecutionResultLeaf>(
        input.noExecutionResultLeaf as SignedLeafInput,
        input.publicKeysHex,
        "openspell.hosted-migration-no-execution-result.v1",
      );
      if (result.status === "refused") return result;
      if (!applyNoExecutionMatches(result.value.leaf, input.approvalGrant, input.executionTicket)) {
        return { status: "refused", code: "binding_mismatch" };
      }
    } else {
      return { status: "refused", code: "invalid_transition" };
    }
    return conformantPhase({
      phase: input.binding.phase,
      state: "terminal_no_spawn_result_present",
      signedLeafCount: input.initialSignedLeafCount + 1,
    });
  }

  if (!hasAttestations) {
    return conformantPhase({
      phase: input.binding.phase,
      state: input.initialState,
      signedLeafCount: input.initialSignedLeafCount,
    });
  }

  const attestations = verifyAttestations(input.attestationLeaves, input.publicKeysHex);
  if (attestations.status === "refused") return attestations;
  const firstAttestation = attestations.value[0];
  if (
    firstAttestation === undefined ||
    firstAttestation.leaf.issuerPublicKeySha256 ===
      input.binding.rootAuthorityIssuerPublicKeySha256 ||
    Date.parse(firstAttestation.leaf.observedAt) >=
      Date.parse(input.binding.authorizationExpiresAt) ||
    attestations.value.some(
      (item) =>
        !attestationMatches(item.leaf, input.binding) ||
        Date.parse(item.leaf.observedAt) < Date.parse(input.binding.authorizationNotBefore),
    )
  ) {
    return { status: "refused", code: "binding_mismatch" };
  }
  const folded = foldVerifiedRuntimeAttestations(attestations.value);
  if (folded.status === "refused") return folded;
  if (!hasTerminal) {
    return conformantPhase({
      phase: input.binding.phase,
      state: "incomplete_execution_evidence",
      signedLeafCount: input.initialSignedLeafCount + attestations.value.length,
      terminalChainSha256: folded.value.evidence.terminalChainSha256,
    });
  }

  const terminal = verifyAs<TerminalExecGraphLeaf>(
    input.terminalGraphLeaf as SignedLeafInput,
    input.publicKeysHex,
    "openspell.hosted-migration-terminal-exec-graph.v1",
  );
  if (terminal.status === "refused") return terminal;
  const leaf = terminal.value.leaf;
  const boundChain = folded.value.chainValues[leaf.boundObservedExecCount - 1];
  const lastAttestation = attestations.value.at(-1);
  if (
    !terminalMatches(leaf, input.binding) ||
    leaf.boundObservedExecCount !== attestations.value.length ||
    leaf.terminalObservedExecCount !== attestations.value.length ||
    leaf.boundChainPrefixSha256 !== boundChain ||
    leaf.terminalChainSha256 !== folded.value.evidence.terminalChainSha256 ||
    lastAttestation === undefined ||
    leaf.issuerPublicKeySha256 !== lastAttestation.leaf.issuerPublicKeySha256 ||
    leaf.rootLauncherIdentitySha256 !== lastAttestation.leaf.rootLauncherIdentitySha256 ||
    Date.parse(leaf.observedAt) < Date.parse(lastAttestation.leaf.observedAt)
  ) {
    return { status: "refused", code: "binding_mismatch" };
  }
  return conformantPhase({
    phase: input.binding.phase,
    state: "terminal_graph_present",
    signedLeafCount: input.initialSignedLeafCount + attestations.value.length + 1,
    terminalChainSha256: folded.value.evidence.terminalChainSha256,
  });
}

function preparationInput(value: unknown): value is PreparationTranscriptInput {
  if (
    !hasExactInputKeys(
      value,
      ["preparationTicketLeaf", "attestationLeaves", "publicKeysHex"],
      ["terminalGraphLeaf", "noExecutionResultLeaf"],
    ) ||
    !isSignedLeafInput(ownValue(value, "preparationTicketLeaf")) ||
    !Array.isArray(ownValue(value, "publicKeysHex"))
  ) {
    return false;
  }
  const evidence = {
    attestationLeaves: ownValue(value, "attestationLeaves"),
    terminalGraphLeaf: ownValue(value, "terminalGraphLeaf"),
    noExecutionResultLeaf: ownValue(value, "noExecutionResultLeaf"),
  };
  return evidenceLeaves(evidence);
}

/** Reduces one exact WP-197 preparation phase without asserting that its evidence is live. */
function verifyPreparationTranscriptInternal(
  input: PreparationTranscriptInput,
): ConformanceResult<PhaseTranscriptEvidence> {
  if (!preparationInput(input)) return { status: "refused", code: "invalid_leaf" };
  const evidence: ExecutionEvidenceLeaves = {
    attestationLeaves: input.attestationLeaves,
    terminalGraphLeaf: input.terminalGraphLeaf,
    noExecutionResultLeaf: input.noExecutionResultLeaf,
  };
  if (!boundedPhaseEvidence([input.preparationTicketLeaf], evidence)) {
    return { status: "refused", code: "input_limit_exceeded" };
  }
  const ticket = verifyAs<PreparationTicketLeaf>(
    input.preparationTicketLeaf,
    input.publicKeysHex,
    "openspell.hosted-migration-preparation-ticket.v1",
  );
  if (ticket.status === "refused") return ticket;
  const binding: PhaseBinding = {
    operationId: ticket.value.leaf.operationId,
    authorizationNonce: ticket.value.leaf.authorizationNonce,
    phase: ticket.value.leaf.phase,
    phaseAuthorizationKind: "preparation_ticket",
    phaseAuthorizationSha256: ticket.value.canonicalLeafSha256,
    phaseExecTopologyPolicySha256: ticket.value.leaf.phaseExecTopologyPolicySha256,
    childCgroupPolicySha256: ticket.value.leaf.childCgroupPolicySha256,
    rootAuthorityIssuerPublicKeySha256: ticket.value.leaf.issuerPublicKeySha256,
    authorizationNotBefore: ticket.value.leaf.issuedAt,
    authorizationExpiresAt: ticket.value.leaf.expiresAt,
  };
  return reduceExecutionEvidence({
    ...evidence,
    binding,
    initialState: "preparation_ticket_only",
    initialSignedLeafCount: 1,
    publicKeysHex: input.publicKeysHex,
    preparationTicket: ticket.value,
  });
}

const repeatedGrantTicketFields = [
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
] as const;

function grantAndTicketMatch(
  grant: VerifiedSignedLeaf<ApprovalGrantLeaf>,
  ticket: VerifiedSignedLeaf<ExecutionTicketLeaf>,
): boolean {
  return (
    repeatedGrantTicketFields.every(
      (field) => grant.leaf[field] === ticket.leaf[field],
    ) &&
    ticket.leaf.approvalGrantSha256 === grant.canonicalLeafSha256 &&
    ticket.leaf.approvalGrantSignatureSha256 === grant.rawSignatureSha256 &&
    ticket.leaf.ticketNonce !== ticket.leaf.operationId &&
    ticket.leaf.ticketNonce !== ticket.leaf.authorizationNonce &&
    Date.parse(ticket.leaf.consumedAt) >= Date.parse(grant.leaf.issuedAt) &&
    Date.parse(ticket.leaf.consumedAt) <= Date.parse(grant.leaf.expiresAt) &&
    ticket.leaf.expiresAt === grant.leaf.expiresAt &&
    ticket.leaf.issuerPublicKeySha256 === grant.leaf.issuerPublicKeySha256
  );
}

function applyInput(value: unknown): value is ApplyTranscriptInput {
  if (
    !hasExactInputKeys(
      value,
      ["approvalGrantLeaf", "attestationLeaves", "publicKeysHex"],
      ["executionTicketLeaf", "terminalGraphLeaf", "noExecutionResultLeaf"],
    ) ||
    !isSignedLeafInput(ownValue(value, "approvalGrantLeaf")) ||
    (ownValue(value, "executionTicketLeaf") !== undefined &&
      !isSignedLeafInput(ownValue(value, "executionTicketLeaf"))) ||
    !Array.isArray(ownValue(value, "publicKeysHex"))
  ) {
    return false;
  }
  const evidence = {
    attestationLeaves: ownValue(value, "attestationLeaves"),
    terminalGraphLeaf: ownValue(value, "terminalGraphLeaf"),
    noExecutionResultLeaf: ownValue(value, "noExecutionResultLeaf"),
  };
  return evidenceLeaves(evidence);
}

/** Reduces exact WP-197 grant/ticket evidence without asserting approval, freshness or apply safety. */
function verifyApplyTranscriptInternal(
  input: ApplyTranscriptInput,
): ConformanceResult<PhaseTranscriptEvidence> {
  if (!applyInput(input)) return { status: "refused", code: "invalid_leaf" };
  const evidence: ExecutionEvidenceLeaves = {
    attestationLeaves: input.attestationLeaves,
    terminalGraphLeaf: input.terminalGraphLeaf,
    noExecutionResultLeaf: input.noExecutionResultLeaf,
  };
  const authorizationLeaves = [
    input.approvalGrantLeaf,
    ...(input.executionTicketLeaf === undefined ? [] : [input.executionTicketLeaf]),
  ];
  if (!boundedPhaseEvidence(authorizationLeaves, evidence)) {
    return { status: "refused", code: "input_limit_exceeded" };
  }
  const grant = verifyAs<ApprovalGrantLeaf>(
    input.approvalGrantLeaf,
    input.publicKeysHex,
    "openspell.hosted-migration-approval-grant.v1",
  );
  if (grant.status === "refused") return grant;
  if (input.executionTicketLeaf === undefined) {
    if (
      evidence.attestationLeaves.length > 0 ||
      evidence.terminalGraphLeaf !== undefined ||
      evidence.noExecutionResultLeaf !== undefined
    ) {
      return { status: "refused", code: "invalid_transition" };
    }
    return conformantPhase({ phase: "apply", state: "grant_only", signedLeafCount: 1 });
  }

  const ticket = verifyAs<ExecutionTicketLeaf>(
    input.executionTicketLeaf,
    input.publicKeysHex,
    "openspell.hosted-migration-execution-ticket.v1",
  );
  if (ticket.status === "refused") return ticket;
  if (!grantAndTicketMatch(grant.value, ticket.value)) {
    return { status: "refused", code: "binding_mismatch" };
  }
  const binding: PhaseBinding = {
    operationId: ticket.value.leaf.operationId,
    authorizationNonce: ticket.value.leaf.authorizationNonce,
    phase: "apply",
    phaseAuthorizationKind: "apply_execution_ticket",
    phaseAuthorizationSha256: ticket.value.canonicalLeafSha256,
    phaseExecTopologyPolicySha256: ticket.value.leaf.phaseExecTopologyPolicySha256,
    childCgroupPolicySha256: ticket.value.leaf.childCgroupPolicySha256,
    rootAuthorityIssuerPublicKeySha256: ticket.value.leaf.issuerPublicKeySha256,
    authorizationNotBefore: ticket.value.leaf.consumedAt,
    authorizationExpiresAt: ticket.value.leaf.expiresAt,
  };
  return reduceExecutionEvidence({
    ...evidence,
    binding,
    initialState: "execution_ticket_only",
    initialSignedLeafCount: 2,
    publicKeysHex: input.publicKeysHex,
    approvalGrant: grant.value,
    executionTicket: ticket.value,
  });
}

export function verifyPreparationTranscript(
  input: PreparationTranscriptInput,
): ConformanceResult<PhaseTranscriptEvidence> {
  try {
    const result = verifyPreparationTranscriptInternal(input);
    return result.status === "refused" ? frozenRefusal(result.code) : result;
  } catch {
    return frozenRefusal("invalid_leaf");
  }
}

export function verifyApplyTranscript(
  input: ApplyTranscriptInput,
): ConformanceResult<PhaseTranscriptEvidence> {
  try {
    const result = verifyApplyTranscriptInternal(input);
    return result.status === "refused" ? frozenRefusal(result.code) : result;
  } catch {
    return frozenRefusal("invalid_leaf");
  }
}
