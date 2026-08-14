import { describe, expect, it } from 'vitest';
import { analyzeProfile } from './analyze.js';
import type { Briefing } from './analyze.js';
import { renderDigest } from './digest.js';
import type { EntityDataPayload, McpProfile } from './mcp-client.js';

const profile: McpProfile = {
  id: 'p-1',
  amazonProfileId: 'dev-3001',
  countryCode: 'JP',
  currencyCode: 'JPY',
  timezone: 'Asia/Tokyo',
  accountName: 'Dev JP',
  syncEnabled: true,
  targetAcos: 0.25,
  goalLens: 'profit',
  monthlyBudget: null,
};

function entity(row: Record<string, number> | null): EntityDataPayload {
  return {
    entity: 'profile',
    window: { from: '2026-01-01', to: '2026-01-30' },
    comparisonWindow: null,
    columns: [],
    rowCount: row ? 1 : 0,
    rows: row ? [row] : [],
    freshness: { latestFactDate: '2026-01-30', provisional: false, note: 'loaded' },
  };
}

function briefing(row: Record<string, number> | null): Briefing {
  return {
    profile,
    context: {
      strategySummary: { present: false, scope: null, sections: [], refreshedAt: null },
      counts: { campaigns: 0, adGroups: 0, keywords: 0, targets: 0 },
      recentChanges: [],
    },
    window: { from: '2026-01-01', to: '2026-01-30' },
    entity: entity(row),
    flags: { asOf: '2026-01-30', active: [], suppressed: [] },
    pacing: { asOf: '2026-01-30', pacing: null },
    asOf: '2026-01-30',
    provisional: false,
  };
}

describe('renderDigest', () => {
  it('renders a well-formed digest with the profile currency and deltas', () => {
    const analysis = analyzeProfile(briefing({ spend: 450, sales: 1500, acos: 0.3, spend_delta_percent: 12.5 }));
    const md = renderDigest(analysis, profile.currencyCode);

    expect(md).toContain('### Dev JP — 2026-01-30');
    expect(md).toContain('JPY 450');
    expect(md).toContain('(+12.5%)');
    expect(md).toContain('**Findings**');
    // Currency is the profile's own, never a hardcoded dollar.
    expect(md).not.toContain('USD');
  });

  it('states plainly when there is no data', () => {
    const md = renderDigest(analyzeProfile(briefing(null)), profile.currencyCode);
    expect(md).toContain('No facts are loaded');
    expect(md).not.toContain('**Findings**');
  });
});
