/// <reference types="node" />

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SpCompleteCampaignBiddingState,
  SpWriteAction,
  SpWritePlan,
  orderSpWriteActions,
  serializeSpWriteActionFingerprint,
  serializeSpWritePlanFingerprint,
  type SpWriteAction as SpWriteActionType,
  type SpWritePlan as SpWritePlanType,
  type SpWriteProviderScope,
  type SpWriteRouteCounts,
} from '@wizard-ads/shared/sp-writes';
import {
  buildSpWriteObservationBody,
  parseSpWrite207,
  parseSpWriteObservationPage,
  parseSpWriteObservationRows,
  prepareSpWriteCalls,
} from './sp-write-codec.js';

const sha256 = {
  algorithm: 'sha256' as const,
  digest: (value: string): string => createHash('sha256').update(value).digest('hex'),
};
const sha = (character: string): string => character.repeat(64);
const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

const US_SCOPE: SpWriteProviderScope = {
  amazonProfileId: 'amazon-profile-synthetic',
  connectionId: uuid(3),
  region: 'NA',
  marketplaceId: 'ATVPDKIKX0DER',
  currencyCode: 'USD',
  apiDialect: 'sp_v3',
};

function entityId(action: SpWriteActionType): string {
  switch (action.routeKey) {
    case 'sp.v3.campaigns.update': return action.entity.campaignId;
    case 'sp.v3.ad_groups.update': return action.entity.adGroupId;
    case 'sp.v3.keywords.update': return action.entity.keywordId;
    case 'sp.v3.targets.update': return action.entity.targetId;
    case 'sp.v3.product_ads.update': return action.entity.productAdId;
  }
}

function withFingerprint(raw: unknown): SpWriteActionType {
  const action = SpWriteAction.parse(raw);
  return SpWriteAction.parse({
    ...action,
    fingerprint: sha256.digest(serializeSpWriteActionFingerprint(action)),
  });
}

function counts(actions: readonly SpWriteActionType[]): {
  logicalChanges: number;
  providerRows: number;
  uniqueEntities: number;
  byRoute: SpWriteRouteCounts;
} {
  const byRoute: SpWriteRouteCounts = {
    'sp.v3.campaigns.update': 0,
    'sp.v3.ad_groups.update': 0,
    'sp.v3.keywords.update': 0,
    'sp.v3.targets.update': 0,
    'sp.v3.product_ads.update': 0,
  };
  for (const action of actions) byRoute[action.routeKey] += 1;
  return {
    logicalChanges: actions.reduce((total, action) => total + action.sources.length, 0),
    providerRows: actions.length,
    uniqueEntities: new Set(actions.map((action) => `${action.routeKey}:${entityId(action)}`)).size,
    byRoute,
  };
}

function planFor(
  rawActions: readonly unknown[],
  providerScope: SpWriteProviderScope = US_SCOPE,
): SpWritePlanType {
  const actions = orderSpWriteActions(rawActions.map(withFingerprint));
  const unsigned = SpWritePlan.parse({
    schemaVersion: 'openspell.sp-write-plan.v1',
    id: uuid(4),
    orgId: uuid(1),
    profileId: uuid(2),
    providerScope,
    direction: 'forward',
    source: {
      kind: 'apply_batch',
      applyBatchId: uuid(20),
      guardrailSnapshotFingerprint: sha('a'),
      provenanceSnapshotFingerprint: sha('b'),
    },
    generatedAt: '2026-08-31T08:00:00.000Z',
    frozenAt: '2026-08-31T08:01:00.000Z',
    expiresAt: '2026-08-31T10:00:00.000Z',
    actions,
    counts: counts(actions),
    fingerprint: sha('0'),
  });
  return SpWritePlan.parse({
    ...unsigned,
    fingerprint: sha256.digest(serializeSpWritePlanFingerprint(unsigned)),
  });
}

function moneyAction(
  route: 'sp.v3.ad_groups.update' | 'sp.v3.keywords.update' | 'sp.v3.targets.update',
  expected: string,
  requested: string,
  currencyCode = 'USD',
  serial = 100,
): unknown {
  if (route === 'sp.v3.ad_groups.update') {
    return {
      actionId: uuid(serial), routeKey: route, entity: { adGroupId: `ad-group-${serial}` },
      changes: {
        defaultBid: {
          expected: { amount: expected, currencyCode },
          requested: { amount: requested, currencyCode },
        },
      },
      sources: [{ kind: 'apply_row', applyRowId: uuid(serial + 1000), changeKey: 'ad_group.default_bid' }],
      fingerprint: sha('0'),
    };
  }
  const noun = route === 'sp.v3.keywords.update' ? 'keyword' : 'target';
  const idKey = route === 'sp.v3.keywords.update' ? 'keywordId' : 'targetId';
  const changeKey = route === 'sp.v3.keywords.update' ? 'keyword.bid' : 'target.bid';
  return {
    actionId: uuid(serial), routeKey: route, entity: { [idKey]: `${noun}-${serial}` },
    changes: {
      bid: {
        expected: { amount: expected, currencyCode },
        requested: { amount: requested, currencyCode },
      },
    },
    sources: [{ kind: 'apply_row', applyRowId: uuid(serial + 1000), changeKey }],
    fingerprint: sha('0'),
  };
}

const expectedBidding = SpCompleteCampaignBiddingState.parse({
  strategy: 'auto_for_sales',
  placements: {
    topOfSearch: 20,
    productPages: null,
    restOfSearch: 0,
    amazonBusiness: 10,
  },
  shopperCohorts: [{
    shopperCohortType: 'AUDIENCE_SEGMENT',
    percentage: 30,
    audienceSegments: [{
      audienceId: 'audience-synthetic',
      audienceSegmentType: 'BEHAVIOR_DYNAMIC',
    }],
  }],
  offAmazonBudgetControlStrategy: 'MINIMIZE_SPEND',
});

const requestedBidding = SpCompleteCampaignBiddingState.parse({
  ...expectedBidding,
  placements: { ...expectedBidding.placements, topOfSearch: 21 },
});

function campaignAction(
  expectedBudget = '10',
  requestedBudget = '11',
  currencyCode = 'USD',
): unknown {
  return {
    actionId: uuid(101),
    routeKey: 'sp.v3.campaigns.update',
    entity: { campaignId: 'campaign-101' },
    changes: {
      budget: {
        expected: { amount: expectedBudget, currencyCode },
        requested: { amount: requestedBudget, currencyCode },
      },
      state: { expected: 'enabled', requested: 'paused' },
      placement: {
        expected: expectedBidding,
        requested: requestedBidding,
        approvedPlacementKeys: ['top_of_search'],
      },
    },
    sources: [
      { kind: 'apply_row', applyRowId: uuid(1101), changeKey: 'campaign.budget' },
      { kind: 'apply_row', applyRowId: uuid(1102), changeKey: 'campaign.placement.top_of_search' },
      { kind: 'apply_row', applyRowId: uuid(1103), changeKey: 'campaign.state' },
    ],
    fingerprint: sha('0'),
  };
}

function allRoutePlan(): SpWritePlanType {
  return planFor([
    campaignAction(),
    moneyAction('sp.v3.ad_groups.update', '1', '1.1', 'USD', 102),
    {
      ...moneyAction('sp.v3.keywords.update', '0.9', '0.95', 'USD', 103) as object,
      changes: {
        bid: {
          expected: { amount: '0.9', currencyCode: 'USD' },
          requested: { amount: '0.95', currencyCode: 'USD' },
        },
        state: { expected: 'enabled', requested: 'paused' },
      },
      sources: [
        { kind: 'apply_row', applyRowId: uuid(1103), changeKey: 'keyword.bid' },
        { kind: 'apply_row', applyRowId: uuid(2103), changeKey: 'keyword.state' },
      ],
    },
    moneyAction('sp.v3.targets.update', '1.2', '1.25', 'USD', 104),
    {
      actionId: uuid(105), routeKey: 'sp.v3.product_ads.update',
      entity: { productAdId: 'product-ad-105' },
      changes: { state: { expected: 'enabled', requested: 'paused' } },
      sources: [{ kind: 'apply_row', applyRowId: uuid(1105), changeKey: 'product_ad.state' }],
      fingerprint: sha('0'),
    },
  ]);
}

describe('SP write preparation and wire compilation', () => {
  it('groups all five routes deterministically and compiles exact route bodies', () => {
    const calls = prepareSpWriteCalls(allRoutePlan(), sha256);
    expect(calls.map((call) => call.routeKey)).toEqual([
      'sp.v3.ad_groups.update',
      'sp.v3.campaigns.update',
      'sp.v3.keywords.update',
      'sp.v3.product_ads.update',
      'sp.v3.targets.update',
    ]);
    expect(calls.map((call) => JSON.parse(call.mutation.body))).toEqual([
      { adGroups: [{ adGroupId: 'ad-group-102', defaultBid: 1.1 }] },
      {
        campaigns: [{
          campaignId: 'campaign-101',
          budget: { budget: 11, budgetType: 'DAILY' },
          state: 'PAUSED',
          dynamicBidding: {
            strategy: 'AUTO_FOR_SALES',
            placementBidding: [
              { placement: 'PLACEMENT_TOP', percentage: 21 },
              { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 0 },
              { placement: 'SITE_AMAZON_BUSINESS', percentage: 10 },
            ],
            shopperCohortBidding: [{
              shopperCohortType: 'AUDIENCE_SEGMENT',
              percentage: 30,
              audienceSegments: [{
                audienceId: 'audience-synthetic',
                audienceSegmentType: 'BEHAVIOR_DYNAMIC',
              }],
            }],
          },
          offAmazonSettings: { offAmazonBudgetControlStrategy: 'MINIMIZE_SPEND' },
        }],
      },
      { keywords: [{ keywordId: 'keyword-103', bid: 0.95, state: 'PAUSED' }] },
      { productAds: [{ adId: 'product-ad-105', state: 'PAUSED' }] },
      { targetingClauses: [{ targetId: 'target-104', bid: 1.25 }] },
    ]);
    expect(calls.every((call) => call.positions[0]?.requestIndex === 0)).toBe(true);
    expect(new Set(calls.map((call) => call.positions[0]?.actionRequestFingerprint)).size).toBe(5);
  });

  it('chunks a canonical route group at 100 and indexes each call from zero', () => {
    const actions = Array.from({ length: 101 }, (_, index) => ({
      actionId: uuid(3000 + index),
      routeKey: 'sp.v3.product_ads.update',
      entity: { productAdId: `product-ad-${String(index).padStart(3, '0')}` },
      changes: { state: { expected: 'enabled', requested: 'paused' } },
      sources: [{
        kind: 'apply_row',
        applyRowId: uuid(4000 + index),
        changeKey: 'product_ad.state',
      }],
      fingerprint: sha('0'),
    }));
    const calls = prepareSpWriteCalls(planFor(actions), sha256);
    expect(calls.map((call) => call.positions.length)).toEqual([100, 1]);
    expect(calls[0]?.positions.map((position) => position.requestIndex)).toEqual(
      Array.from({ length: 100 }, (_, index) => index),
    );
    expect(calls[1]?.positions[0]?.requestIndex).toBe(0);
  });

  it('binds fingerprints to scope, entity, route and exact row bytes', () => {
    const firstPlan = planFor([moneyAction('sp.v3.keywords.update', '1', '1.1')]);
    const first = prepareSpWriteCalls(firstPlan, sha256)[0]!;
    const repeat = prepareSpWriteCalls(firstPlan, sha256)[0]!;
    expect(repeat.positions[0]?.actionRequestFingerprint)
      .toBe(first.positions[0]?.actionRequestFingerprint);

    const changed = prepareSpWriteCalls(
      planFor([moneyAction('sp.v3.keywords.update', '1', '1.2')]),
      sha256,
    )[0]!;
    expect(changed.positions[0]?.actionRequestFingerprint)
      .not.toBe(first.positions[0]?.actionRequestFingerprint);

    const tampered = structuredClone(firstPlan) as SpWritePlanType;
    tampered.actions[0]!.fingerprint = sha('f');
    expect(() => prepareSpWriteCalls(tampered, sha256)).toThrow(/fingerprint mismatch/);
  });

  it('builds only the targeted ID-filter observation body', () => {
    const call = prepareSpWriteCalls(
      planFor([moneyAction('sp.v3.keywords.update', '1', '1.1')]),
      sha256,
    )[0]!;
    expect(buildSpWriteObservationBody(call)).toEqual({
      maxResults: 100,
      keywordIdFilter: { include: ['keyword-100'] },
    });
    expect(buildSpWriteObservationBody(call, 'next-synthetic')).toEqual({
      maxResults: 100,
      keywordIdFilter: { include: ['keyword-100'] },
      nextToken: 'next-synthetic',
    });
  });
});

describe('marketplace money policy', () => {
  const marketplaces = [
    ['A1AM78C64UM0Y8', 'NA', 'MXN', '0.1', '20000', '1', '21000000'],
    ['A1F83G8C2ARO7P', 'EU', 'GBP', '0.02', '1000', '1', '1000000'],
    ['A1PA6795UKMFR9', 'EU', 'EUR', '0.02', '1000', '1', '1000000'],
    ['A2EUQ1WTGCTBG2', 'NA', 'CAD', '0.02', '1000', '1', '1000000'],
    ['A39IBJ37TRP1C6', 'FE', 'AUD', '0.02', '1410', '1.4', '1500000'],
    ['ATVPDKIKX0DER', 'NA', 'USD', '0.02', '1000', '1', '1000000'],
    ['A13V1IB3VIYZZH', 'EU', 'EUR', '0.02', '1000', '1', '1000000'],
    ['A1RKKUPIHCS9HS', 'EU', 'EUR', '0.02', '1000', '1', '1000000'],
    ['APJ6JRA9NG5V4', 'EU', 'EUR', '0.02', '1000', '1', '1000000'],
    ['A1805IZSGTT6HS', 'EU', 'EUR', '0.02', '1000', '1', '1000000'],
    ['A1VC38T7YXB528', 'FE', 'JPY', '2', '100000', '100', '21000000'],
    ['A2VIGQ35RCS4UG', 'EU', 'AED', '0.24', '184', '4', '3700000'],
    ['A2Q3Y263D00KWC', 'NA', 'BRL', '0.07', '3700', '1.32', '5300000'],
    ['A19VAU5U5O7RUS', 'FE', 'SGD', '0.02', '1100', '1.39', '1300000'],
    ['A2NODRKZP88ZB9', 'EU', 'SEK', '0.18', '9300', '9', '9300000'],
    ['A21TJRUUN4KGV', 'EU', 'INR', '1', '5000', '50', '21000000'],
    ['A1C3SOZRARQ6R3', 'EU', 'PLN', '0.04', '2000', '2', '2000000'],
    ['A33AVAJ2PDY3EV', 'EU', 'TRY', '0.05', '2500', '2', '2500000'],
    ['ARBP9OOSHTCHU', 'EU', 'EGP', '0.15', '5.5', '7', '7400000'],
    ['A17E79C6D8DWNP', 'EU', 'SAR', '0.1', '3670', '4', '3700000'],
    ['AMEN7PMS3EDWL', 'EU', 'EUR', '0.02', '1000', '1', '1000000'],
    ['AE08WJ6YKNBMC', 'EU', 'ZAR', '1', '7000', '20', '7000000'],
    ['A28R8C7NBKEWEA', 'EU', 'EUR', '0.02', '1000', '1', '1000000'],
  ] as const;

  it.each(marketplaces)(
    'accepts exact SP bid and budget boundaries for %s',
    (marketplaceId, region, currencyCode, bidMin, bidMax, budgetMin, budgetMax) => {
      const scope: SpWriteProviderScope = {
        ...US_SCOPE, marketplaceId, region, currencyCode,
      };
      expect(() => prepareSpWriteCalls(
        planFor([moneyAction('sp.v3.keywords.update', bidMin, bidMax, currencyCode)], scope),
        sha256,
      )).not.toThrow();
      expect(() => prepareSpWriteCalls(
        planFor([campaignAction(budgetMin, budgetMax, currencyCode)], scope),
        sha256,
      )).not.toThrow();
    },
  );

  it('refuses unknown markets, scope mismatches, scale drift and out-of-range money', () => {
    const base = planFor([moneyAction('sp.v3.keywords.update', '1', '1.1')]);
    const refingerprint = (providerScope: SpWriteProviderScope): SpWritePlanType => {
      const unsigned = SpWritePlan.parse({ ...base, providerScope, fingerprint: sha('0') });
      return SpWritePlan.parse({
        ...unsigned,
        fingerprint: sha256.digest(serializeSpWritePlanFingerprint(unsigned)),
      });
    };
    expect(() => prepareSpWriteCalls(refingerprint({
      ...US_SCOPE, marketplaceId: 'MARKETPLACE-UNKNOWN',
    }), sha256)).toThrow(/Unsupported Amazon marketplace/);
    expect(() => prepareSpWriteCalls(refingerprint({ ...US_SCOPE, region: 'EU' }), sha256))
      .toThrow(/region or currency/);
    expect(() => prepareSpWriteCalls(
      planFor([moneyAction('sp.v3.keywords.update', '0.02', '0.021')]),
      sha256,
    )).toThrow(/currency scale/);
    expect(() => prepareSpWriteCalls(
      planFor([moneyAction('sp.v3.keywords.update', '0.01', '0.02')]),
      sha256,
    )).toThrow(/outside marketplace bounds/);
    const jpy: SpWriteProviderScope = {
      ...US_SCOPE, marketplaceId: 'A1VC38T7YXB528', region: 'FE', currencyCode: 'JPY',
    };
    expect(() => prepareSpWriteCalls(
      planFor([moneyAction('sp.v3.keywords.update', '2', '2.1', 'JPY')], jpy),
      sha256,
    )).toThrow(/currency scale/);
  });
});

describe('strict SP observations', () => {
  it('parses a complete campaign bidding state and selected current values', () => {
    const call = prepareSpWriteCalls(planFor([campaignAction()]), sha256)[0]!;
    const observed = parseSpWriteObservationRows(call, [{
      campaignId: 'campaign-101',
      name: 'Synthetic campaign',
      state: 'ENABLED',
      budget: { budget: 10, budgetType: 'DAILY', effectiveBudget: 10 },
      dynamicBidding: {
        strategy: 'AUTO_FOR_SALES',
        placementBidding: [
          { placement: 'SITE_AMAZON_BUSINESS', percentage: 10 },
          { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 0 },
          { placement: 'PLACEMENT_TOP', percentage: 20 },
        ],
        shopperCohortBidding: [{
          shopperCohortType: 'AUDIENCE_SEGMENT',
          percentage: 30,
          audienceSegments: [{
            audienceId: 'audience-synthetic',
            audienceSegmentType: 'BEHAVIOR_DYNAMIC',
          }],
        }],
      },
      offAmazonSettings: { offAmazonBudgetControlStrategy: 'MINIMIZE_SPEND' },
    }]);
    expect(observed).toEqual([{
      routeKey: 'sp.v3.campaigns.update',
      actionId: call.actions[0]!.actionId,
      actionFingerprint: call.actions[0]!.fingerprint,
      amazonEntityId: 'campaign-101',
      values: {
        budget: { amount: '10', currencyCode: 'USD' },
        state: 'enabled',
        placement: expectedBidding,
      },
    }]);
  });

  it('normalizes documented absent replacement collections without losing four placements', () => {
    const action = campaignAction() as Record<string, unknown>;
    const changes = structuredClone(action['changes']) as Record<string, unknown>;
    delete changes['budget'];
    delete changes['state'];
    action['changes'] = changes;
    action['sources'] = [{
      kind: 'apply_row', applyRowId: uuid(1102), changeKey: 'campaign.placement.top_of_search',
    }];
    const call = prepareSpWriteCalls(planFor([action]), sha256)[0]!;
    expect(parseSpWriteObservationRows(call, [{
      campaignId: 'campaign-101',
      dynamicBidding: { strategy: 'MANUAL' },
    }])[0]).toMatchObject({
      values: {
        placement: {
          strategy: 'manual',
          placements: {
            topOfSearch: null,
            productPages: null,
            restOfSearch: null,
            amazonBusiness: null,
          },
          shopperCohorts: [],
          offAmazonBudgetControlStrategy: null,
        },
      },
    });
  });

  it('refuses identity loss, duplicates, legacy budget, transient state and unknown bidding context', () => {
    const campaign = prepareSpWriteCalls(planFor([campaignAction()]), sha256)[0]!;
    const valid = {
      campaignId: 'campaign-101', state: 'ENABLED',
      budget: { budget: 10, budgetType: 'DAILY' },
      dynamicBidding: { strategy: 'MANUAL' },
    };
    expect(() => parseSpWriteObservationRows(campaign, [])).toThrow(/count/);
    expect(() => parseSpWriteObservationRows(campaign, [{ ...valid, campaignId: 'extra' }]))
      .toThrow(/extra entity/);
    expect(() => parseSpWriteObservationRows(campaign, [{
      ...valid, budget: { budget: 10, budgetType: 'OTHER' },
    }])).toThrow(/DAILY/);
    expect(() => parseSpWriteObservationRows(campaign, [{ ...valid, state: 'ARCHIVED' }]))
      .toThrow(/not mutable/);
    expect(() => parseSpWriteObservationRows(campaign, [{
      ...valid, dynamicBidding: { strategy: 'MANUAL', futureControl: [] },
    }])).toThrow(/unknown key/);
    expect(() => parseSpWriteObservationRows(campaign, [{
      ...valid, dynamicBidding: { strategy: 'MANUAL', placementBidding: null },
    }])).toThrow(/not an array/);
    expect(() => parseSpWriteObservationRows(campaign, [{
      ...valid, offAmazonSettings: null,
    }])).toThrow(/not an object/);
    expect(() => parseSpWriteObservationRows(campaign, [{
      ...valid,
      dynamicBidding: {
        strategy: 'MANUAL',
        placementBidding: [
          { placement: 'PLACEMENT_TOP', percentage: 1 },
          { placement: 'PLACEMENT_TOP', percentage: 2 },
        ],
      },
    }])).toThrow(/repeats placement/);
  });

  it('strictly parses page envelopes and retains pagination evidence', () => {
    const call = prepareSpWriteCalls(
      planFor([moneyAction('sp.v3.keywords.update', '1', '1.1')]), sha256,
    )[0]!;
    expect(parseSpWriteObservationPage({
      keywords: [{ keywordId: 'keyword-100', bid: 1 }],
      nextToken: 'next-page', totalResults: 1,
    }, call)).toEqual({
      rows: [{ keywordId: 'keyword-100', bid: 1 }],
      nextToken: 'next-page', totalResults: 1,
    });
    expect(() => parseSpWriteObservationPage({ keywords: [null] }, call)).toThrow(/not an object/);
    expect(() => parseSpWriteObservationPage({ keywords: [], truncated: true }, call))
      .toThrow(/unknown key/);
    expect(() => parseSpWriteObservationPage({
      keywords: [{ keywordId: 'keyword-100', bid: 1 }], totalResults: 2,
    }, call)).toThrow(/does not match requested positions/);
  });
});

describe('strict indexed 207 parsing', () => {
  function twoKeywordCall() {
    return prepareSpWriteCalls(planFor([
      moneyAction('sp.v3.keywords.update', '1', '1.1', 'USD', 501),
      moneyAction('sp.v3.keywords.update', '2', '2.1', 'USD', 502),
    ]), sha256)[0]!;
  }

  it('accepts reordered success/error arrays and restores request-index order', () => {
    const call = twoKeywordCall();
    const result = parseSpWrite207({
      keywords: {
        success: [{ index: 1, keywordId: 'keyword-502' }],
        error: [{
          index: 0,
          errors: [{ errorType: 'RANGE_ERROR', errorValue: ' synthetic\nreason ' }],
        }],
      },
    }, call);
    expect(result.kind).toBe('positions');
    if (result.kind !== 'positions') return;
    expect(result.positions.map((position) => position.outcome)).toEqual([
      'authoritative_rejected', 'accepted',
    ]);
    expect(result.positions[0]).toMatchObject({ code: 'RANGE_ERROR', message: 'synthetic reason' });
    expect(result.positions[1]).toMatchObject({ providerEntityId: 'keyword-502' });
  });

  it.each([
    { keywords: { success: [{ index: 0, keywordId: 'keyword-501' }] } },
    { keywords: { success: [
      { index: 0, keywordId: 'keyword-501' },
      { index: 0, keywordId: 'keyword-501' },
    ], error: [{ index: 1, errors: [{ errorType: 'X', errorValue: {} }] }] } },
    { keywords: { success: [
      { index: 0, keywordId: 'keyword-501' },
      { index: 2, keywordId: 'keyword-502' },
    ] } },
    { keywords: { success: [
      { index: 0, keywordId: 'wrong' },
      { index: 1, keywordId: 'keyword-502' },
    ] } },
    { keywords: { success: [{ index: 0, keywordId: 'keyword-501' }], errors: [] } },
    { keywords: { success: [null], error: [] } },
    { keywords: { error: [
      { index: 0, errors: [{ errorType: 'X' }] },
      { index: 1, errors: [{ errorType: 'Y', errorValue: {} }] },
    ] } },
  ])('returns one whole-call ambiguity signal for malformed indexed evidence', (response) => {
    expect(parseSpWrite207(response, twoKeywordCall())).toMatchObject({
      kind: 'ambiguous', code: 'MALFORMED_INDEXED_RESPONSE',
    });
  });

  it('sanitizes and bounds provider-controlled scalar diagnostics', () => {
    const call = prepareSpWriteCalls(
      planFor([moneyAction('sp.v3.keywords.update', '1', '1.1')]), sha256,
    )[0]!;
    const result = parseSpWrite207({ keywords: { error: [{
      index: 0,
      errors: [{
        errorType: `BAD\u0000${'X'.repeat(300)}`,
        errorValue: `Bearer synthetic-token-value ${'Y'.repeat(700)}`,
      }],
    }] } }, call);
    expect(result.kind).toBe('positions');
    if (result.kind !== 'positions') return;
    expect(result.positions[0]?.code?.length).toBeLessThanOrEqual(160);
    expect(result.positions[0]?.message?.length).toBeLessThanOrEqual(512);
    expect(JSON.stringify(result)).not.toContain('synthetic-token-value');
    expect(JSON.stringify(result)).not.toContain('Bearer');
  });

  it('does not retain provider-controlled malformed-response explanations', () => {
    const marker = ['synthetic', 'private', 'field'].join('-');
    const call = prepareSpWriteCalls(
      planFor([moneyAction('sp.v3.keywords.update', '1', '1.1')]), sha256,
    )[0]!;
    const result = parseSpWrite207({ keywords: {
      success: [{ index: 0, keywordId: 'keyword-100', [marker]: 'private-value' }],
    } }, call);

    expect(result).toEqual({
      kind: 'ambiguous',
      code: 'MALFORMED_INDEXED_RESPONSE',
      message: null,
    });
    expect(JSON.stringify(result)).not.toContain(marker);
  });
});
