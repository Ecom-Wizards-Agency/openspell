import type { QueueSettlementError, WorkerShutdownEvidence } from './worker.js';
import {
  finalShutdownAudit,
  writeFinalShutdownAudit,
  type WorkerExitCode,
  type WorkerExitTrigger,
} from './shutdown-audit.js';

export interface FatalExitLogger {
  error(message: string, details?: Record<string, unknown>): void;
}

export interface FatalWorkerExitInput {
  failureKind: QueueSettlementError['kind'] | 'unexpected';
  custodyFailure: boolean;
  shutdown: () => Promise<WorkerShutdownEvidence>;
  logger: FatalExitLogger;
  exit?: (code: number) => never;
  auditStream?: NodeJS.WritableStream;
  auditTimeoutMs?: number;
}

export interface FinalWorkerExitInput {
  trigger: WorkerExitTrigger;
  exitCode: WorkerExitCode;
  evidence: WorkerShutdownEvidence;
  settlementFailure: QueueSettlementError['kind'] | null;
  evidenceAvailable: boolean;
  exit?: (code: number) => never;
  auditStream?: NodeJS.WritableStream;
  auditTimeoutMs?: number;
}

/** Await final audit delivery (or its deadline) immediately before force-exit. */
export async function terminateAfterFinalShutdown(input: FinalWorkerExitInput): Promise<never> {
  await writeFinalShutdownAudit(
    input.auditStream ?? process.stdout,
    finalShutdownAudit(input),
    input.auditTimeoutMs,
  );
  const exit = input.exit ?? ((exitCode: number): never => process.exit(exitCode));
  return exit(input.exitCode);
}

/**
 * Complete bounded shutdown before explicitly terminating a fatally stopped
 * worker. `process.exitCode` is insufficient here: an intentionally retained
 * transport can keep the event loop referenced after custody is quarantined.
 */
export async function terminateAfterFatalWorkerFailure(
  input: FatalWorkerExitInput,
): Promise<never> {
  input.logger.error('report worker stopped after fatal failure', {
    failureKind: input.failureKind,
  });
  let evidence: WorkerShutdownEvidence = { released: 0, unresolved: 1 };
  let evidenceAvailable = false;
  try {
    evidence = await input.shutdown();
    evidenceAvailable = true;
  } catch {
    input.logger.error('report worker fatal shutdown evidence unavailable');
  }
  const code = input.custodyFailure || evidence.unresolved > 0 ? 78 : 1;
  return terminateAfterFinalShutdown({
    trigger: 'fatal',
    exitCode: code,
    evidence,
    settlementFailure: input.custodyFailure && input.failureKind !== 'unexpected'
      ? input.failureKind
      : null,
    evidenceAvailable,
    exit: input.exit,
    auditStream: input.auditStream,
    auditTimeoutMs: input.auditTimeoutMs,
  });
}
