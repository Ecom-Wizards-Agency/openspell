/**
 * The worker's Sponsored Products report-row parsing delegates every grain to
 * `@wizard-ads/ads-api`, then adds database provenance and profile aggregation.
 *
 * The regression these cover is not hypothetical: the worker's own strict
 * parser demanded a `targetId` column the `spTargeting` report has never sent
 * and match-type spellings Amazon does not use, so every non-empty targeting
 * and search-term report failed to load and both fact tables stayed empty.
 *
 * Every payload here is synthetic: ids are shaped like Amazon's, they are not
 * Amazon's.
 */
import { describe, expect, it } from 'vitest';
import type { AdsProfileContext } from './ads-api.js';
import { SKIP_FAILURE_RATIO, parseReportRows } from './parsers.js';

const orgId = '11111111-1111-4111-8111-111111111111';
const profileId = '22222222-2222-4222-8222-222222222222';
const reportRequestId = '33333333-3333-4333-8333-333333333333';

const profile: AdsProfileContext = {
  id: profileId,
  orgId,
  amazonProfileId: 'amazon-profile-1',
  region: 'NA',
  currencyCode: 'USD',
  timezone: 'America/Los_Angeles',
};

/** A `spTargeting` row as Amazon actually sends it: `keywordId`, no `targetId`. */
function targetingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    date: '2026-08-14',
    campaignId: 'c-1',
    adGroupId: 'ag-1',
    keywordId: 'kw-1',
    keyword: 'blue widget',
    keywordType: 'BROAD',
    matchType: 'EXACT',
    impressions: 120,
    clicks: 6,
    cost: 3.5,
    purchases1d: 0,
    purchases7d: 1,
    purchases14d: 1,
    purchases30d: 1,
    sales1d: 0,
    sales7d: 20,
    sales14d: 20,
    sales30d: 20,
    unitsSoldClicks7d: 1,
    ...overrides,
  };
}

function searchTermRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    date: '2026-08-14',
    campaignId: 'c-1',
    adGroupId: 'ag-1',
    keywordId: 'kw-1',
    searchTerm: 'blue widget large',
    matchType: 'PHRASE',
    impressions: 40,
    clicks: 2,
    cost: 1.25,
    purchases7d: 0,
    sales7d: 0,
    unitsSoldClicks7d: 0,
    ...overrides,
  };
}

function parseTargeting(rows: unknown[]) {
  return parseReportRows('spTargeting', rows, profile, reportRequestId);
}

describe('spTargeting delegation', () => {
  it('reads the identifier from keywordId, which is the only one the report sends', () => {
    const batch = parseTargeting([targetingRow()]);

    expect(batch.kind).toBe('sp_target');
    expect(batch.skipped).toEqual([]);
    expect(batch.rows).toHaveLength(1);
    expect(batch.rows[0]).toMatchObject({ targetId: 'kw-1', campaignId: 'c-1', adGroupId: 'ag-1' });
  });

  it('falls back to targetId when a payload carries that spelling instead', () => {
    const { keywordId: _dropped, ...withoutKeywordId } = targetingRow();
    const batch = parseTargeting([{ ...withoutKeywordId, targetId: 't-9' }]);

    expect(batch.rows[0]).toMatchObject({ targetId: 't-9' });
  });

  it.each([
    ['EXACT', 'exact'],
    ['BROAD', 'broad'],
    ['PHRASE', 'phrase'],
  ])('normalizes Amazon match type %s to %s', (amazon, canonical) => {
    const batch = parseTargeting([targetingRow({ matchType: amazon })]);

    expect(batch.rows[0]).toMatchObject({ matchType: canonical, targetKind: 'keyword' });
  });

  it('treats TARGETING_EXPRESSION as a product target, not a broken keyword', () => {
    const batch = parseTargeting([
      targetingRow({ matchType: 'TARGETING_EXPRESSION', keywordType: 'TARGETING_EXPRESSION' }),
    ]);

    expect(batch.skipped).toEqual([]);
    expect(batch.rows[0]).toMatchObject({ matchType: null, targetKind: 'target' });
  });

  it('refuses a row missing a keyed dimension and still accounts for every source row', () => {
    const { campaignId: _dropped, ...noCampaign } = targetingRow();
    const batch = parseTargeting([targetingRow(), noCampaign, targetingRow({ keywordId: 'kw-2' })]);

    expect(batch.rows).toHaveLength(2);
    expect(batch.skipped).toEqual([{ index: 1, reason: 'no campaignId' }]);
    expect(batch.sourceRows).toBe(batch.rows.length + batch.skipped.length);
  });

  it('stamps the tenant join onto every row', () => {
    const batch = parseTargeting([targetingRow(), targetingRow({ keywordId: 'kw-2' })]);

    for (const row of batch.rows) {
      expect(row).toMatchObject({ orgId, profileId, reportRequestId, adProduct: 'SP' });
    }
  });

  it('carries the metrics through, with a null share where none was reported', () => {
    const batch = parseTargeting([targetingRow()]);

    expect(batch.rows[0]).toMatchObject({
      date: '2026-08-14',
      impressions: 120,
      clicks: 6,
      cost: 3.5,
      purchases7d: 1,
      sales7d: 20,
      unitsSold7d: 1,
      topOfSearchImpressionShare: null,
    });
  });
});

describe('spSearchTerm delegation', () => {
  it('parses a keyword-attributed term', () => {
    const batch = parseReportRows('spSearchTerm', [searchTermRow()], profile, reportRequestId);

    expect(batch.kind).toBe('search_term');
    expect(batch.skipped).toEqual([]);
    expect(batch.rows[0]).toMatchObject({
      orgId,
      profileId,
      reportRequestId,
      targetId: 'kw-1',
      searchTerm: 'blue widget large',
      matchType: 'phrase',
    });
  });

  it('leaves targetId null when the report attributes a term to no named target', () => {
    const batch = parseReportRows(
      'spSearchTerm',
      [searchTermRow({ keywordId: null })],
      profile,
      reportRequestId,
    );

    expect(batch.rows).toHaveLength(1);
    expect(batch.rows[0]).toMatchObject({ targetId: null });
  });

  it('refuses a row with no search term and counts it', () => {
    const { searchTerm: _dropped, ...noTerm } = searchTermRow();
    const batch = parseReportRows('spSearchTerm', [searchTermRow(), noTerm], profile, reportRequestId);

    expect(batch.rows).toHaveLength(1);
    expect(batch.skipped).toEqual([{ index: 1, reason: 'no searchTerm' }]);
    expect(batch.sourceRows).toBe(2);
  });
});

describe('SP campaign and placement delegation', () => {
  it('still aggregates spCampaigns onto the profile grain, per date', () => {
    const rows = [
      { date: '2026-08-14', campaignId: 'c-1', impressions: 10, clicks: 2, cost: 1, purchases7d: 1, sales7d: 5, unitsSoldClicks7d: 1 },
      { date: '2026-08-14', campaignId: 'c-2', impressions: 20, clicks: 3, cost: 2, purchases7d: 0, sales7d: 0, unitsSoldClicks7d: 0 },
      { date: '2026-08-15', campaignId: 'c-1', impressions: 5, clicks: 1, cost: 0.5, purchases7d: 0, sales7d: 0, unitsSoldClicks7d: 0 },
    ];
    const batch = parseReportRows('spCampaigns', rows, profile, reportRequestId);

    expect(batch.kind).toBe('profile');
    expect(batch.sourceRows).toBe(3);
    expect(batch.skipped).toEqual([]);
    expect(batch.rows).toHaveLength(2);
    expect(batch.rows[0]).toMatchObject({ date: '2026-08-14', impressions: 30, clicks: 5, cost: 3 });
    expect(batch.rows[1]).toMatchObject({ date: '2026-08-15', impressions: 5 });
  });

  it('reports no skipped rows for spPlacement', () => {
    const batch = parseReportRows(
      'spPlacement',
      [{ date: '2026-08-14', campaignId: 'c-1', placementClassification: 'Top of Search on-Amazon', impressions: 1, clicks: 1, cost: 1, purchases7d: 0, sales7d: 0 }],
      profile,
      reportRequestId,
    );

    expect(batch.kind).toBe('placement');
    expect(batch.skipped).toEqual([]);
    expect(batch.rows[0]).toMatchObject({ placement: 'top_of_search' });
  });

  it.each(['spCampaigns', 'spPlacement'] as const)(
    'retains refusal indices for fail-closed %s replacement',
    (reportType) => {
      const batch = parseReportRows(
        reportType,
        [{ date: '2026-08-14', impressions: 1, clicks: 1, cost: 1 }],
        profile,
        reportRequestId,
      );

      expect(batch.sourceRows).toBe(1);
      expect(batch.rows).toEqual([]);
      expect(batch.skipped).toEqual([{ index: 0, reason: 'no campaignId' }]);
    },
  );

  it.each(['sbCampaigns', 'sdCampaigns'] as const)('reports no skipped rows for %s', (reportType) => {
    const batch = parseReportRows(
      reportType,
      [{ date: '2026-08-14', campaignId: 'c-1', adGroupId: null, impressions: 1, clicks: 1, cost: 1, purchases7d: 0, sales7d: 0, unitsSoldClicks7d: 0 }],
      profile,
      reportRequestId,
    );

    expect(batch.skipped).toEqual([]);
    expect(batch.rows).toHaveLength(1);
  });
});

describe('SKIP_FAILURE_RATIO', () => {
  it('is a fraction, not a percentage', () => {
    expect(SKIP_FAILURE_RATIO).toBeGreaterThan(0);
    expect(SKIP_FAILURE_RATIO).toBeLessThan(1);
  });
});
