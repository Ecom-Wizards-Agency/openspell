/**
 * Construction-time shapes: credentials, injected effects, retry policy.
 *
 * Effects (`fetch`, `sleep`, `now`) are injected rather than imported so the
 * fixture suite can drive a whole backoff sequence without waiting for it, and
 * so nothing in this package reaches for a global that a test cannot see. It is
 * the same seam `SPAdsApiDataSource` uses for `session` and `sleep`.
 */
import type { Region } from '@wizard-ads/shared';

/** An LWA application plus one advertiser's grant. */
export interface AdsCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** The subset of `fetch` this client uses. Anything Fetch-shaped satisfies it. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** How the client retries one request. The worker owns pacing between jobs. */
export interface RetryPolicy {
  /** Total attempts per request, first try included. */
  maxAttempts: number;
  /** First backoff step in milliseconds; doubles per attempt. */
  baseDelayMs: number;
  /** Ceiling for a single backoff step. */
  maxDelayMs: number;
  /**
   * Full-jitter fraction, 0 to 1. Amazon throttles a whole client, so a fleet
   * that backs off in lockstep simply re-collides; jitter is what breaks that.
   */
  jitter: number;
  /** Cap on an honored `Retry-After`, so a hostile header cannot park a worker. */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitter: 0.5,
  maxRetryAfterMs: 120_000,
};

/** Why the client decided to try again. */
export type RetryReason = 'throttled' | 'server-error' | 'token-expired' | 'network';

/**
 * One retry decision, handed to the caller as it happens.
 *
 * The worker uses these to pace itself: the client only knows about the request
 * in its hand, while the worker knows it has 211 profiles queued behind it.
 */
export interface RetryEvent {
  region: Region;
  method: string;
  /** Path only. Query strings can carry ids; the caller already knows them. */
  path: string;
  reason: RetryReason;
  /** 1-based index of the attempt that just failed. */
  attempt: number;
  status: number | null;
  /** What the client is about to sleep, jitter included. */
  delayMs: number;
  /** The value Amazon sent, when it sent one. Null is the common case. */
  retryAfterMs: number | null;
}

/**
 * What the client has seen lately, for a worker deciding whether to slow down.
 *
 * Amazon publishes no quota headers, so an observed throttle rate is the only
 * signal that exists. Reset by any successful request.
 */
export interface ThrottleState {
  region: Region;
  /** Successive throttled requests since the last success. */
  consecutiveThrottles: number;
  /** Throttled requests since the client was constructed. */
  totalThrottles: number;
  lastThrottledAt: number | null;
  /** The last `Retry-After` Amazon volunteered, in milliseconds. */
  lastRetryAfterMs: number | null;
  /** What the client would wait next, were it to be throttled again now. */
  suggestedDelayMs: number;
}

export interface AdsApiClientOptions {
  credentials: AdsCredentials;
  region: Region;
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Defaults to a real timer. Tests pass a recorder. */
  sleep?: (ms: number) => Promise<void>;
  /** Defaults to `Date.now`. */
  now?: () => number;
  /** Defaults to `Math.random`, used only for jitter. */
  random?: () => number;
  retry?: Partial<RetryPolicy>;
  onRetry?: (event: RetryEvent) => void;
  /** User-Agent sent on every request. Amazon asks integrators to identify. */
  userAgent?: string;
}

/** The shape every list endpoint returns, pages counted rather than assumed. */
export interface ListResult<T> {
  items: T[];
  /** How many HTTP round trips produced `items`. */
  pages: number;
  /**
   * Set when the caller capped the walk with `maxPages` and Amazon still had
   * more. A caller that ignores this is silently truncating its own mirror.
   */
  truncated: boolean;
  /** The token that would fetch the next page, when `truncated`. */
  nextToken: string | null;
}

/** Common options for a paginated list call. */
export interface ListOptions {
  /** Page size asked of Amazon. */
  maxResults?: number;
  /** Hard stop on round trips. Absent means "walk to the end". */
  maxPages?: number;
  /** Amazon's state vocabulary, upper case: ENABLED, PAUSED, ARCHIVED. */
  stateFilter?: readonly string[];
  /** Restrict to these campaigns where the endpoint supports it. */
  campaignIdFilter?: readonly string[];
  /** Restrict to these ad groups where the endpoint supports it. */
  adGroupIdFilter?: readonly string[];
  /** Restrict a targeted post-write observation to resource ids. */
  entityIdFilter?: readonly string[];
  /** Cancels the complete request, including asynchronous access-token headers. */
  signal?: AbortSignal;
  /** Hard wall-clock bound for each HTTP round trip, including header resolution. */
  timeoutMs?: number;
}

/** Optional cancellation boundary for one non-idempotent mutation call. */
export interface MutationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
