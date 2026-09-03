export const LEAF_SCHEMA_VERSIONS = Object.freeze([
  "openspell.hosted-migration-external-window.v1",
  "openspell.hosted-migration-preparation-ticket.v1",
  "openspell.hosted-migration-preparation-no-execution-result.v1",
  "openspell.hosted-migration-runtime-attestation.v1",
  "openspell.hosted-migration-terminal-exec-graph.v1",
  "openspell.hosted-migration-approval-grant.v1",
  "openspell.hosted-migration-execution-ticket.v1",
  "openspell.hosted-migration-no-execution-result.v1",
] as const);

export type LeafSchemaVersion = (typeof LEAF_SCHEMA_VERSIONS)[number];
export type Phase = "history_fetch" | "dry_run" | "apply";
export type PreparationPhase = Exclude<Phase, "apply">;
export type PhaseAuthorizationKind = "preparation_ticket" | "apply_execution_ticket";

export interface ExternalWindowLeaf {
  readonly schemaVersion: "openspell.hosted-migration-external-window.v1";
  readonly operationId: string;
  readonly authorizationNonce: string;
  readonly targetFingerprint: string;
  readonly generation: number;
  readonly state: "held";
  readonly excludedActorClasses: readonly [
    "agent_brokers",
    "manual_cli",
    "other_hosts",
    "scheduled_jobs",
  ];
  readonly actorRosterSha256: string;
  readonly credentialInventorySha256: string;
  readonly issuerRevision: string;
  readonly issuerPublicKeySha256: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly detachedSignatureSha256: string;
}

export interface PreparationTicketLeaf {
  readonly schemaVersion: "openspell.hosted-migration-preparation-ticket.v1";
  readonly ticketNonce: string;
  readonly operationId: string;
  readonly authorizationNonce: string;
  readonly phase: PreparationPhase;
  readonly writeCapability: false;
  readonly targetFingerprint: string;
  readonly targetSelectionSha256: string;
  readonly officialSourceEvidenceSha256: string;
  readonly nativeRuntimeIdentitySha256: string;
  readonly childSandboxPolicySha256: string;
  readonly phaseExecTopologyPolicySha256: string;
  readonly childCgroupPolicySha256: string;
  readonly phaseInvocationEvidenceSha256: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly state: "prepared";
  readonly issuerPublicKeySha256: string;
  readonly detachedSignatureSha256: string;
}

export interface PreparationNoExecutionResultLeaf {
  readonly schemaVersion: "openspell.hosted-migration-preparation-no-execution-result.v1";
  readonly preparationTicketSha256: string;
  readonly ticketNonce: string;
  readonly operationId: string;
  readonly authorizationNonce: string;
  readonly phase: PreparationPhase;
  readonly writeCapability: false;
  readonly targetFingerprint: string;
  readonly rootPhaseJournalGeneration: number;
  readonly reasonCode:
    | "preparation_ticket_expired"
    | "preparation_invariant_failed"
    | "preparation_launcher_rejected_before_execution";
  readonly priorState: "prepared";
  readonly terminalState: "terminal_no_spawn";
  readonly executingTransitionCount: 0;
  readonly namespaceCreationCount: 0;
  readonly cgroupCreationCount: 0;
  readonly childCreationCount: 0;
  readonly pidfdCreationCount: 0;
  readonly phaseSessionCount: 0;
  readonly zeroPhaseSessionEvidenceSha256: string;
  readonly targetQuarantineEvidenceSha256: string;
  readonly observedAt: string;
  readonly issuerPublicKeySha256: string;
  readonly detachedSignatureSha256: string;
}

export interface RuntimeAttestationLeaf {
  readonly schemaVersion: "openspell.hosted-migration-runtime-attestation.v1";
  readonly phase: Phase;
  readonly operationId: string;
  readonly authorizationNonce: string;
  readonly phaseAuthorizationKind: PhaseAuthorizationKind;
  readonly phaseAuthorizationSha256: string;
  readonly phaseExecTopologyPolicySha256: string;
  readonly childCgroupPolicySha256: string;
  readonly childCgroupEvidenceSha256: string;
  readonly execOrdinal: number;
  readonly processPid: number;
  readonly processStart: string;
  readonly parentPid: number;
  readonly parentStart: string;
  readonly executableRelativePath: "usr/local/libexec/supabase" | "usr/local/libexec/supabase-go";
  readonly executableSha256: string;
  readonly namespaceRootDevice: number;
  readonly namespaceRootInode: number;
  readonly mapsManifestSha256: string;
  readonly runtimeUid: number;
  readonly runtimeGid: number;
  readonly noNewPrivileges: true;
  readonly dumpable: false;
  readonly coreLimitBytes: 0;
  readonly effectiveCapabilities: readonly [];
  readonly permittedCapabilities: readonly [];
  readonly inheritableCapabilities: readonly [];
  readonly ambientCapabilities: readonly [];
  readonly procPolicySha256: string;
  readonly egressPolicySha256: string;
  readonly observedAt: string;
  readonly rootLauncherIdentitySha256: string;
  readonly issuerPublicKeySha256: string;
  readonly detachedSignatureSha256: string;
}

export interface TerminalExecGraphLeaf {
  readonly schemaVersion: "openspell.hosted-migration-terminal-exec-graph.v1";
  readonly phase: Phase;
  readonly operationId: string;
  readonly authorizationNonce: string;
  readonly phaseAuthorizationKind: PhaseAuthorizationKind;
  readonly phaseAuthorizationSha256: string;
  readonly phaseExecTopologyPolicySha256: string;
  readonly boundChainPrefixSha256: string;
  readonly boundObservedExecCount: number;
  readonly terminalChainSha256: string;
  readonly terminalObservedExecCount: number;
  readonly terminalGraphState: "closed";
  readonly childCgroupEmpty: true;
  readonly taggedSessionCount: 0;
  readonly observedAt: string;
  readonly rootLauncherIdentitySha256: string;
  readonly issuerPublicKeySha256: string;
  readonly detachedSignatureSha256: string;
}

export interface ApprovalGrantLeaf {
  readonly schemaVersion: "openspell.hosted-migration-approval-grant.v1";
  readonly operationId: string;
  readonly authorizationNonce: string;
  readonly targetFingerprint: string;
  readonly targetSelectionSha256: string;
  readonly envelopeSha256: string;
  readonly externalExclusiveWindowGeneration: number;
  readonly externalExclusiveWindowEvidenceSha256: string;
  readonly officialSourceEvidenceSha256: string;
  readonly nativeRuntimeIdentitySha256: string;
  readonly childSandboxPolicySha256: string;
  readonly phaseExecTopologyPolicySha256: string;
  readonly childCgroupPolicySha256: string;
  readonly applyInvocationEvidenceSha256: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly authenticatedOperatorIdentitySha256: string;
  readonly osAuthenticationSessionSha256: string;
  readonly authenticatedAt: string;
  readonly state: "approved";
  readonly issuerPublicKeySha256: string;
  readonly detachedSignatureSha256: string;
}

export interface ExecutionTicketLeaf {
  readonly schemaVersion: "openspell.hosted-migration-execution-ticket.v1";
  readonly approvalGrantSha256: string;
  readonly approvalGrantSignatureSha256: string;
  readonly ticketNonce: string;
  readonly operationId: string;
  readonly authorizationNonce: string;
  readonly targetFingerprint: string;
  readonly targetSelectionSha256: string;
  readonly envelopeSha256: string;
  readonly externalExclusiveWindowGeneration: number;
  readonly externalExclusiveWindowEvidenceSha256: string;
  readonly officialSourceEvidenceSha256: string;
  readonly nativeRuntimeIdentitySha256: string;
  readonly childSandboxPolicySha256: string;
  readonly phaseExecTopologyPolicySha256: string;
  readonly childCgroupPolicySha256: string;
  readonly applyInvocationEvidenceSha256: string;
  readonly consumedAt: string;
  readonly expiresAt: string;
  readonly state: "consumed";
  readonly issuerPublicKeySha256: string;
  readonly detachedSignatureSha256: string;
}

export interface NoExecutionResultLeaf {
  readonly schemaVersion: "openspell.hosted-migration-no-execution-result.v1";
  readonly approvalGrantSha256: string;
  readonly executionTicketSha256: string;
  readonly ticketNonce: string;
  readonly operationId: string;
  readonly authorizationNonce: string;
  readonly targetFingerprint: string;
  readonly rootJournalGeneration: number;
  readonly reasonCode:
    | "pre_spawn_invariant_failed"
    | "ticket_expired"
    | "launcher_rejected_before_execution";
  readonly priorState: "consumed";
  readonly terminalState: "terminal_no_spawn";
  readonly executingTransitionCount: 0;
  readonly namespaceCreationCount: 0;
  readonly cgroupCreationCount: 0;
  readonly childCreationCount: 0;
  readonly pidfdCreationCount: 0;
  readonly applySessionCount: 0;
  readonly zeroApplySessionEvidenceSha256: string;
  readonly targetQuarantineEvidenceSha256: string;
  readonly externalExclusiveWindowGeneration: number;
  readonly externalExclusiveWindowEvidenceSha256: string;
  readonly observedAt: string;
  readonly issuerPublicKeySha256: string;
  readonly detachedSignatureSha256: string;
}

export type MigrationLeaf =
  | ExternalWindowLeaf
  | PreparationTicketLeaf
  | PreparationNoExecutionResultLeaf
  | RuntimeAttestationLeaf
  | TerminalExecGraphLeaf
  | ApprovalGrantLeaf
  | ExecutionTicketLeaf
  | NoExecutionResultLeaf;

export const REFUSAL_CODES = Object.freeze([
  "input_limit_exceeded",
  "invalid_canonical_json",
  "unknown_leaf_schema",
  "invalid_leaf",
  "invalid_public_key",
  "verification_key_not_found",
  "detached_signature_mismatch",
  "invalid_signature",
  "invalid_session_tag",
  "invalid_attestation_chain",
  "binding_mismatch",
  "invalid_transition",
  "missing_evidence",
  "ambiguous_evidence",
] as const);

export type RefusalCode = (typeof REFUSAL_CODES)[number];
export type ConformanceResult<T> =
  | { readonly status: "conformant"; readonly value: T }
  | { readonly status: "refused"; readonly code: RefusalCode };

export function frozenRefusal(code: RefusalCode): ConformanceResult<never> {
  return Object.freeze({ status: "refused", code });
}

export interface SignedLeafInput {
  readonly canonicalLeafBytes: Uint8Array;
  readonly rawSignatureHex: string;
}

export interface VerifiedSignedLeaf<T extends MigrationLeaf = MigrationLeaf> {
  readonly leaf: T;
  readonly canonicalLeafSha256: string;
  readonly rawSignatureSha256: string;
}

export interface SignedLeafEvidence {
  readonly schemaVersion: LeafSchemaVersion;
  readonly canonicalLeafSha256: string;
  readonly rawSignatureSha256: string;
}

export interface AttestationChainEvidence {
  readonly terminalChainSha256: string;
  readonly terminalObservedExecCount: number;
}

export type ReducedPhaseState =
  | "grant_only"
  | "preparation_ticket_only"
  | "execution_ticket_only"
  | "terminal_graph_present"
  | "terminal_no_spawn_result_present"
  | "incomplete_execution_evidence";

export interface PhaseTranscriptEvidence {
  readonly phase: Phase;
  readonly state: ReducedPhaseState;
  readonly signedLeafCount: number;
  readonly terminalChainSha256?: string;
}

export interface ExecutionEvidenceLeaves {
  readonly attestationLeaves: readonly SignedLeafInput[];
  readonly terminalGraphLeaf?: SignedLeafInput;
  readonly noExecutionResultLeaf?: SignedLeafInput;
}

export interface PreparationTranscriptInput extends ExecutionEvidenceLeaves {
  readonly preparationTicketLeaf: SignedLeafInput;
  readonly publicKeysHex: readonly string[];
}

export interface ApplyTranscriptInput extends ExecutionEvidenceLeaves {
  readonly approvalGrantLeaf: SignedLeafInput;
  readonly executionTicketLeaf?: SignedLeafInput;
  readonly publicKeysHex: readonly string[];
}
