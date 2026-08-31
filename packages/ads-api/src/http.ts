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

interface HttpTransportSpec {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers: HeaderFactory;
  /** JSON strings for most calls; media upload also needs an exact multipart byte body. */
  body?: string | ArrayBuffer;
}

/**
 * Controls for exactly one HTTP attempt. A timeout covers header resolution,
 * fetch, and response consumption; it is not a retry-wide deadline.
 */
export interface HttpAttemptSpec extends HttpTransportSpec {
  signal?: AbortSignal;
  /** Positive, finite milliseconds for this one attempt. */
  timeoutMs?: number;
  redirect?: NonNullable<RequestInit['redirect']>;
  /** Maximum response bytes retained in memory. Zero permits only an empty body. */
  maxResponseBytes?: number;
}

export interface HttpRequestSpec extends HttpTransportSpec {
  /** Path (or a short label) used in retry events; never carries a token. */
  path: string;
  /**
   * True when re-sending the request cannot change server state. List
   * endpoints are POSTs and are still reads, hence a flag rather than a verb
   * check.
   */
  idempotent: boolean;
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

export type HttpAttemptPhase = 'headers' | 'fetch' | 'body';

/** Identifies the failed stage without classifying an HTTP status. */
export class HttpAttemptError extends Error {
  override readonly name = 'HttpAttemptError';

  constructor(
    readonly phase: HttpAttemptPhase,
    readonly originalCause: unknown,
  ) {
    super(`HTTP attempt failed during ${phase}`, { cause: originalCause });
  }
}

/** Raised before a response can exceed the caller's in-memory bound. */
export class HttpResponseTooLargeError extends Error {
  override readonly name = 'HttpResponseTooLargeError';

  constructor(
    readonly maxResponseBytes: number,
    readonly observedResponseBytes: number,
  ) {
    super(`HTTP response exceeded the ${maxResponseBytes}-byte limit`);
  }
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

const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface AttemptCancellation {
  signal: AbortSignal | undefined;
  dispose: () => void;
}

function validateAttemptSpec(spec: HttpAttemptSpec): void {
  if (
    spec.timeoutMs !== undefined &&
    (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs <= 0 || spec.timeoutMs > MAX_TIMER_DELAY_MS)
  ) {
    throw new RangeError(`timeoutMs must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`);
  }
  if (
    spec.maxResponseBytes !== undefined &&
    (!Number.isSafeInteger(spec.maxResponseBytes) || spec.maxResponseBytes < 0)
  ) {
    throw new RangeError('maxResponseBytes must be a non-negative safe integer');
  }
}

function timeoutError(timeoutMs: number): DOMException {
  return new DOMException(`HTTP attempt timed out after ${timeoutMs}ms`, 'TimeoutError');
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('HTTP attempt aborted', 'AbortError');
}

function createAttemptCancellation(spec: HttpAttemptSpec): AttemptCancellation {
  if (spec.signal === undefined && spec.timeoutMs === undefined) {
    return { signal: undefined, dispose: () => undefined };
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeExternalListener = (): void => undefined;

  if (spec.signal !== undefined) {
    const externalSignal = spec.signal;
    const forwardAbort = (): void => controller.abort(abortReason(externalSignal));
    if (externalSignal.aborted) {
      forwardAbort();
    } else {
      externalSignal.addEventListener('abort', forwardAbort, { once: true });
      removeExternalListener = () => externalSignal.removeEventListener('abort', forwardAbort);
    }
  }

  const timeoutMs = spec.timeoutMs;
  if (timeoutMs !== undefined && !controller.signal.aborted) {
    timer = setTimeout(() => controller.abort(timeoutError(timeoutMs)), timeoutMs);
  }

  return {
    signal: controller.signal,
    dispose: () => {
      removeExternalListener();
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

async function waitFor<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) throw abortReason(signal);

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(cause);
      },
    );
  });
}

function cancelBody(body: ReadableStream<Uint8Array> | null, reason: unknown): void {
  if (body === null || body.locked) return;
  void body.cancel(reason).catch(() => undefined);
}

function throwIfAttemptAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortReason(signal);
}

async function responseBytes(
  response: Response,
  maxResponseBytes: number | undefined,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (maxResponseBytes !== undefined && contentLength !== null && /^\d+$/.test(contentLength)) {
    const declaredBytes = Number(contentLength);
    if (declaredBytes > maxResponseBytes) {
      cancelBody(response.body, new HttpResponseTooLargeError(maxResponseBytes, declaredBytes));
      throw new HttpResponseTooLargeError(maxResponseBytes, declaredBytes);
    }
  }

  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const chunk = await waitFor(reader.read(), signal);
      if (chunk.done) break;
      const nextTotal = totalBytes + chunk.value.byteLength;
      if (maxResponseBytes !== undefined && nextTotal > maxResponseBytes) {
        throw new HttpResponseTooLargeError(maxResponseBytes, nextTotal);
      }
      chunks.push(chunk.value);
      totalBytes = nextTotal;
    }
  } catch (cause) {
    void reader.cancel(cause).catch(() => undefined);
    throw cause;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A non-compliant fetch double can leave read() pending after cancel.
    }
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Perform at most one fetch and return its response without interpreting status.
 * Cancellation and timeout remain active until the response body is consumed.
 */
export async function httpRequestOnce(ctx: Pick<HttpContext, 'fetch'>, spec: HttpAttemptSpec): Promise<HttpResult> {
  validateAttemptSpec(spec);
  const cancellation = createAttemptCancellation(spec);

  try {
    let headers: Record<string, string>;
    try {
      throwIfAttemptAborted(cancellation.signal);
      headers = await waitFor(spec.headers(false), cancellation.signal);
    } catch (cause) {
      throw new HttpAttemptError('headers', cause);
    }

    let response: Response;
    try {
      throwIfAttemptAborted(cancellation.signal);
      response = await waitFor(
        ctx.fetch(spec.url, {
          method: spec.method,
          headers,
          ...(spec.body === undefined ? {} : { body: spec.body }),
          ...(cancellation.signal === undefined ? {} : { signal: cancellation.signal }),
          ...(spec.redirect === undefined ? {} : { redirect: spec.redirect }),
        }),
        cancellation.signal,
      );
    } catch (cause) {
      throw new HttpAttemptError('fetch', cause);
    }

    try {
      const body = await responseBytes(response, spec.maxResponseBytes, cancellation.signal);
      return { status: response.status, headers: response.headers, body, attempts: 1 };
    } catch (cause) {
      throw new HttpAttemptError('body', cause);
    }
  } finally {
    cancellation.dispose();
  }
}

/**
 * Send one request, retrying inside the policy, and return whatever Amazon
 * finally said. Only exhausted retries and unexpected statuses throw.
 */
export async function httpRequest(ctx: HttpContext, spec: HttpRequestSpec): Promise<HttpResult> {
  const expected = spec.expectedStatuses ?? [];
  let tokenRefreshed = false;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= ctx.retry.maxAttempts; attempt += 1) {
    const isLast = attempt === ctx.retry.maxAttempts;
    let result: HttpResult;

    try {
      result = await httpRequestOnce(ctx, spec);
    } catch (attemptError) {
      if (attemptError instanceof HttpAttemptError && attemptError.phase === 'body') {
        throw attemptError.originalCause;
      }
      const cause = attemptError instanceof HttpAttemptError ? attemptError.originalCause : attemptError;
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

    const { body: buffer, headers, status } = result;

    if ((status >= 200 && status < 300) || expected.includes(status)) {
      ctx.throttle.recordSuccess();
      return { status, headers, body: buffer, attempts: attempt };
    }

    if (status === 429) {
      const retryAfterMs = parseRetryAfter(headers.get('retry-after'), ctx.now());
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
  throw new AdsApiHttpError(`${spec.method} ${spec.path} exhausted retries`, 0, '', ctx.retry.maxAttempts, lastError);
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
