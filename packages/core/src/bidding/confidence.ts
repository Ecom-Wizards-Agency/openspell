/**
 * The Data Confidence Hierarchy.
 *
 * A keyword with one click and no sales has no meaningful RPC of its own, so
 * the benchmark comes from the ad group, then the campaign, then the profile.
 * Which level answered is recorded on every proposal, because a bid built on a
 * profile-wide average is a much weaker claim than one built on the keyword's
 * own conversions and the operator is entitled to see the difference.
 */
import type { CvrSourceLevel } from '@wizard-ads/shared';
import { safeDiv } from '../num.js';
import type { ConfidenceLevels, LevelMetrics, ResolvedConfidence } from './types.js';

const ORDER: Array<{ level: CvrSourceLevel; key: keyof ConfidenceLevels }> = [
  { level: 'keyword', key: 'keyword' },
  { level: 'ad_group', key: 'adGroup' },
  { level: 'campaign', key: 'campaign' },
  { level: 'profile', key: 'profile' },
];

function describe(level: CvrSourceLevel, metrics: LevelMetrics): ResolvedConfidence {
  return {
    level,
    metrics,
    cvr: safeDiv(metrics.orders, metrics.clicks),
    aov: safeDiv(metrics.sales, metrics.orders),
    rpc: safeDiv(metrics.sales, metrics.clicks),
    clicksToConversion: safeDiv(metrics.clicks, metrics.orders),
  };
}

/**
 * Walk keyword to ad group to campaign to profile, stopping at the first level
 * with at least `minOrders` conversions. When nothing qualifies the profile
 * answers anyway, since it is the last resort by definition; its `aov` and
 * `cvr` may still be null, and a caller that needs them must handle that
 * rather than substitute a number nobody measured.
 */
export function resolveConfidence(
  levels: ConfidenceLevels,
  minOrders = 1,
): ResolvedConfidence {
  for (const { level, key } of ORDER) {
    const metrics = levels[key];
    if (!metrics) continue;
    if (metrics.orders >= minOrders && metrics.clicks > 0) {
      return describe(level, metrics);
    }
  }
  return describe('profile', levels.profile);
}
