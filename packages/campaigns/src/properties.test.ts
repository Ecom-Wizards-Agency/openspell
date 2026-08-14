/**
 * Property tests: the four things that must hold for every plan, not just for
 * the eleven the goldens pin.
 *
 *   1. every name is a legal sentence in the naming grammar,
 *   2. no keyword appears twice with the same match type in one ad group,
 *   3. every bid sits inside the strategy's bounds,
 *   4. every campaign arrives paused.
 *
 * The generator is a seeded pseudo-random one rather than a property-testing
 * library, for the same reason the XLSX writer is hand-rolled: a package this
 * self-contained should not add a dependency to a lockfile seven other
 * packages are being built against. The seed is fixed, so a failure is
 * reproducible and a reviewer can rerun the exact case.
 *
 * The strategy numbers below are INVENTED for this test. No threshold from any
 * real strategy document is in this repository, and none ever may be.
 */
import { TENANT_STRATEGY_SCHEMA, type TenantStrategy } from '@wizard-ads/shared';
import { describe, expect, it } from 'vitest';

import { MAX_BID, MAX_CAMPAIGN_NAME, MIN_BID } from './constants.js';
import { specsFromRows, type CampaignBucket, type KeywordRow, type TargetRow } from './keywords.js';
import { EW_NAMING_PRESET, LEGACY_NAMING_PRESET } from './naming.js';
import { buildCampaignPlan, planToRows } from './plan.js';
import { preflight } from './preflight.js';
import { bucketOf, checkStructureCaps, specDefaultsForBucket } from './strategy.js';
import type { CampaignBuildConfig, CampaignSpec } from './types.js';
import { validateRows } from './validate.js';

/** A tiny deterministic PRNG (mulberry32). Fixed seed, reproducible failures. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['widget', 'gadget', 'holder', 'kitchen', 'office', 'travel', 'compact', 'refill'];

const BUCKETS: CampaignBucket[] = [
  'rank_skw', 'shield_skw', 'halo', 'discovery_phrase', 'shield_discovery_phrase',
];

/** Invented, not doctrine: this is a shape with plausible numbers in it. */
const STRATEGY: TenantStrategy = {
  schema: TENANT_STRATEGY_SCHEMA,
  pacing: {},
  opt_groups: {},
  rank_lifecycle: {},
  staged_apply: {},
  bids: {
    start_bid_pct_of_recommended: -30,
    by_bucket: {
      rank_skw: { daily_budget: 20, top_of_search_placement: 50 },
      halo: { daily_budget: 12 },
      discovery_phrase: { daily_budget: 8 },
    },
  },
  sv_bands: {},
  caps: { halo_keywords_per_campaign: 12, pat_asins_per_campaign: 20 },
  pat_split: {},
  naming: {},
  discovery: { min_root_words: 2 },
};

function randomKeyword(next: () => number): string {
  const length = 1 + Math.floor(next() * 3);
  const parts: string[] = [];
  for (let i = 0; i < length; i += 1) {
    parts.push(WORDS[Math.floor(next() * WORDS.length)] as string);
  }
  return parts.join(' ');
}

function randomConfig(seed: number): CampaignBuildConfig {
  const next = rng(seed);
  const keywordRows: KeywordRow[] = [];
  const seen = new Set<string>();
  const rowCount = 3 + Math.floor(next() * 12);
  for (let i = 0; i < rowCount; i += 1) {
    const bucket = BUCKETS[Math.floor(next() * BUCKETS.length)] as CampaignBucket;
    const text = randomKeyword(next);
    // One keyword belongs to one bucket. Research that puts the same term in
    // two of them is a contradiction upstream, and under the legacy naming
    // preset it produces two identically-named campaigns — which the QA gate
    // catches, and `catches a cross-bucket name collision` below proves.
    if (seen.has(text)) continue;
    seen.add(text);
    keywordRows.push({ text, bucket, searchVolume: Math.floor(next() * 5000) });
  }

  const targetRows: TargetRow[] = [];
  const targetCount = Math.floor(next() * 4);
  for (let i = 0; i < targetCount; i += 1) {
    targetRows.push({
      // An ASIN is exactly ten characters, so the digits are exactly eight.
      asin: `B0${String(10000000 + Math.floor(next() * 89999999))}`,
      bucket: next() < 0.5 ? 'pat_stronger' : 'pat_weaker',
    });
  }

  const specs: CampaignSpec[] = specsFromRows(keywordRows, targetRows, {
    productName: 'Widget',
    sku: ['SKU-1'],
  }).map((spec) => {
    const bucket = bucketOf(spec);
    return bucket === null ? spec : { ...spec, ...specDefaultsForBucket(STRATEGY, bucket) };
  });

  return {
    client: 'Property Test',
    marketplace: 'US',
    naming: next() < 0.5 ? EW_NAMING_PRESET : LEGACY_NAMING_PRESET,
    defaults: { dailyBudget: 10, keywordBid: 0.5, state: 'paused' },
    campaigns: specs,
  };
}

const TODAY = '2026-08-14';
const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);

describe('every generated plan holds its properties', () => {
  for (const seed of SEEDS) {
    const config = randomConfig(seed);
    const plan = buildCampaignPlan(config, { today: TODAY });

    it(`seed ${seed}: names are legal in the naming grammar`, () => {
      const delimiter = config.naming.delimiter;
      for (const campaign of plan.campaigns) {
        expect(campaign.name.length).toBeGreaterThan(0);
        expect(campaign.name.length).toBeLessThanOrEqual(MAX_CAMPAIGN_NAME);
        // A blank slot is dropped, never joined: no empty part, and no
        // delimiter left dangling at either end.
        expect(campaign.name.startsWith(delimiter)).toBe(false);
        expect(campaign.name.endsWith(delimiter)).toBe(false);
        const parts = campaign.name.split(delimiter);
        expect(parts.length).toBeLessThanOrEqual(config.naming.variableOrder.length);
        for (const part of parts) expect(part).not.toBe('');
        // The ad group name is the shorter form, so it can never be longer.
        expect(campaign.adGroup.name.length).toBeLessThanOrEqual(campaign.name.length);
      }
    });

    it(`seed ${seed}: campaign names are unique across the file`, () => {
      const names = plan.campaigns.map((campaign) => campaign.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it(`seed ${seed}: no duplicate keyword and match inside one ad group`, () => {
      for (const campaign of plan.campaigns) {
        const keys = campaign.adGroup.keywords.map((k) => `${k.text.toLowerCase()} ${k.matchType}`);
        expect(new Set(keys).size).toBe(keys.length);
      }
    });

    it(`seed ${seed}: every bid is inside Amazon's bounds`, () => {
      for (const campaign of plan.campaigns) {
        expect(campaign.adGroup.defaultBid).toBeGreaterThanOrEqual(MIN_BID);
        expect(campaign.adGroup.defaultBid).toBeLessThanOrEqual(MAX_BID);
        for (const keyword of campaign.adGroup.keywords) {
          expect(keyword.bid).toBeGreaterThanOrEqual(MIN_BID);
          expect(keyword.bid).toBeLessThanOrEqual(MAX_BID);
        }
        for (const target of campaign.adGroup.productTargets) {
          expect(target.bid).toBeGreaterThanOrEqual(MIN_BID);
          expect(target.bid).toBeLessThanOrEqual(MAX_BID);
        }
      }
    });

    it(`seed ${seed}: every campaign is paused`, () => {
      for (const campaign of plan.campaigns) expect(campaign.state).toBe('paused');
      for (const row of planToRows(plan)) {
        if (row.State !== '') expect(row.State).toBe('paused');
      }
    });

    it(`seed ${seed}: the structure caps hold`, () => {
      const failures = checkStructureCaps(config.campaigns, STRATEGY)
        .filter((finding) => finding.severity === 'fail');
      expect(failures).toEqual([]);
    });

    it(`seed ${seed}: the plan preflights and its rows pass the QA gates`, () => {
      const result = preflight(config, TODAY);
      expect(result.issues).toEqual([]);
      const gates = validateRows(planToRows(plan), TODAY);
      expect(gates.fails).toEqual([]);
    });

    it(`seed ${seed}: every campaign advertises something and targets something`, () => {
      for (const campaign of plan.campaigns) {
        expect(campaign.adGroup.productAds.length).toBeGreaterThan(0);
        const targets = campaign.adGroup.keywords.length + campaign.adGroup.productTargets.length;
        expect(targets).toBeGreaterThan(0);
      }
    });

    it(`seed ${seed}: the rows account for every planned entity`, () => {
      // Verify the artifact, not the exit code: count the rows the plan says
      // it should produce and compare, so a dropped entity is a failure rather
      // than a shorter file nobody notices.
      const expected = plan.campaigns.reduce((total, campaign) => total
        + 1
        + campaign.placements.length
        + 1
        + campaign.adGroup.productAds.length
        + campaign.adGroup.productTargets.length
        + campaign.adGroup.keywords.length
        + campaign.adGroup.negativeProductTargets.length
        + campaign.adGroup.negativeKeywords.length
        + campaign.negativeKeywords.length, 0);
      expect(planToRows(plan).length).toBe(expected);
    });
  }

  it('catches a cross-bucket name collision the legacy preset cannot express', () => {
    // The legacy preset has no trigger-word slot, so a rank keyword and the
    // same keyword defended as a shield produce the same campaign name. That
    // is a research contradiction rather than an engine bug, and the point of
    // this test is that it does not get uploaded: the gate fails the file.
    const config: CampaignBuildConfig = {
      client: 'Collision',
      marketplace: 'US',
      naming: LEGACY_NAMING_PRESET,
      defaults: { dailyBudget: 10, keywordBid: 0.5, state: 'paused' },
      campaigns: specsFromRows(
        [
          { text: 'widget holder', bucket: 'rank_skw' },
          { text: 'widget holder', bucket: 'shield_skw' },
        ],
        [],
        { productName: 'Widget', sku: ['SKU-1'] },
      ),
    };
    const rows = planToRows(buildCampaignPlan(config, { today: TODAY }));
    const gates = validateRows(rows, TODAY);
    expect(gates.pass).toBe(false);
    expect(gates.fails.some((message) => message.includes('duplicate campaign name'))).toBe(true);
  });

  it('the generated corpus is varied enough to be worth testing', () => {
    const types = new Set<string>();
    let campaigns = 0;
    for (const seed of SEEDS) {
      const plan = buildCampaignPlan(randomConfig(seed), { today: TODAY });
      campaigns += plan.campaigns.length;
      for (const campaign of plan.campaigns) types.add(campaign.campaignType);
    }
    expect(campaigns).toBeGreaterThan(200);
    expect([...types].sort()).toEqual(['Halo', 'PAT', 'Phrase', 'SKW']);
  });
});
