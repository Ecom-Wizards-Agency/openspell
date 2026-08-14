/**
 * The predicate that decides between "not wired up yet" and a real bug.
 *
 * Both halves matter equally. Miss a connection failure and the read surfaces
 * go back to rendering a stack trace on a deployment whose database moved; match
 * too widely and a genuine bug — a typo in a column name, a violated constraint
 * — is swallowed and renders as an empty page nobody can debug.
 */
import { describe, expect, it } from 'vitest';
import { isDatabaseUnreachable } from './db-unreachable.js';

const withCode = (code: string): Error => Object.assign(new Error(code), { code });

describe('isDatabaseUnreachable', () => {
  it('matches a connection that was never made', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'CONNECT_TIMEOUT']) {
      expect(isDatabaseUnreachable(withCode(code))).toBe(true);
    }
  });

  it('matches a server that answered and refused to seat us', () => {
    // Wrong password, no such database, shutting down: all operator fixes.
    for (const code of ['28P01', '3D000', '57P03', '53300']) {
      expect(isDatabaseUnreachable(withCode(code))).toBe(true);
    }
  });

  it('finds the socket failure postgres.js hides on `cause`', () => {
    const wrapped = Object.assign(new Error('write CONNECTION_CLOSED'), {
      cause: withCode('ECONNREFUSED'),
    });
    expect(isDatabaseUnreachable(wrapped)).toBe(true);
  });

  it('does not match a bug in this repository', () => {
    // Syntax error, undefined column, not-null violation, unique violation.
    for (const code of ['42601', '42703', '23502', '23505']) {
      expect(isDatabaseUnreachable(withCode(code))).toBe(false);
    }
    expect(isDatabaseUnreachable(new Error('relation "campaigns" does not exist'))).toBe(false);
    expect(isDatabaseUnreachable(new TypeError('rows is not iterable'))).toBe(false);
  });

  it('is false for anything that is not an error at all', () => {
    for (const value of [null, undefined, 'ECONNREFUSED', 42, {}]) {
      expect(isDatabaseUnreachable(value)).toBe(false);
    }
  });

  it('terminates on a self-referential cause', () => {
    const looping = new Error('loop') as Error & { cause?: unknown };
    looping.cause = looping;
    expect(isDatabaseUnreachable(looping)).toBe(false);
  });
});
