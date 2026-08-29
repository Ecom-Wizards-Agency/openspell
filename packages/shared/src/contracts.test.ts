/**
 * Contract round-trip suite.
 *
 * Every exported contract gets one sample that must survive
 * `parse(JSON.parse(JSON.stringify(sample)))` unchanged. That is a low bar on
 * purpose: it catches the two failures that actually happen in a monorepo
 * frozen this early, a schema that cannot represent its own documented shape,
 * and a schema that quietly drops a field on the way through.
 *
 * Every value below is synthetic. No doctrine threshold, no client, no real
 * profile id appears here or anywhere else in this repo.
 */
import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';

import {
  AdProduct,
  ApplyRow,
  ApplyRowWire,
  BidBoundUnit,
  CvrSourceLevel,
  DailyFact,
  EntityRef,
  EntityRow,
  EntityState,
  EntityType,
  JobPayload,
  MatchType,
  Placement,
  PlacementFact,
  ProfileFact,
  Recommendation,
  RecommendationReason,
  RecommendationStatus,
  Region,
  ReportType,
  WorkerReportType,
  SearchTermFact,
  TENANT_STRATEGY_SCHEMA,
  TenantStrategy,
  fromApplyRowWire,
  serializeApplyRows,
  toApplyRowWire,
} from './index.js';

const PROFILE_ID = '00000000-0000-4000-8000-000000000001';
const RUN_ID = '00000000-0000-4000-8000-000000000002';
const ORG_ID = '00000000-0000-4000-8000-000000000003';
const REQUEST_ID = '00000000-0000-4000-8000-000000000004';

/** JSON round-trip: what a queue, an API response or a jsonb column would do. */
function roundTrip<T>(schema: ZodType<T>, sample: unknown): T {
  const parsed = schema.parse(sample);
  const again = schema.parse(JSON.parse(JSON.stringify(parsed)));
  expect(again).toEqual(parsed);
  return again;
}

describe('enums', () => {
  it('cover the documented vocabularies', () => {
    expect(Region.options).toEqual(['NA', 'EU', 'FE']);
    expect(AdProduct.options).toEqual(['SP', 'SB', 'SD']);
    expect(EntityState.options).toEqual(['enabled', 'paused', 'archived']);
    expect(EntityType.options).toContain('ad_group');
    expect(MatchType.options).toContain('exact');
    expect(Placement.options).toContain('off_amazon');
    expect(RecommendationReason.options).toEqual([
      'high_acos',
      'high_spend_no_sales',
      'low_acos',
      'low_visibility',
      'flag',
      'pacing',
    ]);
    expect(CvrSourceLevel.options).toEqual(['keyword', 'ad_group', 'campaign', 'profile']);
    expect(RecommendationStatus.options).toContain('proposed');
    expect(ReportType.options).toContain('spSearchTerm');
    expect(ReportType.options).not.toContain('sbAds');
    expect(WorkerReportType.options).toContain('sbAds');
  });

  it('rejects a value outside the vocabulary', () => {
    expect(Region.safeParse('LATAM').success).toBe(false);
    expect(AdProduct.safeParse('sp').success).toBe(false);
  });
});

describe('EntityRow', () => {
  const base = {
    profileId: PROFILE_ID,
    adProduct: 'SP',
    name: 'synthetic',
    state: 'enabled',
  };

  it('round-trips every variant', () => {
    const variants: unknown[] = [
      {
        ...base,
        entityType: 'portfolio',
        amazonId: 'p-1',
        budgetAmount: null,
        budgetPolicy: null,
      },
      {
        ...base,
        entityType: 'campaign',
        amazonId: 'c-1',
        portfolioId: null,
        budgetAmount: 1,
        budgetType: 'daily',
        targetingType: 'manual',
        biddingStrategy: 'manual',
        placementBidding: { topOfSearch: 0, productPages: 0, restOfSearch: 0 },
        startDate: '2026-01-01',
        endDate: null,
      },
      { ...base, entityType: 'ad_group', amazonId: 'g-1', campaignId: 'c-1', defaultBid: 1 },
      {
        ...base,
        entityType: 'product_ad',
        amazonId: 'a-1',
        campaignId: 'c-1',
        adGroupId: 'g-1',
        asin: 'B000000000',
        sku: 'SKU-1',
      },
      {
        ...base,
        entityType: 'keyword',
        amazonId: 'k-1',
        campaignId: 'c-1',
        adGroupId: 'g-1',
        keywordText: 'synthetic term',
        matchType: 'exact',
        bid: 1,
      },
      {
        ...base,
        entityType: 'target',
        amazonId: 't-1',
        campaignId: 'c-1',
        adGroupId: 'g-1',
        expression: [{ type: 'asin_same_as', value: 'B000000000' }],
        resolvedExpression: 'asin="B000000000"',
        bid: 1,
      },
      {
        ...base,
        entityType: 'negative',
        amazonId: 'n-1',
        campaignId: 'c-1',
        adGroupId: null,
        scope: 'campaign',
        keywordText: 'synthetic term',
        expression: null,
        matchType: 'negative_exact',
      },
    ];

    const seen = variants.map((v) => roundTrip(EntityRow, v).entityType);
    expect(new Set(seen).size).toBe(EntityType.options.length);
  });

  it('discriminates: a keyword row without keywordText is not a keyword row', () => {
    const bad = { ...base, entityType: 'keyword', amazonId: 'k-2', campaignId: 'c-1' };
    expect(EntityRow.safeParse(bad).success).toBe(false);
  });
});

describe('facts', () => {
  it('round-trips the target grain, including the optional TOS share', () => {
    const fact = roundTrip(DailyFact, {
      profileId: PROFILE_ID,
      date: '2026-08-01',
      adProduct: 'SP',
      campaignId: 'c-1',
      adGroupId: 'g-1',
      targetId: 'k-1',
      targetKind: 'keyword',
      matchType: 'exact',
      impressions: 10,
      clicks: 2,
      cost: 1.5,
      purchases1d: 0,
      purchases7d: 1,
      purchases14d: 1,
      purchases30d: 1,
      sales1d: 0,
      sales7d: 20,
      sales14d: 20,
      sales30d: 20,
      unitsSold7d: 1,
      topOfSearchImpressionShare: 0.5,
    });
    expect(fact.topOfSearchImpressionShare).toBe(0.5);

    const { topOfSearchImpressionShare: _omitted, ...withoutShare } = fact;
    expect(DailyFact.safeParse(withoutShare).success).toBe(true);
  });

  it('rejects a malformed date and a negative metric', () => {
    const ok = {
      profileId: PROFILE_ID,
      date: '2026-08-01',
      impressions: 1,
      clicks: 0,
      cost: 0,
      currencyCode: 'EUR',
      purchases7d: 0,
      sales7d: 0,
      unitsSold7d: 0,
      provisional: false,
    };
    roundTrip(ProfileFact, ok);
    expect(ProfileFact.safeParse({ ...ok, date: '01.08.2026' }).success).toBe(false);
    expect(ProfileFact.safeParse({ ...ok, clicks: -1 }).success).toBe(false);
    expect(ProfileFact.safeParse({ ...ok, currencyCode: 'eur' }).success).toBe(false);
  });

  it('round-trips search-term and placement grains', () => {
    roundTrip(SearchTermFact, {
      profileId: PROFILE_ID,
      date: '2026-08-01',
      adProduct: 'SP',
      campaignId: 'c-1',
      adGroupId: 'g-1',
      targetId: 'k-1',
      searchTerm: 'synthetic term',
      matchType: 'broad',
      impressions: 5,
      clicks: 1,
      cost: 0.5,
      purchases7d: 0,
      sales7d: 0,
      unitsSold7d: 0,
    });

    roundTrip(PlacementFact, {
      profileId: PROFILE_ID,
      date: '2026-08-01',
      adProduct: 'SP',
      campaignId: 'c-1',
      placement: 'off_amazon',
      impressions: 5,
      clicks: 1,
      cost: 0.5,
      purchases7d: 0,
      sales7d: 0,
    });
  });
});

describe('Recommendation', () => {
  it('round-trips with full inputs provenance', () => {
    const rec = roundTrip(Recommendation, {
      runId: RUN_ID,
      profileId: PROFILE_ID,
      reason: 'high_acos',
      entityRef: {
        profileId: PROFILE_ID,
        entityType: 'keyword',
        entityId: 'k-1',
        adProduct: 'SP',
        campaignId: 'c-1',
        adGroupId: 'g-1',
        name: 'synthetic term',
      },
      field: 'bid',
      currentValue: 2,
      proposedValue: 1,
      inputs: {
        rpc: 4,
        clicks: 30,
        cvrSourceLevel: 'ad_group',
        ceilingApplied: null,
        capClamped: true,
        window: { start: '2026-07-01', end: '2026-07-30' },
      },
      status: 'proposed',
    });
    expect(rec.inputs.cvrSourceLevel).toBe('ad_group');
    expect(rec.inputs.capClamped).toBe(true);
  });

  it('requires provenance: a recommendation without inputs does not parse', () => {
    expect(
      Recommendation.safeParse({
        runId: RUN_ID,
        profileId: PROFILE_ID,
        reason: 'low_acos',
        entityRef: { profileId: PROFILE_ID, entityType: 'keyword', entityId: 'k-1' },
        field: 'bid',
        currentValue: 1,
        proposedValue: 2,
        status: 'proposed',
      }).success,
    ).toBe(false);
  });

  it('EntityRef round-trips on its own', () => {
    roundTrip(EntityRef, {
      profileId: PROFILE_ID,
      entityType: 'campaign',
      entityId: 'c-1',
    });
  });
});

describe('ApplyRow', () => {
  const row = {
    entityType: 'keyword',
    entityId: 'k-1',
    field: 'bid',
    old: 1.25,
    new: 1,
    name: 'synthetic term',
  } as const;

  it('round-trips and converts to and from the wire shape', () => {
    const parsed = roundTrip(ApplyRow, row);
    const wire = roundTrip(ApplyRowWire, toApplyRowWire(parsed));
    expect(wire.entity_type).toBe('keyword');
    expect(fromApplyRowWire(wire)).toEqual(parsed);
  });

  /**
   * The bytes are the contract. batches.py's documented row shape is
   * `{"entity_type", "entity_id", "field", "old", "new", "name"}` written with
   * `json.dumps(indent=2)` plus a trailing newline. If this literal ever needs
   * editing, the export bridge has broken and the Python side will reject the
   * file with "row N missing keys".
   */
  it('serializes byte-identically to what batches.py reads', () => {
    const expected = [
      '[',
      '  {',
      '    "entity_type": "keyword",',
      '    "entity_id": "k-1",',
      '    "field": "bid",',
      '    "old": 1.25,',
      '    "new": 1,',
      '    "name": "synthetic term"',
      '  },',
      '  {',
      '    "entity_type": "campaign",',
      '    "entity_id": "c-1",',
      '    "field": "budget",',
      '    "old": 10,',
      '    "new": 12,',
      '    "clicks": 30,',
      '    "revenue": 120',
      '  }',
      ']',
      '',
    ].join('\n');

    const rows = [
      ApplyRow.parse(row),
      ApplyRow.parse({
        entityType: 'campaign',
        entityId: 'c-1',
        field: 'budget',
        old: 10,
        new: 12,
        clicks: 30,
        revenue: 120,
      }),
    ];
    expect(serializeApplyRows(rows)).toBe(expected);
  });

  it('rejects an entity type batches.py does not know', () => {
    expect(ApplyRow.safeParse({ ...row, entityType: 'portfolio' }).success).toBe(false);
  });
});

describe('TenantStrategy', () => {
  /** Structure only. Every number here is a placeholder, not doctrine. */
  const synthetic = {
    schema: TENANT_STRATEGY_SCHEMA,
    refreshed_at: '2026-01-01',
    pacing: { cut_order: ['waste', 'discovery', 'profit', 'rank'], monthly_budget: null },
    opt_groups: { 'synthetic-group': { target_acos: 1, max_increase: 1, max_decrease: 1 } },
    rank_lifecycle: { source: 'rank_radar' },
    staged_apply: { cooldown_days: 1, levers: ['other'] },
    bids: { by_bucket: { synthetic_bucket: { daily_budget: 1 } } },
    sv_bands: { rank_skw: { severity_outside: 'warn' } },
    caps: {},
    pat_split: { method: 'agent', revenue_floor: null },
    naming: { delimiter: ' | ', by_bucket: { synthetic_bucket: { goal: 'Rank' } } },
  };

  /**
   * The WP-00.1 widening, on top of the same document.
   *
   * Kept as a separate object rather than folded into `synthetic` so the test
   * above keeps proving the thing the widening promised: a document written
   * against the original contract, with none of these keys, still parses.
   */
  const widened = {
    ...synthetic,
    pacing: {
      ...synthetic.pacing,
      run_rate_tolerance: 1,
      warn_above: 1,
      act_above: 1,
      underpace_below: 1,
      rank_cut_requires_operator: true,
      lookback_days: 1,
    },
    opt_groups: {
      'synthetic-group': {
        ...synthetic.opt_groups['synthetic-group'],
        max_increase_steady: 1,
        preset: 'synthetic-preset',
        bid_floor_unit: 'absolute',
        bid_floor_value: 1,
        bid_ceiling_unit: 'times_cpc',
        bid_ceiling_value: 1,
        placement_max_increase: 1,
        placement_max_decrease: 1,
        spend_share_max: 1,
        tacos_x_breakeven: 1,
        tacos_x_breakeven_min: 1,
        tacos_x_breakeven_max: 1,
      },
      'other-group': { bid_ceiling_unit: 'pct_of_recommended', bid_ceiling_value: 1 },
    },
    rank_lifecycle: {
      ...synthetic.rank_lifecycle,
      dwell_days: 1,
      graduate_weeks_stable: 1,
      stepdown_cycles_min: 1,
      stepdown_cycles_max: 1,
      regression_reescalate: 'synthetic-stage',
    },
    staged_apply: {
      ...synthetic.staged_apply,
      max_batches_per_run: 1,
      cooldown_bypasses: ['other'],
      tag_format: 'synthetic-{run}',
      push_rank_min_days: 1,
      priority_order: ['other'],
      group_cadence: { 'synthetic-group': 'synthetic-cadence' },
      batch_unit: 'rows',
    },
    discovery: { min_root_words: 1 },
    expanded_candidate_filter: { min_relevancy: 1, max_sv: 1 },
    recommendation_evidence: {
      synchronizationTolerance: 1,
      minimumMatchedPairs: 1,
      minimumCombinedIncrementalVolume: 1,
      minimumAbsoluteLift: 1,
      minimumRelativeLift: 1,
    },
  };

  it('round-trips the shape', () => {
    const parsed = roundTrip(TenantStrategy, synthetic);
    expect(parsed.schema).toBe(TENANT_STRATEGY_SCHEMA);
    expect(parsed.opt_groups['synthetic-group']?.target_acos).toBe(1);
  });

  it('round-trips every field the WP-00.1 widening added', () => {
    const parsed = roundTrip(TenantStrategy, widened);

    // Each assertion below names a leaf that had no contract home before WP-00.1.
    expect(parsed.pacing.warn_above).toBe(1);
    expect(parsed.pacing.act_above).toBe(1);
    expect(parsed.pacing.underpace_below).toBe(1);
    expect(parsed.pacing.rank_cut_requires_operator).toBe(true);
    expect(parsed.pacing.run_rate_tolerance).toBe(1);

    const group = parsed.opt_groups['synthetic-group'];
    expect(group?.bid_floor_unit).toBe('absolute');
    expect(group?.bid_floor_value).toBe(1);
    expect(group?.bid_ceiling_unit).toBe('times_cpc');
    expect(group?.bid_ceiling_value).toBe(1);
    expect(group?.placement_max_increase).toBe(1);
    expect(group?.placement_max_decrease).toBe(1);
    expect(group?.spend_share_max).toBe(1);
    expect(group?.preset).toBe('synthetic-preset');
    expect(group?.max_increase_steady).toBe(1);
    expect(group?.tacos_x_breakeven).toBe(1);
    expect(group?.tacos_x_breakeven_min).toBe(1);
    expect(group?.tacos_x_breakeven_max).toBe(1);
    expect(parsed.opt_groups['other-group']?.bid_ceiling_unit).toBe('pct_of_recommended');

    expect(parsed.rank_lifecycle.dwell_days).toBe(1);
    expect(parsed.rank_lifecycle.graduate_weeks_stable).toBe(1);
    expect(parsed.rank_lifecycle.stepdown_cycles_min).toBe(1);
    expect(parsed.rank_lifecycle.stepdown_cycles_max).toBe(1);
    expect(parsed.rank_lifecycle.regression_reescalate).toBe('synthetic-stage');

    expect(parsed.staged_apply.max_batches_per_run).toBe(1);
    expect(parsed.staged_apply.cooldown_bypasses).toEqual(['other']);
    expect(parsed.staged_apply.tag_format).toBe('synthetic-{run}');
    expect(parsed.staged_apply.push_rank_min_days).toBe(1);
    expect(parsed.staged_apply.priority_order).toEqual(['other']);
    expect(parsed.staged_apply.group_cadence).toEqual({ 'synthetic-group': 'synthetic-cadence' });
    expect(parsed.staged_apply.batch_unit).toBe('rows');

    expect(parsed.discovery?.min_root_words).toBe(1);
    expect(parsed.expanded_candidate_filter?.min_relevancy).toBe(1);
    expect(parsed.expanded_candidate_filter?.max_sv).toBe(1);
    expect(parsed.recommendation_evidence).toEqual(widened.recommendation_evidence);
  });

  it('requires every recommendation evidence gate and supplies no defaults', () => {
    expect(TenantStrategy.parse(synthetic).recommendation_evidence).toBeUndefined();
    expect(TenantStrategy.safeParse({
      ...synthetic,
      recommendation_evidence: {
        synchronizationTolerance: 1,
        minimumMatchedPairs: 0,
        minimumCombinedIncrementalVolume: 1,
        minimumAbsoluteLift: 1,
        minimumRelativeLift: 1,
      },
    }).success).toBe(false);
  });

  it('keeps the bid-bound unit a closed vocabulary', () => {
    expect(BidBoundUnit.options).toEqual(['absolute', 'pct_of_recommended', 'times_cpc']);
    // Casing is the seeder's job to normalize, not a second spelling of a token.
    const group = { ...widened.opt_groups['synthetic-group'], bid_ceiling_unit: 'TIMES_CPC' };
    expect(
      TenantStrategy.safeParse({ ...widened, opt_groups: { 'synthetic-group': group } }).success,
    ).toBe(false);
  });

  it('rejects a document that is not this schema version', () => {
    expect(TenantStrategy.safeParse({ ...synthetic, schema: 'something-else' }).success).toBe(
      false,
    );
  });
});

describe('JobPayload', () => {
  it('round-trips every member of the union', () => {
    const jobs: unknown[] = [
      { orgId: ORG_ID, profileId: PROFILE_ID, type: 'entity.sync', full: false },
      {
        orgId: ORG_ID,
        profileId: PROFILE_ID,
        type: 'report.request',
        reportType: 'spCampaigns',
        startDate: '2026-07-01',
        endDate: '2026-07-31',
      },
      {
        orgId: ORG_ID,
        profileId: PROFILE_ID,
        type: 'report.poll',
        reportRequestId: REQUEST_ID,
        amazonReportId: 'amzn-report-1',
        attempt: 3,
      },
      {
        orgId: ORG_ID,
        profileId: PROFILE_ID,
        type: 'report.fetch',
        reportRequestId: REQUEST_ID,
        amazonReportId: 'amzn-report-1',
        downloadUrl: 'https://example.invalid/report.json.gz',
      },
      {
        orgId: ORG_ID,
        profileId: PROFILE_ID,
        type: 'crosscheck.ingest',
        date: '2026-07-31',
        sourcePath: 'crosscheck/2026-07-31.csv',
      },
      {
        orgId: ORG_ID,
        profileId: PROFILE_ID,
        type: 'recommendations.run',
        runId: RUN_ID,
        lookbackDays: 30,
      },
      {
        orgId: ORG_ID,
        profileId: PROFILE_ID,
        type: 'keepa.sync',
        asins: ['B000000001'],
        includeCompetitors: true,
      },
      {
        orgId: ORG_ID,
        profileId: PROFILE_ID,
        type: 'rank.sync',
        radarIds: ['radar-1'],
      },
      { orgId: ORG_ID, profileId: PROFILE_ID, type: 'economics.sync' },
      {
        orgId: ORG_ID,
        profileId: PROFILE_ID,
        type: 'sqp.categorize',
        weekStart: '2026-07-26',
      },
      {
        orgId: ORG_ID,
        profileId: PROFILE_ID,
        type: 'creative.sync',
        startDate: '2026-07-01',
        endDate: '2026-07-31',
        adProduct: 'SB',
      },
      {
        orgId: ORG_ID,
        profileId: PROFILE_ID,
        type: 'sqp.request',
        marketplaceId: 'marketplace-1',
        asins: ['B000000001'],
        weekStart: '2026-07-19',
        weekEnd: '2026-07-25',
      },
      {
        orgId: ORG_ID,
        profileId: PROFILE_ID,
        type: 'history.bootstrap',
        reportType: 'sbAds',
        source: 'amazon_unified_reporting',
        cursorDate: null,
      },
      {
        orgId: ORG_ID,
        profileId: PROFILE_ID,
        type: 'report.promote',
        reportRequestId: REQUEST_ID,
        reportType: 'sbAds',
        date: '2026-07-31',
      },
      {
        orgId: ORG_ID,
        profileId: PROFILE_ID,
        type: 'marketing_stream.normalize',
        messageIds: ['message-1'],
      },
    ];

    const seen = jobs.map((j) => roundTrip(JobPayload, j).type);
    expect(seen).toEqual([
      'entity.sync',
      'report.request',
      'report.poll',
      'report.fetch',
      'crosscheck.ingest',
      'recommendations.run',
      'keepa.sync',
      'rank.sync',
      'economics.sync',
      'sqp.categorize',
      'creative.sync',
      'sqp.request',
      'history.bootstrap',
      'report.promote',
      'marketing_stream.normalize',
    ]);
  });

  it('rejects an unknown job type and a payload missing its tenant scope', () => {
    expect(JobPayload.safeParse({ orgId: ORG_ID, profileId: PROFILE_ID, type: 'nope' }).success).toBe(
      false,
    );
    expect(JobPayload.safeParse({ profileId: PROFILE_ID, type: 'entity.sync' }).success).toBe(false);
  });
});
