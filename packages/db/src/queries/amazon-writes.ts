import {
  AmazonWriteAction,
  AmazonWriteAccounting,
  AmazonWriteProviderEvidence,
  ApproveAmazonWriteExecution,
  type AmazonPlacementField,
  type AmazonWriteExecutionStatus,
  type ApplyEntityType,
  type ApplyValue,
  type ApproveAmazonWriteExecution as ApproveAmazonWriteExecutionInput,
} from '@wizard-ads/shared';
import type { QuerySql } from '../client.js';
import type { DbHandle } from '../client.js';
import { lockCurrentApplyStates, resolveCurrentApplyStates } from './apply-state.js';
import { toDate, toDateOrNull } from './pg-time.js';

export type AmazonWriteQueryHandle = Pick<DbHandle, 'sql'>;

export interface ApprovedAmazonWriteExecution {
  executionId: string;
  approvalId: string;
  applyBatchId: string;
  requested: number;
  actions: AmazonWriteAction[];
  replayed: boolean;
}

interface ApplyBatchForApproval {
  id: string;
  status: string;
  artifact_sha256: string | null;
  reversible_rows: number;
  unsupported_rows: number;
}

interface ApplyRowForApproval {
  id: string;
  entity_type: ApplyEntityType;
  entity_id: string;
  field: string;
  old_value: unknown;
  new_value: unknown;
}

interface CampaignContextRow {
  amazon_id: string;
  ad_product: string;
  bidding_strategy: 'legacy_for_sales' | 'auto_for_sales' | 'manual' | 'rule_based' | null;
  placement_bidding: {
    topOfSearch?: unknown;
    productPages?: unknown;
    restOfSearch?: unknown;
  } | null;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function sameNumber(left: ApplyValue | null, right: number): boolean {
  return typeof left === 'number' && Number.isFinite(left) && Object.is(left, right);
}

export function canonicalAmazonPlacementField(field: string): AmazonPlacementField | null {
  if (['top_of_search', 'top_of_search_modifier', 'top_of_search_placement', 'tos_modifier'].includes(field)) {
    return 'top_of_search';
  }
  if (['product_pages', 'product_pages_modifier', 'product_pages_placement'].includes(field)) {
    return 'product_pages';
  }
  if (['rest_of_search', 'rest_of_search_modifier', 'rest_of_search_placement'].includes(field)) {
    return 'rest_of_search';
  }
  return null;
}

function placementNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 900) {
    throw new Error('campaign placement context contains an invalid percentage');
  }
  return value;
}

function validateActionValue(action: 'bid' | 'placement', oldValue: number, newValue: number): void {
  if (action === 'bid') {
    if (oldValue <= 0 || newValue <= 0) throw new Error('Sponsored Products bids must be positive');
    return;
  }
  if (!Number.isInteger(oldValue) || !Number.isInteger(newValue) || oldValue < 0 || oldValue > 900 || newValue < 0 || newValue > 900) {
    throw new Error('Sponsored Products placement percentages must be integers from 0 through 900');
  }
}

function buildAction(
  row: ApplyRowForApproval,
  campaignById: ReadonlyMap<string, CampaignContextRow>,
): AmazonWriteAction {
  const expectedValue = finiteNumber(row.old_value, `${row.entity_type}:${row.entity_id}.${row.field} old value`);
  const requestedValue = finiteNumber(row.new_value, `${row.entity_type}:${row.entity_id}.${row.field} new value`);
  if (Object.is(expectedValue, requestedValue)) throw new Error(`apply row ${row.id} does not change its value`);

  if (row.entity_type === 'keyword' && row.field === 'bid') {
    validateActionValue('bid', expectedValue, requestedValue);
    return AmazonWriteAction.parse({
      actionType: 'sp_keyword_bid', applyRowId: row.id, amazonEntityId: row.entity_id,
      field: 'bid', expectedValue, requestedValue, inverseValue: expectedValue,
    });
  }
  if (row.entity_type === 'target' && row.field === 'bid') {
    validateActionValue('bid', expectedValue, requestedValue);
    return AmazonWriteAction.parse({
      actionType: 'sp_target_bid', applyRowId: row.id, amazonEntityId: row.entity_id,
      field: 'bid', expectedValue, requestedValue, inverseValue: expectedValue,
    });
  }
  if (row.entity_type === 'placement') {
    const field = canonicalAmazonPlacementField(row.field);
    if (field === null) throw new Error(`unsupported Sponsored Products placement field ${row.field}`);
    validateActionValue('placement', expectedValue, requestedValue);
    const campaign = campaignById.get(row.entity_id);
    if (!campaign || campaign.ad_product !== 'SP' || campaign.bidding_strategy === null) {
      throw new Error(`campaign ${row.entity_id} has no synchronized Sponsored Products bidding strategy`);
    }
    const context = campaign.placement_bidding ?? {};
    return AmazonWriteAction.parse({
      actionType: 'sp_campaign_placement', applyRowId: row.id,
      amazonEntityId: row.entity_id, field, expectedValue, requestedValue,
      inverseValue: expectedValue,
      campaignContext: {
        strategy: campaign.bidding_strategy,
        placementBidding: {
          topOfSearch: placementNumber(context.topOfSearch),
          productPages: placementNumber(context.productPages),
          restOfSearch: placementNumber(context.restOfSearch),
        },
      },
    });
  }
  throw new Error(`apply row ${row.id} is not an implemented Sponsored Products mutation`);
}

/**
 * Freeze one current export as an approved execution. All offered rows are
 * locked, current-state checked, materialized as typed provider actions, and
 * counted in the same transaction.
 */
export async function approveAmazonWriteExecution(
  handle: AmazonWriteQueryHandle,
  rawInput: ApproveAmazonWriteExecutionInput,
): Promise<ApprovedAmazonWriteExecution> {
  const input = ApproveAmazonWriteExecution.parse(rawInput);
  return handle.sql.begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${
      `amazon-write:${input.orgId}:${input.profileId}`
    }, 0))`;

    const [existing] = await sql<{
      execution_id: string;
      approval_id: string;
      apply_batch_id: string;
      requested_count: number;
      org_id: string;
      profile_id: string;
    }[]>`
      select execution.id as execution_id, execution.approval_id,
             execution.apply_batch_id, execution.requested_count,
             execution.org_id, execution.profile_id
        from public.amazon_write_executions execution
       where execution.idempotency_key = ${input.idempotencyKey}
    `;
    if (existing) {
      if (
        existing.org_id !== input.orgId
        || existing.profile_id !== input.profileId
        || existing.apply_batch_id !== input.applyBatchId
        || existing.requested_count !== input.expectedCount
      ) {
        throw new Error('Amazon write idempotency key already belongs to another preview');
      }
      const actions = await loadExecutionActions(sql, input.orgId, input.profileId, existing.execution_id);
      return {
        executionId: existing.execution_id,
        approvalId: existing.approval_id,
        applyBatchId: existing.apply_batch_id,
        requested: existing.requested_count,
        actions,
        replayed: true,
      };
    }

    const [batch] = await sql<ApplyBatchForApproval[]>`
      select id, status::text as status, artifact_sha256, reversible_rows, unsupported_rows
        from public.apply_batches
       where org_id = ${input.orgId} and profile_id = ${input.profileId}
         and id = ${input.applyBatchId}
       for update
    `;
    if (!batch) throw new Error('Amazon write preview batch does not exist in this profile');
    if (batch.status !== 'staged') throw new Error('Amazon write preview is no longer staged');
    if (batch.artifact_sha256 !== input.previewSha256) throw new Error('Amazon write preview fingerprint changed');
    if (batch.unsupported_rows !== 0) throw new Error('Amazon write preview contains unsupported rows');
    if (batch.reversible_rows !== input.expectedCount) throw new Error('Amazon write approval count does not match the preview');
    if (toDate(input.expiresAt).getTime() <= toDate(input.approvedAt).getTime()) {
      throw new Error('Amazon write approval expires before it is valid');
    }

    const rows = await sql<ApplyRowForApproval[]>`
      select id, entity_type::text as entity_type, entity_id, field, old_value, new_value
        from public.apply_rows
       where org_id = ${input.orgId} and profile_id = ${input.profileId}
         and batch_id = ${input.applyBatchId}
       order by created_at, id
       for update
    `;
    if (rows.length !== input.expectedCount) {
      throw new Error(`Amazon write approval offered ${input.expectedCount} rows but loaded ${rows.length}`);
    }

    const targets = rows.map((row) => ({
      key: row.id, entityType: row.entity_type, entityId: row.entity_id, field: row.field,
    }));
    await lockCurrentApplyStates({ sql }, { orgId: input.orgId, profileId: input.profileId, targets });
    const current = await resolveCurrentApplyStates(
      { sql }, { orgId: input.orgId, profileId: input.profileId, targets },
    );
    const currentByRow = new Map(current.map((state) => [state.key, state] as const));

    const campaignIds = [...new Set(rows.filter((row) => row.entity_type === 'placement').map((row) => row.entity_id))];
    const campaignRows = campaignIds.length === 0 ? [] : await sql<CampaignContextRow[]>`
      select amazon_id, ad_product::text as ad_product,
             bidding_strategy::text as bidding_strategy, placement_bidding
        from public.campaigns
       where org_id = ${input.orgId} and profile_id = ${input.profileId}
         and amazon_id = any(${campaignIds}::text[])
       for share
    `;
    const campaignById = new Map(campaignRows.map((campaign) => [campaign.amazon_id, campaign] as const));

    const actions = rows.map((row) => {
      const state = currentByRow.get(row.id);
      const oldValue = finiteNumber(row.old_value, `apply row ${row.id} old value`);
      if (!state?.supported || !state.present || !sameNumber(state.currentValue, oldValue)) {
        throw new Error(`Amazon write preview row ${row.id} no longer matches synchronized state`);
      }
      return buildAction(row, campaignById);
    });
    const actionKeys = new Set(actions.map((action) => `${action.actionType}:${action.amazonEntityId}:${action.field}`));
    if (actionKeys.size !== actions.length) {
      throw new Error('Amazon write preview repeats an entity field');
    }
    if (actions.length !== input.expectedCount) {
      throw new Error(`Amazon write approval offered ${input.expectedCount} rows but materialized ${actions.length}`);
    }

    const [approval] = await sql<{ id: string }[]>`
      insert into public.amazon_write_approvals
        (org_id, profile_id, apply_batch_id, mode, preview_sha256, approved_count,
         approved_by, approved_at, expires_at, inverse_preapproved)
      values (${input.orgId}, ${input.profileId}, ${input.applyBatchId}, ${input.approvalMode},
              ${input.previewSha256}, ${input.expectedCount}, ${input.approvedBy},
              ${input.approvedAt}, ${input.expiresAt}, ${input.inversePreapproved})
      returning id
    `;
    if (!approval) throw new Error('Amazon write approval was not recorded');

    const [execution] = await sql<{ id: string }[]>`
      insert into public.amazon_write_executions
        (org_id, profile_id, apply_batch_id, approval_id, idempotency_key, requested_count)
      values (${input.orgId}, ${input.profileId}, ${input.applyBatchId}, ${approval.id},
              ${input.idempotencyKey}, ${input.expectedCount})
      returning id
    `;
    if (!execution) throw new Error('Amazon write execution was not recorded');

    const inserted = await sql<{ id: string }[]>`
      insert into public.amazon_write_rows
        (org_id, profile_id, execution_id, apply_row_id, action_type, action,
         expected_value, requested_value, inverse_value)
      select ${input.orgId}, ${input.profileId}, ${execution.id},
             offered.apply_row_id::uuid,
             offered.action_type::public.amazon_write_action_type,
             offered.action::jsonb, offered.expected_value::jsonb,
             offered.requested_value::jsonb, offered.inverse_value::jsonb
        from unnest(
          ${actions.map((action) => action.applyRowId)}::text[],
          ${actions.map((action) => action.actionType)}::text[],
          ${actions.map((action) => json(action))}::text[],
          ${actions.map((action) => json(action.expectedValue))}::text[],
          ${actions.map((action) => json(action.requestedValue))}::text[],
          ${actions.map((action) => json(action.inverseValue))}::text[]
        ) as offered(apply_row_id, action_type, action, expected_value, requested_value, inverse_value)
      returning id
    `;
    if (inserted.length !== input.expectedCount) {
      throw new Error(`Amazon write approval materialized ${inserted.length} of ${input.expectedCount} rows`);
    }
    return {
      executionId: execution.id,
      approvalId: approval.id,
      applyBatchId: input.applyBatchId,
      requested: actions.length,
      actions,
      replayed: false,
    };
  });
}

interface StoredWriteRow {
  id: string;
  apply_row_id: string;
  action: unknown;
  row_status: string;
  observation_status: string;
  attempt_count: number;
}

async function loadExecutionActions(
  sql: QuerySql,
  orgId: string,
  profileId: string,
  executionId: string,
): Promise<AmazonWriteAction[]> {
  const rows = await sql<{ action: unknown }[]>`
    select action from public.amazon_write_rows
     where org_id = ${orgId} and profile_id = ${profileId} and execution_id = ${executionId}
     order by created_at, id
  `;
  return rows.map((row) => AmazonWriteAction.parse(row.action));
}

export interface PreparedAmazonWriteRow {
  writeRowId: string;
  attemptNumber: number;
  action: AmazonWriteAction;
}

export interface PreparedAmazonWriteExecution {
  executionId: string;
  applyBatchId: string;
  approvalMode: 'manual' | 'bounded_live_test';
  inversePreapproved: boolean;
  expiresAt: Date;
  status: AmazonWriteExecutionStatus;
  requested: number;
  rows: PreparedAmazonWriteRow[];
  replayed: boolean;
}

interface ExecutionHeader {
  id: string;
  apply_batch_id: string;
  status: AmazonWriteExecutionStatus;
  requested_count: number;
  mode: 'manual' | 'bounded_live_test';
  expires_at: Date | string;
  inverse_preapproved: boolean;
  approved_at: Date | string;
}

/** Recheck every unresolved row under lock immediately before provider I/O. */
export async function prepareAmazonWriteExecution(
  handle: AmazonWriteQueryHandle,
  input: {
    orgId: string;
    profileId: string;
    executionId: string;
    now: Date;
    maxConcurrentMutations: number;
  },
): Promise<PreparedAmazonWriteExecution> {
  return handle.sql.begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended('amazon-write:global', 0))`;
    await sql`select pg_advisory_xact_lock(hashtextextended(${
      `amazon-write:${input.orgId}:${input.profileId}`
    }, 0))`;
    const [execution] = await sql<ExecutionHeader[]>`
      select execution.id, execution.apply_batch_id,
             execution.status::text as status, execution.requested_count,
             approval.mode::text as mode, approval.approved_at, approval.expires_at,
             approval.inverse_preapproved
        from public.amazon_write_executions execution
        join public.amazon_write_approvals approval
          on approval.org_id = execution.org_id
         and approval.profile_id = execution.profile_id
         and approval.id = execution.approval_id
       where execution.org_id = ${input.orgId}
         and execution.profile_id = ${input.profileId}
         and execution.id = ${input.executionId}
       for update of execution
    `;
    if (!execution) throw new Error('Amazon write execution does not exist in this profile');
    if (['awaiting_sync', 'succeeded', 'refused', 'failed', 'conflict'].includes(execution.status)) {
      return {
        executionId: execution.id, applyBatchId: execution.apply_batch_id,
        approvalMode: execution.mode, inversePreapproved: execution.inverse_preapproved,
        expiresAt: toDate(execution.expires_at), status: execution.status,
        requested: execution.requested_count, rows: [], replayed: true,
      };
    }
    if (execution.status === 'running') {
      return {
        executionId: execution.id, applyBatchId: execution.apply_batch_id,
        approvalMode: execution.mode, inversePreapproved: execution.inverse_preapproved,
        expiresAt: toDate(execution.expires_at), status: execution.status,
        requested: execution.requested_count, rows: [], replayed: true,
      };
    }
    if (
      toDate(execution.approved_at).getTime() > input.now.getTime()
      || toDate(execution.expires_at).getTime() <= input.now.getTime()
    ) {
      await refuseExecutionRows(sql, execution.id, 'approval is outside its valid execution window');
      return {
        executionId: execution.id, applyBatchId: execution.apply_batch_id,
        approvalMode: execution.mode, inversePreapproved: execution.inverse_preapproved,
        expiresAt: toDate(execution.expires_at), status: 'refused',
        requested: execution.requested_count, rows: [], replayed: false,
      };
    }
    const [active] = await sql<{ count: number }[]>`
      select count(*)::int as count from public.amazon_write_executions
       where status = 'running' and id <> ${execution.id}
    `;
    if ((active?.count ?? 0) >= input.maxConcurrentMutations) {
      throw new Error('Amazon write concurrency gate is occupied');
    }
    const stored = await sql<StoredWriteRow[]>`
      select id, apply_row_id, action, row_status::text as row_status,
             observation_status::text as observation_status, attempt_count
        from public.amazon_write_rows
       where org_id = ${input.orgId} and profile_id = ${input.profileId}
         and execution_id = ${input.executionId}
       order by created_at, id
       for update
    `;
    if (stored.length !== execution.requested_count) {
      throw new Error(`Amazon write execution requested ${execution.requested_count} rows but loaded ${stored.length}`);
    }
    const unresolved = stored.filter((row) => row.row_status === 'pending' || row.row_status === 'retryable');
    if (unresolved.length === 0) {
      return {
        executionId: execution.id, applyBatchId: execution.apply_batch_id,
        approvalMode: execution.mode, inversePreapproved: execution.inverse_preapproved,
        expiresAt: toDate(execution.expires_at), status: execution.status,
        requested: execution.requested_count, rows: [], replayed: true,
      };
    }
    const actions = unresolved.map((row) => ({ row, action: AmazonWriteAction.parse(row.action) }));
    const targets = actions.map(({ row, action }) => ({
      key: row.id,
      entityType: action.actionType === 'sp_campaign_placement' ? 'placement' as const
        : action.actionType === 'sp_keyword_bid' ? 'keyword' as const : 'target' as const,
      entityId: action.amazonEntityId,
      field: action.field,
    }));
    await lockCurrentApplyStates({ sql }, { orgId: input.orgId, profileId: input.profileId, targets });
    const current = await resolveCurrentApplyStates(
      { sql }, { orgId: input.orgId, profileId: input.profileId, targets },
    );
    const currentByRow = new Map(current.map((state) => [state.key, state] as const));
    const conflicts: string[] = [];
    for (const { row, action } of actions) {
      const state = currentByRow.get(row.id);
      if (!state?.supported || !state.present || !sameNumber(state.currentValue, action.expectedValue)) {
        conflicts.push(row.id);
      }
    }
    if (conflicts.length > 0) {
      await refuseExecutionRows(sql, input.executionId, `current synchronized state changed for ${conflicts.length} row(s)`);
      return {
        executionId: execution.id, applyBatchId: execution.apply_batch_id,
        approvalMode: execution.mode, inversePreapproved: execution.inverse_preapproved,
        expiresAt: toDate(execution.expires_at), status: 'refused',
        requested: execution.requested_count, rows: [], replayed: false,
      };
    }
    await sql`
      update public.amazon_write_executions
         set status = 'running', started_at = coalesce(started_at, ${input.now.toISOString()})
       where id = ${execution.id}
    `;
    return {
      executionId: execution.id,
      applyBatchId: execution.apply_batch_id,
      approvalMode: execution.mode,
      inversePreapproved: execution.inverse_preapproved,
      expiresAt: toDate(execution.expires_at),
      status: 'running',
      requested: execution.requested_count,
      rows: actions.map(({ row, action }) => ({
        writeRowId: row.id, attemptNumber: row.attempt_count + 1, action,
      })),
      replayed: false,
    };
  });
}

/** Re-open only a request that Amazon explicitly rejected before mutation. */
export async function releaseAmazonWriteExecutionForRetry(
  handle: AmazonWriteQueryHandle,
  input: { orgId: string; profileId: string; executionId: string },
): Promise<void> {
  await handle.sql.begin(async (sql) => {
    const [execution] = await sql<{ id: string }[]>`
      select id from public.amazon_write_executions
       where org_id = ${input.orgId} and profile_id = ${input.profileId}
         and id = ${input.executionId} and status = 'running'
       for update
    `;
    if (!execution) throw new Error('running Amazon write execution is unavailable for retry release');
    const [state] = await sql<{ ambiguous: number; unresolved: number }[]>`
      select count(*) filter (where row_status = 'ambiguous')::int as ambiguous,
             count(*) filter (where row_status in ('pending', 'retryable'))::int as unresolved
        from public.amazon_write_rows where execution_id = ${execution.id}
    `;
    if ((state?.ambiguous ?? 0) > 0 || (state?.unresolved ?? 0) === 0) {
      throw new Error('Amazon write retry release is blocked without safely unresolved rows');
    }
    await sql`
      update public.amazon_write_executions set status = 'queued', started_at = null
       where id = ${execution.id}
    `;
  });
}

async function refuseExecutionRows(sql: QuerySql, executionId: string, reason: string): Promise<void> {
  const rows = await sql<{ id: string }[]>`
    update public.amazon_write_rows
       set row_status = 'refused', refusal_reason = ${reason}
     where execution_id = ${executionId}
       and row_status in ('pending', 'retryable')
    returning id
  `;
  const [counts] = await sql<{ requested: number; refused: number }[]>`
    select count(*)::int as requested,
           count(*) filter (where row_status = 'refused')::int as refused
      from public.amazon_write_rows where execution_id = ${executionId}
  `;
  if (!counts || counts.requested === 0) throw new Error('Amazon write refusal has no execution rows');
  if (rows.length > 0) await refreshExecutionCounts(sql, executionId);
}

export async function refuseAmazonWriteExecution(
  handle: AmazonWriteQueryHandle,
  input: { orgId: string; profileId: string; executionId: string; reason: string },
): Promise<AmazonWriteAccounting> {
  return handle.sql.begin(async (sql) => {
    const [execution] = await sql<{ id: string }[]>`
      select id from public.amazon_write_executions
       where org_id = ${input.orgId} and profile_id = ${input.profileId}
         and id = ${input.executionId}
       for update
    `;
    if (!execution) throw new Error('Amazon write execution does not exist in this profile');
    await refuseExecutionRows(sql, execution.id, input.reason.slice(0, 1_000));
    return readAccounting(sql, execution.id);
  });
}

export interface AmazonWriteRowOutcome {
  writeRowId: string;
  attemptNumber: number;
  requestFingerprint: string;
  evidence: AmazonWriteProviderEvidence;
}

export interface RecordedAmazonWriteOutcomes {
  status: AmazonWriteExecutionStatus;
  accounting: AmazonWriteAccounting;
  retryable: number;
  shouldObserve: boolean;
}

export async function recordAmazonWriteOutcomes(
  handle: AmazonWriteQueryHandle,
  input: {
    orgId: string;
    profileId: string;
    executionId: string;
    attemptedAt: Date;
    outcomes: readonly AmazonWriteRowOutcome[];
  },
): Promise<RecordedAmazonWriteOutcomes> {
  if (input.outcomes.length === 0) throw new Error('Amazon write outcome list is empty');
  return handle.sql.begin(async (sql) => {
    const [execution] = await sql<{ id: string; requested_count: number }[]>`
      select id, requested_count from public.amazon_write_executions
       where org_id = ${input.orgId} and profile_id = ${input.profileId}
         and id = ${input.executionId}
       for update
    `;
    if (!execution) throw new Error('Amazon write execution does not exist in this profile');
    const unique = new Set(input.outcomes.map((outcome) => outcome.writeRowId));
    if (unique.size !== input.outcomes.length) throw new Error('Amazon write outcomes repeat a row');

    for (const outcome of input.outcomes) {
      const evidence = AmazonWriteProviderEvidence.parse(outcome.evidence);
      const inserted = await sql<{ id: string }[]>`
        insert into public.amazon_write_attempts
          (org_id, profile_id, execution_id, write_row_id, attempt_number,
           request_fingerprint, outcome, provider_evidence, attempted_at)
        values (${input.orgId}, ${input.profileId}, ${input.executionId}, ${outcome.writeRowId},
                ${outcome.attemptNumber}, ${outcome.requestFingerprint}, ${evidence.outcome},
                ${json(evidence)}::jsonb, ${input.attemptedAt.toISOString()})
        on conflict (request_fingerprint) do nothing
        returning id
      `;
      if (inserted.length === 0) continue;
      const status = evidence.outcome === 'accepted' ? 'accepted'
        : evidence.outcome === 'retryable' ? 'retryable'
          : evidence.outcome === 'ambiguous' ? 'ambiguous' : 'failed';
      const updated = await sql<{ id: string }[]>`
        update public.amazon_write_rows
           set row_status = ${status}::public.amazon_write_row_status,
               attempt_count = ${outcome.attemptNumber},
               provider_evidence = ${json(evidence)}::jsonb,
               provider_accepted_at = case when ${status} = 'accepted'
                 then ${input.attemptedAt.toISOString()}::timestamptz else provider_accepted_at end
         where org_id = ${input.orgId} and profile_id = ${input.profileId}
           and execution_id = ${input.executionId} and id = ${outcome.writeRowId}
           and attempt_count + 1 = ${outcome.attemptNumber}
           and row_status in ('pending', 'retryable')
        returning id
      `;
      if (updated.length !== 1) throw new Error(`Amazon write outcome could not transition row ${outcome.writeRowId}`);
    }

    const state = await refreshExecutionCounts(sql, input.executionId);
    return state;
  });
}

async function refreshExecutionCounts(
  sql: QuerySql,
  executionId: string,
): Promise<RecordedAmazonWriteOutcomes> {
  const [counts] = await sql<{
    requested: number;
    attempted: number;
    succeeded: number;
    failed: number;
    refused: number;
    retryable: number;
    ambiguous: number;
    observation_pending: number;
    resync_requested: number;
    resynchronized: number;
  }[]>`
    select count(*)::int as requested,
           count(*) filter (where attempt_count > 0)::int as attempted,
           count(*) filter (where row_status = 'accepted')::int as succeeded,
           count(*) filter (where row_status = 'failed')::int as failed,
           count(*) filter (where row_status = 'refused')::int as refused,
           count(*) filter (where row_status in ('pending', 'retryable'))::int as retryable,
           count(*) filter (where row_status = 'ambiguous')::int as ambiguous,
           count(*) filter (
             where row_status in ('accepted', 'ambiguous') and observation_status = 'pending'
           )::int as observation_pending,
           count(*) filter (
             where provider_evidence->>'outcome' in ('accepted', 'ambiguous')
           )::int as resync_requested,
           count(*) filter (where observation_status = 'observed')::int as resynchronized
      from public.amazon_write_rows where execution_id = ${executionId}
  `;
  if (!counts || counts.requested === 0) throw new Error('Amazon write execution has no rows');
  const status: AmazonWriteExecutionStatus = counts.retryable > 0
    ? 'running'
    : counts.observation_pending > 0 ? 'awaiting_sync'
      : counts.succeeded > 0 && counts.failed + counts.refused > 0 ? 'partial'
        : counts.succeeded > 0 ? 'awaiting_sync'
          : counts.failed > 0 && counts.refused > 0 ? 'partial'
            : counts.refused > 0 ? 'refused' : counts.failed > 0 ? 'failed' : 'running';
  await sql`
    update public.amazon_write_executions
       set status = ${status}::public.amazon_write_execution_status,
           requested_count = ${counts.requested}, attempted_count = ${counts.attempted},
           succeeded_count = ${counts.succeeded}, failed_count = ${counts.failed},
           ambiguous_count = ${counts.ambiguous},
           refused_count = ${counts.refused}, resync_requested_count = ${counts.resync_requested},
           resynchronized_count = ${counts.resynchronized},
           completed_at = case when ${status} in ('failed', 'refused') then now() else null end
     where id = ${executionId}
  `;
  return {
    status,
    accounting: AmazonWriteAccounting.parse({
      requested: counts.requested, attempted: counts.attempted,
      succeeded: counts.succeeded, failed: counts.failed, ambiguous: counts.ambiguous,
      refused: counts.refused,
      resyncRequested: counts.resync_requested, resynchronized: counts.resynchronized,
    }),
    retryable: counts.retryable,
    shouldObserve: counts.observation_pending > 0,
  };
}

async function readAccounting(sql: QuerySql, executionId: string): Promise<AmazonWriteAccounting> {
  const [row] = await sql<{
    requested_count: number; attempted_count: number; succeeded_count: number;
    failed_count: number; ambiguous_count: number; refused_count: number;
    resync_requested_count: number;
    resynchronized_count: number;
  }[]>`
    select requested_count, attempted_count, succeeded_count, failed_count,
           ambiguous_count, refused_count, resync_requested_count, resynchronized_count
      from public.amazon_write_executions where id = ${executionId}
  `;
  if (!row) throw new Error('Amazon write accounting is missing');
  return AmazonWriteAccounting.parse({
    requested: row.requested_count, attempted: row.attempted_count,
    succeeded: row.succeeded_count, failed: row.failed_count,
    ambiguous: row.ambiguous_count, refused: row.refused_count,
    resyncRequested: row.resync_requested_count, resynchronized: row.resynchronized_count,
  });
}

export interface AmazonWriteObservationRow {
  writeRowId: string;
  action: AmazonWriteAction;
}

export async function listAmazonWriteObservationRows(
  handle: AmazonWriteQueryHandle,
  input: { orgId: string; profileId: string; executionId: string },
): Promise<AmazonWriteObservationRow[]> {
  const rows = await handle.sql<{ id: string; action: unknown }[]>`
    select id, action from public.amazon_write_rows
     where org_id = ${input.orgId} and profile_id = ${input.profileId}
       and execution_id = ${input.executionId}
       and row_status in ('accepted', 'ambiguous') and observation_status = 'pending'
     order by created_at, id
  `;
  return rows.map((row) => ({ writeRowId: row.id, action: AmazonWriteAction.parse(row.action) }));
}

export interface AmazonWriteObservation {
  writeRowId: string;
  state: 'observed' | 'pending' | 'conflict';
  currentValue: ApplyValue | null;
}

export interface RecordedAmazonWriteObservation {
  status: AmazonWriteExecutionStatus;
  accounting: AmazonWriteAccounting;
  pending: number;
  inverseReady: boolean;
}

export async function recordAmazonWriteObservations(
  handle: AmazonWriteQueryHandle,
  input: {
    orgId: string;
    profileId: string;
    executionId: string;
    observedAt: Date;
    attempt: number;
    observations: readonly AmazonWriteObservation[];
  },
): Promise<RecordedAmazonWriteObservation> {
  return handle.sql.begin(async (sql) => {
    const [execution] = await sql<{
      id: string; apply_batch_id: string; requested_count: number;
      succeeded_count: number; failed_count: number; refused_count: number;
    }[]>`
      select id, apply_batch_id, requested_count, succeeded_count, failed_count, refused_count
        from public.amazon_write_executions
       where org_id = ${input.orgId} and profile_id = ${input.profileId}
         and id = ${input.executionId}
       for update
    `;
    if (!execution) throw new Error('Amazon write execution does not exist in this profile');
    const offered = await sql<{ id: string; apply_row_id: string; action: unknown }[]>`
      select id, apply_row_id, action from public.amazon_write_rows
       where org_id = ${input.orgId} and profile_id = ${input.profileId}
         and execution_id = ${input.executionId}
         and row_status in ('accepted', 'ambiguous') and observation_status = 'pending'
       for update
    `;
    if (offered.length !== input.observations.length) {
      throw new Error(`Amazon observation offered ${offered.length} rows but classified ${input.observations.length}`);
    }
    const offeredById = new Map(offered.map((row) => [row.id, row] as const));
    for (const observation of input.observations) {
      const row = offeredById.get(observation.writeRowId);
      if (!row) throw new Error(`Amazon observation names unknown row ${observation.writeRowId}`);
      const action = AmazonWriteAction.parse(row.action);
      if (observation.state === 'pending') {
        await sql`
          update public.amazon_write_rows set current_observed_value = ${json(observation.currentValue)}::jsonb
           where id = ${row.id}
        `;
        continue;
      }
      const updated = await sql<{ id: string }[]>`
        update public.amazon_write_rows
           set row_status = case
                 when row_status = 'ambiguous' and ${observation.state} = 'observed'
                   then 'accepted'::public.amazon_write_row_status
                 when row_status = 'ambiguous' and ${observation.state} = 'conflict'
                   then 'failed'::public.amazon_write_row_status
                 else row_status
               end,
               observation_status = ${observation.state}::public.amazon_write_observation_status,
               current_observed_value = ${json(observation.currentValue)}::jsonb,
               observed_at = ${input.observedAt.toISOString()}
         where id = ${row.id} and observation_status = 'pending'
        returning id
      `;
      if (updated.length !== 1) throw new Error(`Amazon observation did not update row ${row.id}`);
      if (observation.state === 'observed') {
        await sql`
          insert into public.entity_changes
            (org_id, profile_id, entity_type, amazon_id, field, old_value, new_value,
             source, apply_batch_id, apply_row_id, observed_at)
          values (${input.orgId}, ${input.profileId},
                  ${action.actionType === 'sp_campaign_placement' ? 'campaign' : action.actionType === 'sp_keyword_bid' ? 'keyword' : 'target'}::public.entity_type,
                  ${action.amazonEntityId}, ${action.field}, ${json(action.expectedValue)}::jsonb,
                  ${json(action.requestedValue)}::jsonb, 'apply', ${execution.apply_batch_id},
                  ${row.apply_row_id}, ${input.observedAt.toISOString()})
          on conflict (apply_row_id) where apply_row_id is not null do nothing
        `;
      }
    }

    const [counts] = await sql<{
      observed: number; conflicts: number; pending: number;
      attempted: number; succeeded: number; failed: number; refused: number;
      ambiguous: number; resync_requested: number;
    }[]>`
      select count(*) filter (where observation_status = 'observed')::int as observed,
             count(*) filter (where observation_status = 'conflict')::int as conflicts,
             count(*) filter (
               where row_status in ('accepted', 'ambiguous') and observation_status = 'pending'
             )::int as pending,
             count(*) filter (where attempt_count > 0)::int as attempted,
             count(*) filter (where row_status = 'accepted')::int as succeeded,
             count(*) filter (where row_status = 'failed')::int as failed,
             count(*) filter (where row_status = 'ambiguous')::int as ambiguous,
             count(*) filter (where row_status = 'refused')::int as refused,
             count(*) filter (
               where provider_evidence->>'outcome' in ('accepted', 'ambiguous')
             )::int as resync_requested
        from public.amazon_write_rows where execution_id = ${execution.id}
    `;
    if (!counts) throw new Error('Amazon write observation accounting is missing');
    const fullyObserved = counts.observed === execution.requested_count
      && counts.failed === 0 && counts.refused === 0;
    const status: AmazonWriteExecutionStatus = fullyObserved ? 'succeeded'
      : counts.conflicts > 0 ? 'conflict'
        : counts.pending > 0 ? 'awaiting_sync'
          : counts.succeeded > 0 && counts.failed + counts.refused > 0 ? 'partial'
            : counts.refused > 0 ? 'refused' : counts.failed > 0 ? 'failed' : 'awaiting_sync';
    await sql`
      update public.amazon_write_executions
         set status = ${status}::public.amazon_write_execution_status,
             attempted_count = ${counts.attempted},
             succeeded_count = ${counts.succeeded},
             failed_count = ${counts.failed},
             ambiguous_count = ${counts.ambiguous},
             refused_count = ${counts.refused},
             resync_requested_count = ${counts.resync_requested},
             resynchronized_count = ${counts.observed},
             observation_attempts = greatest(observation_attempts, ${input.attempt + 1}),
             inverse_ready_at = case when ${fullyObserved} then ${input.observedAt.toISOString()}::timestamptz else null end,
             completed_at = case when ${status} in ('succeeded', 'conflict')
               then ${input.observedAt.toISOString()}::timestamptz else completed_at end
       where id = ${execution.id}
    `;
    if (fullyObserved) {
      await sql`
        update public.apply_batches
           set status = 'applied', applied_at = ${input.observedAt.toISOString()},
               applied_on = ${input.observedAt.toISOString()}::timestamptz::date
         where id = ${execution.apply_batch_id} and status = 'staged'
      `;
    }
    return {
      status,
      accounting: await readAccounting(sql, execution.id),
      pending: counts.pending,
      inverseReady: fullyObserved,
    };
  });
}

export interface AmazonWriteInversePreview {
  executionId: string;
  sourceApplyBatchId: string;
  inverseReadyAt: Date;
  inversePreapproved: boolean;
  actions: AmazonWriteAction[];
}

function setPlacementValue(
  action: Extract<AmazonWriteAction, { actionType: 'sp_campaign_placement' }>,
): Extract<AmazonWriteAction, { actionType: 'sp_campaign_placement' }>['campaignContext']['placementBidding'] {
  const bidding = { ...action.campaignContext.placementBidding };
  if (action.field === 'top_of_search') bidding.topOfSearch = action.requestedValue;
  if (action.field === 'product_pages') bidding.productPages = action.requestedValue;
  if (action.field === 'rest_of_search') bidding.restOfSearch = action.requestedValue;
  return bidding;
}

/** Return the exact inverse only after every forward value was synchronized. */
export async function getAmazonWriteInversePreview(
  handle: AmazonWriteQueryHandle,
  input: { orgId: string; profileId: string; executionId: string },
): Promise<AmazonWriteInversePreview> {
  const [header] = await handle.sql<{
    apply_batch_id: string;
    inverse_ready_at: Date | string | null;
    inverse_preapproved: boolean;
    status: AmazonWriteExecutionStatus;
  }[]>`
    select execution.apply_batch_id, execution.inverse_ready_at,
           approval.inverse_preapproved, execution.status::text as status
      from public.amazon_write_executions execution
      join public.amazon_write_approvals approval on approval.id = execution.approval_id
     where execution.org_id = ${input.orgId} and execution.profile_id = ${input.profileId}
       and execution.id = ${input.executionId}
  `;
  const readyAt = toDateOrNull(header?.inverse_ready_at ?? null);
  if (!header || header.status !== 'succeeded' || readyAt === null) {
    throw new Error('Amazon write inverse is blocked until every expected value is synchronized');
  }
  const forward = await loadExecutionActions(handle.sql, input.orgId, input.profileId, input.executionId);
  const actions = forward.map((action): AmazonWriteAction => {
    if (action.actionType === 'sp_campaign_placement') {
      return AmazonWriteAction.parse({
        ...action,
        expectedValue: action.requestedValue,
        requestedValue: action.inverseValue,
        inverseValue: action.requestedValue,
        campaignContext: {
          ...action.campaignContext,
          placementBidding: setPlacementValue(action),
        },
      });
    }
    return AmazonWriteAction.parse({
      ...action,
      expectedValue: action.requestedValue,
      requestedValue: action.inverseValue,
      inverseValue: action.requestedValue,
    });
  });
  return {
    executionId: input.executionId,
    sourceApplyBatchId: header.apply_batch_id,
    inverseReadyAt: readyAt,
    inversePreapproved: header.inverse_preapproved,
    actions,
  };
}
