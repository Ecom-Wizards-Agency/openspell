import { gunzipSync } from 'node:zlib';
import { KeepaHttpError, KeepaParseError, KeepaRetryableError } from './errors.js';
import { isRecord } from './parsers.js';
import type { FetchLike, KeepaTokenState } from './types.js';

export interface HttpEffects {
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  maxAttempts: number;
}

export interface TokenTracker {
  update(payload: unknown): void;
  snapshot(): KeepaTokenState;
  recordRequest(): void;
}

/** The one place HTTP leaves this package. */
export async function keepaRequest(
  effects: HttpEffects,
  tokens: TokenTracker,
  path: string,
  url: string,
): Promise<Record<string, unknown>> {
  let lastCause: unknown;
  for (let attempt = 1; attempt <= effects.maxAttempts; attempt += 1) {
    let response: Response;
    tokens.recordRequest();
    try {
      response = await effects.fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json', 'accept-encoding': 'gzip' },
      });
    } catch (cause) {
      lastCause = cause;
      if (attempt === effects.maxAttempts) {
        throw new KeepaHttpError(`${path} was unreachable after ${attempt} attempts`, 0, attempt, { cause });
      }
      await effects.sleep(retryDelay(attempt, effects.random()));
      continue;
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    let payload: Record<string, unknown>;
    try {
      payload = decodeBody(bytes, path);
    } catch (error) {
      // Exhaustion is retryable even when an intermediary replaces Keepa's
      // JSON body. The exact refill delay is unavailable, so use the reference
      // client's conservative one-minute fallback.
      if (response.status !== 429) throw error;
      payload = {};
    }
    tokens.update(payload);
    if (response.status >= 200 && response.status < 300) return payload;
    if (response.status === 429) {
      const state = tokens.snapshot();
      throw new KeepaRetryableError(
        `${path} exhausted the Keepa token bucket`,
        (state.refillInMs ?? 60_000) + 1_000,
        state.tokensLeft,
        null,
      );
    }
    if (response.status >= 500 && response.status <= 599 && attempt < effects.maxAttempts) {
      await effects.sleep(retryDelay(attempt, effects.random()));
      continue;
    }
    throw new KeepaHttpError(`${path} failed with HTTP ${response.status}`, response.status, attempt);
  }
  throw new KeepaHttpError(`${path} retries exhausted`, 0, effects.maxAttempts, { cause: lastCause });
}

function retryDelay(attempt: number, random: number): number {
  const ceiling = Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling * (0.75 + 0.25 * Math.min(1, Math.max(0, random))));
}

function decodeBody(bytes: Uint8Array, path: string): Record<string, unknown> {
  let decoded = bytes;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) decoded = gunzipSync(bytes);
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(decoded));
    if (!isRecord(value)) throw new Error('response is not an object');
    return value;
  } catch (cause) {
    throw new KeepaParseError(`${path} returned malformed JSON`, { cause });
  }
}
