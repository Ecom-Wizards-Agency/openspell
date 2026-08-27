import type { FetchLike } from '../types.js';

export interface RecordedResponse {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
}

export interface RecordedRoute {
  method: 'GET';
  match: string | RegExp;
  responses: RecordedResponse[];
}

export interface RecordedRequest {
  method: string;
  url: string;
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string>;
}

export interface MockServer {
  fetch: FetchLike;
  requests: RecordedRequest[];
  requestsFor(match: string | RegExp): RecordedRequest[];
}

function matches(route: RecordedRoute, url: URL, method: string): boolean {
  if (route.method !== method) return false;
  return route.match instanceof RegExp ? route.match.test(url.toString()) : route.match === url.pathname;
}

function response(input: RecordedResponse): Response {
  const headers = new Headers(input.headers ?? {});
  if (input.text !== undefined) return new Response(input.text, { status: input.status, headers });
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(input.json ?? null), { status: input.status, headers });
}

export function createMockServer(routes: RecordedRoute[]): MockServer {
  const requests: RecordedRequest[] = [];
  const cursors = new Map<RecordedRoute, number>();
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    requests.push({ method, url: url.toString(), pathname: url.pathname, query: url.searchParams, headers });

    const route = routes.find((candidate) => matches(candidate, url, method));
    if (!route) throw new Error(`no recorded fixture for ${method} ${url.pathname}`);
    const index = cursors.get(route) ?? 0;
    cursors.set(route, index + 1);
    const recorded = route.responses[Math.min(index, route.responses.length - 1)];
    if (!recorded) throw new Error(`route ${String(route.match)} has no responses`);
    return response(recorded);
  };
  return {
    fetch,
    requests,
    requestsFor: (match) => requests.filter((request) =>
      match instanceof RegExp ? match.test(request.url) : request.pathname === match,
    ),
  };
}

export function testEffects(): {
  sleep: (ms: number) => Promise<void>;
  slept: number[];
  now: () => number;
  random: () => number;
} {
  const slept: number[] = [];
  let clock = Date.parse('2026-08-27T00:00:00Z');
  return {
    sleep: async (ms) => { slept.push(ms); clock += ms; },
    slept,
    now: () => clock,
    random: () => 0.5,
  };
}
