/**
 * A recorded-fixture HTTP layer for the test suite.
 *
 * Every test in this package runs against recorded responses and never against
 * Amazon. The client takes its `fetch` as an argument for exactly this reason,
 * so the seam is the same one production uses rather than a global patched at
 * test time.
 *
 * Two behaviours make the fixtures worth more than a stub:
 *
 *  - A route serves a *sequence*. `[PENDING, PENDING, COMPLETED]` is how a real
 *    report behaves and is the only honest way to test a poll loop; the last
 *    entry repeats once the sequence runs out.
 *  - An unmatched request throws. A fixture server that answers 404 to an
 *    endpoint nobody recorded turns "this test never called Amazon correctly"
 *    into a passing test with an empty result.
 *
 * Requests are captured verbatim so a test can assert what was actually sent:
 * the media type, the profile scope header, the request body. Those are the
 * parts of an Amazon integration that break silently.
 */
import type { FetchLike } from '../types.js';

export interface RecordedResponse {
  status: number;
  headers?: Record<string, string>;
  /** Serialised with `JSON.stringify`. */
  json?: unknown;
  /** Raw bytes, for gzip and malformed-payload cases. */
  bytes?: Uint8Array;
  text?: string;
}

export interface RecordedRoute {
  method: string;
  /** Matched against the URL's pathname, or the whole URL for a RegExp. */
  match: string | RegExp;
  responses: RecordedResponse[];
}

export interface RecordedRequest {
  method: string;
  url: string;
  pathname: string;
  headers: Record<string, string>;
  body: string | null;
  /** Parsed body for JSON requests, so assertions read normally. */
  json: unknown;
}

export interface MockServer {
  fetch: FetchLike;
  requests: RecordedRequest[];
  /** Requests whose pathname matched, in order. */
  requestsFor: (match: string | RegExp) => RecordedRequest[];
}

function matches(route: RecordedRoute, url: URL, method: string): boolean {
  if (route.method.toUpperCase() !== method.toUpperCase()) return false;
  if (route.match instanceof RegExp) return route.match.test(url.toString());
  return route.match === url.pathname;
}

function toResponse(recorded: RecordedResponse): Response {
  const headers = new Headers(recorded.headers ?? {});
  if (recorded.bytes !== undefined) {
    // Copied into an exactly sized buffer: a Buffer from `gzipSync` can be a
    // view into a larger pool, and handing that over would send extra bytes.
    return new Response(new Uint8Array(recorded.bytes).buffer, { status: recorded.status, headers });
  }
  if (recorded.text !== undefined) {
    return new Response(recorded.text, { status: recorded.status, headers });
  }
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(recorded.json ?? null), { status: recorded.status, headers });
}

export function createMockServer(routes: RecordedRoute[]): MockServer {
  const requests: RecordedRequest[] = [];
  const cursors = new Map<RecordedRoute, number>();

  const fetchImpl: FetchLike = async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = new URL(input);
    const body = typeof init?.body === 'string' ? init.body : null;
    let json: unknown = null;
    if (body !== null) {
      try {
        json = JSON.parse(body);
      } catch {
        json = null;
      }
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    requests.push({ method, url: url.toString(), pathname: url.pathname, headers, body, json });

    const route = routes.find((candidate) => matches(candidate, url, method));
    if (route === undefined) {
      throw new Error(`no recorded fixture for ${method} ${url.pathname}`);
    }
    const index = cursors.get(route) ?? 0;
    cursors.set(route, index + 1);
    const recorded = route.responses[Math.min(index, route.responses.length - 1)];
    if (recorded === undefined) {
      throw new Error(`route ${method} ${String(route.match)} has no recorded responses`);
    }
    return toResponse(recorded);
  };

  return {
    fetch: fetchImpl,
    requests,
    requestsFor: (match) =>
      requests.filter((request) =>
        match instanceof RegExp ? match.test(request.url) : request.pathname === match,
      ),
  };
}

/** The LWA refresh route every client test needs before anything else works. */
export function lwaRoute(responses?: RecordedResponse[]): RecordedRoute {
  return {
    method: 'POST',
    match: '/auth/o2/token',
    responses: responses ?? [
      { status: 200, json: { access_token: 'fake-access-token', expires_in: 3600, token_type: 'bearer' } },
    ],
  };
}

/** Deterministic effects: no real waiting, no real randomness. */
export function testEffects(): {
  sleep: (ms: number) => Promise<void>;
  slept: number[];
  now: () => number;
  random: () => number;
} {
  const slept: number[] = [];
  let clock = 1_700_000_000_000;
  return {
    sleep: async (ms: number) => {
      slept.push(ms);
      clock += ms;
    },
    slept,
    now: () => clock,
    // Fixed at the midpoint so jitter is deterministic and still exercised.
    random: () => 0.5,
  };
}
