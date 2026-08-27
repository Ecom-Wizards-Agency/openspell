import {
  DataDiveHttpError,
  DataDiveParseError,
  DataDiveThrottleError,
  DataDiveTransportError,
} from './errors.js';
import {
  DEFAULT_RETRY_POLICY,
  type DataDiveRetryEvent,
  type FetchLike,
  type RetryPolicy,
} from './types.js';

export interface HttpContext {
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random: () => number;
  retry: RetryPolicy;
  onRetry?: (event: DataDiveRetryEvent) => void;
}

export interface HttpRequest {
  url: string;
  path: string;
  apiKey: string;
}

export function createHttpContext(options: {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  retry?: Partial<RetryPolicy>;
  onRetry?: (event: DataDiveRetryEvent) => void;
}): HttpContext {
  return {
    fetch: options.fetch ?? fetch,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: options.now ?? Date.now,
    random: options.random ?? Math.random,
    retry: { ...DEFAULT_RETRY_POLICY, ...options.retry },
    ...(options.onRetry === undefined ? {} : { onRetry: options.onRetry }),
  };
}

export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export function backoffDelay(policy: RetryPolicy, attempt: number, random: number): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.min(1, Math.max(0, policy.jitter));
  return Math.round(ceiling * (1 - jitter * Math.min(1, Math.max(0, random))));
}

function boundedBody(text: string): string {
  return text.length > 2_000 ? `${text.slice(0, 2_000)}...` : text;
}

function retryDelay(
  ctx: HttpContext,
  attempt: number,
  retryAfterMs: number | null,
): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, ctx.retry.maxRetryAfterMs);
  return backoffDelay(ctx.retry, attempt, ctx.random());
}

/** The only function in this package that calls `fetch`. */
export async function httpGetJson(ctx: HttpContext, request: HttpRequest): Promise<unknown> {
  let lastTransportError: unknown;

  for (let attempt = 1; attempt <= ctx.retry.maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await ctx.fetch(request.url, {
        method: 'GET',
        headers: { accept: 'application/json', 'x-api-key': request.apiKey },
      });
    } catch (error) {
      lastTransportError = error;
      if (attempt === ctx.retry.maxAttempts) break;
      const delayMs = retryDelay(ctx, attempt, null);
      ctx.onRetry?.({
        path: request.path,
        attempt,
        reason: 'transport-error',
        delayMs,
        retryAfterMs: null,
      });
      await ctx.sleep(delayMs);
      continue;
    }

    const text = await response.text();
    if (response.ok) {
      if (!text.trim()) throw new DataDiveParseError(`${request.path} returned an empty body`);
      try {
        return JSON.parse(text);
      } catch (cause) {
        throw new DataDiveParseError(`${request.path} returned a body that is not JSON`, { cause });
      }
    }

    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), ctx.now());
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === ctx.retry.maxAttempts) {
      const body = boundedBody(text);
      if (response.status === 429) {
        throw new DataDiveThrottleError(attempt, retryAfterMs, body);
      }
      throw new DataDiveHttpError(
        `DataDive ${request.path} returned HTTP ${response.status}`,
        response.status,
        attempt,
        body,
      );
    }

    const delayMs = retryDelay(ctx, attempt, retryAfterMs);
    ctx.onRetry?.({
      path: request.path,
      attempt,
      reason: response.status === 429 ? 'throttled' : 'server-error',
      delayMs,
      retryAfterMs,
    });
    await ctx.sleep(delayMs);
  }

  throw new DataDiveTransportError(
    `DataDive ${request.path} failed after ${ctx.retry.maxAttempts} transport attempts`,
    ctx.retry.maxAttempts,
    lastTransportError instanceof Error ? { cause: lastTransportError } : undefined,
  );
}
