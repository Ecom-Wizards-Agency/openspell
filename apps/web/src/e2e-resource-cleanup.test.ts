import { describe, expect, it } from 'vitest';
import { runE2EGlobalSetup, waitForE2EServerOrFailure } from '../e2e/global-setup.js';
import type { E2EGlobalSetupOperations } from '../e2e/global-setup.js';
import { createE2EResourceCleanup } from './e2e-resource-cleanup.js';

describe('E2E resource cleanup', () => {
  it('runs acquired-resource cleanup once in reverse order', async () => {
    const cleanup = createE2EResourceCleanup();
    const calls: string[] = [];

    cleanup.register(() => {
      calls.push('database');
    });
    cleanup.register(async () => {
      await Promise.resolve();
      calls.push('mock');
    });
    cleanup.register(() => {
      calls.push('Next');
    });

    await Promise.all([cleanup.cleanup(), cleanup.cleanup()]);
    await cleanup.cleanup();

    expect(calls).toEqual(['Next', 'mock', 'database']);
    expect(() => cleanup.register(() => undefined)).toThrow(
      'Cannot register an E2E resource after cleanup has started',
    );
  });

  it.each([
    { acquired: [] },
    { acquired: ['database'] },
    { acquired: ['database', 'mock'] },
    { acquired: ['database', 'mock', 'Next'] },
  ])('preserves a setup failure after acquiring $acquired', async ({ acquired }) => {
    const cleanup = createE2EResourceCleanup();
    const calls: string[] = [];
    const setupError = new Error('setup failed');

    for (const resource of acquired) {
      cleanup.register(() => {
        calls.push(resource);
      });
    }

    await expect(cleanup.cleanupAfterFailure(setupError)).rejects.toBe(setupError);
    expect(calls).toEqual([...acquired].reverse());
  });

  it.each(['database', 'mock', 'Next'])(
    'attempts every task when %s cleanup fails',
    async (failedResource) => {
      const cleanup = createE2EResourceCleanup();
      const calls: string[] = [];
      const cleanupError = new Error(`${failedResource} cleanup failed`);

      for (const resource of ['database', 'mock', 'Next']) {
        cleanup.register(() => {
          calls.push(resource);
          if (resource === failedResource) throw cleanupError;
        });
      }

      await expect(cleanup.cleanup()).rejects.toBe(cleanupError);
      expect(calls).toEqual(['Next', 'mock', 'database']);
      await expect(cleanup.cleanup()).rejects.toBe(cleanupError);
      expect(calls).toEqual(['Next', 'mock', 'database']);
    },
  );

  it('aggregates cleanup failures in attempted order', async () => {
    const cleanup = createE2EResourceCleanup();
    const databaseError = new Error('database cleanup failed');
    const nextError = new Error('Next cleanup failed');

    cleanup.register(() => {
      throw databaseError;
    });
    cleanup.register(() => undefined);
    cleanup.register(() => {
      throw nextError;
    });

    const error = await cleanup.cleanup().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([nextError, databaseError]);
  });

  it('keeps the original setup failure first when cleanup also fails', async () => {
    const cleanup = createE2EResourceCleanup();
    const setupError = new Error('setup failed');
    const databaseError = new Error('database cleanup failed');
    const nextError = new Error('Next cleanup failed');
    const calls: string[] = [];

    cleanup.register(() => {
      calls.push('database');
      throw databaseError;
    });
    cleanup.register(() => {
      calls.push('mock');
    });
    cleanup.register(() => {
      calls.push('Next');
      throw nextError;
    });

    const error = await cleanup.cleanupAfterFailure(setupError).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([setupError, nextError, databaseError]);
    expect(calls).toEqual(['Next', 'mock', 'database']);
  });
});

type SetupCut =
  | 'database-connect'
  | 'database-create-unknown'
  | 'database-prepare'
  | 'mock-acquire'
  | 'server-acquire'
  | 'server-readiness';

function faultedSetup(
  cut: SetupCut | undefined,
  failure: Error,
  cleanupCalls: string[],
  installed: { teardown?: () => Promise<void> },
): E2EGlobalSetupOperations<string, string> {
  return {
    installTeardown: (teardown) => {
      installed.teardown = teardown;
    },
    acquireDatabase: async (registerDrop) => {
      if (cut === 'database-connect') throw failure;
      // The real helper registers the idempotent drop immediately before
      // CREATE, covering an unknown CREATE outcome and admin-close failure.
      registerDrop(() => {
        cleanupCalls.push('database');
      });
      if (cut === 'database-create-unknown') throw failure;
      return 'database';
    },
    prepareDatabase: async () => {
      if (cut === 'database-prepare') throw failure;
    },
    acquireMock: async () => {
      if (cut === 'mock-acquire') throw failure;
      return {
        resource: 'mock',
        cleanup: () => {
          cleanupCalls.push('mock');
        },
      };
    },
    acquireServer: () => {
      if (cut === 'server-acquire') throw failure;
      return {
        resource: 'Next',
        cleanup: () => {
          cleanupCalls.push('Next');
        },
      };
    },
    waitUntilReady: async () => {
      if (cut === 'server-readiness') throw failure;
    },
  };
}

describe('authenticated E2E global-setup acquisition cuts', () => {
  it.each([
    { cut: 'database-connect', cleanup: [] },
    { cut: 'database-create-unknown', cleanup: ['database'] },
    { cut: 'database-prepare', cleanup: ['database'] },
    { cut: 'mock-acquire', cleanup: ['database'] },
    { cut: 'server-acquire', cleanup: ['mock', 'database'] },
    { cut: 'server-readiness', cleanup: ['Next', 'mock', 'database'] },
  ] as const)('cleans every owned resource after $cut', async ({ cut, cleanup: expected }) => {
    const failure = new Error(`${cut} failed`);
    const cleanupCalls: string[] = [];
    const installed: { teardown?: () => Promise<void> } = {};

    await expect(
      runE2EGlobalSetup(faultedSetup(cut, failure, cleanupCalls, installed)),
    ).rejects.toBe(failure);
    expect(cleanupCalls).toEqual(expected);

    // Playwright may still invoke teardown after setup rejects. It shares the
    // completed idempotent stack and cannot clean any resource twice.
    await installed.teardown?.();
    expect(cleanupCalls).toEqual(expected);
  });

  it('installs one successful reverse-order teardown before acquisition starts', async () => {
    const cleanupCalls: string[] = [];
    const installed: { teardown?: () => Promise<void> } = {};

    await runE2EGlobalSetup(faultedSetup(undefined, new Error('unused'), cleanupCalls, installed));
    expect(cleanupCalls).toEqual([]);
    expect(installed.teardown).toBeTypeOf('function');

    await Promise.all([installed.teardown?.(), installed.teardown?.()]);
    expect(cleanupCalls).toEqual(['Next', 'mock', 'database']);
  });

  it('cancels and settles the readiness poll before propagating early server failure', async () => {
    const serverFailure = new Error('Next exited before readiness');
    let pollActive = false;
    let pollAborted = false;

    const waitUntilReady = async (signal: AbortSignal): Promise<void> => {
      pollActive = true;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          pollAborted = true;
          pollActive = false;
          reject(signal.reason);
        }, { once: true });
      });
    };

    await expect(
      waitForE2EServerOrFailure(waitUntilReady, Promise.reject(serverFailure)),
    ).rejects.toBe(serverFailure);
    expect(pollAborted).toBe(true);
    expect(pollActive).toBe(false);
  });
});
