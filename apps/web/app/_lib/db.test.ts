/**
 * `withDatabase` keeps the promise its own header makes.
 *
 * The header always said a read surface must say "not wired up yet" rather than
 * take the app down. It only ever honoured that for an *absent* `DATABASE_URL`;
 * a variable that was set and pointed nowhere sailed through `openDatabase` and
 * threw on the first query, which is the failure a real deployment actually
 * hits. These three cases are the whole contract: absent, unreachable, and a
 * bug that must still be loud.
 *
 * No Postgres required — the point is a connection that cannot be made.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DbHandle } from '@wizard-ads/db';
import { withDatabase, withExistingDatabase } from './db.js';

/** Port 1 is privileged and nothing listens on it: a refusal, not a timeout. */
const NOWHERE = 'postgres://nobody@127.0.0.1:1/nothing';

const previous = process.env['DATABASE_URL'];

afterEach(() => {
  if (previous === undefined) delete process.env['DATABASE_URL'];
  else process.env['DATABASE_URL'] = previous;
});

describe('withDatabase', () => {
  it('returns null when nothing is configured', async () => {
    delete process.env['DATABASE_URL'];
    await expect(withDatabase(async () => 'ran')).resolves.toBeNull();
  });

  it('returns null when the database is configured but unreachable', async () => {
    process.env['DATABASE_URL'] = NOWHERE;
    await expect(
      withDatabase(async (handle) => {
        await handle.sql`select 1`;
        return 'ran';
      }),
    ).resolves.toBeNull();
  }, 30_000);

  it('still throws a bug in the caller rather than hiding it as "no database"', async () => {
    process.env['DATABASE_URL'] = NOWHERE;
    await expect(
      withDatabase(async () => {
        throw new TypeError('rows is not iterable');
      }),
    ).rejects.toThrow(/not iterable/);
  });
});

describe('withExistingDatabase', () => {
  it('uses the authenticated page handle without closing the process pool', async () => {
    const close = vi.fn(async () => {});
    const handle = { close } as unknown as DbHandle;
    const run = vi.fn(async (received: DbHandle) => {
      expect(received).toBe(handle);
      return 'shared';
    });

    await expect(withExistingDatabase(handle, run)).resolves.toBe('shared');
    expect(run).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it('does not disguise a page bug as a database outage', async () => {
    const handle = { close: vi.fn(async () => {}) } as unknown as DbHandle;
    await expect(
      withExistingDatabase(handle, async () => {
        throw new TypeError('synthetic page bug');
      }),
    ).rejects.toThrow(/synthetic page bug/);
  });
});
