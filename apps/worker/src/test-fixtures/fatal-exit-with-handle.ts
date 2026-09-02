import { terminateAfterFatalWorkerFailure } from '../fatal-exit.js';

// Deliberately referenced: setting only process.exitCode would leave this
// fixture alive until the parent test's deadline.
setInterval(() => undefined, 60_000);
const mode = process.env['FATAL_AUDIT_TEST_MODE'];
const filler = Buffer.alloc(64 * 1_024, 'x');
while (process.stdout.write(filler)) {
  // Stop only when the OS/Node pipe actually applies backpressure.
}
console.error('audit-backpressure-ready');

await terminateAfterFatalWorkerFailure({
  failureKind: 'custody_quarantined',
  custodyFailure: true,
  shutdown: async () => {
    await Promise.resolve();
    process.stdout.write('shutdown-complete\n');
    return { released: 0, unresolved: 1 };
  },
  logger: console,
  auditTimeoutMs: mode === 'never-drain' ? 50 : 1_000,
});
