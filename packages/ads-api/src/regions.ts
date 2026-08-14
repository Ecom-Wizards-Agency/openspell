/**
 * Regional routing.
 *
 * The three Amazon Ads hosts are three separate deployments: a profile id is
 * meaningful on exactly one of them, tokens are shared but rate limits are not,
 * and a request sent to the wrong host returns an unhelpful 401. Ported from
 * `SPAdsApiDataSource.REGION_ENDPOINTS` (live-verified 2026-08-13).
 */
import type { Region } from '@wizard-ads/shared';
import { AdsApiConfigError } from './errors.js';

/** LWA is global: one token endpoint for all three regions. */
export const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

/** Where a human is sent to grant consent. Region-specific by marketplace. */
export const LWA_AUTHORIZE_URL: Readonly<Record<Region, string>> = {
  NA: 'https://www.amazon.com/ap/oa',
  EU: 'https://eu.account.amazon.com/ap/oa',
  FE: 'https://apac.account.amazon.com/ap/oa',
};

export const REGION_HOSTS: Readonly<Record<Region, string>> = {
  NA: 'https://advertising-api.amazon.com',
  EU: 'https://advertising-api-eu.amazon.com',
  FE: 'https://advertising-api-fe.amazon.com',
};

export const ALL_REGIONS: readonly Region[] = ['NA', 'EU', 'FE'];

/** Narrow an untrusted string to a region, loudly. */
export function assertRegion(value: string): Region {
  const upper = value.toUpperCase();
  if (upper === 'NA' || upper === 'EU' || upper === 'FE') return upper;
  throw new AdsApiConfigError(`unsupported Ads API region '${value}'`);
}

export function hostFor(region: Region): string {
  return REGION_HOSTS[region];
}
