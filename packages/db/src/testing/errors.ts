/**
 * Reading a database error properly.
 *
 * Drizzle wraps a driver error in one of its own ("Failed query: insert into
 * ...") and hangs the real one off `cause`. A test that matches on the outer
 * message therefore passes for the wrong reason or fails for no reason, which
 * is exactly the sort of test that gets deleted six months later. These two
 * helpers read the whole chain instead.
 */

/** Every message in the cause chain, outermost first. */
export function errorChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  if (messages.length === 0) messages.push(String(error));
  return messages.join(' | ');
}

/**
 * Assert a promise rejects with a message matching `pattern`, anywhere in the
 * cause chain. Returns the chain so a caller can assert more.
 */
export async function expectRejection(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const chain = errorChain(error);
    if (!pattern.test(chain)) {
      throw new Error(`expected a rejection matching ${String(pattern)}, got: ${chain}`, {
        cause: error,
      });
    }
    return chain;
  }
  throw new Error(`expected a rejection matching ${String(pattern)}, but it resolved`);
}
