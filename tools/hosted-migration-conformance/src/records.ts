import type { LeafSchemaVersion, MigrationLeaf, Phase } from "./types.js";

const HEX_40 = /^[0-9a-f]{40}$/u;
const HEX_64 = /^[0-9a-f]{64}$/u;
const PRINTABLE_ASCII = /^[\x20-\x7e]{1,256}$/u;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const UTC_INSTANT_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const leafKeys = {
  "openspell.hosted-migration-external-window.v1": [
    "schemaVersion",
    "operationId",
    "authorizationNonce",
    "targetFingerprint",
    "generation",
    "state",
    "excludedActorClasses",
    "actorRosterSha256",
    "credentialInventorySha256",
    "issuerRevision",
    "issuerPublicKeySha256",
    "acquiredAt",
    "expiresAt",
    "detachedSignatureSha256",
  ],
  "openspell.hosted-migration-preparation-ticket.v1": [
    "schemaVersion",
    "ticketNonce",
    "operationId",
    "authorizationNonce",
    "phase",
    "writeCapability",
    "targetFingerprint",
    "targetSelectionSha256",
    "officialSourceEvidenceSha256",
    "nativeRuntimeIdentitySha256",
    "childSandboxPolicySha256",
    "phaseExecTopologyPolicySha256",
    "childCgroupPolicySha256",
    "phaseInvocationEvidenceSha256",
    "issuedAt",
    "expiresAt",
    "state",
    "issuerPublicKeySha256",
    "detachedSignatureSha256",
  ],
  "openspell.hosted-migration-preparation-no-execution-result.v1": [
    "schemaVersion",
    "preparationTicketSha256",
    "ticketNonce",
    "operationId",
    "authorizationNonce",
    "phase",
    "writeCapability",
    "targetFingerprint",
    "rootPhaseJournalGeneration",
    "reasonCode",
    "priorState",
    "terminalState",
    "executingTransitionCount",
    "namespaceCreationCount",
    "cgroupCreationCount",
    "childCreationCount",
    "pidfdCreationCount",
    "phaseSessionCount",
    "zeroPhaseSessionEvidenceSha256",
    "targetQuarantineEvidenceSha256",
    "observedAt",
    "issuerPublicKeySha256",
    "detachedSignatureSha256",
  ],
  "openspell.hosted-migration-runtime-attestation.v1": [
    "schemaVersion",
    "phase",
    "operationId",
    "authorizationNonce",
    "phaseAuthorizationKind",
    "phaseAuthorizationSha256",
    "phaseExecTopologyPolicySha256",
    "childCgroupPolicySha256",
    "childCgroupEvidenceSha256",
    "execOrdinal",
    "processPid",
    "processStart",
    "parentPid",
    "parentStart",
    "executableRelativePath",
    "executableSha256",
    "namespaceRootDevice",
    "namespaceRootInode",
    "mapsManifestSha256",
    "runtimeUid",
    "runtimeGid",
    "noNewPrivileges",
    "dumpable",
    "coreLimitBytes",
    "effectiveCapabilities",
    "permittedCapabilities",
    "inheritableCapabilities",
    "ambientCapabilities",
    "procPolicySha256",
    "egressPolicySha256",
    "observedAt",
    "rootLauncherIdentitySha256",
    "issuerPublicKeySha256",
    "detachedSignatureSha256",
  ],
  "openspell.hosted-migration-terminal-exec-graph.v1": [
    "schemaVersion",
    "phase",
    "operationId",
    "authorizationNonce",
    "phaseAuthorizationKind",
    "phaseAuthorizationSha256",
    "phaseExecTopologyPolicySha256",
    "boundChainPrefixSha256",
    "boundObservedExecCount",
    "terminalChainSha256",
    "terminalObservedExecCount",
    "terminalGraphState",
    "childCgroupEmpty",
    "taggedSessionCount",
    "observedAt",
    "rootLauncherIdentitySha256",
    "issuerPublicKeySha256",
    "detachedSignatureSha256",
  ],
  "openspell.hosted-migration-approval-grant.v1": [
    "schemaVersion",
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
    "issuedAt",
    "expiresAt",
    "authenticatedOperatorIdentitySha256",
    "osAuthenticationSessionSha256",
    "authenticatedAt",
    "state",
    "issuerPublicKeySha256",
    "detachedSignatureSha256",
  ],
  "openspell.hosted-migration-execution-ticket.v1": [
    "schemaVersion",
    "approvalGrantSha256",
    "approvalGrantSignatureSha256",
    "ticketNonce",
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
    "consumedAt",
    "expiresAt",
    "state",
    "issuerPublicKeySha256",
    "detachedSignatureSha256",
  ],
  "openspell.hosted-migration-no-execution-result.v1": [
    "schemaVersion",
    "approvalGrantSha256",
    "executionTicketSha256",
    "ticketNonce",
    "operationId",
    "authorizationNonce",
    "targetFingerprint",
    "rootJournalGeneration",
    "reasonCode",
    "priorState",
    "terminalState",
    "executingTransitionCount",
    "namespaceCreationCount",
    "cgroupCreationCount",
    "childCreationCount",
    "pidfdCreationCount",
    "applySessionCount",
    "zeroApplySessionEvidenceSha256",
    "targetQuarantineEvidenceSha256",
    "externalExclusiveWindowGeneration",
    "externalExclusiveWindowEvidenceSha256",
    "observedAt",
    "issuerPublicKeySha256",
    "detachedSignatureSha256",
  ],
} as const satisfies Record<LeafSchemaVersion, readonly string[]>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownValue(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.get === undefined ? descriptor?.value : undefined;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key, index) => typeof key === "string" && key === keys[index]) &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.get === undefined && descriptor.set === undefined;
    })
  );
}

function isHex40(value: unknown): value is string {
  return typeof value === "string" && HEX_40.test(value);
}

export function isHex64(value: unknown): value is string {
  return typeof value === "string" && HEX_64.test(value);
}

function isPhase(value: unknown): value is Phase {
  return value === "history_fetch" || value === "dry_run" || value === "apply";
}

function isPreparationPhase(value: unknown): boolean {
  return value === "history_fetch" || value === "dry_run";
}

function isSafeInteger(value: unknown, positive: boolean): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= (positive ? 1 : 0) &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function isUtcInstant(value: unknown): value is string {
  if (typeof value !== "string" || !UTC_INSTANT.test(value)) return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  const normalized = new Date(milliseconds).toISOString();
  return value.includes(".") ? normalized === value : normalized.replace(".000Z", "Z") === value;
}

function isUtcInstantMilliseconds(value: unknown): value is string {
  if (typeof value !== "string" || !UTC_INSTANT_MILLISECONDS.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function orderedInstants(before: unknown, after: unknown, maxMilliseconds?: number): boolean {
  if (!isUtcInstant(before) || !isUtcInstant(after)) return false;
  const duration = Date.parse(after) - Date.parse(before);
  return duration > 0 && (maxMilliseconds === undefined || duration <= maxMilliseconds);
}

function isPrintableAscii(value: unknown): value is string {
  return typeof value === "string" && PRINTABLE_ASCII.test(value);
}

function isEmptyArray(value: unknown): value is readonly [] {
  return Array.isArray(value) && value.length === 0;
}

function baseIdentity(value: Record<string, unknown>): boolean {
  return isHex64(ownValue(value, "operationId")) && isHex64(ownValue(value, "authorizationNonce"));
}

function phaseAuthorizationMatches(value: Record<string, unknown>): boolean {
  const phase = ownValue(value, "phase");
  const kind = ownValue(value, "phaseAuthorizationKind");
  return (
    isPhase(phase) &&
    ((phase === "apply" && kind === "apply_execution_ticket") ||
      (phase !== "apply" && kind === "preparation_ticket"))
  );
}

function allDigests(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => isHex64(ownValue(value, key)));
}

function allZero(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => ownValue(value, key) === 0);
}

export function isLeafSchemaVersion(value: unknown): value is LeafSchemaVersion {
  return typeof value === "string" && Object.hasOwn(leafKeys, value);
}

export function validateMigrationLeaf(value: unknown): MigrationLeaf | undefined {
  if (!isObject(value)) return undefined;
  const schemaVersion = ownValue(value, "schemaVersion");
  if (!isLeafSchemaVersion(schemaVersion) || !hasExactKeys(value, leafKeys[schemaVersion])) {
    return undefined;
  }
  if (!isHex64(ownValue(value, "issuerPublicKeySha256"))) return undefined;
  if (!isHex64(ownValue(value, "detachedSignatureSha256"))) return undefined;

  switch (schemaVersion) {
    case "openspell.hosted-migration-external-window.v1": {
      const excluded = ownValue(value, "excludedActorClasses");
      if (
        !baseIdentity(value) ||
        !isHex64(ownValue(value, "targetFingerprint")) ||
        !isSafeInteger(ownValue(value, "generation"), true) ||
        ownValue(value, "state") !== "held" ||
        !Array.isArray(excluded) ||
        excluded.length !== 4 ||
        excluded[0] !== "agent_brokers" ||
        excluded[1] !== "manual_cli" ||
        excluded[2] !== "other_hosts" ||
        excluded[3] !== "scheduled_jobs" ||
        !allDigests(value, ["actorRosterSha256", "credentialInventorySha256"]) ||
        !isHex40(ownValue(value, "issuerRevision")) ||
        !isUtcInstantMilliseconds(ownValue(value, "acquiredAt")) ||
        !isUtcInstantMilliseconds(ownValue(value, "expiresAt")) ||
        !orderedInstants(ownValue(value, "acquiredAt"), ownValue(value, "expiresAt"))
      ) {
        return undefined;
      }
      break;
    }
    case "openspell.hosted-migration-preparation-ticket.v1":
      if (
        !baseIdentity(value) ||
        !isHex64(ownValue(value, "ticketNonce")) ||
        !isPreparationPhase(ownValue(value, "phase")) ||
        ownValue(value, "writeCapability") !== false ||
        !isHex64(ownValue(value, "targetFingerprint")) ||
        !allDigests(value, [
          "targetSelectionSha256",
          "officialSourceEvidenceSha256",
          "nativeRuntimeIdentitySha256",
          "childSandboxPolicySha256",
          "phaseExecTopologyPolicySha256",
          "childCgroupPolicySha256",
          "phaseInvocationEvidenceSha256",
        ]) ||
        !orderedInstants(ownValue(value, "issuedAt"), ownValue(value, "expiresAt")) ||
        ownValue(value, "state") !== "prepared"
      ) {
        return undefined;
      }
      break;
    case "openspell.hosted-migration-preparation-no-execution-result.v1":
      if (
        !baseIdentity(value) ||
        !isHex64(ownValue(value, "preparationTicketSha256")) ||
        !isHex64(ownValue(value, "ticketNonce")) ||
        !isPreparationPhase(ownValue(value, "phase")) ||
        ownValue(value, "writeCapability") !== false ||
        !isHex64(ownValue(value, "targetFingerprint")) ||
        !isSafeInteger(ownValue(value, "rootPhaseJournalGeneration"), true) ||
        ![
          "preparation_ticket_expired",
          "preparation_invariant_failed",
          "preparation_launcher_rejected_before_execution",
        ].includes(ownValue(value, "reasonCode") as string) ||
        ownValue(value, "priorState") !== "prepared" ||
        ownValue(value, "terminalState") !== "terminal_no_spawn" ||
        !allZero(value, [
          "executingTransitionCount",
          "namespaceCreationCount",
          "cgroupCreationCount",
          "childCreationCount",
          "pidfdCreationCount",
          "phaseSessionCount",
        ]) ||
        !allDigests(value, [
          "zeroPhaseSessionEvidenceSha256",
          "targetQuarantineEvidenceSha256",
        ]) ||
        !isUtcInstant(ownValue(value, "observedAt"))
      ) {
        return undefined;
      }
      break;
    case "openspell.hosted-migration-runtime-attestation.v1":
      if (
        !baseIdentity(value) ||
        !phaseAuthorizationMatches(value) ||
        !allDigests(value, [
          "phaseAuthorizationSha256",
          "phaseExecTopologyPolicySha256",
          "childCgroupPolicySha256",
          "childCgroupEvidenceSha256",
          "executableSha256",
          "mapsManifestSha256",
          "procPolicySha256",
          "egressPolicySha256",
          "rootLauncherIdentitySha256",
        ]) ||
        !isSafeInteger(ownValue(value, "execOrdinal"), true) ||
        !isSafeInteger(ownValue(value, "processPid"), true) ||
        !isPrintableAscii(ownValue(value, "processStart")) ||
        !isSafeInteger(ownValue(value, "parentPid"), true) ||
        !isPrintableAscii(ownValue(value, "parentStart")) ||
        (ownValue(value, "executableRelativePath") !== "usr/local/libexec/supabase" &&
          ownValue(value, "executableRelativePath") !== "usr/local/libexec/supabase-go") ||
        !isSafeInteger(ownValue(value, "namespaceRootDevice"), true) ||
        !isSafeInteger(ownValue(value, "namespaceRootInode"), true) ||
        !isSafeInteger(ownValue(value, "runtimeUid"), true) ||
        !isSafeInteger(ownValue(value, "runtimeGid"), true) ||
        ownValue(value, "noNewPrivileges") !== true ||
        ownValue(value, "dumpable") !== false ||
        ownValue(value, "coreLimitBytes") !== 0 ||
        !isEmptyArray(ownValue(value, "effectiveCapabilities")) ||
        !isEmptyArray(ownValue(value, "permittedCapabilities")) ||
        !isEmptyArray(ownValue(value, "inheritableCapabilities")) ||
        !isEmptyArray(ownValue(value, "ambientCapabilities")) ||
        !isUtcInstant(ownValue(value, "observedAt"))
      ) {
        return undefined;
      }
      break;
    case "openspell.hosted-migration-terminal-exec-graph.v1": {
      const boundCount = ownValue(value, "boundObservedExecCount");
      const terminalCount = ownValue(value, "terminalObservedExecCount");
      if (
        !baseIdentity(value) ||
        !phaseAuthorizationMatches(value) ||
        !allDigests(value, [
          "phaseAuthorizationSha256",
          "phaseExecTopologyPolicySha256",
          "boundChainPrefixSha256",
          "terminalChainSha256",
          "rootLauncherIdentitySha256",
        ]) ||
        !isSafeInteger(boundCount, true) ||
        !isSafeInteger(terminalCount, true) ||
        terminalCount < boundCount ||
        ownValue(value, "terminalGraphState") !== "closed" ||
        ownValue(value, "childCgroupEmpty") !== true ||
        ownValue(value, "taggedSessionCount") !== 0 ||
        !isUtcInstant(ownValue(value, "observedAt"))
      ) {
        return undefined;
      }
      break;
    }
    case "openspell.hosted-migration-approval-grant.v1": {
      const issuedAt = ownValue(value, "issuedAt");
      const authenticatedAt = ownValue(value, "authenticatedAt");
      if (
        !baseIdentity(value) ||
        !isHex64(ownValue(value, "targetFingerprint")) ||
        !allDigests(value, [
          "targetSelectionSha256",
          "envelopeSha256",
          "externalExclusiveWindowEvidenceSha256",
          "officialSourceEvidenceSha256",
          "nativeRuntimeIdentitySha256",
          "childSandboxPolicySha256",
          "phaseExecTopologyPolicySha256",
          "childCgroupPolicySha256",
          "applyInvocationEvidenceSha256",
          "authenticatedOperatorIdentitySha256",
          "osAuthenticationSessionSha256",
        ]) ||
        !isSafeInteger(ownValue(value, "externalExclusiveWindowGeneration"), true) ||
        !orderedInstants(issuedAt, ownValue(value, "expiresAt"), 15 * 60 * 1_000) ||
        !isUtcInstant(authenticatedAt) ||
        Date.parse(issuedAt as string) - Date.parse(authenticatedAt) < 0 ||
        Date.parse(issuedAt as string) - Date.parse(authenticatedAt) > 5 * 60 * 1_000 ||
        ownValue(value, "state") !== "approved"
      ) {
        return undefined;
      }
      break;
    }
    case "openspell.hosted-migration-execution-ticket.v1":
      if (
        !baseIdentity(value) ||
        !allDigests(value, [
          "approvalGrantSha256",
          "approvalGrantSignatureSha256",
          "targetFingerprint",
          "targetSelectionSha256",
          "envelopeSha256",
          "externalExclusiveWindowEvidenceSha256",
          "officialSourceEvidenceSha256",
          "nativeRuntimeIdentitySha256",
          "childSandboxPolicySha256",
          "phaseExecTopologyPolicySha256",
          "childCgroupPolicySha256",
          "applyInvocationEvidenceSha256",
        ]) ||
        !isHex64(ownValue(value, "ticketNonce")) ||
        !isSafeInteger(ownValue(value, "externalExclusiveWindowGeneration"), true) ||
        !orderedInstants(ownValue(value, "consumedAt"), ownValue(value, "expiresAt")) ||
        ownValue(value, "state") !== "consumed"
      ) {
        return undefined;
      }
      break;
    case "openspell.hosted-migration-no-execution-result.v1":
      if (
        !baseIdentity(value) ||
        !allDigests(value, [
          "approvalGrantSha256",
          "executionTicketSha256",
          "targetFingerprint",
          "zeroApplySessionEvidenceSha256",
          "targetQuarantineEvidenceSha256",
          "externalExclusiveWindowEvidenceSha256",
        ]) ||
        !isHex64(ownValue(value, "ticketNonce")) ||
        !isSafeInteger(ownValue(value, "rootJournalGeneration"), true) ||
        ![
          "pre_spawn_invariant_failed",
          "ticket_expired",
          "launcher_rejected_before_execution",
        ].includes(ownValue(value, "reasonCode") as string) ||
        ownValue(value, "priorState") !== "consumed" ||
        ownValue(value, "terminalState") !== "terminal_no_spawn" ||
        !allZero(value, [
          "executingTransitionCount",
          "namespaceCreationCount",
          "cgroupCreationCount",
          "childCreationCount",
          "pidfdCreationCount",
          "applySessionCount",
        ]) ||
        !isSafeInteger(ownValue(value, "externalExclusiveWindowGeneration"), true) ||
        !isUtcInstant(ownValue(value, "observedAt"))
      ) {
        return undefined;
      }
      break;
  }

  return value as unknown as MigrationLeaf;
}
