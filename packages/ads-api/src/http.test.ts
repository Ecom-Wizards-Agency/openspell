/**
 * The retry engine, which is where an Amazon integration lives or dies.
 *
 * Amazon signals throttling with a bare 429 and no quota headers, so there is
 * nothing to test against but behaviour: how long we wait, how many times, and
 * which requests are safe to send twice. Every case below is one of the failure
 * modes the brief names.
 */
import { describe, expect, it } from 'vitest';
import { createHttpContext } from './context.js';
import { AdsApiHttpError, AdsThrottleError } from './errors.js';
import {
  backoffCeiling,
  backoffDelay,
  decodeText,
  HttpAttemptError,
  HttpResponseTooLargeError,
  httpRequest,
  httpRequestOnce,
  parseRetryAfter,
  type HttpAttemptSpec,
} from './http.js';
import type { RetryEvent } from './types.js';
import { createMockServer, testEffects } from './__fixtures__/server.js';

const URL_BASE = 'https://advertising-api.amazon.com';

function context(fetchImpl: ReturnType<typeof createMockServer>['fetch'], onRetry?: (e: RetryEvent) => void) {
  const effects = testEffects();
  const ctx = createHttpContext('NA', {
    fetch: fetchImpl,
    sleep: effects.sleep,
    now: effects.now,
    random: effects.random,
    ...(onRetry === undefined ? {} : { onRetry }),
  });
  return { ctx, effects };
}

const staticHeaders = async () => ({ Authorization: 'Bearer fake-access-token' });

function attemptSpec(overrides: Partial<HttpAttemptSpec> = {}): HttpAttemptSpec {
  return {
    method: 'POST',
    url: `${URL_BASE}/sp/campaigns`,
    headers: staticHeaders,
    body: '{}',
    ...overrides,
  };
}

describe('one-attempt transport', () => {
  it('returns an unclassified status after exactly one fetch', async () => {
    let fetches = 0;

    const result = await httpRequestOnce(
      {
        fetch: async () => {
          fetches += 1;
          return new Response('throttled', { status: 429 });
        },
      },
      attemptSpec(),
    );

    expect(result.status).toBe(429);
    expect(result.attempts).toBe(1);
    expect(decodeText(result.body)).toBe('throttled');
    expect(fetches).toBe(1);
  });

  it("passes redirect: 'error' to fetch", async () => {
    let capturedInit: RequestInit | undefined;

    await httpRequestOnce(
      {
        fetch: async (_input, init) => {
          capturedInit = init;
          return new Response(null, { status: 207 });
        },
      },
      attemptSpec({ redirect: 'error' }),
    );

    expect(capturedInit?.redirect).toBe('error');
  });

  it('aborts delayed header resolution without issuing a late fetch', async () => {
    const controller = new AbortController();
    const reason = new DOMException('operator cancelled', 'AbortError');
    let resolveHeaders: ((headers: Record<string, string>) => void) | undefined;
    let fetches = 0;
    const headers = new Promise<Record<string, string>>((resolve) => {
      resolveHeaders = resolve;
    });

    const pending = httpRequestOnce(
      {
        fetch: async () => {
          fetches += 1;
          return new Response(null, { status: 207 });
        },
      },
      attemptSpec({ headers: async () => headers, signal: controller.signal }),
    );

    controller.abort(reason);
    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(HttpAttemptError);
    expect(error).toMatchObject({ phase: 'headers', originalCause: reason });

    resolveHeaders?.({ Authorization: 'Bearer later-token' });
    await Promise.resolve();
    expect(fetches).toBe(0);
  });

  it('enforces a finite timeout while fetch is pending', async () => {
    let fetches = 0;

    const error = await httpRequestOnce(
      {
        fetch: () => {
          fetches += 1;
          return new Promise<Response>(() => undefined);
        },
      },
      attemptSpec({ timeoutMs: 10 }),
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(HttpAttemptError);
    expect(error).toMatchObject({ phase: 'fetch' });
    expect((error as HttpAttemptError).originalCause).toMatchObject({ name: 'TimeoutError' });
    expect(fetches).toBe(1);
  });

  it('rejects an oversized streaming body before retaining the excess chunk', async () => {
    const encoder = new TextEncoder();
    let bodyCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(encoder.encode('123'));
        stream.enqueue(encoder.encode('456'));
      },
      cancel() {
        bodyCancelled = true;
      },
    });

    const error = await httpRequestOnce(
      { fetch: async () => new Response(body, { status: 207 }) },
      attemptSpec({ maxResponseBytes: 4 }),
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(HttpAttemptError);
    expect(error).toMatchObject({ phase: 'body' });
    expect((error as HttpAttemptError).originalCause).toBeInstanceOf(HttpResponseTooLargeError);
    expect((error as HttpAttemptError).originalCause).toMatchObject({
      maxResponseBytes: 4,
      observedResponseBytes: 6,
    });
    expect(bodyCancelled).toBe(true);
  });

  it('cancels a pending response reader when the external signal aborts', async () => {
    const controller = new AbortController();
    const reason = new DOMException('operator cancelled', 'AbortError');
    let bodyCancelled = false;
    let bodyReadStarted: (() => void) | undefined;
    const reading = new Promise<void>((resolve) => {
      bodyReadStarted = resolve;
    });
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          bodyReadStarted?.();
          return new Promise<void>(() => undefined);
        },
        cancel() {
          bodyCancelled = true;
        },
      },
      { highWaterMark: 0 },
    );

    const pending = httpRequestOnce(
      { fetch: async () => new Response(body, { status: 207 }) },
      attemptSpec({ signal: controller.signal }),
    );

    await reading;
    controller.abort(reason);
    const error = await pending.catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(HttpAttemptError);
    expect(error).toMatchObject({ phase: 'body', originalCause: reason });
    expect(bodyCancelled).toBe(true);
  });

  it('validates bounds before resolving headers or calling fetch', async () => {
    let headerCalls = 0;
    let fetches = 0;

    await expect(
      httpRequestOnce(
        {
          fetch: async () => {
            fetches += 1;
            return new Response(null, { status: 207 });
          },
        },
        attemptSpec({
          headers: async () => {
            headerCalls += 1;
            return {};
          },
          timeoutMs: Number.POSITIVE_INFINITY,
        }),
      ),
    ).rejects.toBeInstanceOf(RangeError);

    expect(headerCalls).toBe(0);
    expect(fetches).toBe(0);
  });
});

describe('backoff arithmetic', () => {
  it('doubles per attempt and stops at the ceiling', () => {
    const policy = { maxAttempts: 6, baseDelayMs: 1_000, maxDelayMs: 8_000, jitter: 0, maxRetryAfterMs: 120_000 };
    expect([1, 2, 3, 4, 5].map((n) => backoffCeiling(policy, n))).toEqual([1_000, 2_000, 4_000, 8_000, 8_000]);
  });

  it('keeps jitter inside [ceiling * (1 - jitter), ceiling]', () => {
    const policy = { maxAttempts: 4, baseDelayMs: 1_000, maxDelayMs: 30_000, jitter: 0.5, maxRetryAfterMs: 120_000 };
    for (const random of [0, 0.25, 0.5, 0.75, 1]) {
      const delay = backoffDelay(policy, 3, random);
      expect(delay).toBeGreaterThanOrEqual(2_000);
      expect(delay).toBeLessThanOrEqual(4_000);
    }
  });
});

describe('Retry-After parsing', () => {
  const now = Date.parse('2026-08-14T10:00:00Z');

  it('reads the seconds form Amazon actually sends', () => {
    expect(parseRetryAfter('30', now)).toBe(30_000);
  });

  it('reads the HTTP-date form the RFC allows', () => {
    expect(parseRetryAfter('Fri, 14 Aug 2026 10:00:45 GMT', now)).toBe(45_000);
  });

  it('is null when absent or unparseable, never zero', () => {
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter('   ', now)).toBeNull();
    expect(parseRetryAfter('soon', now)).toBeNull();
  });
});

describe('throttling', () => {
  it('backs off exponentially with jitter and then succeeds', async () => {
    const server = createMockServer([
      {
        method: 'GET',
        match: '/v2/profiles',
        responses: [{ status: 429, json: {} }, { status: 429, json: {} }, { status: 200, json: [] }],
      },
    ]);
    const events: RetryEvent[] = [];
    const { ctx, effects } = context(server.fetch, (event) => events.push(event));

    const result = await httpRequest(ctx, {
      method: 'GET',
      url: `${URL_BASE}/v2/profiles`,
      path: '/v2/profiles',
      headers: staticHeaders,
      idempotent: true,
    });

    expect(result.status).toBe(200);
    expect(result.attempts).toBe(3);
    // random() is pinned at 0.5, so each wait is 75% of its ceiling.
    expect(effects.slept).toEqual([750, 1_500]);
    expect(events.map((event) => event.reason)).toEqual(['throttled', 'throttled']);
    expect(events[0]?.retryAfterMs).toBeNull();
  });

  it('honours Retry-After when Amazon bothers to send one', async () => {
    const server = createMockServer([
      {
        method: 'GET',
        match: '/v2/profiles',
        responses: [{ status: 429, headers: { 'retry-after': '5' }, json: {} }, { status: 200, json: [] }],
      },
    ]);
    const { ctx, effects } = context(server.fetch);

    await httpRequest(ctx, {
      method: 'GET',
      url: `${URL_BASE}/v2/profiles`,
      path: '/v2/profiles',
      headers: staticHeaders,
      idempotent: true,
    });

    expect(effects.slept).toEqual([5_000]);
    expect(ctx.throttle.snapshot().lastRetryAfterMs).toBe(5_000);
  });

  it('caps a hostile Retry-After rather than parking the worker', async () => {
    const server = createMockServer([
      {
        method: 'GET',
        match: '/v2/profiles',
        responses: [{ status: 429, headers: { 'retry-after': '86400' }, json: {} }, { status: 200, json: [] }],
      },
    ]);
    const { ctx, effects } = context(server.fetch);

    await httpRequest(ctx, {
      method: 'GET',
      url: `${URL_BASE}/v2/profiles`,
      path: '/v2/profiles',
      headers: staticHeaders,
      idempotent: true,
    });

    expect(effects.slept).toEqual([120_000]);
  });

  it('gives up as a typed throttle error the worker can pace on', async () => {
    const server = createMockServer([
      { method: 'GET', match: '/v2/profiles', responses: [{ status: 429, headers: { 'retry-after': '2' }, json: {} }] },
    ]);
    const { ctx, effects } = context(server.fetch);

    await expect(
      httpRequest(ctx, {
        method: 'GET',
        url: `${URL_BASE}/v2/profiles`,
        path: '/v2/profiles',
        headers: staticHeaders,
        idempotent: true,
      }),
    ).rejects.toBeInstanceOf(AdsThrottleError);

    // Four attempts, three waits: the last failure is not slept on.
    expect(effects.slept).toHaveLength(3);
    const state = ctx.throttle.snapshot();
    expect(state.consecutiveThrottles).toBe(4);
    expect(state.totalThrottles).toBe(4);
    expect(state.region).toBe('NA');
    expect(state.suggestedDelayMs).toBeGreaterThan(0);
  });

  it('resets the consecutive counter on any success', async () => {
    const server = createMockServer([
      { method: 'GET', match: '/v2/profiles', responses: [{ status: 429, json: {} }, { status: 200, json: [] }] },
    ]);
    const { ctx } = context(server.fetch);

    await httpRequest(ctx, {
      method: 'GET',
      url: `${URL_BASE}/v2/profiles`,
      path: '/v2/profiles',
      headers: staticHeaders,
      idempotent: true,
    });

    const state = ctx.throttle.snapshot();
    expect(state.consecutiveThrottles).toBe(0);
    expect(state.totalThrottles).toBe(1);
  });
});

describe('server errors', () => {
  it('retries a read', async () => {
    const server = createMockServer([
      { method: 'GET', match: '/v2/profiles', responses: [{ status: 503, json: {} }, { status: 200, json: [] }] },
    ]);
    const { ctx, effects } = context(server.fetch);

    const result = await httpRequest(ctx, {
      method: 'GET',
      url: `${URL_BASE}/v2/profiles`,
      path: '/v2/profiles',
      headers: staticHeaders,
      idempotent: true,
    });

    expect(result.attempts).toBe(2);
    expect(effects.slept).toEqual([750]);
  });

  it('does not retry a write, because the write may already have happened', async () => {
    const server = createMockServer([
      { method: 'POST', match: '/reporting/reports', responses: [{ status: 503, json: {} }] },
    ]);
    const { ctx, effects } = context(server.fetch);

    const error = await httpRequest(ctx, {
      method: 'POST',
      url: `${URL_BASE}/reporting/reports`,
      path: '/reporting/reports',
      headers: staticHeaders,
      body: '{}',
      idempotent: false,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AdsApiHttpError);
    expect((error as AdsApiHttpError).attempts).toBe(1);
    expect(effects.slept).toEqual([]);
    expect(server.requests).toHaveLength(1);
  });
});

describe('token expiry', () => {
  it('forces one refresh and retries exactly once', async () => {
    const server = createMockServer([
      { method: 'GET', match: '/v2/profiles', responses: [{ status: 401, json: {} }, { status: 200, json: [] }] },
    ]);
    const events: RetryEvent[] = [];
    const { ctx, effects } = context(server.fetch, (event) => events.push(event));
    const forced: boolean[] = [];

    const result = await httpRequest(ctx, {
      method: 'GET',
      url: `${URL_BASE}/v2/profiles`,
      path: '/v2/profiles',
      headers: async (force) => {
        forced.push(force);
        return { Authorization: 'Bearer fake-access-token' };
      },
      idempotent: true,
    });

    expect(result.status).toBe(200);
    expect(forced).toEqual([false, true, false]);
    expect(events.map((event) => event.reason)).toEqual(['token-expired']);
    // A refresh is not a backoff: nothing is slept on.
    expect(effects.slept).toEqual([]);
  });

  it('stops after the second 401, because the grant itself is gone', async () => {
    const server = createMockServer([
      { method: 'GET', match: '/v2/profiles', responses: [{ status: 401, text: 'denied' }] },
    ]);
    const { ctx } = context(server.fetch);

    const error = await httpRequest(ctx, {
      method: 'GET',
      url: `${URL_BASE}/v2/profiles`,
      path: '/v2/profiles',
      headers: staticHeaders,
      idempotent: true,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AdsApiHttpError);
    expect((error as AdsApiHttpError).status).toBe(401);
    expect((error as AdsApiHttpError).attempts).toBe(2);
  });
});

describe('transport failures', () => {
  it('retries a read when fetch itself throws', async () => {
    let calls = 0;
    const { ctx, effects } = context(async () => {
      calls += 1;
      if (calls === 1) throw new Error('socket hang up');
      return new Response('[]', { status: 200 });
    });

    const result = await httpRequest(ctx, {
      method: 'GET',
      url: `${URL_BASE}/v2/profiles`,
      path: '/v2/profiles',
      headers: staticHeaders,
      idempotent: true,
    });

    expect(result.attempts).toBe(2);
    expect(effects.slept).toEqual([750]);
  });

  it('never retries a write when fetch throws: the request may have landed', async () => {
    let calls = 0;
    const { ctx } = context(async () => {
      calls += 1;
      throw new Error('socket hang up');
    });

    await expect(
      httpRequest(ctx, {
        method: 'POST',
        url: `${URL_BASE}/reporting/reports`,
        path: '/reporting/reports',
        headers: staticHeaders,
        body: '{}',
        idempotent: false,
      }),
    ).rejects.toBeInstanceOf(AdsApiHttpError);
    expect(calls).toBe(1);
  });

  it('preserves the legacy rule that a response-body failure is not retried', async () => {
    const bodyFailure = new Error('response stream failed');
    let calls = 0;
    const { ctx, effects } = context(async () => {
      calls += 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.error(bodyFailure);
          },
        }),
        { status: 200 },
      );
    });

    const error = await httpRequest(ctx, {
      method: 'GET',
      url: `${URL_BASE}/v2/profiles`,
      path: '/v2/profiles',
      headers: staticHeaders,
      idempotent: true,
    }).catch((cause: unknown) => cause);

    expect(error).toBe(bodyFailure);
    expect(calls).toBe(1);
    expect(effects.slept).toEqual([]);
  });

  it('cancels a retry sleep and never issues a later idempotent attempt', async () => {
    const controller = new AbortController();
    const reason = new DOMException('synthetic retry cancellation', 'AbortError');
    let calls = 0;
    let markSleeping: (() => void) | undefined;
    const sleeping = new Promise<void>((resolve) => {
      markSleeping = resolve;
    });
    const ctx = createHttpContext('NA', {
      fetch: async () => {
        calls += 1;
        return new Response('unavailable', { status: 503 });
      },
      sleep: () => {
        markSleeping?.();
        return new Promise<void>(() => undefined);
      },
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 },
    });
    const pending = httpRequest(ctx, {
      method: 'GET',
      url: `${URL_BASE}/v2/profiles`,
      path: '/v2/profiles',
      headers: staticHeaders,
      idempotent: true,
      signal: controller.signal,
    });

    await sleeping;
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(calls).toBe(1);
  });
});

describe('expected statuses', () => {
  it('returns rather than throws, so the caller can handle 425 itself', async () => {
    const server = createMockServer([
      { method: 'POST', match: '/reporting/reports', responses: [{ status: 425, json: { detail: 'duplicate' } }] },
    ]);
    const { ctx } = context(server.fetch);

    const result = await httpRequest(ctx, {
      method: 'POST',
      url: `${URL_BASE}/reporting/reports`,
      path: '/reporting/reports',
      headers: staticHeaders,
      body: '{}',
      idempotent: false,
      expectedStatuses: [425],
    });

    expect(result.status).toBe(425);
    expect(decodeText(result.body)).toContain('duplicate');
  });
});
