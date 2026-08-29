import { describe, expect, it } from 'vitest';
import {
  createConfigFromGuide,
  defaultCreateGuide,
  defaultUpdateGuide,
  previewCreateNames,
  selectCreateRecipe,
  updateConfigFromGuide,
  validateCreateGuide,
  validateUpdateGuide,
} from './guided.js';

const TODAY = '2026-08-29';

describe('guided CREATE translation', () => {
  it('uses the campaign engine for recipe fan-out and live names', () => {
    const guide = {
      ...defaultCreateGuide('Synthetic profile', 'US'),
      productName: 'Widget',
      targetDescriptor: 'long-tail',
      sku: 'SKU-1',
      targets: 'synthetic keyword one\nsynthetic keyword two',
    };
    const config = createConfigFromGuide(guide);
    expect(config).toMatchObject({
      client: 'Synthetic profile',
      marketplace: 'US',
      defaults: { dailyBudget: 10, keywordBid: 0.5, state: 'paused' },
      campaigns: [{ campaignType: 'Halo', keywords: ['synthetic keyword one', 'synthetic keyword two'] }],
    });
    expect(validateCreateGuide(guide, TODAY)).toEqual([]);
    expect(previewCreateNames(guide, TODAY)).toEqual([
      'Profit | SP | Exact | Halo | Widget | long-tail | 01 | EW',
    ]);
  });

  it('changes the goal and input shape with the selected recipe', () => {
    const base = defaultCreateGuide('Synthetic profile', 'US');
    const pat = {
      ...selectCreateRecipe(base, 'PAT'),
      productName: 'Widget',
      targetDescriptor: 'competitors',
      sku: 'SKU-1',
      targets: 'B000000001',
    };
    expect(pat.goal).toBe('Discovery');
    expect(createConfigFromGuide(pat).campaigns[0]).toMatchObject({
      campaignType: 'PAT',
      targetAsins: ['B000000001'],
    });
    expect(validateCreateGuide(pat, TODAY)).toEqual([]);
  });

  it('surfaces friendly validation before the server preflight', () => {
    const guide = { ...defaultCreateGuide('Synthetic profile', 'US'), dailyBudget: '0' };
    expect(validateCreateGuide(guide, TODAY)).toEqual(expect.arrayContaining([
      expect.stringContaining('Daily budget'),
      expect.stringContaining('product_name'),
      expect.stringContaining('sku(s)'),
    ]));
  });
});

describe('guided UPDATE translation', () => {
  it('keeps sparse campaign changes and the two-switch end-date clear', () => {
    const guide = {
      ...defaultUpdateGuide(),
      campaignId: '1001',
      amount: '25',
      clearEndDate: true,
    };
    expect(validateUpdateGuide(guide)).toEqual([]);
    expect(updateConfigFromGuide(guide)).toEqual({
      allowEndDateClear: true,
      changes: {
        campaigns: [{
          campaignId: '1001',
          name: undefined,
          dailyBudget: 25,
          biddingStrategy: undefined,
          state: undefined,
          endDate: undefined,
          clearEndDate: true,
        }],
      },
    });
  });

  it('builds the immutable-keyword replacement input expected by the diff engine', () => {
    const guide = {
      ...defaultUpdateGuide(),
      recipe: 'replace-keyword' as const,
      entityId: '4001',
      text: 'replacement keyword',
      matchType: 'EXACT',
    };
    expect(validateUpdateGuide(guide)).toEqual([]);
    expect(updateConfigFromGuide(guide).changes).toEqual({
      keywords: {
        replace: [{
          oldKeywordId: '4001',
          newText: 'replacement keyword',
          newMatchType: 'EXACT',
          newBid: undefined,
          state: undefined,
        }],
      },
    });
  });

  it('rejects temp and cross-shape ids before requesting a diff', () => {
    expect(validateUpdateGuide({
      ...defaultUpdateGuide(),
      campaignId: 'new_1',
      amount: '25',
    })).toContain('Campaign ID must be a numeric Amazon ID from the synced profile.');
  });

  it('applies the engine bounds to guided budgets and bids', () => {
    expect(validateUpdateGuide({
      ...defaultUpdateGuide(), campaignId: '1001', amount: '0',
    })).toContain('Daily budget must be between 1 and 1000.');
    expect(validateUpdateGuide({
      ...defaultUpdateGuide(), recipe: 'ad-group', adGroupId: '2001', amount: '0',
    })).toContain('Bid must be between 0.02 and 1000.');
  });
});
