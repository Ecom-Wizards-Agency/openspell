/**
 * Every Postgres enum in the schema, in one place.
 *
 * The values are the values in `@wizard-ads/shared`, character for character.
 * That is the whole trick behind "no translation table": a contract value
 * travels from TypeScript into Postgres and back out into JSON unchanged, so
 * there is no layer where a rename can silently half-apply.
 *
 * Where a contract already owns the value list, the enum is built from it
 * (`Region.options`) rather than retyped, so a drift is a compile error rather
 * than a runtime surprise. The lists that have no contract are spelled out, and
 * `enums.test.ts` asserts every one of them against the live database.
 */
import { pgEnum } from 'drizzle-orm/pg-core';
import {
  AdProduct,
  CreativeAttributionState,
  EntityState,
  EntityType,
  HistoricalBootstrapStatus,
  HourSettlingState,
  JobType,
  MarketingStreamDataset,
  MatchType,
  OptimizationGroupRole,
  OptimizationPrioritization,
  Placement,
  QueryCategory,
  QueryVocabularyKind,
  QueryVocabularySource,
  RecommendationEvidenceDecision,
  RecommendationEvidenceState,
  Region,
  ReportDataSource,
  UnifiedReportDefinitionVersion,
  UnifiedReportOperationDisposition,
  UnifiedReportOperationKind,
  UnifiedReportOperationState,
  UnifiedReportRunState,
  WorkerReportType,
} from '@wizard-ads/shared';
import {
  SpWriteApprovalMode,
  SpWriteObservationOutcome,
  SpWriteProviderPositionOutcome,
  SpWriteRefusalReason,
  SpWriteRouteKey,
} from '@wizard-ads/shared/sp-writes';

/**
 * `pgEnum` wants a non-empty tuple; a contract's `.options` is an array of
 * literals. Same values, different type, so this narrows rather than converts.
 */
const tuple = <T extends string>(values: readonly T[]): [T, ...T[]] => {
  const [first, ...rest] = values;
  if (first === undefined) throw new Error('an enum needs at least one value');
  return [first, ...rest];
};

export const orgRole = pgEnum('org_role', ['owner', 'admin', 'analyst', 'viewer']);
export const connectionStatus = pgEnum('connection_status', [
  'pending',
  'active',
  'error',
  'revoked',
]);
export const INTEGRATION_PROVIDERS = ['keepa', 'datadive', 'mrp'] as const;
export const integrationProvider = pgEnum('integration_provider', INTEGRATION_PROVIDERS);

export const adsRegion = pgEnum('ads_region', tuple(Region.options));
export const profileAccountType = pgEnum('profile_account_type', ['seller', 'vendor', 'agency']);

export const adProduct = pgEnum('ad_product', tuple(AdProduct.options));
export const entityState = pgEnum('entity_state', tuple(EntityState.options));
export const entityType = pgEnum('entity_type', tuple(EntityType.options));
export const matchType = pgEnum('match_type', tuple(MatchType.options));
export const placement = pgEnum('placement', tuple(Placement.options));

export const budgetType = pgEnum('budget_type', ['daily', 'lifetime']);
export const targetingType = pgEnum('targeting_type', ['manual', 'auto']);
export const biddingStrategy = pgEnum('bidding_strategy', [
  'legacy_for_sales',
  'auto_for_sales',
  'manual',
  'rule_based',
]);
export const negativeScope = pgEnum('negative_scope', ['campaign', 'ad_group']);
export const entityChangeSource = pgEnum('entity_change_source', ['sync', 'apply']);
export const targetKind = pgEnum('target_kind', ['keyword', 'target']);

export const syncJobType = pgEnum('sync_job_type', tuple(JobType.options));
export const syncJobStatus = pgEnum('sync_job_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'dead',
]);
export const reportType = pgEnum('report_type', tuple(WorkerReportType.options));
export const reportStatus = pgEnum('report_status', [
  'pending',
  'processing',
  'completed',
  'failed',
  'expired',
  'cancelled',
]);
export const unifiedReportDefinitionVersion = pgEnum(
  'unified_report_definition_version',
  tuple(UnifiedReportDefinitionVersion.options),
);
export const unifiedReportRunState = pgEnum(
  'unified_report_run_state',
  tuple(UnifiedReportRunState.options),
);
export const unifiedReportOperationKind = pgEnum(
  'unified_report_operation_kind',
  tuple(UnifiedReportOperationKind.options),
);
export const unifiedReportOperationState = pgEnum(
  'unified_report_operation_state',
  tuple(UnifiedReportOperationState.options),
);
export const unifiedReportOperationDisposition = pgEnum(
  'unified_report_operation_disposition',
  tuple(UnifiedReportOperationDisposition.options),
);

export const recommendationReason = pgEnum('recommendation_reason', [
  'high_acos',
  'high_spend_no_sales',
  'low_acos',
  'low_visibility',
  'flag',
  'pacing',
]);
export const recommendationStatus = pgEnum('recommendation_status', [
  'proposed',
  'accepted',
  'dismissed',
  'exported',
  'applied',
  'superseded',
]);
export const runStatus = pgEnum('run_status', ['queued', 'running', 'succeeded', 'failed']);
export const crosscheckVerdict = pgEnum('crosscheck_verdict', [
  'verified',
  'mismatch',
  'missing_ours',
  'missing_theirs',
  'skipped_provisional',
]);

export const applyEntityType = pgEnum('apply_entity_type', [
  'keyword',
  'target',
  'campaign',
  'ad_group',
  'placement',
]);
export const applyBatchStatus = pgEnum('apply_batch_status', [
  'staged',
  'applied',
  'reverted',
  'abandoned',
]);

export const auditActorType = pgEnum('audit_actor_type', ['user', 'service', 'mcp', 'system']);
export const supaRule = pgEnum('supa_rule', ['P1', 'P2', 'P3', 'O1', 'O2', 'E1']);

// WP-56 operator-intelligence foundations. Values come directly from the
// contract package so SQL, Drizzle and the worker cannot drift by spelling.
export const reportDataSource = pgEnum(
  'report_data_source',
  tuple(ReportDataSource.options),
);
export const historicalBootstrapStatus = pgEnum(
  'historical_bootstrap_status',
  tuple(HistoricalBootstrapStatus.options),
);
export const creativeAttributionState = pgEnum(
  'creative_attribution_state',
  tuple(CreativeAttributionState.options),
);
export const queryCategory = pgEnum('query_category', tuple(QueryCategory.options));
export const queryVocabularyKind = pgEnum(
  'query_vocabulary_kind',
  tuple(QueryVocabularyKind.options),
);
export const queryVocabularySource = pgEnum(
  'query_vocabulary_source',
  tuple(QueryVocabularySource.options),
);
export const optimizationGroupRole = pgEnum(
  'optimization_group_role',
  tuple(OptimizationGroupRole.options),
);
export const optimizationPrioritization = pgEnum(
  'optimization_prioritization',
  tuple(OptimizationPrioritization.options),
);
export const recommendationEvidenceState = pgEnum(
  'recommendation_evidence_state',
  tuple(RecommendationEvidenceState.options),
);
export const recommendationEvidenceDecision = pgEnum(
  'recommendation_evidence_decision',
  tuple(RecommendationEvidenceDecision.options),
);
export const marketingStreamDataset = pgEnum(
  'marketing_stream_dataset',
  tuple(MarketingStreamDataset.options),
);
export const hourSettlingState = pgEnum(
  'hour_settling_state',
  tuple(HourSettlingState.options),
);

// WP-187's storage-only write-ledger enums. Canonical lifecycle vocabulary
// comes from the explicit frozen-contract subpath; DB-internal state remains
// deliberately narrow and does not widen the current job or queue contracts.
export const spWriteRouteKey = pgEnum(
  'sp_write_route_key',
  tuple(SpWriteRouteKey.options),
);
export const spWritePlanDirection = pgEnum('sp_write_plan_direction', [
  'forward',
  'inverse',
]);
export const spWriteApprovalMode = pgEnum(
  'sp_write_approval_mode',
  tuple(SpWriteApprovalMode.options),
);
export const spWriteActionResolutionKind = pgEnum(
  'sp_write_action_resolution_kind',
  ['refusal', 'intent'],
);
export const spWriteResultOrigin = pgEnum('sp_write_result_origin', [
  'provider_adapter',
  'recovery_synthesized',
]);
export const spWriteProviderOutcome = pgEnum(
  'sp_write_provider_outcome',
  tuple(SpWriteProviderPositionOutcome.options),
);
export const spWriteObservationOutcome = pgEnum(
  'sp_write_observation_outcome',
  tuple(SpWriteObservationOutcome.options),
);
export const spWriteRefusalReason = pgEnum(
  'sp_write_refusal_reason',
  tuple(SpWriteRefusalReason.options),
);
export const spWriteOutboxKind = pgEnum('sp_write_outbox_kind', [
  'dispatch',
  'observe_and_recover',
]);
