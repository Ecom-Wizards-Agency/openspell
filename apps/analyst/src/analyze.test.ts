import { describe, expect, it } from 'vitest';
import { analyzeProfile } from './analyze.js';
import type { Briefing } from './analyze.js';
import type {
  EntityDataPayload,
  FlagsPayload,
  McpProfile,
  PacingPayload,
  ProfileContextPayload,
} from './mcp-client.js';

function profile(overrides: Partial<McpProfile> = {}): McpProfile {
  return {
    id: 'p-1',
    amazonProfileId: 'dev-1001',
    countryCode: 'US',
    currencyCode: 'USD',
    timezone: 'America/Los_Angeles',
    accountName: 'Dev US',
    syncEnabled: true,
    targetAcos: 0.25,
    goalLens: 'profit',
    monthlyBudget: 3000,
    ...overrides,
  };
}

const context: ProfileContextPayload = {
  strategySummary: { present: true, scope: 'org', sections: ['bidding'], refreshedAt: null },
  counts: { campaigns: 1, adGroups: 1, keywords: 5, targets: 5 },
  recentChanges: [],
};

function entity(row: Record<string, number> | null): EntityDataPayload {
  return {
    entity: 'profile',
    window: { from: '2026-01-01', to: '2026-01-30' },
    comparisonWindow: { from: '2025-12-02', to: '2025-12-31' },
    columns: [],
    rowCount: row ? 1 : 0,
    rows: row ? [row] : [],
    freshness: { latestFactDate: '2026-01-30', provisional: false, note: 'loaded through 2026-01-30' },
  };
}

function briefing(overrides: {
  profile?: McpProfile;
  row?: Record<string, number> | null;
  flags?: FlagsPayload;
  pacing?: PacingPayload;
}): Briefing {
  return {
    profile: overrides.profile ?? profile(),
    context,
    window: { from: '2026-01-01', to: '2026-01-30' },
    entity: entity(overrides.row === undefined ? { spend: 100, sales: 500, acos: 0.2 } : overrides.row),
    flags: overrides.flags ?? { asOf: '2026-01-30', active: [], suppressed: [] },
    pacing: overrides.pacing ?? { asOf: '2026-01-30', pacing: null },
    asOf: '2026-01-30',
    provisional: false,
  };
}

describe('analyzeProfile', () => {
  it('extracts figures from the profile-grain row', () => {
    const analysis = analyzeProfile(
      briefing({
        row: {
          impressions: 10_000,
          clicks: 300,
          spend: 450.5,
          sales: 1500,
          orders: 45,
          acos: 0.3003,
          ctr: 0.03,
          cvr: 0.15,
          spend_delta_percent: 12.5,
          sales_delta_percent: -4,
          acos_delta_percent: 17,
        },
      }),
    );

    expect(analysis.figures.hasData).toBe(true);
    expect(analysis.figures.totals.spend).toBe(450.5);
    expect(analysis.figures.totals.sales).toBe(1500);
    expect(analysis.figures.totals.acos).toBeCloseTo(0.3003, 4);
    expect(analysis.figures.deltaPercent.acos).toBe(17);
    // ACOS 30.03% is 5.03 points above the 25% target.
    expect(analysis.figures.acosVsTargetPoints).toBeCloseTo(5.03, 2);
  });

  it('flags ACOS above target and ranks the sharper finding first', () => {
    const analysis = analyzeProfile(
      briefing({
        row: { spend: 400, sales: 1000, acos: 0.4, acos_delta_percent: 3 },
      }),
    );
    const target = analysis.findings.find((f) => f.headline.includes('above target'));
    expect(target).toBeDefined();
    // 40% vs 25% target => 15 points over => alert.
    expect(target?.severity).toBe('alert');
    // Findings are severity-ranked; the alert precedes the info trend.
    expect(analysis.findings[0]?.severity).toBe('alert');
  });

  it('carries doctrine flags through as findings', () => {
    const analysis = analyzeProfile(
      briefing({
        flags: {
          asOf: '2026-01-30',
          active: [
            {
              severity: 'critical',
              metric: 'spend',
              message: 'spend with no sales',
              likelyCause: 'a broad target burning budget',
              scope: 'Dev | SP | Exact',
              suppressed: false,
              suppressedReason: null,
            },
          ],
          suppressed: [],
        },
      }),
    );
    expect(analysis.findings[0]?.severity).toBe('critical');
    expect(analysis.figures.flags.active).toBe(1);
    expect(analysis.title).toContain('critical');
  });

  it('reports over-pace pacing', () => {
    const analysis = analyzeProfile(
      briefing({
        pacing: {
          asOf: '2026-01-30',
          pacing: { status: 'over', pace: 1.3, monthToDateSpend: 2100, monthlyBudget: 3000 },
        },
      }),
    );
    expect(analysis.findings.some((f) => f.scope === 'pacing')).toBe(true);
    expect(analysis.figures.pacing.status).toBe('over');
  });

  it('handles a profile with no facts without inventing numbers', () => {
    const analysis = analyzeProfile(briefing({ row: null }));
    expect(analysis.figures.hasData).toBe(false);
    expect(analysis.figures.totals.spend).toBeNull();
    expect(analysis.findings).toHaveLength(1);
    expect(analysis.findings[0]?.headline).toBe('No facts loaded');
    expect(analysis.title).toContain('no data');
  });
});
