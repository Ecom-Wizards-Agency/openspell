/**
 * Inert Sponsored Products write adapter.
 *
 * This module is available only through the explicit package subpath. It
 * describes exact provider calls, reads current state, and performs one
 * mutation attempt after a caller has durably recorded the shared intent. It
 * does not authorize, reserve, persist, retry, or observe a completed write.
 */
import {
  SpWriteProviderCallIntent,
  SpWriteProviderResult,
  SpWriteSha256,
  serializeSpWriteProviderCallIntentFingerprint,
  serializeSpWriteProviderRequestFingerprint,
  serializeSpWriteProviderResultFingerprint,
  type SpWriteObservedAction,
  type SpWritePlan,
  type SpWriteProviderCallIntent as SpWriteProviderCallIntentType,
  type SpWriteProviderResult as SpWriteProviderResultType,
  type SpWriteSha256Hasher,
} from '@wizard-ads/shared/sp-writes';
import { TokenProvider } from './auth.js';
import { createHttpContext } from './context.js';
import { adsHeaders } from './headers.js';
import { decodeText, httpRequest, httpRequestOnce, type HttpContext } from './http.js';
import { hostFor } from './regions.js';
import {
  buildSpWriteObservationBody,
  parseSpWrite207,
  parseSpWriteObservationPage,
  parseSpWriteObservationRows,
  prepareSpWriteCalls,
  type SpWriteCompiledCall,
  type SpWriteProviderPositionDraft,
} from './sp-write-codec.js';
import type { AdsApiClientOptions } from './types.js';

const DEFAULT_TIMEOUT_MS = 35_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_OBSERVATION_PAGES = 100;
const ZERO_SHA256 = '0'.repeat(64);

export type SpWritePreparedCall = Readonly<{
  routeKey: SpWriteProviderCallIntentType['routeKey'];
  positions: Readonly<SpWriteProviderCallIntentType['positions']>;
}>;

export type SpWriteAdapterOptions = Readonly<{
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

export interface SpWriteAdapter {
  preparePlan(plan: SpWritePlan): readonly SpWritePreparedCall[];

  observeCurrent(
    input: { plan: SpWritePlan; call: SpWritePreparedCall },
    options?: SpWriteAdapterOptions,
  ): Promise<readonly SpWriteObservedAction[]>;

  executeOneAttempt(
    input: {
      plan: SpWritePlan;
      intent: SpWriteProviderCallIntentType;
      resultId: string;
    },
    options?: SpWriteAdapterOptions,
  ): Promise<SpWriteProviderResultType>;
}

export type SpWriteAdapterDependencies = Readonly<{
  hasher: SpWriteSha256Hasher;
  now?: () => number;
}>;

function adapterRefusal(code: string): Error {
  return new Error(`SP write adapter refused: ${code}`);
}

function digest(preimage: string, hasher: SpWriteSha256Hasher): string {
  if (hasher.algorithm !== 'sha256') throw adapterRefusal('invalid_hasher');
  return SpWriteSha256.parse(hasher.digest(preimage));
}

function samePositions(
  left: readonly unknown[],
  right: readonly unknown[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function publicCall(call: SpWriteCompiledCall): SpWritePreparedCall {
  const positions = call.positions.map((position) => Object.freeze({ ...position }));
  return Object.freeze({
    routeKey: call.routeKey,
    positions: Object.freeze(positions),
  });
}

function findCall(
  compiled: readonly SpWriteCompiledCall[],
  requested: SpWritePreparedCall,
): SpWriteCompiledCall {
  const match = compiled.find((call) =>
    call.routeKey === requested.routeKey && samePositions(call.positions, requested.positions));
  if (match === undefined) throw adapterRefusal('prepared_call_mismatch');
  return match;
}

function ambiguousPositions(
  intent: SpWriteProviderCallIntentType,
  code: string | null = 'SP_WRITE_AMBIGUOUS',
  message: string | null = null,
): readonly SpWriteProviderPositionDraft[] {
  return intent.positions.map((position) => ({
    requestIndex: position.requestIndex,
    actionId: position.actionId,
    actionFingerprint: position.actionFingerprint,
    actionRequestFingerprint: position.actionRequestFingerprint,
    outcome: 'ambiguous',
    providerEntityId: null,
    code,
    message,
  }));
}

function completedAt(now: () => number, intent: SpWriteProviderCallIntentType): string {
  const time = Math.max(now(), Date.parse(intent.recordedAt));
  if (!Number.isFinite(time)) throw adapterRefusal('invalid_completion_time');
  return new Date(time).toISOString();
}

function buildResult(
  resultId: string,
  intent: SpWriteProviderCallIntentType,
  positions: readonly SpWriteProviderPositionDraft[],
  hasher: SpWriteSha256Hasher,
  now: () => number,
): SpWriteProviderResultType {
  const unsigned = SpWriteProviderResult.parse({
    schemaVersion: 'openspell.sp-write-provider-result.v1',
    resultId,
    intentId: intent.intentId,
    intentFingerprint: intent.fingerprint,
    providerCallId: intent.providerCallId,
    requestFingerprint: intent.requestFingerprint,
    completedAt: completedAt(now, intent),
    positions,
    fingerprint: ZERO_SHA256,
  });
  return SpWriteProviderResult.parse({
    ...unsigned,
    fingerprint: digest(serializeSpWriteProviderResultFingerprint(unsigned), hasher),
  });
}

function verifyIntent(
  rawIntent: SpWriteProviderCallIntentType,
  plan: SpWritePlan,
  calls: readonly SpWriteCompiledCall[],
  hasher: SpWriteSha256Hasher,
): { intent: SpWriteProviderCallIntentType; call: SpWriteCompiledCall } {
  let intent: SpWriteProviderCallIntentType;
  try {
    intent = SpWriteProviderCallIntent.parse(rawIntent);
    if (intent.planId !== plan.id || intent.planFingerprint !== plan.fingerprint) {
      throw adapterRefusal('intent_plan_mismatch');
    }
    if (digest(serializeSpWriteProviderRequestFingerprint(intent), hasher)
      !== intent.requestFingerprint) {
      throw adapterRefusal('request_fingerprint_mismatch');
    }
    if (digest(serializeSpWriteProviderCallIntentFingerprint(intent), hasher)
      !== intent.fingerprint) {
      throw adapterRefusal('intent_fingerprint_mismatch');
    }
  } catch {
    throw adapterRefusal('invalid_intent');
  }

  const call = calls.find((candidate) =>
    candidate.routeKey === intent.routeKey
      && samePositions(candidate.positions, intent.positions));
  if (call === undefined) throw adapterRefusal('intent_positions_mismatch');
  return { intent, call };
}

function jsonBody(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw adapterRefusal('request_serialization_failed');
    return serialized;
  } catch {
    throw adapterRefusal('request_serialization_failed');
  }
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(decodeText(body)) as unknown;
  } catch {
    throw adapterRefusal('provider_body_not_json');
  }
}

function requestOptions(options: SpWriteAdapterOptions): {
  signal?: AbortSignal;
  timeoutMs: number;
  redirect: 'error';
  maxResponseBytes: number;
} {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw adapterRefusal('invalid_timeout');
  }
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    timeoutMs,
    redirect: 'error',
    maxResponseBytes: MAX_RESPONSE_BYTES,
  };
}

function headersFor(
  getAccessToken: (force: boolean) => Promise<string>,
  clientId: string,
  profileId: string,
  mediaType: string,
  userAgent?: string,
) {
  return adsHeaders(getAccessToken, {
    clientId,
    profileId,
    contentType: mediaType,
    accept: mediaType,
    ...(userAgent === undefined ? {} : { userAgent }),
  });
}

class DefaultSpWriteAdapter implements SpWriteAdapter {
  private readonly ctx: HttpContext;
  private readonly tokens: TokenProvider;
  private readonly now: () => number;

  constructor(
    private readonly options: AdsApiClientOptions,
    private readonly dependencies: SpWriteAdapterDependencies,
  ) {
    this.ctx = createHttpContext(options.region, options);
    this.tokens = new TokenProvider(options.credentials, options);
    this.now = dependencies.now ?? options.now ?? (() => Date.now());
  }

  private compile(plan: SpWritePlan): readonly SpWriteCompiledCall[] {
    try {
      if (plan.providerScope.region !== this.options.region) {
        throw adapterRefusal('client_region_mismatch');
      }
      return prepareSpWriteCalls(plan, this.dependencies.hasher);
    } catch {
      throw adapterRefusal('invalid_plan_or_provider_scope');
    }
  }

  preparePlan(plan: SpWritePlan): readonly SpWritePreparedCall[] {
    return Object.freeze(this.compile(plan).map(publicCall));
  }

  async observeCurrent(
    input: { plan: SpWritePlan; call: SpWritePreparedCall },
    options: SpWriteAdapterOptions = {},
  ): Promise<readonly SpWriteObservedAction[]> {
    try {
      const call = findCall(this.compile(input.plan), input.call);
      const request = requestOptions(options);
      const rows: Record<string, unknown>[] = [];
      const seenTokens = new Set<string>();
      let nextToken: string | null = null;

      for (let pageNumber = 0; pageNumber < MAX_OBSERVATION_PAGES; pageNumber += 1) {
        const body = jsonBody(buildSpWriteObservationBody(
          call,
          nextToken === null ? undefined : nextToken,
        ));
        const result = await httpRequest(this.ctx, {
          method: 'POST',
          url: `${hostFor(input.plan.providerScope.region)}${call.observation.path}`,
          path: call.observation.path,
          headers: headersFor(
            (force) => force ? this.tokens.forceRefresh() : this.tokens.getAccessToken(),
            this.options.credentials.clientId,
            input.plan.providerScope.amazonProfileId,
            call.observation.mediaType,
            this.options.userAgent,
          ),
          body,
          idempotent: true,
          ...request,
        });
        if (result.status !== 200) throw adapterRefusal('unexpected_observation_status');
        const page = parseSpWriteObservationPage(parseJson(result.body), call);
        rows.push(...page.rows);
        nextToken = page.nextToken;
        if (nextToken === null) return parseSpWriteObservationRows(call, rows);
        if (page.rows.length === 0 || seenTokens.has(nextToken)) {
          throw adapterRefusal('observation_pagination_stalled');
        }
        seenTokens.add(nextToken);
      }
      throw adapterRefusal('observation_page_limit');
    } catch {
      throw adapterRefusal('observation_failed');
    }
  }

  async executeOneAttempt(
    input: {
      plan: SpWritePlan;
      intent: SpWriteProviderCallIntentType;
      resultId: string;
    },
    options: SpWriteAdapterOptions = {},
  ): Promise<SpWriteProviderResultType> {
    const calls = this.compile(input.plan);
    const { intent, call } = verifyIntent(
      input.intent,
      input.plan,
      calls,
      this.dependencies.hasher,
    );
    // Validate result identity and hashing before the mutation request. After a
    // valid intent reaches I/O, every operational failure must still close it.
    buildResult(
      input.resultId,
      intent,
      ambiguousPositions(intent),
      this.dependencies.hasher,
      this.now,
    );

    let positions: readonly SpWriteProviderPositionDraft[] = ambiguousPositions(intent);
    try {
      const request = requestOptions(options);
      const response = await httpRequestOnce(this.ctx, {
        method: 'PUT',
        url: `${hostFor(input.plan.providerScope.region)}${call.mutation.path}`,
        headers: headersFor(
          () => this.tokens.getAccessToken(),
          this.options.credentials.clientId,
          input.plan.providerScope.amazonProfileId,
          call.mutation.mediaType,
          this.options.userAgent,
        ),
        body: call.mutation.body,
        ...request,
      });

      if (response.status === 207) {
        const parsed = parseSpWrite207(parseJson(response.body), call);
        positions = parsed.kind === 'positions'
          ? parsed.positions
          : ambiguousPositions(intent, parsed.code, parsed.message);
      }
    } catch {
      positions = ambiguousPositions(intent);
    }

    return buildResult(
      input.resultId,
      intent,
      positions,
      this.dependencies.hasher,
      this.now,
    );
  }
}

export function createSpWriteAdapter(
  options: AdsApiClientOptions,
  dependencies: SpWriteAdapterDependencies,
): SpWriteAdapter {
  return new DefaultSpWriteAdapter(options, dependencies);
}
