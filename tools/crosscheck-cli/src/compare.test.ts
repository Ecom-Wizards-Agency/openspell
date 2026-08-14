import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compare, compareCampaignWeek, compareProfileDays, rollUp } from './compare.js';
import type { CrosscheckFinding } from './compare.js';
import { parseExport } from './contract.js';
import {
  CLEAN_CAMPAIGN_EXPORT,
  CLEAN_PROFILE_EXPORT,
  CORRUPTED_CAMPAIGN,
  CORRUPTED_DIR,
  FIXTURE_PROFILE,
  FIXTURE_REPORT_DAY,
  FIXTURE_WEEK,
  INBOX_DIR,
  PROVISIONAL_DIR,
  PROVISIONAL_PROFILE_EXPORT,
  ourCampaignTotals,
  ourProfileDays,
} from './fixtures.js';

const read = (dir: string, name: string) => readFile(join(dir, name), 'utf8');

async function loadExport(dir: string, name: string) {
  return parseExport(name, await read(dir, name), { amazonProfileId: FIXTURE_PROFILE });
}

const headlines = (findings: readonly CrosscheckFinding[], grain: string) =>
  findings.filter((finding) => finding.grain === grain && finding.metric === 'headline');

describe('the clean fixture', () => {
  it('verifies every profile-day', async () => {
    const exported = await loadExport(INBOX_DIR, CLEAN_PROFILE_EXPORT);
    const findings = compareProfileDays({
      ours: ourProfileDays(false),
      theirs: exported.profileDays,
      source: exported.source,
    });

    const days = headlines(findings, 'profile');
    expect(days).toHaveLength(7);
    expect(days.every((day) => day.verdict === 'verified')).toBe(true);
    expect(findings.filter((f) => f.verdict === 'mismatch')).toEqual([]);
  });

  it('verifies every campaign, with the delta recorded on each figure', async () => {
    const exported = await loadExport(INBOX_DIR, CLEAN_CAMPAIGN_EXPORT);
    const result = compare({
      campaign: {
        weekStart: FIXTURE_WEEK.start,
        ours: ourCampaignTotals(),
        theirs: exported.campaigns,
        source: exported.source,
      },
    });

    expect(result.summary.campaignsCompared).toBe(4);
    expect(result.summary.headline).toBe('verified');
    const spend = result.findings.find(
      (finding) => finding.entityId === 'cmp-9001' && finding.metric === 'ad_spend',
    );
    expect(spend?.ours).toBe(300);
    expect(spend?.theirs).toBe(306);
    expect(spend?.deltaPct).toBeCloseTo(0.02, 6);
  });
});

describe('the corrupted fixture', () => {
  it('flags a mismatch on exactly the corrupted campaign', async () => {
    const exported = await loadExport(CORRUPTED_DIR, CLEAN_CAMPAIGN_EXPORT);
    const findings = compareCampaignWeek({
      weekStart: FIXTURE_WEEK.start,
      ours: ourCampaignTotals(),
      theirs: exported.campaigns,
      source: exported.source,
    });

    const mismatching = new Set(
      findings.filter((finding) => finding.verdict === 'mismatch').map((f) => f.entityId),
    );
    expect([...mismatching]).toEqual([CORRUPTED_CAMPAIGN]);

    const spend = findings.find(
      (finding) => finding.entityId === CORRUPTED_CAMPAIGN && finding.metric === 'ad_spend',
    );
    expect(spend?.ours).toBe(150.5);
    expect(spend?.theirs).toBe(168.56);
    expect(spend?.deltaPct).toBeCloseTo(0.12, 4);
    expect(spend?.verdict).toBe('mismatch');

    // Every other campaign is untouched: a corrupted figure must not smear.
    for (const campaign of ['cmp-9001', 'cmp-9002', 'cmp-9004']) {
      const headline = findings.find(
        (finding) => finding.entityId === campaign && finding.metric === 'headline',
      );
      expect(headline?.verdict).toBe('verified');
    }
  });
});

describe('the provisional day', () => {
  it('is skipped, kept visible, and cannot fail the verdict', async () => {
    const exported = await loadExport(PROVISIONAL_DIR, PROVISIONAL_PROFILE_EXPORT);
    const result = compare(
      {
        profile: {
          ours: ourProfileDays(true),
          theirs: exported.profileDays,
          source: exported.source,
        },
      },
      { reportDay: FIXTURE_REPORT_DAY },
    );

    const provisional = result.findings.filter((finding) => finding.date === FIXTURE_REPORT_DAY);
    expect(provisional).toHaveLength(3);
    expect(provisional.every((finding) => finding.verdict === 'skipped_provisional')).toBe(true);
    // The figures are kept: "excluded" has to be a claim a reader can check.
    expect(provisional.find((f) => f.metric === 'ad_spend')?.ours).toBe(130);
    expect(provisional.find((f) => f.metric === 'ad_spend')?.theirs).toBe(12.4);

    expect(result.summary.profileDaysCompared).toBe(7);
    expect(result.summary.profileDaysSkipped).toBe(1);
    expect(result.summary.headline).toBe('verified');
  });

  it('is skipped on our provisional flag even when no report day is given', async () => {
    const exported = await loadExport(PROVISIONAL_DIR, PROVISIONAL_PROFILE_EXPORT);
    const result = compare({
      profile: {
        ours: ourProfileDays(true),
        theirs: exported.profileDays,
        source: exported.source,
      },
    });
    expect(result.summary.headline).toBe('verified');
    expect(result.summary.profileDaysSkipped).toBe(1);
  });

  it('would have failed loudly without the exclusion', async () => {
    const exported = await loadExport(PROVISIONAL_DIR, PROVISIONAL_PROFILE_EXPORT);
    const ours = ourProfileDays(true).map((day) => ({ ...day, provisional: false }));
    const result = compare({
      profile: { ours, theirs: exported.profileDays, source: exported.source },
    });
    expect(result.summary.headline).toBe('mismatch');
  });
});

describe('absence and idleness', () => {
  it('says which side is missing rather than a directionless no_data', () => {
    const findings = compareCampaignWeek({
      weekStart: FIXTURE_WEEK.start,
      ours: [{ campaignId: 'ours-only', adSpend: 10, adSales: 40 }],
      theirs: [
        {
          campaignId: 'theirs-only',
          campaignName: null,
          date: null,
          amazonProfileId: null,
          adSpend: 10,
          adSales: 40,
        },
      ],
      source: 'test',
    });

    expect(
      findings.find((f) => f.entityId === 'ours-only' && f.metric === 'headline')?.verdict,
    ).toBe('missing_theirs');
    expect(
      findings.find((f) => f.entityId === 'theirs-only' && f.metric === 'headline')?.verdict,
    ).toBe('missing_ours');
  });

  it('drops campaigns that neither side reported spend or sales for', () => {
    const result = compare({
      campaign: {
        weekStart: FIXTURE_WEEK.start,
        ours: [
          { campaignId: 'idle', adSpend: 0, adSales: 0 },
          { campaignId: 'live', adSpend: 100, adSales: 400 },
        ],
        theirs: [
          {
            campaignId: 'idle',
            campaignName: null,
            date: null,
            amazonProfileId: null,
            adSpend: 0,
            adSales: 0,
          },
          {
            campaignId: 'live',
            campaignName: null,
            date: null,
            amazonProfileId: null,
            adSpend: 101,
            adSales: 402,
          },
        ],
        source: 'test',
      },
    });
    expect(result.summary.campaignsCompared).toBe(1);
    expect(result.summary.campaignsSkippedIdle).toBe(1);
  });

  it('sums a daily-breakdown export to the same verdict as a window total', async () => {
    const exported = await loadExport(INBOX_DIR, CLEAN_CAMPAIGN_EXPORT);
    const daily = exported.campaigns.flatMap((campaign) =>
      [0, 1].map((half) => ({
        ...campaign,
        date: half === 0 ? '2026-08-01' : '2026-08-02',
        adSpend: (campaign.adSpend ?? 0) / 2,
        adSales: (campaign.adSales ?? 0) / 2,
      })),
    );
    const findings = compareCampaignWeek({
      weekStart: FIXTURE_WEEK.start,
      ours: ourCampaignTotals(),
      theirs: daily,
      source: 'test',
    });
    expect(headlines(findings, 'campaign_week').every((f) => f.verdict === 'verified')).toBe(true);
  });
});

describe('rollUp', () => {
  it('lets the worst comparable verdict win and ignores skipped days', () => {
    expect(rollUp(['verified', 'skipped_provisional'])).toBe('verified');
    expect(rollUp(['verified', 'missing_theirs'])).toBe('missing_theirs');
    expect(rollUp(['missing_ours', 'mismatch'])).toBe('mismatch');
    expect(rollUp(['skipped_provisional'])).toBe('no_data');
    expect(rollUp([])).toBe('no_data');
  });
});
