import { describe, expect, it } from 'vitest';
import {
  AdCreativeAssetMapping,
  AttributionObservation,
  CampaignOptimizationAssignment,
  ContextualNegativeProposal,
  CreativeAsset,
  DaypartingScheduleProposal,
  DirectionalAdjustmentProvenance,
  FeatureJobPayload,
  MarketingStreamHourlyFact,
  MarketingStreamLedgerEvent,
  OptimizationGroup,
  OptimizationRunContext,
  QueryCategory,
  QueryVocabularyEntry,
  RecommendationObservation,
  ReportCoverage,
  ReportPromotionWatermark,
  ReversionPreview,
  SqpWeeklyFact,
} from './index.js';

const PROFILE_ID = '00000000-0000-4000-8000-000000000001';
const ORG_ID = '00000000-0000-4000-8000-000000000002';
const GROUP_ID = '00000000-0000-4000-8000-000000000003';
const RUN_ID = '00000000-0000-4000-8000-000000000004';
const REC_ID = '00000000-0000-4000-8000-000000000005';

describe('creative attribution', () => {
  it('uses Asset ID as identity even when content hashes are null', () => {
    const first = CreativeAsset.parse({
      profileId: PROFILE_ID,
      assetId: 'asset-one',
      name: 'Synthetic video one',
      assetType: 'video',
      contentHash: null,
      thumbnailUrl: null,
    });
    const second = CreativeAsset.parse({ ...first, assetId: 'asset-two' });
    expect(first.assetId).not.toBe(second.assetId);
    expect(first.contentHash).toBeNull();
    expect(second.contentHash).toBeNull();
  });

  it('requires an explicit mapping state when no asset can be attributed', () => {
    expect(
      AdCreativeAssetMapping.parse({
        profileId: PROFILE_ID,
        adProduct: 'SB',
        campaignId: 'campaign-1',
        adGroupId: 'group-1',
        adId: 'ad-1',
        creativeId: null,
        assetId: null,
        placement: null,
        attributionState: 'legacy',
        observedAt: '2026-08-28T00:00:00Z',
      }).attributionState,
    ).toBe('legacy');
  });
});

describe('query intelligence', () => {
  it('keeps the complete six-category taxonomy', () => {
    expect(QueryCategory.options).toEqual([
      'own_brand',
      'competitor',
      'core',
      'head',
      'excluded',
      'unreviewed',
    ]);
  });

  it('represents weekly SQP shares without calling impression share share-of-voice', () => {
    const fact = SqpWeeklyFact.parse({
      profileId: PROFILE_ID,
      marketplaceId: 'marketplace-1',
      asin: 'B000000001',
      weekStart: '2026-08-16',
      weekEnd: '2026-08-22',
      searchQuery: 'synthetic query',
      normalizedQuery: 'synthetic query',
      category: 'unreviewed',
      searchQueryScore: 1,
      searchQueryVolume: 100,
      totalImpressions: 80,
      asinImpressions: 8,
      asinImpressionShare: 0.1,
      totalClicks: 20,
      asinClicks: 4,
      asinClickShare: 0.2,
      totalCartAdds: 10,
      asinCartAdds: 2,
      asinCartAddShare: 0.2,
      totalPurchases: 5,
      asinPurchases: 2,
      asinPurchaseShare: 0.4,
    });
    expect(fact.asinClickShare).toBe(0.2);
    expect(fact.asinPurchaseShare).toBe(0.4);
  });

  it('requires human approval state for vocabulary suggestions', () => {
    const entry = QueryVocabularyEntry.parse({
      orgId: ORG_ID,
      marketplaceId: 'marketplace-1',
      kind: 'own_brand_alias',
      value: 'synthetic alias',
      normalizedValue: 'synthetic alias',
      source: 'ai_suggestion',
      approved: false,
      reviewedAt: null,
    });
    expect(entry.approved).toBe(false);
  });

  it('keeps all negatives as ad-group review/export proposals', () => {
    const proposal = ContextualNegativeProposal.parse({
      profileId: PROFILE_ID,
      marketplaceId: 'marketplace-1',
      campaignId: 'campaign-1',
      adGroupId: 'group-1',
      searchTerm: 'synthetic excluded term',
      normalizedQuery: 'synthetic excluded term',
      category: 'excluded',
      sourceGroupRole: 'profit',
      matchType: 'negative_exact',
      reason: 'operator exclusion',
      status: 'proposed',
    });
    expect(proposal.status).toBe('proposed');
    expect(proposal.adGroupId).toBe('group-1');
  });
});

describe('optimization observations and reversion', () => {
  const group = OptimizationGroup.parse({
    id: GROUP_ID,
    orgId: ORG_ID,
    profileId: PROFILE_ID,
    name: 'Synthetic Rank',
    role: 'rank',
    targetAcos: 1,
    bidFloor: null,
    bidCeiling: null,
    bidIncreaseCap: 1,
    bidDecreaseCap: 1,
    placementIncreaseCap: 1,
    placementDecreaseCap: 1,
    exclusions: [],
    cadence: 'synthetic cadence',
    prioritization: 'balanced',
    enabled: true,
  });

  it('carries group context through the recommendation run', () => {
    const context = OptimizationRunContext.parse({
      runId: RUN_ID,
      profileId: PROFILE_ID,
      groupId: GROUP_ID,
      groupRole: 'rank',
      groupSnapshot: group,
      dueAt: '2026-08-28T00:00:00Z',
      windowStart: '2026-08-01',
      windowEnd: '2026-08-27',
    });
    expect(context.groupSnapshot.id).toBe(context.groupId);
    expect(
      CampaignOptimizationAssignment.parse({
        profileId: PROFILE_ID,
        campaignId: 'campaign-1',
        groupId: GROUP_ID,
        assignedAt: '2026-08-28T00:00:00Z',
        assignedBy: null,
      }).groupId,
    ).toBe(GROUP_ID);
  });

  it('holds while synchronization is incomplete', () => {
    const observation = RecommendationObservation.parse({
      recommendationId: REC_ID,
      priorRecommendationId: null,
      groupId: GROUP_ID,
      expectedValue: 1.01,
      synchronizedValue: null,
      synchronizedAt: null,
      observationWindowStart: '2026-08-20',
      observationWindowEnd: '2026-08-27',
      evidenceState: 'awaiting_sync',
      decision: 'hold',
      preIncrementalVolume: null,
      postIncrementalVolume: null,
      evidenceNote: 'awaiting synchronized evidence',
    });
    expect(observation.decision).toBe('hold');
  });

  it('records bounded non-mechanical adjustments and blocks conflicted reversions', () => {
    expect(
      DirectionalAdjustmentProvenance.parse({
        requestedValue: 1,
        constrainedValue: 1,
        finalValue: 1.01,
        direction: 'increase',
        adjustmentKind: 'one_cent',
        hardBoundPreventedAdjustment: false,
      }).finalValue,
    ).toBe(1.01);

    const reversion = ReversionPreview.parse({
      recommendationId: REC_ID,
      originalValue: 1,
      proposedValue: 1.01,
      exportedValue: 1.01,
      synchronizedValue: 1.01,
      currentValue: 1.02,
      inverseValue: 1,
      conflict: true,
      exportAllowed: false,
      reason: 'current state differs from expected applied value',
    });
    expect(reversion.exportAllowed).toBe(false);
  });
});

describe('report promotion and attribution observations', () => {
  it('makes coverage and row reconciliation explicit', () => {
    expect(
      ReportCoverage.parse({
        profileId: PROFILE_ID,
        reportType: 'spCampaigns',
        grain: 'campaign',
        source: 'amazon_reporting_v3',
        status: 'loading',
        earliestRequestedDate: '2026-01-01',
        earliestReturnedDate: '2026-01-01',
        latestLoadedDate: '2026-08-27',
        latestSettledDate: '2026-08-13',
        availabilityStartDate: '2026-01-01',
        missingDates: [],
        updatedAt: '2026-08-28T00:00:00Z',
      }).latestLoadedDate,
    ).toBe('2026-08-27');

    const watermark = ReportPromotionWatermark.parse({
      profileId: PROFILE_ID,
      reportType: 'spCampaigns',
      date: '2026-08-27',
      source: 'amazon_reporting_v3',
      reportRequestId: RUN_ID,
      requestedAt: '2026-08-28T00:00:00Z',
      promotedAt: '2026-08-28T01:00:00Z',
      sourceRows: 10,
      parsedRows: 9,
      refusedRows: 1,
      promotedRows: 9,
      canonicalRows: 9,
    });
    expect(watermark.parsedRows + watermark.refusedRows).toBe(watermark.sourceRows);
  });

  it('retains traffic and conversion revisions together', () => {
    const observation = AttributionObservation.parse({
      profileId: PROFILE_ID,
      date: '2026-08-27',
      adProduct: 'SP',
      reportType: 'spCampaigns',
      source: 'amazon_reporting_v3',
      observedAt: '2026-08-28T00:00:00Z',
      attributionWindowDays: 14,
      eventDateAgeDays: 1,
      impressions: 100,
      clicks: 10,
      cost: 5,
      purchases: 1,
      sales: 20,
      supersededAt: null,
    });
    expect(observation.clicks).toBe(10);
    expect(observation.sales).toBe(20);
  });
});

describe('Marketing Stream and dayparting', () => {
  it('preserves an idempotent raw event and DST-aware local derivation fields', () => {
    const event = MarketingStreamLedgerEvent.parse({
      profileId: PROFILE_ID,
      messageId: 'message-1',
      dataset: 'conversion',
      adProduct: 'SB',
      eventTime: '2026-08-28T00:00:00Z',
      receivedAt: '2026-08-28T00:01:00Z',
      revision: 0,
      payloadHash: 'synthetic-hash',
      rawPayload: { synthetic: true },
    });
    expect(event.messageId).toBe('message-1');

    const fact = MarketingStreamHourlyFact.parse({
      profileId: PROFILE_ID,
      adProduct: 'SB',
      campaignId: 'campaign-1',
      utcHour: '2026-08-28T00:00:00Z',
      profileTimeZone: 'Etc/UTC',
      localDate: '2026-08-28',
      localHour: 0,
      localDayOfWeek: 5,
      currencyCode: 'USD',
      impressions: 100,
      clicks: 10,
      cost: 5,
      purchases: 1,
      sales: 20,
      budgetUsagePercent: 90,
      budgetCapped: false,
      settlingState: 'settling',
      sourceEvents: 1,
    });
    expect(fact.settlingState).toBe('settling');
  });

  it('keeps schedules as export-only proposals', () => {
    const proposal = DaypartingScheduleProposal.parse({
      profileId: PROFILE_ID,
      campaignId: 'campaign-1',
      baselineLabel: 'synthetic baseline',
      evidenceStart: '2026-08-01',
      evidenceEnd: '2026-08-27',
      settledHours: 100,
      blocks: [
        { dayOfWeek: 1, startHour: 8, endHour: 12, adjustmentPercent: 1, confidence: 0.8 },
      ],
      status: 'proposed',
    });
    expect(proposal.status).toBe('proposed');
  });
});

describe('feature jobs', () => {
  it('accepts the new worker-owned jobs and SB ad-level report', () => {
    const jobs = [
      {
        orgId: ORG_ID,
        profileId: PROFILE_ID,
        type: 'creative.sync',
        startDate: '2026-08-01',
        endDate: '2026-08-27',
        adProduct: 'SB',
      },
      {
        orgId: ORG_ID,
        profileId: PROFILE_ID,
        type: 'sqp.request',
        marketplaceId: 'marketplace-1',
        asins: ['B000000001'],
        weekStart: '2026-08-16',
        weekEnd: '2026-08-22',
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
        reportRequestId: RUN_ID,
        reportType: 'sbAds',
        date: '2026-08-27',
      },
      {
        orgId: ORG_ID,
        profileId: PROFILE_ID,
        type: 'marketing_stream.normalize',
        messageIds: ['message-1'],
      },
    ];
    expect(jobs.map((job) => FeatureJobPayload.parse(job).type)).toEqual([
      'creative.sync',
      'sqp.request',
      'history.bootstrap',
      'report.promote',
      'marketing_stream.normalize',
    ]);
  });
});
