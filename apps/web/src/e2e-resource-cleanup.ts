export type E2EResourceCleanupTask = () => void | Promise<void>;

export interface E2EResourceCleanup {
  register(task: E2EResourceCleanupTask): void;
  cleanup(): Promise<void>;
  cleanupAfterFailure(error: unknown): Promise<never>;
}

/**
 * Own the resources acquired by one authenticated E2E process.
 *
 * Tasks run once, in reverse acquisition order. Every task is attempted even
 * when an earlier task rejects, and concurrent or repeated cleanup calls share
 * that one execution.
 */
export function createE2EResourceCleanup(): E2EResourceCleanup {
  const tasks: E2EResourceCleanupTask[] = [];
  let cleanupStarted = false;
  let cleanupResult: Promise<readonly unknown[]> | undefined;

  function register(task: E2EResourceCleanupTask): void {
    if (cleanupStarted) {
      throw new Error('Cannot register an E2E resource after cleanup has started');
    }
    tasks.push(task);
  }

  function collectCleanupErrors(): Promise<readonly unknown[]> {
    if (cleanupResult !== undefined) return cleanupResult;

    cleanupStarted = true;
    const pending = tasks.splice(0).reverse();
    cleanupResult = (async () => {
      const errors: unknown[] = [];
      for (const task of pending) {
        try {
          await task();
        } catch (error) {
          errors.push(error);
        }
      }
      return errors;
    })();
    return cleanupResult;
  }

  async function cleanup(): Promise<void> {
    const errors = await collectCleanupErrors();
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, `${errors.length} E2E resource cleanup tasks failed`);
    }
  }

  async function cleanupAfterFailure(error: unknown): Promise<never> {
    const cleanupErrors = await collectCleanupErrors();
    if (cleanupErrors.length === 0) throw error;
    throw new AggregateError(
      [error, ...cleanupErrors],
      `E2E setup failed and ${cleanupErrors.length} resource cleanup task${
        cleanupErrors.length === 1 ? '' : 's'
      } also failed`,
    );
  }

  return { register, cleanup, cleanupAfterFailure };
}
