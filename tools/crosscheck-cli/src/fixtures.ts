/**
 * The synthetic account both sides of the crosscheck are tested against.
 *
 * Our side lives here as data; the AdLabs side lives in `fixtures/` as real
 * CSV files, because a parser tested against a string literal is a parser that
 * has never met a byte-order mark. The two are arithmetically consistent by
 * construction: the campaign dailies sum to the profile dailies, and the clean
 * export is our figures within tolerance. That is what makes the corrupted
 * fixture's single 12% campaign the only thing that can fail.
 *
 * Nothing here came from a real account and nothing here ever may: the profile
 * ids, campaign ids and names are invented, and a fixture built from live data
 * would be a client data leak with extra steps.
 */
import { fileURLToPath } from 'node:url';
import type { OurCampaignTotals, OurProfileDay } from './compare.js';

export const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));
export const INBOX_DIR = `${FIXTURES_DIR}inbox`;
export const CORRUPTED_DIR = `${FIXTURES_DIR}corrupted`;
export const PROVISIONAL_DIR = `${FIXTURES_DIR}provisional`;

export const FIXTURE_PROFILE = '9900000001';
export const FIXTURE_OTHER_PROFILE = '9900000002';
export const FIXTURE_WEEK = { start: '2026-08-01', end: '2026-08-07' } as const;
/** The in-progress day: present in our facts, provisional, badly under-reported by AdLabs. */
export const FIXTURE_REPORT_DAY = '2026-08-08';

export const FIXTURE_DATES = [
  '2026-08-01',
  '2026-08-02',
  '2026-08-03',
  '2026-08-04',
  '2026-08-05',
  '2026-08-06',
  '2026-08-07',
] as const;

export interface FixtureCampaign {
  campaignId: string;
  name: string;
  adGroupId: string;
  targetId: string;
  spend: readonly number[];
  sales: readonly number[];
}

export const FIXTURE_CAMPAIGNS: readonly FixtureCampaign[] = [
  {
    campaignId: 'cmp-9001',
    name: 'SKW | Exact | Core',
    adGroupId: 'agp-9001',
    targetId: 'tgt-9001',
    spend: [40, 45, 38, 50, 42, 52, 33],
    sales: [160, 180, 152, 200, 168, 208, 132],
  },
  {
    campaignId: 'cmp-9002',
    name: 'AUTO | Discovery',
    adGroupId: 'agp-9002',
    targetId: 'tgt-9002',
    spend: [35, 36, 30, 40, 34, 45, 30],
    sales: [140, 144, 120, 160, 136, 180, 120],
  },
  {
    campaignId: 'cmp-9003',
    name: 'PAT | Competitor ASINs',
    adGroupId: 'agp-9003',
    targetId: 'tgt-9003',
    spend: [20, 22, 20, 23, 22, 25, 18.5],
    sales: [80, 88, 80, 92, 88, 100, 72],
  },
  {
    campaignId: 'cmp-9004',
    name: 'SB | Video | Brand',
    adGroupId: 'agp-9004',
    targetId: 'tgt-9004',
    spend: [5, 7, 7.5, 7.25, 7, 8, 18.25],
    sales: [20, 38, 28, 48, 18, 32, 66],
  },
];

/** Our profile-grain facts for the week, plus the provisional in-progress day. */
export function ourProfileDays(includeProvisionalDay = true): OurProfileDay[] {
  const days = FIXTURE_DATES.map((date, index) => ({
    date,
    adSpend: round(FIXTURE_CAMPAIGNS.reduce((total, c) => total + (c.spend[index] ?? 0), 0)),
    adSales: round(FIXTURE_CAMPAIGNS.reduce((total, c) => total + (c.sales[index] ?? 0), 0)),
    provisional: false,
  }));
  if (!includeProvisionalDay) return days;
  // Same shape as a real in-progress day: our sync has it, it is still
  // attributing, and the other side has barely started reporting it.
  return [...days, { date: FIXTURE_REPORT_DAY, adSpend: 130, adSales: 100, provisional: true }];
}

/** Our campaign totals for the week. */
export function ourCampaignTotals(): OurCampaignTotals[] {
  return FIXTURE_CAMPAIGNS.map((campaign) => ({
    campaignId: campaign.campaignId,
    adSpend: round(campaign.spend.reduce((total, value) => total + value, 0)),
    adSales: round(campaign.sales.reduce((total, value) => total + value, 0)),
  }));
}

/** The naming contract, built rather than spelled out. See `contract.ts`. */
export function exportFileName(
  grain: 'profile' | 'campaign',
  amazonProfileId: string,
  startDate: string,
  endDate: string,
): string {
  return ['adlabs', grain, amazonProfileId, startDate, `${endDate}.csv`].join('_');
}

export const CLEAN_PROFILE_EXPORT = exportFileName(
  'profile',
  FIXTURE_PROFILE,
  FIXTURE_WEEK.start,
  FIXTURE_WEEK.end,
);
export const CLEAN_CAMPAIGN_EXPORT = exportFileName(
  'campaign',
  FIXTURE_PROFILE,
  FIXTURE_WEEK.start,
  FIXTURE_WEEK.end,
);
export const PROVISIONAL_PROFILE_EXPORT = exportFileName(
  'profile',
  FIXTURE_PROFILE,
  FIXTURE_WEEK.start,
  FIXTURE_REPORT_DAY,
);
export const EURO_PROFILE_EXPORT = exportFileName(
  'profile',
  FIXTURE_OTHER_PROFILE,
  FIXTURE_WEEK.start,
  '2026-08-03',
);
/** The campaign the corrupted export puts 12% out. Nothing else may move. */
export const CORRUPTED_CAMPAIGN = 'cmp-9003';

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
