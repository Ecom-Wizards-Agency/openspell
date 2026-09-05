import { createHash } from 'node:crypto';
import { Uuid } from '@wizard-ads/shared';
import {
  SpWritePlan, SpWriteProviderResult, serializeSpWriteProviderResultFingerprint,
  verifySpWritePlanFingerprints, type SpWriteProviderCallIntent,
} from '@wizard-ads/shared/sp-writes';
import type { DbHandle, QuerySql } from '../client.js';
import type { LoadVerifiedSpWriteExecutionIdentity } from './sp-write-persistence.js';

const hasher = { algorithm: 'sha256' as const, digest: (text: string) => createHash('sha256').update(text).digest('hex') };

/** Database time is evidence, never permission to dispatch. */
export async function readSpWriteDatabaseTime(database: { sql: QuerySql }): Promise<string> {
  const rows = await database.sql<{ now: string }[]>`select app.sp_write_instant(clock_timestamp()) as now`;
  if (rows.length !== 1 || !Number.isFinite(Date.parse(rows[0]!.now))) throw new Error('SP write database clock unavailable');
  return rows[0]!.now;
}

/**
 * A conservative preflight only. Reservation rechecks authority under locks.
 * Reconciliation deliberately does not use this predicate.
 */
export async function isSpWriteDispatchCurrent(
  database: Pick<DbHandle, 'sql'>, identity: LoadVerifiedSpWriteExecutionIdentity,
): Promise<boolean> {
  const ids = { orgId: Uuid.parse(identity.orgId), profileId: Uuid.parse(identity.profileId),
    executionId: Uuid.parse(identity.executionId), planId: Uuid.parse(identity.planId),
    approvalId: Uuid.parse(identity.approvalId), generation: Uuid.parse(identity.generation) };
  const rows = await database.sql<{ allowed: boolean }[]>`
    select exists (
      select 1 from public.sp_write_cycle_plans child
      join public.sp_write_plans plan using (org_id, profile_id, plan_id)
      join public.sp_write_authorization_receipts receipt
        on receipt.org_id = child.org_id and receipt.profile_id = child.profile_id and receipt.approval_id = child.approval_id
      join public.sp_write_environment_gate_head eh on eh.singleton
      join public.sp_write_environment_gate_versions ev on ev.version_id = eh.version_id
      join public.sp_write_profile_grant_heads gh on gh.org_id = plan.org_id and gh.profile_id = plan.profile_id
      join public.sp_write_profile_grant_versions gv
        on gv.org_id = gh.org_id and gv.profile_id = gh.profile_id and gv.grant_id = gh.grant_id and gv.version_id = gh.version_id
      join public.ad_profiles profile on profile.org_id = plan.org_id and profile.id = plan.profile_id
      join public.ads_connections connection on connection.org_id = profile.org_id and connection.id = profile.connection_id
      where child.org_id = ${ids.orgId}::uuid and child.profile_id = ${ids.profileId}::uuid
        and child.execution_id = ${ids.executionId}::uuid and child.plan_id = ${ids.planId}::uuid
        and child.approval_id = ${ids.approvalId}::uuid and child.generation = ${ids.generation}::uuid
        and clock_timestamp() < receipt.expires_at and clock_timestamp() < plan.expires_at
        and ev.enabled and ev.version_id = receipt.environment_gate_version
        and gv.enabled and gv.grant_id = receipt.profile_grant_id and gv.version_id = receipt.profile_grant_version
        and gv.amazon_profile_id = plan.amazon_profile_id and gv.connection_id = plan.connection_id
        and gv.region = plan.region and gv.marketplace_id = plan.marketplace_id
        and gv.currency_code = plan.currency_code and gv.api_dialect = plan.api_dialect
        and profile.sync_enabled and connection.status = 'active'
        and profile.amazon_profile_id = plan.amazon_profile_id and profile.connection_id = plan.connection_id
        and profile.region = plan.region and profile.currency_code = plan.currency_code
        and not exists (select 1 from public.sp_write_bounded_authorization_revocations revoked
                        where revoked.authorization_id = receipt.bounded_authorization_id)
    ) as allowed
  `;
  if (rows.length !== 1) throw new Error('SP write dispatch preflight unavailable');
  return rows[0]!.allowed;
}

/**
 * Resolve credentials for pending, allowlisted scopes before claiming custody.
 * Public immutable facts identify pending work; private delivery heads stay private.
 */
export async function listSpWriteProviderPlans(
  database: Pick<DbHandle, 'sql'>, profileIds: readonly string[], dispatchEnabled: boolean, reconcileEnabled: boolean,
): Promise<SpWritePlan[]> {
  const profiles = [...new Set(profileIds.map((id) => Uuid.parse(id)))];
  if (profiles.length === 0 || (!dispatchEnabled && !reconcileEnabled)) return [];
  const rows = await database.sql<{
    artifact_text: string; org_id: string; profile_id: string; execution_id: string;
    plan_id: string; approval_id: string; generation: string; dispatch_pending: boolean; observation_pending: boolean;
  }[]>`
    select plan.artifact_text, child.org_id::text, child.profile_id::text, child.execution_id::text,
           child.plan_id::text, child.approval_id::text, child.generation::text,
           exists (select 1 from public.sp_write_plan_actions action
                   where action.org_id = child.org_id and action.profile_id = child.profile_id and action.plan_id = child.plan_id
                     and not exists (select 1 from public.sp_write_action_resolutions resolution
                                     where resolution.org_id = child.org_id and resolution.profile_id = child.profile_id
                                       and resolution.execution_id = child.execution_id and resolution.plan_id = child.plan_id
                                       and resolution.action_id = action.action_id)) as dispatch_pending,
           exists (select 1 from public.sp_write_provider_call_positions position
                   left join public.sp_write_provider_result_positions result
                     on result.org_id = position.org_id and result.profile_id = position.profile_id
                    and result.intent_id = position.intent_id and result.action_id = position.action_id
                   where position.org_id = child.org_id and position.profile_id = child.profile_id
                     and position.execution_id = child.execution_id and position.plan_id = child.plan_id
                     and (result.outcome is null or (result.outcome <> 'authoritative_rejected' and not exists (
                       select 1 from public.sp_write_observations observation
                       where observation.org_id = position.org_id and observation.profile_id = position.profile_id
                         and observation.intent_id = position.intent_id and observation.action_id = position.action_id
                     )))) as observation_pending
      from public.sp_write_execution_requests child
      join public.sp_write_plans plan using (org_id, profile_id, plan_id)
      join public.ad_profiles profile on profile.org_id = plan.org_id and profile.id = plan.profile_id
      join public.ads_connections connection on connection.org_id = profile.org_id and connection.id = profile.connection_id
     where child.profile_id = any(${database.sql.array(profiles)}::uuid[])
       and connection.status = 'active' and profile.amazon_profile_id = plan.amazon_profile_id
       and profile.connection_id = plan.connection_id and profile.region = plan.region and profile.currency_code = plan.currency_code
     order by child.requested_at, child.plan_id
  `;
  const plans: SpWritePlan[] = [];
  for (const row of rows) {
    const identity = { orgId: row.org_id, profileId: row.profile_id, executionId: row.execution_id,
      planId: row.plan_id, approvalId: row.approval_id, generation: row.generation };
    if (!(reconcileEnabled && row.observation_pending)
      && !(dispatchEnabled && row.dispatch_pending && await isSpWriteDispatchCurrent(database, identity))) continue;
    const plan = SpWritePlan.parse(JSON.parse(row.artifact_text));
    verifySpWritePlanFingerprints(plan, hasher);
    if (plan.id !== row.plan_id || plan.orgId !== row.org_id || plan.profileId !== row.profile_id) {
      throw new Error('SP write candidate identity mismatch');
    }
    plans.push(plan);
  }
  return plans;
}

/** SQL remains the final recovery deadline authority at append. No provider call occurs here. */
export async function readSpWriteRecoveryResult(
  database: Pick<DbHandle, 'sql'>, intent: SpWriteProviderCallIntent,
): Promise<SpWriteProviderResult | null> {
  const rows = await database.sql<{ result_id: string; completed_at: string }[]>`
    select intent.reserved_result_id::text as result_id, app.sp_write_instant(clock_timestamp()) as completed_at
      from public.sp_write_provider_call_intents intent
      join public.sp_write_dispatch_leases lease on lease.lease_id = intent.dispatch_lease_id
     where intent.intent_id = ${intent.intentId}::uuid and intent.fingerprint = ${intent.fingerprint}
       and clock_timestamp() >= greatest(intent.provider_attempt_deadline, lease.expires_at)
  `;
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error('SP write recovery identity mismatch');
  const result = SpWriteProviderResult.parse({
    schemaVersion: 'openspell.sp-write-provider-result.v1', resultId: rows[0]!.result_id,
    intentId: intent.intentId, intentFingerprint: intent.fingerprint, providerCallId: intent.providerCallId,
    requestFingerprint: intent.requestFingerprint, completedAt: rows[0]!.completed_at,
    positions: intent.positions.map((position) => ({ requestIndex: position.requestIndex, actionId: position.actionId,
      actionFingerprint: position.actionFingerprint, actionRequestFingerprint: position.actionRequestFingerprint,
      outcome: 'ambiguous', providerEntityId: null, code: 'WORKER_RESULT_UNAVAILABLE', message: null })),
    fingerprint: '0'.repeat(64),
  });
  return { ...result, fingerprint: hasher.digest(serializeSpWriteProviderResultFingerprint(result)) };
}
