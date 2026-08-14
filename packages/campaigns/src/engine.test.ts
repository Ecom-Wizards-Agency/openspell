/**
 * Unit tests for the parts the parity goldens cannot reach: the pieces that
 * only exist in this port (the dropped campaign type, the strategy readers),
 * and the conversions whose Python behaviour is a footgun worth pinning.
 */
import { TENANT_STRATEGY_SCHEMA, type TenantStrategy } from '@wizard-ads/shared';
import { describe, expect, it } from 'vitest';

import { CAMPAIGN_TYPES } from './constants.js';
import { bulkFilename, summarizePlan, toBulkRows, toPlanJson } from './export.js';
import { sectionsFromRows, specsFromRows, type KeywordRow, type TargetRow } from './keywords.js';
import {
  EW_NAMING_PRESET,
  LEGACY_NAMING_PRESET,
  generateAdGroupName,
  generateCampaignName,
  resolveNaming,
  swapNameOrder,
} from './naming.js';
import { buildCampaignPlan, planToRows } from './plan.js';
import { preflight } from './preflight.js';
import {
  checkSearchVolumeBands,
  checkStructureCaps,
  formatDescriptor,
  namingFromStrategy,
  specDefaultsForBucket,
  splitPatTargets,
  startBid,
} from './strategy.js';
import type { CampaignBuildConfig } from './types.js';
import { formatStartDate, money, parseDateToExport, parseProductList, pyFloat } from './util.js';

const TODAY = '2026-08-14';

function baseConfig(overrides: Partial<CampaignBuildConfig> = {}): CampaignBuildConfig {
  return {
    client: 'Sample',
    marketplace: 'US',
    naming: LEGACY_NAMING_PRESET,
    defaults: { dailyBudget: 10, keywordBid: 0.5, state: 'paused' },
    campaigns: [
      {
        campaignType: 'Halo',
        productName: 'Widget',
        targetDescriptor: 'long-tail',
        sku: ['SKU-1'],
        keywords: ['widget for kitchen'],
      },
    ],
    ...overrides,
  };
}

/** A shape with invented numbers. No real threshold is in this repository. */
function strategy(overrides: Partial<TenantStrategy> = {}): TenantStrategy {
  return {
    schema: TENANT_STRATEGY_SCHEMA,
    pacing: {},
    opt_groups: {},
    rank_lifecycle: {},
    staged_apply: {},
    bids: {},
    sv_bands: {},
    caps: {},
    pat_split: {},
    naming: {},
    ...overrides,
  };
}

describe('money rounds the way the Python reference rounds', () => {
  it('breaks an exact half-cent to the even cent', () => {
    // Verified against CPython: round(0.125, 2) == 0.12, round(0.375, 2) == 0.38.
    expect(money(0.125)).toBe(0.12);
    expect(money(0.375)).toBe(0.38);
    expect(money(0.625)).toBe(0.62);
    expect(money(0.875)).toBe(0.88);
  });

  it('rounds a decimal that only looks like a tie by its true value', () => {
    // 8.475 is really 8.47499…, and 0.135 is really 0.13500…0888.
    expect(money(8.475)).toBe(8.47);
    expect(money(2.675)).toBe(2.67);
    expect(money(0.135)).toBe(0.14);
  });

  it('leaves an amount that is already cents alone', () => {
    for (const value of [0, 0.02, 0.5, 10, 1000, 12.34]) expect(money(value)).toBe(value);
  });
});

describe('the small conversions', () => {
  it('splits a product list on newlines and commas', () => {
    expect(parseProductList('SKU-1, SKU-2')).toEqual(['SKU-1', 'SKU-2']);
    expect(parseProductList('SKU-1\nSKU-2\n')).toEqual(['SKU-1', 'SKU-2']);
    expect(parseProductList(['SKU-1', ' SKU-2 ', ''])).toEqual(['SKU-1', 'SKU-2']);
    expect(parseProductList('')).toEqual([]);
    expect(parseProductList(undefined)).toEqual([]);
  });

  it('formats a start date and drops one it cannot read', () => {
    expect(formatStartDate('2099-01-15')).toBe('01/15/2099');
    expect(formatStartDate('')).toBe('');
    expect(formatStartDate('15/01/2099')).toBe('');
    expect(formatStartDate('2099-01')).toBe('');
  });

  it('exports a date from either spelling, and falls back to the day it is given', () => {
    expect(parseDateToExport('01/15/2099', TODAY)).toBe('20990115');
    expect(parseDateToExport('2099-01-15', TODAY)).toBe('20990115');
    expect(parseDateToExport('1/5/2099', TODAY)).toBe('20990105');
    expect(parseDateToExport('', TODAY)).toBe('20260814');
    expect(parseDateToExport('not a date', TODAY)).toBe('20260814');
  });

  it('renders a whole float the way Python prints one', () => {
    expect(pyFloat(1)).toBe('1.0');
    expect(pyFloat(1000)).toBe('1000.0');
    expect(pyFloat(0.02)).toBe('0.02');
  });
});

describe('the naming grammar', () => {
  const ctx = {
    goal: 'Rank',
    campaignType: 'SKW',
    matchType: 'EXACT',
    productName: 'Widget',
    targetDescriptor: 'red widget',
    keywordText: 'red widget',
    triggerWord: 'SKW',
    counter: 1,
  };

  it('drops a blank slot instead of joining it', () => {
    // `CampCounter` renders empty for a SKW campaign, and the name must not
    // carry a dangling delimiter where it would have been.
    const name = generateCampaignName(EW_NAMING_PRESET, ctx, TODAY);
    expect(name).toBe('Rank | SP | Exact | SKW | Widget | red widget | EW');
    expect(name).not.toContain('|  |');
  });

  it('keeps the campaign counter for Halo and Auto only', () => {
    const halo = generateCampaignName(EW_NAMING_PRESET, { ...ctx, campaignType: 'Halo' }, TODAY);
    expect(halo).toContain('01');
    expect(generateCampaignName(EW_NAMING_PRESET, ctx, TODAY)).not.toContain('01');
  });

  it('shortens the ad group name and never lengthens it', () => {
    const campaign = generateCampaignName(EW_NAMING_PRESET, ctx, TODAY);
    const adGroup = generateAdGroupName(EW_NAMING_PRESET, ctx, TODAY);
    expect(adGroup.length).toBeLessThan(campaign.length);
    expect(adGroup).not.toContain('Rank');
    expect(adGroup).not.toContain('EW');
  });

  it('swaps the product and descriptor slots, and leaves an order without both alone', () => {
    expect(swapNameOrder(LEGACY_NAMING_PRESET).variableOrder)
      .toEqual(['Goal', 'SP', 'MatchType', 'TargetDescriptor', 'ProductName', 'EW']);
    const noDescriptor = { ...LEGACY_NAMING_PRESET, variableOrder: ['Goal', 'ProductName'] };
    expect(swapNameOrder(noDescriptor).variableOrder).toEqual(['Goal', 'ProductName']);
  });

  it('defaults to the EW preset and lets an explicit order beat it', () => {
    expect(resolveNaming(undefined).variableOrder).toEqual(EW_NAMING_PRESET.variableOrder);
    expect(resolveNaming({ preset: 'legacy' }).variableOrder).toEqual(LEGACY_NAMING_PRESET.variableOrder);
    expect(resolveNaming({ preset: 'EW', variableOrder: ['Goal'] }).variableOrder).toEqual(['Goal']);
  });
});

describe('BMM is out of the generation matrix', () => {
  it('is not a campaign type this engine offers', () => {
    expect([...CAMPAIGN_TYPES]).toEqual(['SKW', 'Halo', 'Phrase', 'Auto', 'PAT']);
  });

  it('is refused with a message that says what to use instead', () => {
    const result = preflight(baseConfig({
      campaigns: [{ campaignType: 'BMM', productName: 'Widget', sku: ['SKU-1'], keywords: ['widget'] }],
    }), TODAY);
    expect(result.ready).toBe(false);
    expect(result.issues).toEqual([
      'campaign 1 (BMM): BMM generation was dropped on 2026-08-14 (operator decision); use Phrase for discovery',
    ]);
  });

  it('reports an unknown type against the five that remain', () => {
    const result = preflight(baseConfig({
      campaigns: [{ campaignType: 'SB', productName: 'Widget', sku: ['SKU-1'] }],
    }), TODAY);
    expect(result.issues).toEqual(['campaign 1 (SB): campaign_type must be one of SKW/Halo/Phrase/Auto/PAT']);
  });
});

describe('keyword buckets', () => {
  const keywordRows: KeywordRow[] = [
    { text: 'red widget', bucket: 'rank_skw', searchVolume: 2000 },
    { text: 'blue widget', bucket: 'rank_skw', searchVolume: 1500 },
    { text: 'widget for kitchen', bucket: 'halo', searchVolume: 300 },
    { text: 'widget for office', bucket: 'halo', searchVolume: 250 },
    { text: 'widget', bucket: 'discovery_phrase', searchVolume: 5000 },
  ];
  const targetRows: TargetRow[] = [
    { asin: 'b000000001', bucket: 'pat_stronger', brand: 'Rival One' },
    { asin: 'B000000002', bucket: 'pat_weaker', brand: 'Rival Two' },
  ];

  it('orders sections by bucket, not by the order rows arrived in', () => {
    const shuffled = [...keywordRows].reverse();
    expect(sectionsFromRows(shuffled).map((s) => s.campaignType))
      .toEqual(['SKW', 'Halo', 'Phrase']);
  });

  it('fans out one campaign per rank keyword and one for the whole halo list', () => {
    const specs = specsFromRows(keywordRows, targetRows, { productName: 'Widget', sku: ['SKU-1'] });
    const halo = specs.filter((spec) => spec.campaignType === 'Halo');
    expect(specs.filter((spec) => spec.campaignType === 'SKW')).toHaveLength(2);
    expect(halo).toHaveLength(1);
    expect(halo[0]?.keywords).toEqual(['widget for kitchen', 'widget for office']);
    expect(specs.filter((spec) => spec.campaignType === 'Phrase')).toHaveLength(1);
  });

  it('upper-cases every ASIN target, because the expression is case-sensitive', () => {
    const specs = specsFromRows([], targetRows, { productName: 'Widget', sku: ['SKU-1'] });
    expect(specs.map((spec) => spec.targetAsins)).toEqual([['B000000001'], ['B000000002']]);
  });

  it('produces no sections for an empty bucket', () => {
    expect(sectionsFromRows([], [])).toEqual([]);
  });
});

describe('the strategy readers', () => {
  it('takes the naming grammar off the tenant document', () => {
    const naming = namingFromStrategy(strategy({
      naming: { variable_order: ['Goal', 'ProductName'], delimiter: '_', suffix: 'ACME' },
    }));
    expect(naming.variableOrder).toEqual(['Goal', 'ProductName']);
    expect(naming.delimiter).toBe('_');
    expect(naming.suffix).toBe('ACME');
  });

  it('computes a launch bid off the recommendation, and declines without one', () => {
    const withRule = strategy({ bids: { start_bid_pct_of_recommended: -30 } });
    expect(startBid(withRule, 1.0)).toBe(0.7);
    expect(startBid(withRule, null)).toBeNull();
    expect(startBid(strategy(), 1.0)).toBeNull();
  });

  it('fills the descriptor template, and leaves an unknown placeholder visible', () => {
    expect(formatDescriptor('{keyword}', { keyword: 'red widget' })).toBe('red widget');
    expect(formatDescriptor('Brand {root}', { root: 'widget' })).toBe('Brand widget');
    expect(formatDescriptor('Stronger {counter}', { counter: 2 })).toBe('Stronger 2');
    expect(formatDescriptor('{unknown}', {})).toBe('{unknown}');
  });

  it('flags a keyword outside its search-volume band at the stated severity', () => {
    const bands = strategy({
      sv_bands: {
        rank_skw: { min: 500, max: 5000, severity_outside: 'fail' },
        halo: { max: 1000 },
      },
    });
    const findings = checkSearchVolumeBands([
      { text: 'too small', bucket: 'rank_skw', searchVolume: 100 },
      { text: 'just right', bucket: 'rank_skw', searchVolume: 2000 },
      { text: 'too big', bucket: 'rank_skw', searchVolume: 9000 },
      { text: 'not long tail', bucket: 'halo', searchVolume: 1000 },
      { text: 'no data', bucket: 'halo', searchVolume: null },
    ], bands);
    expect(findings.map((f) => [f.severity, f.message.split("'")[1]]))
      .toEqual([['fail', 'too small'], ['fail', 'too big'], ['warn', 'not long tail']]);
  });

  it('says nothing at all when the tenant has stated no bands', () => {
    expect(checkSearchVolumeBands([{ text: 'x', bucket: 'rank_skw', searchVolume: 1 }], strategy()))
      .toEqual([]);
  });

  it('fails a campaign over its structure cap and warns on a thin discovery root', () => {
    const capped = strategy({
      caps: { halo_keywords_per_campaign: 2, pat_asins_per_campaign: 1 },
      discovery: { min_root_words: 2 },
    });
    const findings = checkStructureCaps([
      { campaignType: 'Halo', targetDescriptor: 'long-tail', keywords: ['a', 'b', 'c'] },
      { campaignType: 'PAT', targetDescriptor: 'Stronger', targetAsins: ['B000000001', 'B000000002'] },
      { campaignType: 'Phrase', targetDescriptor: 'root', keywords: ['widget'] },
    ], capped);
    expect(findings.map((f) => f.severity)).toEqual(['fail', 'fail', 'warn']);
  });

  it('splits competitors on the median, and hands the decision back when asked to', () => {
    const targets: TargetRow[] = [
      { asin: 'B000000001', bucket: 'pat_weaker', revenue: 100 },
      { asin: 'B000000002', bucket: 'pat_weaker', revenue: 500 },
      { asin: 'B000000003', bucket: 'pat_weaker', revenue: 900 },
    ];
    const byMedian = splitPatTargets(targets, strategy({ pat_split: { method: 'median_revenue' } }));
    expect(byMedian.unresolved).toBeNull();
    expect(byMedian.targets.map((t) => t.bucket))
      .toEqual(['pat_weaker', 'pat_stronger', 'pat_stronger']);

    const byFloor = splitPatTargets(targets, strategy({
      pat_split: { method: 'revenue_floor', revenue_floor: 800 },
    }));
    expect(byFloor.targets.map((t) => t.bucket))
      .toEqual(['pat_weaker', 'pat_weaker', 'pat_stronger']);

    const byAgent = splitPatTargets(targets, strategy({ pat_split: { method: 'agent' } }));
    expect(byAgent.unresolved).toMatch(/operator decision/);
    expect(byAgent.targets.map((t) => t.bucket)).toEqual(['pat_weaker', 'pat_weaker', 'pat_weaker']);
  });

  it('leaves a target with no revenue where it was rather than guessing', () => {
    const result = splitPatTargets(
      [{ asin: 'B000000001', bucket: 'pat_stronger', revenue: null }],
      strategy({ pat_split: { method: 'revenue_floor', revenue_floor: 100 } }),
    );
    expect(result.targets[0]?.bucket).toBe('pat_stronger');
  });

  it('never revives a dropped campaign type from a stale document', () => {
    const stale = strategy({
      naming: { by_bucket: { discovery_phrase: { campaign_type: 'BMM', goal: 'Discovery' } } },
    });
    const defaults = specDefaultsForBucket(stale, 'discovery_phrase');
    expect(defaults.campaignType).toBeUndefined();
    expect(defaults.goal).toBe('Discovery');
  });
});

describe('the exports', () => {
  const plan = buildCampaignPlan(baseConfig(), { today: TODAY });

  it('names the file after the day, the client and the marketplace', () => {
    expect(bulkFilename(plan)).toBe('2026-08-14_sample_US_SP_bulk_campaigns.xlsx');
  });

  it('serializes a plan as JSON that parses back to the same plan', () => {
    const json = toPlanJson(plan);
    expect(json.endsWith('\n')).toBe(true);
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(plan)));
    expect(JSON.parse(json).schema).toBe('wizard-ads.campaign-plan.v1');
  });

  it('summarizes one line per campaign', () => {
    const lines = summarizePlan(plan);
    expect(lines).toHaveLength(plan.campaigns.length);
    expect(lines[0]).toContain('Halo · MANUAL · paused');
    expect(lines[0]).toContain('1 keyword(s)');
  });

  it('projects the same rows through both entry points', () => {
    expect(toBulkRows(plan)).toEqual(planToRows(plan));
  });
});
