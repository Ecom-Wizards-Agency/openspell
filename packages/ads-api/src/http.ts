/**
 * The one place an HTTP request leaves this package.
 *
 * Everything Amazon does badly is handled here, once: throttling that arrives
 * as a bare 429 with no quota headers and only sometimes a `Retry-After`,
 * 5xx on reads, and access tokens that expire mid-flight. The division of
 * labour with the worker is deliberate — this module owns *per-request* retry
 * (a handful of attempts, seconds apart), the worker owns *pacing* (which
 * profile runs next, hours apart) and gets told what happened through
 * `onRetry` and `ThrottleState`.
 *
 * Retrying is not applied uniformly. A read is retried on 5xx and on a
 * transport error; a write is retried only when the request provably never
 * executed (429). Retrying an ambiguous POST is how a duplicate report request
 * or a double budget change happens.
 */
import type { Region } from '@wizard-ads/shared';
import { AdsApiHttpError, AdsThrottleError } from './errors.js';
import type { FetchLike, RetryEvent, RetryPolicy, ThrottleState } from './types.js';

/** Headers are produced per attempt so a forced token refresh can change them. */
export type HeaderFactory = (forceTokenRefresh: boolean) => Promise<Record<string, string>>;

export interface HttpRequestSpec {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  /** Path (or a short label) used in retry events; never carries a token. */
  path: string;
  headers: HeaderFactory;
  /** JSON strings for most calls; media upload also needs an exact multipart byte body. */
  body?: string | ArrayBuffer;
  /**
   * True when re-sending the request cannot change server state. List
   * endpoints are POSTs and are still reads, hence a flag rather than a verb
   * check.
   */
  idempotent: boolean;
  /** Mutations use one durable worker-level attempt; never retry in this client. */
  singleAttempt?: boolean;
  /** Optional hard wall-clock bound for one network attempt. */
  timeoutMs?: number;
  /** Statuses the caller handles itself, returned rather than thrown. */
  expectedStatuses?: readonly number[];
}

export interface HttpResult {
  status: number;
  headers: Headers;
  body: Uint8Array;
  /** Attempts spent, first try included. Asserted by the fixture suite. */
  attempts: number;
}

export interface HttpContext {
  region: Region;
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random: () => number;
  retry: RetryPolicy;
  onRetry?: (event: RetryEvent) => void;
  throttle: ThrottleTracker;
}

/** Mutable throttle bookkeeping for one region. Read through `snapshot()`. */
export class ThrottleTracker {
  private consecutive = 0;
  private total = 0;
  private lastAt: number | null = null;
  private lastRetryAfterMs: number | null = null;

  constructor(
    private readonly region: Region,
    private readonly policy: RetryPolicy,
  ) {}

  recordThrottle(at: number, retryAfterMs: number | null): void {
    this.consecutive += 1;
    this.total += 1;
    this.lastAt = at;
    this.lastRetryAfterMs = retryAfterMs;
  }

  recordSuccess(): void {
    this.consecutive = 0;
  }

  snapshot(): ThrottleState {
    return {
      region: this.region,
      consecutiveThrottles: this.consecutive,
      totalThrottles: this.total,
      lastThrottledAt: this.lastAt,
      lastRetryAfterMs: this.lastRetryAfterMs,
      suggestedDelayMs: backoffCeiling(this.policy, this.consecutive + 1),
    };
  }
}

/** Exponential step for an attempt, before jitter. Attempt is 1-based. */
export function backoffCeiling(policy: RetryPolicy, attempt: number): number {
  const raw = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(policy.maxDelayMs, raw);
}

/**
 * Exponential backoff with jitter.
 *
 * The jitter is subtractive (`[ceiling * (1 - jitter), ceiling]`) so a fleet of
 * workers that all hit the same limit at the same second does not retry in
 * lockstep, while still keeping the guaranteed minimum wait an exponential
 * schedule is chosen for in the first place.
 */
export function backoffDelay(policy: RetryPolicy, attempt: number, random: number): number {
  const ceiling = backoffCeiling(policy, attempt);
  const spread = Math.min(1, Math.max(0, policy.jitter));
  return Math.round(ceiling * (1 - spread * random));
}

/**
 * `Retry-After` is either a delta in seconds or an HTTP date. Amazon sends the
 * seconds form when it sends anything at all; the date form is parsed because
 * the RFC allows it and a wrong guess would be a multi-hour stall.
 */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return null;
  return Math.max(0, asDate - now);
}

const isServerError = (status: number): boolean => status >= 500 && status <= 599;
const isAuthError = (status: number): boolean => status === 401 || status === 403;

export function decodeText(body: Uint8Array): string {
  return new TextDecoder().decode(body);
}

/** Truncated so an error message cannot paste a whole report into a log line. */
function errorBody(body: Uint8Array): string {
  const text = decodeText(body);
  return text.length > 2_000 ? `${text.slice(0, 2_000)}...` : text;
}

/**
 * Send one request, retrying inside the policy, and return whatever Amazon
 * finally said. Only exhausted retries and unexpected statuses throw.
 */
export async function httpRequest(ctx: HttpContext, spec: HttpRequestSpec): Promise<HttpResult> {
  const expected = spec.expectedStatuses ?? [];
  let tokenRefreshed = false;
  let lastError: unknown = null;

  const maxAttempts = spec.singleAttempt ? 1 : ctx.retry.maxAttempts;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const isLast = attempt === maxAttempts;
    let response: Response;

    try {
      response = await ctx.fetch(spec.url, {
        method: spec.method,
        headers: await spec.headers(false),
        ...(spec.body === undefined ? {} : { body: spec.body }),
        ...(spec.timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(spec.timeoutMs) }),
      });
    } catch (cause) {
      lastError = cause;
      // A transport failure on a write is ambiguous: the request may well have
      // been executed. Only reads are re-sent.
      if (!spec.idempotent || isLast) {
        throw new AdsApiHttpError(
          `${spec.method} ${spec.path} failed: ${String(cause)}`,
          0,
          '',
          attempt,
          cause,
        );
      }
      const delayMs = backoffDelay(ctx.retry, attempt, ctx.random());
      emit(ctx, spec, 'network', attempt, null, delayMs, null);
      await ctx.sleep(delayMs);
      continue;
    }

    const buffer = new Uint8Array(await response.arrayBuffer());
    const { status } = response;

    if ((status >= 200 && status < 300) || expected.includes(status)) {
      ctx.throttle.recordSuccess();
      return { status, headers: response.headers, body: buffer, attempts: attempt };
    }

    if (status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), ctx.now());
      ctx.throttle.recordThrottle(ctx.now(), retryAfterMs);
      if (isLast) {
        throw new AdsThrottleError(
          `${spec.method} ${spec.path} throttled after ${attempt} attempts`,
          status,
          errorBody(buffer),
          attempt,
          retryAfterMs,
        );
      }
      const delayMs =
        retryAfterMs === null
          ? backoffDelay(ctx.retry, attempt, ctx.random())
          : Math.min(retryAfterMs, ctx.retry.maxRetryAfterMs);
      emit(ctx, spec, 'throttled', attempt, status, delayMs, retryAfterMs);
      await ctx.sleep(delayMs);
      continue;
    }

    // An expired access token looks like any other 401. Refresh once, retry
    // once: a second failure means the grant itself is gone, and hammering a
    // revoked refresh token is how an LWA app gets rate limited.
    if (isAuthError(status) && !tokenRefreshed && !isLast) {
      tokenRefreshed = true;
      await spec.headers(true);
      emit(ctx, spec, 'token-expired', attempt, status, 0, null);
      continue;
    }

    if (isServerError(status) && spec.idempotent && !isLast) {
      const delayMs = backoffDelay(ctx.retry, attempt, ctx.random());
      emit(ctx, spec, 'server-error', attempt, status, delayMs, null);
      await ctx.sleep(delayMs);
      continue;
    }

    throw new AdsApiHttpError(
      `${spec.method} ${spec.path} failed with ${status}`,
      status,
      errorBody(buffer),
      attempt,
    );
  }

  /* c8 ignore next 3 -- the loop always returns or throws; this satisfies the compiler. */
  throw new AdsApiHttpError(`${spec.method} ${spec.path} exhausted retries`, 0, '', maxAttempts, lastError);
}

function emit(
  ctx: HttpContext,
  spec: HttpRequestSpec,
  reason: RetryEvent['reason'],
  attempt: number,
  status: number | null,
  delayMs: number,
  retryAfterMs: number | null,
): void {
  ctx.onRetry?.({
    region: ctx.region,
    method: spec.method,
    path: spec.path,
    reason,
    attempt,
    status,
    delayMs,
    retryAfterMs,
  });
}
