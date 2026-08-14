/**
 * The six report parsers.
 *
 * Each one is checked against the same two questions: does it produce the fact
 * shape the contract describes, and does it account for every row it was given.
 * The second question is the one that catches real bugs — a parser that quietly
 * drops the rows it does not understand looks identical to a light traffic day.
 */
import { describe, expect, it } from 'vitest';
import {
  mapPlacement,
  parseSbCampaignReport,
  parseSdCampaignReport,
  parseSpCampaignReport,
  parseSpPlacementReport,
  parseSpSearchTermReport,
  parseSpTargetingReport,
} from './parsers.js';
import {
  REPORT_SB,
  REPORT_SD,
  REPORT_SP_CAMPAIGNS,
  REPORT_SP_PLACEMENT,
  REPORT_SP_SEARCH_TERM,
  REPORT_SP_TARGETING,
} from './__fixtures__/payloads.js';

describe('spTargeting to the target-grain fact', () => {
  const parsed = parseSpTargetingReport(REPORT_SP_TARGETING);

  it('accounts for every input row', () => {
    expect(parsed.input).toBe(REPORT_SP_TARGETING.length);
    expect(parsed.rows.length + parsed.skipped.length).toBe(parsed.input);
  });

  it('maps a keyword row into every attribution window', () => {
    expect(parsed.rows[0]).toEqual({
      date: '2026-08-10',
      adProduct: 'SP',
      campaignId: '100000000000001',
      adGroupId: '200000000000001',
      targetId: '300000000000001',
      targetKind: 'keyword',
      matchType: 'exact',
      impressions: 1200,
      clicks: 30,
      cost: 24.5,
      purchases1d: 1,
      purchases7d: 3,
      purchases14d: 4,
      purchases30d: 4,
      sales1d: 25,
      sales7d: 75,
      sales14d: 100,
      sales30d: 100,
      unitsSold7d: 3,
      topOfSearchImpressionShare: null,
    });
  });

  it('calls a product target a target, and leaves its match type null', () => {
    // `keywordId` is the identifier for both kinds; only the match type separates them.
    expect(parsed.rows[2]).toMatchObject({
      targetId: '400000000000001',
      targetKind: 'target',
      matchType: null,
    });
  });

  it('refuses a summary-shaped row instead of dating it from startDate', () => {
    expect(parsed.skipped).toEqual([{ index: 3, reason: 'no daily date column' }]);
  });

  it('treats an absent metric as zero, because Amazon omits zero rows entirely', () => {
    expect(parsed.rows[1]).toMatchObject({ purchases1d: 0, sales30d: 0, unitsSold7d: 0 });
  });
});

describe('spSearchTerm to the search-term fact', () => {
  const parsed = parseSpSearchTermReport(REPORT_SP_SEARCH_TERM);

  it('accounts for every input row', () => {
    expect(parsed.rows.length + parsed.skipped.length).toBe(parsed.input);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.skipped[0]?.reason).toBe('no searchTerm');
  });

  it('keeps a null target id rather than inventing a join key', () => {
    expect(parsed.rows[0]?.targetId).toBe('300000000000001');
    expect(parsed.rows[1]?.targetId).toBeNull();
    expect(parsed.rows[1]?.matchType).toBeNull();
  });

  it('carries the customer query verbatim', () => {
    expect(parsed.rows[1]?.searchTerm).toBe('unbranded placeholder thing');
  });
});

describe('placement grouping', () => {
  const parsed = parseSpPlacementReport(REPORT_SP_PLACEMENT);

  it('accounts for every input row', () => {
    expect(parsed.rows.length + parsed.skipped.length).toBe(parsed.input);
    expect(parsed.skipped).toHaveLength(0);
  });

  it('maps Amazon’s placement names onto the contract vocabulary', () => {
    expect(parsed.rows.map((row) => row.placement)).toEqual([
      'top_of_search',
      'product_pages',
      'rest_of_search',
      'off_amazon',
      'other',
    ]);
  });

  it('keeps off-Amazon separate, because that is the leakage seam', () => {
    const offAmazon = parsed.rows.find((row) => row.placement === 'off_amazon');
    expect(offAmazon).toMatchObject({ campaignId: '100000000000002', impressions: 5000, cost: 12 });
  });

  it('files an unrecognised classification under other rather than dropping the spend', () => {
    expect(mapPlacement('Something Amazon Added')).toBe('other');
    expect(mapPlacement(null)).toBeNull();
  });
});

describe('spCampaigns at campaign grain', () => {
  const parsed = parseSpCampaignReport(REPORT_SP_CAMPAIGNS);

  it('accounts for every input row', () => {
    expect(parsed.rows.length + parsed.skipped.length).toBe(parsed.input);
    expect(parsed.rows).toHaveLength(2);
  });

  it('normalises a percentage impression share into the contract’s fraction', () => {
    expect(parsed.rows[0]?.topOfSearchImpressionShare).toBeCloseTo(0.284, 6);
    expect(parsed.rows[1]?.topOfSearchImpressionShare).toBeNull();
  });

  it('keeps the budget context the pacing widget needs', () => {
    expect(parsed.rows[0]).toMatchObject({
      budgetAmount: 42.5,
      budgetType: 'DAILY',
      currencyCode: 'USD',
      campaignName: 'Placeholder SP Exact',
    });
  });
});

describe('Sponsored Brands', () => {
  const parsed = parseSbCampaignReport(REPORT_SB);

  it('accounts for every input row', () => {
    expect(parsed.rows.length + parsed.skipped.length).toBe(parsed.input);
    expect(parsed.skipped).toEqual([{ index: 1, reason: 'no daily date column' }]);
  });

  it('labels the single attribution window instead of renaming it to 7d', () => {
    expect(parsed.rows[0]).toMatchObject({
      purchases: 4,
      sales: 220,
      unitsSold: 5,
      attributionWindowDays: 14,
      newToBrandPurchases: 3,
      newToBrandSales: 165,
    });
  });

  it('carries the video and viewability columns no other grain has', () => {
    expect(parsed.rows[0]?.metrics).toEqual({
      videoFirstQuartileViews: 2200,
      videoCompleteViews: 900,
      viewableImpressions: 4100,
    });
  });
});

describe('Sponsored Display', () => {
  const parsed = parseSdCampaignReport(REPORT_SD);

  it('accounts for every input row', () => {
    expect(parsed.rows.length + parsed.skipped.length).toBe(parsed.input);
  });

  it('keeps its own extras out of the typed columns', () => {
    expect(parsed.rows[0]).toMatchObject({ purchases: 6, sales: 180, attributionWindowDays: 14 });
    expect(parsed.rows[0]?.metrics).toEqual({ addToCart: 30, detailPageViews: 210 });
  });
});

describe('rows that are not rows', () => {
  it('are refused by every parser rather than crashing it', () => {
    const junk = [null, 'row', 42, []];
    for (const parse of [
      parseSpTargetingReport,
      parseSpSearchTermReport,
      parseSpPlacementReport,
      parseSpCampaignReport,
      parseSbCampaignReport,
      parseSdCampaignReport,
    ]) {
      const parsed = parse(junk);
      expect(parsed.rows).toHaveLength(0);
      expect(parsed.skipped).toHaveLength(4);
      expect(parsed.input).toBe(4);
    }
  });
});
