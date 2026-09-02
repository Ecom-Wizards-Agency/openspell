import type { QueueSettlementError, WorkerShutdownEvidence } from './worker.js';

export interface FatalExitLogger {
  error(message: string, details?: Record<string, unknown>): void;
}

export interface FatalWorkerExitInput {
  failureKind: QueueSettlementError['kind'] | 'unexpected';
  custodyFailure: boolean;
  shutdown: () => Promise<WorkerShutdownEvidence>;
  logger: FatalExitLogger;
  exit?: (code: number) => never;
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
  try {
    evidence = await input.shutdown();
  } catch {
    input.logger.error('report worker fatal shutdown evidence unavailable');
  }
  const code = input.custodyFailure || evidence.unresolved > 0 ? 78 : 1;
  const exit = input.exit ?? ((exitCode: number): never => process.exit(exitCode));
  return exit(code);
}
