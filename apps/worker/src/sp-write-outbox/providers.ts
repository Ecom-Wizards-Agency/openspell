import { performance } from 'node:perf_hooks';
import { createSpWriteAdapter, type SpWriteAdapter } from '@wizard-ads/ads-api/sp-write-adapter';
import { getAdsRefreshToken } from '@wizard-ads/db';
import { readSpWriteDatabaseTime } from '@wizard-ads/db/sp-write-worker';
import type { DbHandle } from '@wizard-ads/db';
import type { SpWritePlan } from '@wizard-ads/shared/sp-writes';
import { hasher, providerKey } from './artifacts.js';

/** Construct only within the worker, before claim. Secrets never enter returned facts or logs. */
export function createSpWriteProviderPreparation(database: DbHandle, env: NodeJS.ProcessEnv = process.env) {
  return async (plans: readonly SpWritePlan[], signal: AbortSignal): Promise<ReadonlyMap<string, SpWriteAdapter>> => {
    const prepared = new Map<string, SpWriteAdapter>();
    if (plans.length === 0) return prepared;
    const clientId = env.LWA_CLIENT_ID ?? env.AMAZON_LWA_CLIENT_ID;
    const secret = env['LWA_CLIENT_SECRET'] ?? env['AMAZON_LWA_CLIENT_SECRET'];
    if (!clientId || !secret) throw new Error('SP write credentials unavailable');
    const baseTime = Date.parse(await readSpWriteDatabaseTime(database));
    const readAt = performance.now();
    // Anchor after readback so network latency cannot advance the provider clock past the database.
    const now = () => baseTime + Math.max(0, performance.now() - readAt);
    for (const plan of plans) {
      signal.throwIfAborted();
      const key = providerKey(plan);
      if (prepared.has(key)) continue;
      const refreshToken = await getAdsRefreshToken(database, plan.providerScope.connectionId);
      if (refreshToken === null) continue;
      prepared.set(key, createSpWriteAdapter({ region: plan.providerScope.region,
        credentials: { clientId, clientSecret: secret, refreshToken },
      }, { hasher, now }));
    }
    return prepared;
  };
}
