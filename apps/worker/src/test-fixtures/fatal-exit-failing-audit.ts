import { Writable } from 'node:stream';
import { terminateAfterFatalWorkerFailure } from '../fatal-exit.js';

setInterval(() => undefined, 60_000);
process.once('uncaughtException', () => {
  console.error('uncaught-audit-error');
  process.exit(97);
});

const auditStream = new Writable({
  write(_chunk, _encoding, callback) {
    callback(new Error('synthetic audit callback failure'));
    process.nextTick(() => {
      auditStream.emit('error', new Error('synthetic later audit event'));
    });
  },
});
const emit = auditStream.emit.bind(auditStream);
auditStream.emit = ((event: string | symbol, ...args: unknown[]): boolean => {
  if (event === 'error') console.error('audit-error-event-observed');
  return emit(event, ...args);
}) as typeof auditStream.emit;

await terminateAfterFatalWorkerFailure({
  failureKind: 'custody_quarantined',
  custodyFailure: true,
  shutdown: async () => {
    console.error('shutdown-complete');
    return { released: 0, unresolved: 1 };
  },
  logger: console,
  auditStream,
  auditTimeoutMs: 250,
});
