/**
 * WP-56 operator-intelligence storage.
 *
 * SQL migrations remain authoritative. These definitions mirror the additive
 * coverage, creative, SQP, optimizer and Marketing Stream foundations so later
 * worker packages consume typed rows rather than inventing local shapes.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  interval,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  CreativeMappingProvenance,
  CreativeSyncSnapshotStatus,
  DaypartingScheduleBlock,
  OptimizationGroup,
} from '@wizard-ads/shared';
import { count, money, ts } from './columns.js';
import {
  adProduct,
  creativeAttributionState,
  historicalBootstrapStatus,
  hourSettlingState,
  marketingStreamDataset,
  optimizationGroupRole,
  optimizationPrioritization,
  placement,
  queryCategory,
  queryVocabularyKind,
  queryVocabularySource,
  recommendationEvidenceDecision,
  recommendationEvidenceState,
  reportDataSource,
} from './enums.js';
import { recommendations } from './analysis.js';
import { creativeAssets } from './seams.js';
import { adProfiles, authUsers, orgs } from './tenancy.js';

export const reportCoverage = pgTable(
  'report_coverage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    reportType: text('report_type').notNull(),
    grain: text('grain').notNull(),
    source: reportDataSource('source').notNull(),
    status: historicalBootstrapStatus('status').notNull().default('pending'),
    earliestRequestedDate: date('earliest_requested_date'),
    earliestReturnedDate: date('earliest_returned_date'),
    latestLoadedDate: date('latest_loaded_date'),
    latestSettledDate: date('latest_settled_date'),
    availabilityStartDate: date('availability_start_date'),
    missingDates: date('missing_dates').array().notNull().default([]),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] })
      .onDelete('cascade'),
    uniqueIndex('report_coverage_profile_id_report_type_grain_source_key').on(
      t.profileId,
      t.reportType,
      t.grain,
      t.source,
    ),
    index('report_coverage_profile_status_idx').on(t.profileId, t.status, t.updatedAt),
  ],
);

export const historicalBootstrapProgress = pgTable(
  'historical_bootstrap_progress',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    reportType: text('report_type').notNull(),
    grain: text('grain').notNull(),
    source: reportDataSource('source').notNull(),
    status: historicalBootstrapStatus('status').notNull().default('pending'),
    requestedStartDate: date('requested_start_date'),
    requestedEndDate: date('requested_end_date'),
    availabilityStartDate: date('availability_start_date'),
    chunksPlanned: integer('chunks_planned').notNull().default(0),
    chunksCompleted: integer('chunks_completed').notNull().default(0),
    chunksFailed: integer('chunks_failed').notNull().default(0),
    earliestReturnedDate: date('earliest_returned_date'),
    latestReturnedDate: date('latest_returned_date'),
    lastRequestAt: ts('last_request_at'),
    lastError: text('last_error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] })
      .onDelete('cascade'),
    uniqueIndex('historical_bootstrap_progress_profile_id_report_type_grain_source_key').on(
      t.profileId,
      t.reportType,
      t.grain,
      t.source,
    ),
    index('historical_bootstrap_profile_status_idx').on(t.profileId, t.status, t.updatedAt),
  ],
);

export const reportPromotionWatermarks = pgTable(
  'report_promotion_watermarks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    reportType: text('report_type').notNull(),
    reportDate: date('report_date').notNull(),
    source: reportDataSource('source').notNull(),
    reportRequestId: uuid('report_request_id').notNull(),
    requestedAt: ts('requested_at').notNull(),
    promotedAt: ts('promoted_at').notNull().defaultNow(),
    sourceRows: count('source_rows').notNull(),
    parsedRows: count('parsed_rows').notNull(),
    refusedRows: count('refused_rows').notNull(),
    promotedRows: count('promoted_rows').notNull(),
    canonicalRows: count('canonical_rows').notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] })
      .onDelete('cascade'),
    uniqueIndex('report_promotion_watermarks_profile_id_report_type_report_date_source_key').on(
      t.profileId,
      t.reportType,
      t.reportDate,
      t.source,
    ),
    index('report_promotion_request_idx').on(t.reportRequestId),
  ],
);

/**
 * Immutable SQP promotion provenance.
 *
 * SQP reports come from SP-API Brand Analytics, which is intentionally not
 * mislabeled as an Ads Reporting v3/unified-reporting source. Each row owns a
 * complete requested-ASIN scope. The query layer takes sorted, per-ASIN
 * transaction advisory locks and treats the newest overlapping run as the
 * freshness watermark.
 */
export const sqpPromotionRuns = pgTable(
  'sqp_promotion_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    marketplaceId: text('marketplace_id').notNull(),
    weekStart: date('week_start').notNull(),
    sourceSystem: text('source_system').notNull(),
    requestIdentity: text('request_identity').notNull(),
    requestedAt: ts('requested_at').notNull(),
    completedAt: ts('completed_at').notNull(),
    promotedAt: ts('promoted_at').notNull().defaultNow(),
    requestedAsins: text('requested_asins').array().notNull(),
    sourceReports: jsonb('source_reports').notNull(),
    inputFingerprint: text('input_fingerprint').notNull(),
    sourceAsins: count('source_asins').notNull(),
    sourceRows: count('source_rows').notNull(),
    parsedRows: count('parsed_rows').notNull(),
    deduplicatedRows: count('deduplicated_rows').notNull(),
    refusedRows: count('refused_rows').notNull(),
    promotedRows: count('promoted_rows').notNull(),
    canonicalRows: count('canonical_rows').notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] })
      .onDelete('cascade'),
    uniqueIndex('sqp_promotion_runs_profile_id_request_identity_key').on(
      t.profileId,
      t.requestIdentity,
    ),
    index('sqp_promotion_runs_scope_freshness_idx').on(
      t.profileId,
      t.marketplaceId,
      t.weekStart,
      t.requestedAt,
    ),
    check('sqp_promotion_runs_source_system_check', sql`${t.sourceSystem} = 'amazon_sp_api_brand_analytics'`),
    check('sqp_promotion_runs_marketplace_nonempty', sql`btrim(${t.marketplaceId}) <> ''`),
    check('sqp_promotion_runs_request_identity_nonempty', sql`btrim(${t.requestIdentity}) <> ''`),
    check('sqp_promotion_runs_time_order', sql`${t.completedAt} >= ${t.requestedAt}`),
    check('sqp_promotion_runs_asins_nonempty', sql`cardinality(${t.requestedAsins}) > 0`),
    check(
      'sqp_promotion_runs_source_reports_nonempty',
      sql`jsonb_typeof(${t.sourceReports}) = 'array' and jsonb_array_length(${t.sourceReports}) > 0`,
    ),
    check(
      'sqp_promotion_runs_source_reconciled',
      sql`${t.sourceRows} = ${t.parsedRows} + ${t.refusedRows}`,
    ),
    check(
      'sqp_promotion_runs_promoted_reconciled',
      sql`${t.deduplicatedRows} = ${t.promotedRows} and ${t.promotedRows} = ${t.canonicalRows}`,
    ),
  ],
);

export const attributionObservations = pgTable(
  'attribution_observations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    sourceObservationKey: text('source_observation_key').notNull(),
    eventDate: date('event_date').notNull(),
    adProduct: adProduct('ad_product').notNull(),
    reportType: text('report_type').notNull(),
    source: reportDataSource('source').notNull(),
    observedAt: ts('observed_at').notNull(),
    attributionWindowDays: integer('attribution_window_days').notNull(),
    eventDateAgeDays: integer('event_date_age_days').notNull(),
    impressions: count('impressions').notNull(),
    clicks: count('clicks').notNull(),
    cost: money('cost', 16, 4).notNull(),
    purchases: count('purchases').notNull(),
    sales: money('sales', 16, 4).notNull(),
    supersededAt: ts('superseded_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] })
      .onDelete('cascade'),
    uniqueIndex('attribution_observations_profile_id_source_source_observation_key_key').on(
      t.profileId,
      t.source,
      t.sourceObservationKey,
    ),
    index('attribution_observations_cohort_idx').on(
      t.profileId,
      t.adProduct,
      t.reportType,
      t.eventDate,
      t.observedAt,
    ),
  ],
);

/** Counted provenance for one current Sponsored Brands ad/asset observation. */
export const creativeSyncSnapshots = pgTable(
  'creative_sync_snapshots',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    observedAt: ts('observed_at').notNull(),
    mappingProvenance: text('mapping_provenance').$type<CreativeMappingProvenance>().notNull(),
    historicalValidity: text('historical_validity')
      .$type<'unproven_current_snapshot'>()
      .notNull(),
    status: text('status').$type<CreativeSyncSnapshotStatus>().notNull(),
    paginationComplete: boolean('pagination_complete').notNull(),
    factPromotionAllowed: boolean('fact_promotion_allowed').notNull(),
    sourceAssets: count('source_assets').notNull(),
    parsedAssets: count('parsed_assets').notNull(),
    sourceAds: count('source_ads').notNull(),
    parsedAds: count('parsed_ads').notNull(),
    mapped: count('mapped').notNull(),
    legacy: count('legacy').notNull(),
    unsupported: count('unsupported').notNull(),
    ambiguous: count('ambiguous').notNull(),
    unmapped: count('unmapped').notNull(),
    reportSourceRows: count('report_source_rows'),
    reportParsedRows: count('report_parsed_rows'),
    reportRefusedRows: count('report_refused_rows'),
    mappedFactRows: count('mapped_fact_rows').notNull().default(0),
    unpromotedReportRows: count('unpromoted_report_rows').notNull().default(0),
    assetsUpserted: count('assets_upserted').notNull().default(0),
    mappingsUpserted: count('mappings_upserted').notNull().default(0),
    factsUpserted: count('facts_upserted').notNull().default(0),
    assetsReadBack: count('assets_read_back').notNull().default(0),
    mappingsReadBack: count('mappings_read_back').notNull().default(0),
    factsReadBack: count('facts_read_back').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] })
      .onDelete('cascade'),
    unique('creative_sync_snapshots_org_id_profile_id_id_key').on(t.orgId, t.profileId, t.id),
    index('creative_sync_snapshots_profile_observed_idx').on(t.profileId, t.observedAt),
    uniqueIndex('creative_sync_snapshots_one_report_pending_idx')
      .on(t.orgId, t.profileId)
      .where(sql`${t.status} = 'report_pending'`),
  ],
);

export const adCreativeAssetMappings = pgTable(
  'ad_creative_asset_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    sourceMappingKey: text('source_mapping_key').notNull(),
    adProduct: adProduct('ad_product').notNull(),
    campaignId: text('campaign_id').notNull(),
    adGroupId: text('ad_group_id').notNull(),
    adId: text('ad_id').notNull(),
    creativeId: text('creative_id'),
    creativeVersion: text('creative_version'),
    creativeAssetId: uuid('creative_asset_id'),
    amazonAssetId: text('amazon_asset_id'),
    placement: placement('placement'),
    attributionState: creativeAttributionState('attribution_state').notNull(),
    mappingProvenance: text('mapping_provenance').$type<CreativeMappingProvenance>(),
    creativeSyncSnapshotId: uuid('creative_sync_snapshot_id'),
    observedAt: ts('observed_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] })
      .onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.profileId, t.creativeAssetId],
      foreignColumns: [creativeAssets.orgId, creativeAssets.profileId, creativeAssets.id],
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.profileId, t.creativeSyncSnapshotId],
      foreignColumns: [creativeSyncSnapshots.orgId, creativeSyncSnapshots.profileId, creativeSyncSnapshots.id],
    }).onDelete('restrict'),
    uniqueIndex('ad_creative_asset_mappings_profile_id_source_mapping_key_key').on(
      t.profileId,
      t.sourceMappingKey,
    ),
    index('ad_creative_asset_mappings_asset_idx').on(t.profileId, t.amazonAssetId, t.observedAt),
    index('ad_creative_asset_mappings_ad_idx').on(t.profileId, t.adProduct, t.adId, t.observedAt),
  ],
);

export const factCreativeDaily = pgTable(
  'fact_creative_daily',
  {
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    date: date('date').notNull(),
    adProduct: adProduct('ad_product').notNull(),
    campaignId: text('campaign_id').notNull(),
    adGroupId: text('ad_group_id').notNull(),
    adId: text('ad_id').notNull(),
    creativeId: text('creative_id'),
    creativeVersion: text('creative_version'),
    amazonAssetId: text('amazon_asset_id'),
    placement: placement('placement'),
    attributionState: creativeAttributionState('attribution_state').notNull(),
    mappingProvenance: text('mapping_provenance').$type<CreativeMappingProvenance>(),
    creativeSyncSnapshotId: uuid('creative_sync_snapshot_id'),
    impressions: count('impressions').notNull().default(0),
    clicks: count('clicks').notNull().default(0),
    cost: money('cost', 16, 4).notNull().default(0),
    purchases: count('purchases').notNull().default(0),
    sales: money('sales', 16, 4).notNull().default(0),
    videoFirstQuartileViews: count('video_first_quartile_views'),
    videoMidpointViews: count('video_midpoint_views'),
    videoThirdQuartileViews: count('video_third_quartile_views'),
    videoCompleteViews: count('video_complete_views'),
    loadedAt: ts('loaded_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] })
      .onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.profileId, t.creativeSyncSnapshotId],
      foreignColumns: [creativeSyncSnapshots.orgId, creativeSyncSnapshots.profileId, creativeSyncSnapshots.id],
    }).onDelete('restrict'),
    unique('fact_creative_daily_grain_key')
      .on(
        t.profileId,
        t.date,
        t.adProduct,
        t.campaignId,
        t.adGroupId,
        t.adId,
        t.creativeId,
        t.creativeVersion,
        t.amazonAssetId,
        t.placement,
      )
      .nullsNotDistinct(),
    index('fact_creative_daily_profile_date').on(t.profileId, t.date),
  ],
);

export const queryVocabulary = pgTable(
  'query_vocabulary',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    marketplaceId: text('marketplace_id').notNull(),
    kind: queryVocabularyKind('kind').notNull(),
    value: text('value').notNull(),
    normalizedValue: text('normalized_value').notNull(),
    source: queryVocabularySource('source').notNull(),
    approved: boolean('approved').notNull().default(false),
    reviewedAt: ts('reviewed_at'),
    reviewedBy: uuid('reviewed_by').references(() => authUsers.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('query_vocabulary_org_id_marketplace_id_kind_normalized_value_key').on(
      t.orgId,
      t.marketplaceId,
      t.kind,
      t.normalizedValue,
    ),
    index('query_vocabulary_review_idx').on(t.orgId, t.marketplaceId, t.approved, t.kind),
  ],
);

export const contextualNegativeProposals = pgTable(
  'contextual_negative_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    marketplaceId: text('marketplace_id').notNull(),
    campaignId: text('campaign_id').notNull(),
    adGroupId: text('ad_group_id').notNull(),
    searchTerm: text('search_term').notNull(),
    normalizedQuery: text('normalized_query').notNull(),
    category: queryCategory('category').notNull(),
    sourceGroupRole: text('source_group_role').$type<'rank' | 'discovery' | 'profit' | 'shield'>().notNull(),
    matchType: text('match_type').$type<'negative_exact' | 'negative_phrase'>().notNull(),
    reason: text('reason').notNull(),
    status: text('status').$type<'proposed' | 'accepted' | 'dismissed' | 'exported'>().notNull().default('proposed'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] })
      .onDelete('cascade'),
    uniqueIndex('contextual_negative_proposals_profile_id_campaign_id_ad_group_id_normalized_query_match_type_key').on(
      t.profileId,
      t.campaignId,
      t.adGroupId,
      t.normalizedQuery,
      t.matchType,
    ),
    index('contextual_negative_review_idx').on(t.profileId, t.status, t.category, t.createdAt),
  ],
);

export const optimizationGroups = pgTable(
  'optimization_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    name: text('name').notNull(),
    role: optimizationGroupRole('role').notNull(),
    targetAcos: money('target_acos', 9, 6).notNull(),
    bidFloor: money('bid_floor', 12, 4),
    bidCeiling: money('bid_ceiling', 12, 4),
    bidIncreaseCap: money('bid_increase_cap', 9, 6).notNull(),
    bidDecreaseCap: money('bid_decrease_cap', 9, 6).notNull(),
    placementIncreaseCap: money('placement_increase_cap', 9, 6).notNull(),
    placementDecreaseCap: money('placement_decrease_cap', 9, 6).notNull(),
    exclusions: text('exclusions').array().notNull().default([]),
    cadence: interval('cadence').notNull(),
    prioritization: optimizationPrioritization('prioritization').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    nextRunAt: ts('next_run_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] })
      .onDelete('cascade'),
    uniqueIndex('optimization_groups_profile_id_name_key').on(t.profileId, t.name),
    uniqueIndex('optimization_groups_org_id_profile_id_id_key').on(t.orgId, t.profileId, t.id),
    index('optimization_groups_due_idx').on(t.nextRunAt).where(sql`${t.enabled}`),
  ],
);

export const campaignOptimizationAssignments = pgTable(
  'campaign_optimization_assignments',
  {
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    campaignId: text('campaign_id').notNull(),
    groupId: uuid('group_id').notNull(),
    assignedAt: ts('assigned_at').notNull().defaultNow(),
    assignedBy: uuid('assigned_by').references(() => authUsers.id, { onDelete: 'set null' }),
  },
  (t) => [
    primaryKey({ columns: [t.profileId, t.campaignId] }),
    foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] })
      .onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.profileId, t.groupId],
      foreignColumns: [optimizationGroups.orgId, optimizationGroups.profileId, optimizationGroups.id],
    }).onDelete('cascade'),
    index('campaign_optimization_assignments_group_idx').on(t.groupId, t.campaignId),
  ],
);

export const recommendationObservations = pgTable(
  'recommendation_observations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    recommendationId: uuid('recommendation_id').notNull(),
    priorRecommendationId: uuid('prior_recommendation_id'),
    groupId: uuid('group_id').notNull(),
    expectedValue: money('expected_value', 16, 6).notNull(),
    synchronizedValue: money('synchronized_value', 16, 6),
    synchronizedAt: ts('synchronized_at'),
    observationWindowStart: date('observation_window_start').notNull(),
    observationWindowEnd: date('observation_window_end').notNull(),
    evidenceState: recommendationEvidenceState('evidence_state').notNull(),
    decision: recommendationEvidenceDecision('decision').notNull(),
    preIncrementalVolume: money('pre_incremental_volume', 16, 6),
    postIncrementalVolume: money('post_incremental_volume', 16, 6),
    evidenceNote: text('evidence_note').notNull(),
    observedAt: ts('observed_at').notNull().defaultNow(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] })
      .onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.profileId, t.recommendationId],
      foreignColumns: [recommendations.orgId, recommendations.profileId, recommendations.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.profileId, t.priorRecommendationId],
      foreignColumns: [recommendations.orgId, recommendations.profileId, recommendations.id],
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.profileId, t.groupId],
      foreignColumns: [optimizationGroups.orgId, optimizationGroups.profileId, optimizationGroups.id],
    }).onDelete('restrict'),
    uniqueIndex('recommendation_observations_recommendation_id_observed_at_key').on(
      t.recommendationId,
      t.observedAt,
    ),
    index('recommendation_observations_state_idx').on(t.profileId, t.evidenceState, t.observedAt),
  ],
);

export const marketingStreamEvents = pgTable(
  'marketing_stream_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    messageId: text('message_id').notNull(),
    dataset: marketingStreamDataset('dataset').notNull(),
    adProduct: adProduct('ad_product').notNull(),
    eventTime: ts('event_time').notNull(),
    receivedAt: ts('received_at').notNull(),
    revision: integer('revision').notNull(),
    payloadHash: text('payload_hash').notNull(),
    rawPayload: jsonb('raw_payload').$type<Record<string, unknown>>().notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] })
      .onDelete('cascade'),
    uniqueIndex('marketing_stream_events_profile_id_dataset_message_id_revision_key').on(
      t.profileId,
      t.dataset,
      t.messageId,
      t.revision,
    ),
    index('marketing_stream_events_normalize_idx').on(t.profileId, t.eventTime, t.receivedAt),
  ],
);

export const marketingStreamHourlyFacts = pgTable(
  'marketing_stream_hourly_facts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    adProduct: adProduct('ad_product').notNull(),
    campaignId: text('campaign_id').notNull(),
    utcHour: ts('utc_hour').notNull(),
    profileTimezone: text('profile_timezone').notNull(),
    localDate: date('local_date').notNull(),
    localHour: smallint('local_hour').notNull(),
    localDayOfWeek: smallint('local_day_of_week').notNull(),
    currencyCode: text('currency_code').notNull(),
    impressions: count('impressions').notNull().default(0),
    clicks: count('clicks').notNull().default(0),
    cost: money('cost', 16, 4).notNull().default(0),
    purchases: count('purchases').notNull().default(0),
    sales: money('sales', 16, 4).notNull().default(0),
    budgetUsagePercent: money('budget_usage_percent', 9, 6),
    budgetCapped: boolean('budget_capped').notNull().default(false),
    settlingState: hourSettlingState('settling_state').notNull(),
    sourceEvents: count('source_events').notNull(),
    loadedAt: ts('loaded_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] })
      .onDelete('cascade'),
    uniqueIndex('marketing_stream_hourly_facts_profile_id_ad_product_campaign_id_utc_hour_key').on(
      t.profileId,
      t.adProduct,
      t.campaignId,
      t.utcHour,
    ),
    index('marketing_stream_hourly_heatmap_idx').on(t.profileId, t.localDayOfWeek, t.localHour, t.localDate),
    index('marketing_stream_hourly_settling_idx').on(t.profileId, t.settlingState, t.utcHour),
  ],
);

export const daypartingScheduleProposals = pgTable(
  'dayparting_schedule_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    campaignId: text('campaign_id').notNull(),
    baselineLabel: text('baseline_label').notNull(),
    evidenceStart: date('evidence_start').notNull(),
    evidenceEnd: date('evidence_end').notNull(),
    settledHours: count('settled_hours').notNull(),
    blocks: jsonb('blocks').$type<DaypartingScheduleBlock[]>().notNull(),
    status: text('status').$type<'proposed' | 'accepted' | 'dismissed' | 'exported'>().notNull().default('proposed'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] })
      .onDelete('cascade'),
    check('dayparting_schedule_proposals_blocks_array', sql`jsonb_typeof(${t.blocks}) = 'array'`),
    index('dayparting_schedule_proposals_review_idx').on(t.profileId, t.status, t.createdAt),
  ],
);

export type ReportCoverageRow = typeof reportCoverage.$inferSelect;
export type NewAttributionObservation = typeof attributionObservations.$inferInsert;
export type CreativeDailyFactRow = typeof factCreativeDaily.$inferSelect;
export type OptimizationGroupRow = typeof optimizationGroups.$inferSelect;
export type NewOptimizationGroup = typeof optimizationGroups.$inferInsert &
  Pick<OptimizationGroup, 'role' | 'prioritization'>;
export type MarketingStreamEventRow = typeof marketingStreamEvents.$inferSelect;
