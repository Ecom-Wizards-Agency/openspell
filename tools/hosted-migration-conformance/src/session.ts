import { createHash } from "node:crypto";

import { isHex64 } from "./records.js";
import type { Phase } from "./types.js";

const SESSION_DOMAIN = "openspell.hosted-migration-session.v1";

export function isPhase(value: string): value is Phase {
  return value === "history_fetch" || value === "dry_run" || value === "apply";
}

export function phaseSessionTag(
  operationId: string,
  authorizationNonce: string,
  phase: string,
): string | undefined {
  if (!isHex64(operationId) || !isHex64(authorizationNonce) || !isPhase(phase)) {
    return undefined;
  }
  const digest = createHash("sha256")
    .update(`${SESSION_DOMAIN}\n${operationId}\n${authorizationNonce}\n${phase}\n`, "utf8")
    .digest("hex");
  return `os-wp197-cli-${digest.slice(0, 48)}`;
}
