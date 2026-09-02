import type { QueueSettlementError, WorkerShutdownEvidence } from './worker.js';

export type WorkerExitTrigger = 'fatal' | 'signal';
export type WorkerExitCode = 0 | 1 | 78;

export interface FinalShutdownAudit {
  event: 'report_worker_final_shutdown';
  trigger: WorkerExitTrigger;
  exitCode: WorkerExitCode;
  released: number;
  unresolved: number;
  settlementFailure: QueueSettlementError['kind'] | null;
  evidenceAvailable: boolean;
}

export type ShutdownAuditWriteResult = 'written' | 'timeout' | 'error';

/**
 * Write the fixed-schema final custody record and prove both callback
 * completion and drain when the stream applies backpressure. A broken or
 * permanently blocked audit pipe cannot prevent bounded process termination.
 */
export function writeFinalShutdownAudit(
  stream: NodeJS.WritableStream,
  audit: FinalShutdownAudit,
  timeoutMs = 1_000,
): Promise<ShutdownAuditWriteResult> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve('error');
  }
  const line = `${JSON.stringify(audit)}\n`;
  return new Promise((resolve) => {
    let settled = false;
    let configured = false;
    let callbackComplete = false;
    let drainComplete = false;
    const cleanup = (): void => {
      clearTimeout(timeout);
      stream.removeListener('drain', onDrain);
      stream.removeListener('error', onError);
    };
    const finish = (result: ShutdownAuditWriteResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const maybeFinish = (): void => {
      if (configured && callbackComplete && drainComplete) finish('written');
    };
    const onDrain = (): void => {
      drainComplete = true;
      maybeFinish();
    };
    const onError = (): void => finish('error');
    stream.once('error', onError);
    const timeout = setTimeout(() => finish('timeout'), timeoutMs);
    try {
      const accepted = stream.write(line, 'utf8', (error?: Error | null) => {
        if (error) {
          finish('error');
          return;
        }
        callbackComplete = true;
        maybeFinish();
      });
      if (settled) return;
      drainComplete = accepted;
      if (!accepted) stream.once('drain', onDrain);
      configured = true;
      maybeFinish();
    } catch {
      finish('error');
    }
  });
}

export function finalShutdownAudit(input: {
  trigger: WorkerExitTrigger;
  exitCode: WorkerExitCode;
  evidence: WorkerShutdownEvidence;
  settlementFailure: QueueSettlementError['kind'] | null;
  evidenceAvailable: boolean;
}): FinalShutdownAudit {
  return {
    event: 'report_worker_final_shutdown',
    trigger: input.trigger,
    exitCode: input.exitCode,
    released: input.evidence.released,
    unresolved: input.evidence.unresolved,
    settlementFailure: input.settlementFailure,
    evidenceAvailable: input.evidenceAvailable,
  };
}
