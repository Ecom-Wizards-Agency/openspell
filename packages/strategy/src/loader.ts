/**
 * The loader seam.
 *
 * `strategy` never talks to a database: it declares what a loader must provide
 * and the worker or `db` package implements it. That is what keeps the resolver
 * a pure function of its inputs, and therefore replayable in a test with no
 * fixture server.
 */
import type { TenantStrategy } from '@wizard-ads/shared';
import type { StrategyDocument } from './resolve.js';
import { resolveStrategy, type ResolvedStrategy } from './resolve.js';

export interface StrategyLoader {
  /** The tenant-wide document for an org, or null when none is seeded. */
  loadTenant(orgId: string): Promise<StrategyDocument | null>;
  /** A per-profile override, or null when the profile inherits the tenant's. */
  loadProfile(profileId: string): Promise<StrategyDocument | null>;
}

export interface LoadStrategyInput {
  orgId: string;
  profileId: string;
  goal?: string | null;
}

/**
 * Compose a loader with the resolver.
 *
 * The awaiting happens here so callers do not each re-implement the layer
 * order; the resolution itself is still the pure function above.
 */
export async function loadStrategy(
  loader: StrategyLoader,
  input: LoadStrategyInput,
): Promise<ResolvedStrategy> {
  const [tenant, profile] = await Promise.all([
    loader.loadTenant(input.orgId),
    loader.loadProfile(input.profileId),
  ]);
  return resolveStrategy({ goal: input.goal, tenant, profile });
}

/** A loader over documents already in memory. Useful in tests and in seeding. */
export function staticLoader(documents: {
  tenant?: StrategyDocument | TenantStrategy | null;
  profile?: StrategyDocument | TenantStrategy | null;
}): StrategyLoader {
  return {
    loadTenant: async () => (documents.tenant as StrategyDocument | null) ?? null,
    loadProfile: async () => (documents.profile as StrategyDocument | null) ?? null,
  };
}
