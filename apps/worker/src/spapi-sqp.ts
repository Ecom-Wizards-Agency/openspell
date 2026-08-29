/** Tenant-scoped SP-API composition for the durable SQP workflow. */
import {
  getSpApiRefreshToken,
  resolveActiveSpApiProfileBinding,
  type DbHandle,
} from '@wizard-ads/db';
import type { Region, SqpRequestJob } from '@wizard-ads/shared';
import {
  LwaRefreshTokenProvider,
  SpApiClient,
  type FetchLike,
} from '@wizard-ads/sp-api';
import {
  MinimumIntervalSqpProviderGate,
  SqpWorkflowPermanentError,
  createPostgresSqpRequestHandler,
  type SqpProviderGate,
  type SqpQueuedJobContext,
} from './sqp.js';

const ENDPOINTS: Readonly<Record<Region, string>> = {
  NA: 'https://sellingpartnerapi-na.amazon.com',
  EU: 'https://sellingpartnerapi-eu.amazon.com',
  FE: 'https://sellingpartnerapi-fe.amazon.com',
};

export function spApiEndpointForRegion(region: Region): string {
  return ENDPOINTS[region];
}

export interface SpApiSqpRuntimeOptions {
  handle: DbHandle;
  lwaClientId: string;
  lwaClientSecret: string;
  userAgent?: string;
  minimumProviderIntervalMs?: number;
  providerGate?: SqpProviderGate;
  fetch?: FetchLike;
  now?: () => Date;
}

type CachedClient = {
  client: SpApiClient;
  orgId: string;
  connectionId: string;
};

/**
 * One payload-scoped handler with a connection/region client pool.
 *
 * Binding ownership is re-resolved on every queue attempt. Cached access tokens
 * never bypass revocation because the handler refuses an inactive binding
 * before delegating, and a 401 invalidates the cache before one retry.
 */
export function createSpApiSqpRequestHandler(
  options: SpApiSqpRuntimeOptions,
): (
  payload: SqpRequestJob,
  context: SqpQueuedJobContext,
) => Promise<Record<string, unknown>> {
  const clients = new Map<string, CachedClient>();
  const gate = options.providerGate ?? new MinimumIntervalSqpProviderGate(
    options.minimumProviderIntervalMs ?? 1_000,
  );

  return async (payload, context) => {
    const binding = await resolveActiveSpApiProfileBinding(options.handle, {
      orgId: payload.orgId,
      profileId: payload.profileId,
      marketplaceId: payload.marketplaceId,
    });
    if (binding === null) {
      throw new SqpWorkflowPermanentError(
        'SQP request has no active exact profile, marketplace, and SP-API binding',
      );
    }

    const key = `${binding.connectionId}\u0000${binding.region}`;
    let cached = clients.get(key);
    if (!cached) {
      const { lwaClientId, lwaClientSecret: lwaKey } = options;
      const accessTokenProvider = new LwaRefreshTokenProvider({
        clientId: lwaClientId,
        clientSecret: lwaKey,
        refreshTokenProvider: () => getSpApiRefreshToken(options.handle, {
          orgId: binding.orgId,
          connectionId: binding.connectionId,
        }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      cached = {
        orgId: binding.orgId,
        connectionId: binding.connectionId,
        client: new SpApiClient({
          endpoint: spApiEndpointForRegion(binding.region),
          accessTokenProvider,
          userAgent: options.userAgent ?? 'WizardAds/1.0 (Language=TypeScript)',
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        }),
      };
      clients.set(key, cached);
    }
    if (cached.orgId !== binding.orgId || cached.connectionId !== binding.connectionId) {
      throw new SqpWorkflowPermanentError('SP-API client cache ownership mismatch');
    }

    const delegate = createPostgresSqpRequestHandler({
      handle: options.handle,
      api: cached.client,
      providerGate: gate,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    return delegate(payload, context);
  };
}
