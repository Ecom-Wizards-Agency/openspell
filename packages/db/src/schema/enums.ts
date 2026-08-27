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
  EntityState,
  EntityType,
  JobType,
  MatchType,
  Placement,
  Region,
} from '@wizard-ads/shared';

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
export const reportType = pgEnum('report_type', [
  'spCampaigns',
  'spTargeting',
  'spSearchTerm',
  'spPlacement',
  'sbCampaigns',
  'sdCampaigns',
]);
export const reportStatus = pgEnum('report_status', [
  'pending',
  'processing',
  'completed',
  'failed',
  'expired',
  'cancelled',
]);

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
