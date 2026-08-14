/**
 * The cron drain route's gate.
 *
 * The only thing worth unit-testing here without a live queue is the door: an
 * unauthenticated caller must never be able to make this route spend Amazon
 * quota. So these check the three ways in are refused — no configured secret, no
 * header, wrong header — and that a correctly authenticated call gets *past* the
 * gate (proven by it failing later, on the missing database, rather than on
 * auth). The draining itself is exercised end to end by the worker's own suite.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET } from './route';

const SECRET = ['synthetic', 'cron', 'secret', 'value'].join('-');

function request(authorization?: string): Request {
  const headers = new Headers();
  if (authorization !== undefined) headers.set('authorization', authorization);
  return new Request('https://example.test/api/cron/sync', { headers });
}

describe('GET /api/cron/sync', () => {
  const savedSecret = process.env['CRON_SECRET'];
  const savedDbUrl = process.env['DATABASE_URL'];

  beforeEach(() => {
    delete process.env['CRON_SECRET'];
    delete process.env['DATABASE_URL'];
  });

  afterEach(() => {
    if (savedSecret === undefined) delete process.env['CRON_SECRET'];
    else process.env['CRON_SECRET'] = savedSecret;
    if (savedDbUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = savedDbUrl;
  });

  it('is 401 when no CRON_SECRET is configured, even with a bearer', async () => {
    const response = await GET(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(401);
  });

  it('is 401 with the secret set but no Authorization header', async () => {
    process.env['CRON_SECRET'] = SECRET;
    const response = await GET(request());
    expect(response.status).toBe(401);
  });

  it('is 401 with a wrong bearer token', async () => {
    process.env['CRON_SECRET'] = SECRET;
    const response = await GET(request('Bearer not-the-secret'));
    expect(response.status).toBe(401);
  });

  it('gets past the gate with the right bearer, then fails on the missing database', async () => {
    process.env['CRON_SECRET'] = SECRET;
    const response = await GET(request(`Bearer ${SECRET}`));
    // Not 401: the gate opened. 500 naming the database is the next failure, and
    // it happens before any Amazon call, proving the auth check is what guards
    // the expensive work.
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/DATABASE_URL/);
  });
});
