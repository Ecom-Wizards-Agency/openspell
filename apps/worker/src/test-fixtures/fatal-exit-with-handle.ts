import { terminateAfterFatalWorkerFailure } from '../fatal-exit.js';

// Deliberately referenced: setting only process.exitCode would leave this
// fixture alive until the parent test's deadline.
setInterval(() => undefined, 60_000);

await terminateAfterFatalWorkerFailure({
  failureKind: 'custody_quarantined',
  custodyFailure: true,
  shutdown: async () => {
    await Promise.resolve();
    console.info('shutdown-complete', { released: 0, unresolved: 1 });
    return { released: 0, unresolved: 1 };
  },
  logger: console,
});
