/**
 * Assembling the injected effects into an `HttpContext`.
 *
 * Split out so the free functions (`exchangeAuthorizationCode`,
 * `refreshAccessToken`, `listProfilesAcrossRegions`) can be called without
 * constructing a client — WP-04's OAuth callback has credentials and a code,
 * and no profile to scope a client to yet.
 */
import type { Region } from '@wizard-ads/shared';
import { ThrottleTracker, type HttpContext } from './http.js';
import { DEFAULT_RETRY_POLICY, type FetchLike, type RetryEvent, type RetryPolicy } from './types.js';

/** Effects any entry point accepts. All optional; all defaulted here. */
export interface EffectOptions {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  retry?: Partial<RetryPolicy>;
  onRetry?: (event: RetryEvent) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function resolveRetryPolicy(overrides?: Partial<RetryPolicy>): RetryPolicy {
  return { ...DEFAULT_RETRY_POLICY, ...overrides };
}

export function createHttpContext(region: Region, options: EffectOptions = {}): HttpContext {
  const retry = resolveRetryPolicy(options.retry);
  return {
    region,
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    sleep: options.sleep ?? defaultSleep,
    now: options.now ?? (() => Date.now()),
    random: options.random ?? (() => Math.random()),
    retry,
    ...(options.onRetry === undefined ? {} : { onRetry: options.onRetry }),
    throttle: new ThrottleTracker(region, retry),
  };
}
