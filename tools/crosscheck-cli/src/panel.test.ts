import { describe, expect, it } from 'vitest';
import { buildPanelModel, verdictLabel, verdictTone } from './panel.js';
import type { StoredResult } from './results.js';

const row = (over: Partial<StoredResult>): StoredResult => ({
  profileId: 'p1',
  date: '2026-08-01',
  grain: 'profile',
  entityId: null,
  metric: 'headline',
  ours: null,
  theirs: null,
  deltaPct: null,
  tolerance: 0.07,
  verdict: 'verified',
  source: 'adlabs_profile_9900000001_2026-08-01_2026-08-07.csv',
  ...over,
});

describe('buildPanelModel', () => {
  const rows: StoredResult[] = [
    row({ date: '2026-08-01' }),
    row({ date: '2026-08-01', metric: 'ad_spend', ours: 100, theirs: 102, deltaPct: 0.02 }),
    row({ date: '2026-08-02' }),
    row({ date: '2026-08-03', verdict: 'skipped_provisional' }),
    row({
      date: '2026-08-01',
      grain: 'campaign_week',
      entityId: 'cmp-9003',
      verdict: 'mismatch',
    }),
    row({
      date: '2026-08-01',
      grain: 'campaign_week',
      entityId: 'cmp-9003',
      metric: 'ad_spend',
      ours: 150.5,
      theirs: 168.56,
      deltaPct: 0.12,
      verdict: 'mismatch',
    }),
    row({ date: '2026-08-01', grain: 'campaign_week', entityId: 'cmp-9001' }),
  ];

  it('reads newest first and takes the chip from the newest compared day', () => {
    const model = buildPanelModel(rows);
    expect(model.days.map((day) => day.date)).toEqual(['2026-08-03', '2026-08-02', '2026-08-01']);
    // The provisional day is shown, and is not what the chip reports.
    expect(model.days[0]?.verdict).toBe('skipped_provisional');
    expect(model.chip.asOf).toBe('2026-08-02');
    expect(model.chip.verdict).toBe('verified');
    expect(model.chip.verifiedStreak).toBe(2);
  });

  it('drills down only into campaigns that disagree, worst delta first', () => {
    const model = buildPanelModel(rows, { campaignNames: new Map([['cmp-9003', 'PAT | Competitor ASINs']]) });
    expect(model.campaignsCompared).toBe(2);
    expect(model.mismatchingCampaigns).toHaveLength(1);
    expect(model.mismatchingCampaigns[0]).toMatchObject({
      campaignId: 'cmp-9003',
      campaignName: 'PAT | Competitor ASINs',
      verdict: 'mismatch',
    });
    expect(model.mismatchingCampaigns[0]?.figures[0]).toMatchObject({
      metric: 'ad_spend',
      ours: 150.5,
      theirs: 168.56,
      deltaPct: 0.12,
    });
  });

  it('says "not cross-checked" rather than verified when there is nothing to show', () => {
    const model = buildPanelModel([]);
    expect(model.chip.verdict).toBe('no_data');
    expect(model.chip.asOf).toBeNull();
    expect(model.chip.verifiedStreak).toBe(0);
  });

  it('breaks the streak on the first day that is not verified', () => {
    const model = buildPanelModel([
      row({ date: '2026-08-01' }),
      row({ date: '2026-08-02', verdict: 'mismatch' }),
      row({ date: '2026-08-03' }),
    ]);
    expect(model.chip.verifiedStreak).toBe(1);
    expect(model.chip.verdict).toBe('verified');
  });

  it('records the exports the verdicts came from', () => {
    expect(buildPanelModel(rows).sources).toEqual([
      'adlabs_profile_9900000001_2026-08-01_2026-08-07.csv',
    ]);
  });
});

describe('the verdict vocabulary', () => {
  it('never renders a raw enum value or a colour the panel has to invent', () => {
    expect(verdictLabel('missing_ours')).toBe('Missing on our side');
    expect(verdictLabel('no_data')).toBe('Not cross-checked');
    expect(verdictTone('mismatch')).toBe('bad');
    expect(verdictTone('skipped_provisional')).toBe('muted');
  });
});
