/**
 * Port of `datasource.classify_campaign_category`.
 *
 * Best-effort category from campaign-name tokens, matching the naming
 * convention the campaign builder writes. The fallback is `Unknown` and not a
 * guess, because every downstream rule treats `Rank` differently and a wrong
 * `Rank` guess silently suppresses a real cut.
 *
 * Match order is significant and is the reference's: `shield` wins over
 * `rank`, which wins over `profit`, which wins over the discovery tokens. A
 * campaign named "Shield Discovery BMM" is a Shield campaign.
 */
import {
  CATEGORY_DISCOVERY,
  CATEGORY_PROFIT,
  CATEGORY_RANK,
  CATEGORY_SHIELD,
  CATEGORY_UNKNOWN,
  type CampaignCategory,
} from './types.js';

const DISCOVERY_TOKENS = ['auto', 'bmm', 'phrase', 'discovery', 'broad'] as const;

export function classifyCampaignCategory(campaignName: string | null | undefined): CampaignCategory {
  if (!campaignName) return CATEGORY_UNKNOWN;
  const name = campaignName.toLowerCase();
  if (name.includes('shield')) return CATEGORY_SHIELD;
  if (name.includes('skw') || name.includes('rank')) return CATEGORY_RANK;
  if (name.includes('halo') || name.includes('profit')) return CATEGORY_PROFIT;
  if (DISCOVERY_TOKENS.some((token) => name.includes(token))) return CATEGORY_DISCOVERY;
  return CATEGORY_UNKNOWN;
}
