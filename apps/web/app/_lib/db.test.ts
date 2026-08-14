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
import { afterEach, describe, expect, it } from 'vitest';
import { withDatabase } from './db.js';

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
