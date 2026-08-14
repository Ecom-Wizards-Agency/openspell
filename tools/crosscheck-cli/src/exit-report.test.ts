import { describe, expect, it } from 'vitest';
import {
  applySpendingFlags,
  campaignWeekShares,
  evaluateExitCriterion,
  historiesFromResults,
  longestVerifiedStreak,
  renderExitReport,
  spendingCampaignWeeks,
} from './exit-report.js';
import type { CampaignWeekVerdict, ProfileDayVerdict, ProfileHistory } from './exit-report.js';

function days(count: number, verdict: ProfileDayVerdict['verdict'] = 'verified', from = '2026-07-01') {
  const start = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => ({
    date: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
    verdict,
  }));
}

function campaignWeek(verified: number, total: number, weekStart = '2026-07-06'): CampaignWeekVerdict[] {
  return Array.from({ length: total }, (_, index) => ({
    weekStart,
    campaignId: `cmp-${index}`,
    spending: true,
    verdict: index < verified ? ('verified' as const) : ('mismatch' as const),
  }));
}

function history(profileId: string, dayCount: number, verified: number, total: number): ProfileHistory {
  return {
    profileId,
    label: profileId,
    region: 'NA',
    profileDays: days(dayCount),
    campaignWeeks: campaignWeek(verified, total),
  };
}

describe('longestVerifiedStreak', () => {
  it('counts calendar-consecutive verified days', () => {
    expect(longestVerifiedStreak(days(14)).length).toBe(14);
  });

  it('is broken by a mismatch', () => {
    const broken = [...days(7), { date: '2026-07-08', verdict: 'mismatch' as const }, ...days(6, 'verified', '2026-07-09')];
    expect(longestVerifiedStreak(broken).length).toBe(7);
  });

  it('is broken by a calendar gap, because an uncompared day did not pass', () => {
    const gapped = [...days(7), ...days(7, 'verified', '2026-07-10')];
    expect(longestVerifiedStreak(gapped).length).toBe(7);
  });

  it('does not let an excluded provisional day weld two runs together', () => {
    const withProvisional = [
      ...days(7),
      { date: '2026-07-08', verdict: 'skipped_provisional' as const },
      ...days(7, 'verified', '2026-07-09'),
    ];
    expect(longestVerifiedStreak(withProvisional).length).toBe(7);
  });

  it('reports the window it found', () => {
    const streak = longestVerifiedStreak(days(3));
    expect(streak).toEqual({ length: 3, start: '2026-07-01', end: '2026-07-03' });
  });
});

describe('campaignWeekShares', () => {
  it('takes the share over spending campaigns only', () => {
    const weeks: CampaignWeekVerdict[] = [
      ...campaignWeek(19, 20),
      { weekStart: '2026-07-06', campaignId: 'idle', spending: false, verdict: 'mismatch' },
    ];
    expect(campaignWeekShares(weeks)[0]).toEqual({
      weekStart: '2026-07-06',
      spending: 20,
      verified: 19,
      share: 0.95,
    });
  });
});

describe('evaluateExitCriterion', () => {
  const passing = () =>
    ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => history(id, 14, 19, 20));

  it('passes when every criterion is met and parity is recorded', () => {
    const report = evaluateExitCriterion(passing(), {
      optimizerParityNote: 'proposals matched the worked examples; preview differs only on their weighting layer',
      optimizerParityPassed: true,
      generatedOn: '2026-09-01',
    });
    expect(report.daysCriterionMet).toBe(true);
    expect(report.campaignCriterionMet).toBe(true);
    expect(report.profilesPassing).toBe(5);
    expect(report.verdict).toBe('pass');
  });

  it('is pending, never pass, while the optimizer parity check is unrecorded', () => {
    const report = evaluateExitCriterion(passing(), { generatedOn: '2026-09-01' });
    expect(report.optimizerParity.status).toBe('not_recorded');
    expect(report.verdict).toBe('pending');
  });

  it('fails on thirteen days', () => {
    const report = evaluateExitCriterion(
      ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => history(id, 13, 19, 20)),
      { optimizerParityNote: 'ok', optimizerParityPassed: true },
    );
    expect(report.daysCriterionMet).toBe(false);
    expect(report.verdict).toBe('fail');
  });

  it('fails at 94% of spending campaigns', () => {
    const report = evaluateExitCriterion(
      ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => history(id, 14, 47, 50)),
      { optimizerParityNote: 'ok', optimizerParityPassed: true },
    );
    expect(report.profiles[0]?.bestWeekShare).toBeCloseTo(0.94, 6);
    expect(report.campaignCriterionMet).toBe(false);
    expect(report.verdict).toBe('fail');
  });

  it('fails on four passing profiles, however good they are', () => {
    const report = evaluateExitCriterion(
      ['p1', 'p2', 'p3', 'p4'].map((id) => history(id, 30, 20, 20)),
      { optimizerParityNote: 'ok', optimizerParityPassed: true },
    );
    expect(report.verdict).toBe('fail');
  });

  it('fails when the operator records a parity failure', () => {
    const report = evaluateExitCriterion(passing(), {
      optimizerParityNote: 'our bids diverged outside their weighting layer',
      optimizerParityPassed: false,
    });
    expect(report.verdict).toBe('fail');
  });
});

describe('renderExitReport', () => {
  it('states the verdict, the per-profile rows and the open parity section', () => {
    const markdown = renderExitReport(
      evaluateExitCriterion(['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => history(id, 14, 19, 20)), {
        generatedOn: '2026-09-01',
      }),
    );
    expect(markdown).toContain('verdict **PENDING**');
    expect(markdown).toContain('(a) Profile-grain streak');
    expect(markdown).toContain('(b) Campaign-grain share');
    expect(markdown).toContain('NOT RECORDED');
    expect(markdown).toContain('| p1 | NA | 14 | 2026-07-01 → 2026-07-14 | PASS |');
    expect(markdown).toContain('95.0%');
  });

  it('names what failed', () => {
    const markdown = renderExitReport(
      evaluateExitCriterion([history('p1', 3, 1, 20)], {
        optimizerParityNote: 'ok',
        optimizerParityPassed: true,
      }),
    );
    expect(markdown).toContain('FAIL — the profile-grain streak and the campaign-grain share');
  });
});

describe('histories from stored rows', () => {
  const rows = [
    { profileId: 'p1', date: '2026-08-01', grain: 'profile', entityId: null, metric: 'headline', ours: null, theirs: null, verdict: 'verified' as const },
    { profileId: 'p1', date: '2026-08-01', grain: 'profile', entityId: null, metric: 'ad_spend', ours: 10, theirs: 10, verdict: 'verified' as const },
    { profileId: 'p1', date: '2026-08-03', grain: 'campaign_week', entityId: 'cmp-1', metric: 'headline', ours: null, theirs: null, verdict: 'verified' as const },
    { profileId: 'p1', date: '2026-08-03', grain: 'campaign_week', entityId: 'cmp-1', metric: 'ad_spend', ours: 100, theirs: 101, verdict: 'verified' as const },
    { profileId: 'p1', date: '2026-08-03', grain: 'campaign_week', entityId: 'cmp-2', metric: 'headline', ours: null, theirs: null, verdict: 'mismatch' as const },
    { profileId: 'p1', date: '2026-08-03', grain: 'campaign_week', entityId: 'cmp-2', metric: 'ad_spend', ours: 0, theirs: 0, verdict: 'verified' as const },
  ];

  it('reads only headline rows, and takes spending from the spend rows', () => {
    const histories = applySpendingFlags(historiesFromResults(rows), spendingCampaignWeeks(rows));
    const history = histories[0];
    expect(history?.profileDays).toEqual([{ date: '2026-08-01', verdict: 'verified' }]);
    expect(history?.campaignWeeks).toEqual([
      { weekStart: '2026-08-03', campaignId: 'cmp-1', spending: true, verdict: 'verified' },
      { weekStart: '2026-08-03', campaignId: 'cmp-2', spending: false, verdict: 'mismatch' },
    ]);
    // The idle campaign's mismatch cannot drag the share down.
    expect(campaignWeekShares(history?.campaignWeeks ?? [])[0]?.share).toBe(1);
  });
});
