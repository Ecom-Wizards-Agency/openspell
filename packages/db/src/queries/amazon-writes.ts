import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  AmazonWriteAction,
  AmazonWriteAccounting,
  AmazonWriteProviderEvidence,
  AmazonWriteProviderCallEvidence,
  ApproveAmazonWriteExecution,
  Uuid,
  serializeApplyRows,
  type AmazonPlacementField,
  type CampaignWriteContext,
  type AmazonWriteExecutionStatus,
  type ApplyRow,
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

/**
 * Bind replay identity to the complete immutable approval scope. Callers do
 * not choose this key: the service derives it after contract validation.
 */
export function amazonWriteExecutionIdempotencyKey(
  input: ApproveAmazonWriteExecutionInput,
  actorId: string,
): string {
  const parsed = ApproveAmazonWriteExecution.parse(input);
  return createHash('sha256').update(JSON.stringify([
    'openspell.amazon-write-execution.v1',
    parsed.orgId,
    parsed.profileId,
    parsed.applyBatchId,
    actorId,
    parsed.approvalMode,
    parsed.expiresAt,
    parsed.previewSha256,
    parsed.expectedCount,
    parsed.inversePreapproved,
    parsed.authorizationId,
    parsed.authorizationSha256,
  ])).digest('hex');
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
  entity_name: string | null;
  clicks: number | null;
  revenue: number | null;
}

interface CampaignContextRow {
  amazon_id: string;
  ad_product: string;
  bidding_strategy: 'legacy_for_sales' | 'auto_for_sales' | 'manual' | 'rule_based' | null;
  campaign_write_context: CampaignWriteContext | null;
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

function validateActionValue(action: 'bid' | 'placement', oldValue: number, newValue: number): void {
  if (action === 'bid') {
    if (oldValue <= 0 || newValue <= 0) throw new Error('Sponsored Products bids must be positive');
    if ([oldValue, newValue].some((value) =>
      Math.abs(value * 100 - Math.round(value * 100)) > 1e-8)) {
      throw new Error('Sponsored Products bids require exact currency-minor-unit precision');
    }
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
    if (!campaign || campaign.ad_product !== 'SP' || campaign.bidding_strategy === null
      || campaign.campaign_write_context === null) {
      throw new Error(`campaign ${row.entity_id} has no complete synchronized Sponsored Products write context`);
    }
    const providerPlacement = campaign.campaign_write_context.placementBidding.find((entry) =>
      entry.placement === (field === 'top_of_search' ? 'PLACEMENT_TOP'
        : field === 'product_pages' ? 'PLACEMENT_PRODUCT_PAGE' : 'PLACEMENT_REST_OF_SEARCH'),
    );
    if (providerPlacement === undefined || !Object.is(providerPlacement.percentage, expectedValue)) {
      throw new Error(`campaign ${row.entity_id} placement display and complete provider context disagree`);
    }
    return AmazonWriteAction.parse({
      actionType: 'sp_campaign_placement', applyRowId: row.id,
      amazonEntityId: row.entity_id, field, expectedValue, requestedValue,
      inverseValue: expectedValue,
      campaignContext: {
        providerState: campaign.campaign_write_context,
      },
    });
  }
  throw new Error(`apply row ${row.id} is not an implemented Sponsored Products mutation`);
}

function placementProviderName(field: AmazonPlacementField) {
  if (field === 'top_of_search') return 'PLACEMENT_TOP' as const;
  if (field === 'product_pages') return 'PLACEMENT_PRODUCT_PAGE' as const;
  return 'PLACEMENT_REST_OF_SEARCH' as const;
}

function withPlacementValue(
  context: CampaignWriteContext,
  field: AmazonPlacementField,
  value: number,
): CampaignWriteContext {
  const placement = placementProviderName(field);
  let found = false;
  const placementBidding = context.placementBidding.map((entry) => {
    if (entry.placement !== placement) return entry;
    found = true;
    return { ...entry, percentage: value };
  });
  if (!found) placementBidding.push({ placement, percentage: value });
  placementBidding.sort((left, right) => left.placement.localeCompare(right.placement));
  return { ...context, placementBidding };
}

/** Freeze inverses against the complete combined forward state per campaign. */
function materializeInverseActions(actions: readonly AmazonWriteAction[]): AmazonWriteAction[] {
  const forwardContextByCampaign = new Map<string, CampaignWriteContext>();
  for (const action of actions) {
    if (action.actionType !== 'sp_campaign_placement') continue;
    const current = forwardContextByCampaign.get(action.amazonEntityId)
      ?? action.campaignContext.providerState;
    forwardContextByCampaign.set(
      action.amazonEntityId,
      withPlacementValue(current, action.field, action.requestedValue),
    );
  }
  return actions.map((action) => {
    if (action.actionType === 'sp_campaign_placement') {
      const forwardContext = forwardContextByCampaign.get(action.amazonEntityId);
      if (!forwardContext) throw new Error('placement inverse has no materialized forward context');
      return AmazonWriteAction.parse({
        ...action,
        expectedValue: action.requestedValue,
        requestedValue: action.inverseValue,
        inverseValue: action.requestedValue,
        campaignContext: { providerState: forwardContext },
      });
    }
    return AmazonWriteAction.parse({
      ...action,
      expectedValue: action.requestedValue,
      requestedValue: action.inverseValue,
      inverseValue: action.requestedValue,
    });
  });
}

/**
 * Freeze one current export as an approved execution. All offered rows are
 * locked, current-state checked, materialized as typed provider actions, and
 * counted in the same transaction.
 */
export async function approveAmazonWriteExecution(
  serviceHandle: AmazonWriteQueryHandle,
  authenticatedHandle: AmazonWriteQueryHandle,
  rawInput: ApproveAmazonWriteExecutionInput,
): Promise<ApprovedAmazonWriteExecution> {
  const input = ApproveAmazonWriteExecution.parse(rawInput);
  const [session] = await authenticatedHandle.sql<{ actor_id: string | null }[]>`
    select auth.uid()::text as actor_id
  `;
  if (!session?.actor_id) {
    throw new Error('Amazon write approval requires an authenticated operator session');
  }
  const actorId = session.actor_id;
  return serviceHandle.sql.begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${
      `amazon-write:${input.orgId}:${input.profileId}`
    }, 0))`;

    const [clock] = await sql<{ approved_at: Date | string }[]>`
      select clock_timestamp() as approved_at
    `;
    if (!clock) throw new Error('Amazon write approval clock is unavailable');
    const approvedAt = toDate(clock.approved_at);
    const idempotencyKey = amazonWriteExecutionIdempotencyKey(input, actorId);

    const [approver] = await sql<{ role: string }[]>`
      select role::text as role from public.org_members
       where org_id = ${input.orgId} and user_id = ${actorId}
         and role in ('owner', 'admin')
    `;
    if (!approver) throw new Error('Amazon write approval requires an owner or admin in this organization');

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
       where execution.idempotency_key = ${idempotencyKey}
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
    if (toDate(input.expiresAt).getTime() <= approvedAt.getTime()) {
      throw new Error('Amazon write approval expires before it is valid');
    }

    const rows = await sql<ApplyRowForApproval[]>`
      select id, entity_type::text as entity_type, entity_id, field, old_value, new_value,
             entity_name, clicks::float8 as clicks, revenue::float8 as revenue
        from public.apply_rows
       where org_id = ${input.orgId} and profile_id = ${input.profileId}
         and batch_id = ${input.applyBatchId}
       order by artifact_ordinal
       for update
    `;
    if (rows.length !== input.expectedCount) {
      throw new Error(`Amazon write approval offered ${input.expectedCount} rows but loaded ${rows.length}`);
    }
    const artifactRows: ApplyRow[] = rows.map((row) => ({
      entityType: row.entity_type,
      entityId: row.entity_id,
      field: row.field,
      old: row.old_value as ApplyValue,
      new: row.new_value as ApplyValue,
      ...(row.entity_name === null ? {} : { name: row.entity_name }),
      ...(row.clicks === null ? {} : { clicks: row.clicks }),
      ...(row.revenue === null ? {} : { revenue: row.revenue }),
    }));
    const lockedArtifactSha256 = createHash('sha256')
      .update(serializeApplyRows(artifactRows))
      .digest('hex');
    if (lockedArtifactSha256 !== batch.artifact_sha256
      || lockedArtifactSha256 !== input.previewSha256) {
      throw new Error('Amazon write preview fingerprint does not match its locked rows');
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
             bidding_strategy::text as bidding_strategy,
             campaign_write_context
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
    const inverseActions = materializeInverseActions(actions);

    const [approval] = await sql<{ id: string }[]>`
      insert into public.amazon_write_approvals
        (org_id, profile_id, apply_batch_id, mode, preview_sha256, approved_count,
         approved_by, approved_at, expires_at, inverse_preapproved, authorization_id,
         authorization_sha256)
      values (${input.orgId}, ${input.profileId}, ${input.applyBatchId}, ${input.approvalMode},
              ${input.previewSha256}, ${input.expectedCount}, ${actorId},
              ${approvedAt.toISOString()}, ${input.expiresAt}, ${input.inversePreapproved},
              ${input.authorizationId}, ${input.authorizationSha256})
      returning id
    `;
    if (!approval) throw new Error('Amazon write approval was not recorded');

    const [execution] = await sql<{ id: string }[]>`
      insert into public.amazon_write_executions
        (org_id, profile_id, apply_batch_id, approval_id, idempotency_key, requested_count)
      values (${input.orgId}, ${input.profileId}, ${input.applyBatchId}, ${approval.id},
              ${idempotencyKey}, ${input.expectedCount})
      returning id
    `;
    if (!execution) throw new Error('Amazon write execution was not recorded');

    if (input.inversePreapproved) {
      if (input.authorizationId === null || input.authorizationSha256 === null) {
        throw new Error('preapproved inverse requires a bounded authorization fingerprint');
      }
      await sql`
        insert into public.amazon_write_inverse_reservations
          (org_id, profile_id, forward_execution_id, authorization_id, authorization_sha256)
        values (${input.orgId}, ${input.profileId}, ${execution.id},
                ${input.authorizationId}, ${input.authorizationSha256})
      `;
    }

    const inserted = await sql<{ id: string }[]>`
      insert into public.amazon_write_rows
        (org_id, profile_id, execution_id, apply_row_id, action_type, action,
         expected_value, requested_value, inverse_value, inverse_action)
      select ${input.orgId}, ${input.profileId}, ${execution.id},
             offered.apply_row_id::uuid,
             offered.action_type::public.amazon_write_action_type,
             offered.action::jsonb, offered.expected_value::jsonb,
             offered.requested_value::jsonb, offered.inverse_value::jsonb,
             offered.inverse_action::jsonb
        from unnest(
          ${actions.map((action) => action.applyRowId)}::text[],
          ${actions.map((action) => action.actionType)}::text[],
          ${actions.map((action) => json(action))}::text[],
          ${actions.map((action) => json(action.expectedValue))}::text[],
          ${actions.map((action) => json(action.requestedValue))}::text[],
          ${actions.map((action) => json(action.inverseValue))}::text[],
          ${inverseActions.map((action) => json(action))}::text[]
        ) as offered(apply_row_id, action_type, action, expected_value, requested_value, inverse_value, inverse_action)
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

async function currentAmazonWriteConflicts(
  sql: QuerySql,
  input: {
    orgId: string;
    profileId: string;
    actions: readonly { id: string; action: AmazonWriteAction }[];
  },
): Promise<string[]> {
  const targets = input.actions.map(({ id, action }) => ({
    key: id,
    entityType: action.actionType === 'sp_campaign_placement' ? 'placement' as const
      : action.actionType === 'sp_keyword_bid' ? 'keyword' as const : 'target' as const,
    entityId: action.amazonEntityId,
    field: action.field,
  }));
  await lockCurrentApplyStates({ sql }, {
    orgId: input.orgId, profileId: input.profileId, targets,
  });
  const current = await resolveCurrentApplyStates({ sql }, {
    orgId: input.orgId, profileId: input.profileId, targets,
  });
  const currentByRow = new Map(current.map((state) => [state.key, state] as const));
  const conflicts: string[] = [];
  for (const { id, action } of input.actions) {
    const state = currentByRow.get(id);
    if (!state?.supported || !state.present || !sameNumber(state.currentValue, action.expectedValue)) {
      conflicts.push(id);
    }
  }
  const placementActions = input.actions.filter((entry): entry is typeof entry & {
    action: Extract<AmazonWriteAction, { actionType: 'sp_campaign_placement' }>;
  } => entry.action.actionType === 'sp_campaign_placement');
  if (placementActions.length > 0) {
    const campaignIds = [...new Set(placementActions.map((entry) => entry.action.amazonEntityId))];
    const contexts = await sql<{
      amazon_id: string;
      campaign_write_context: CampaignWriteContext | null;
    }[]>`
      select amazon_id, campaign_write_context from public.campaigns
       where org_id = ${input.orgId} and profile_id = ${input.profileId}
         and amazon_id = any(${campaignIds}::text[])
       for share
    `;
    const contextByCampaign = new Map(contexts.map((row) => [row.amazon_id, row.campaign_write_context] as const));
    for (const entry of placementActions) {
      if (!isDeepStrictEqual(
        contextByCampaign.get(entry.action.amazonEntityId) ?? null,
        entry.action.campaignContext.providerState,
      )) conflicts.push(entry.id);
    }
  }
  return [...new Set(conflicts)];
}

async function loadExecutionActions(
  sql: QuerySql,
  orgId: string,
  profileId: string,
  executionId: string,
): Promise<AmazonWriteAction[]> {
  const rows = await sql<{ action: unknown }[]>`
    select write_row.action from public.amazon_write_rows write_row
    join public.apply_rows apply_row on apply_row.id = write_row.apply_row_id
     where write_row.org_id = ${orgId} and write_row.profile_id = ${profileId}
       and write_row.execution_id = ${executionId}
     order by apply_row.artifact_ordinal
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
  recoveryObservation: boolean;
  direction: 'forward' | 'inverse';
  retryAfterSeconds?: number;
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
  authorization_id: string | null;
  authorization_sha256: string | null;
  direction: 'forward' | 'inverse';
  batch_status: string;
  dispatch_lease_token: string | null;
  dispatch_lease_expires_at: Date | string | null;
  created_at: Date | string;
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
    authorizationId: string | null;
    authorizationSha256: string | null;
    maxRowsPerExecution: number;
    maxTotalExecutions: number;
    dispatchLeaseToken: string;
    dispatchLeaseExpiresAt: Date;
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
             approval.inverse_preapproved, approval.authorization_id,
             approval.authorization_sha256, execution.direction::text as direction,
             batch.status::text as batch_status,
             execution.dispatch_lease_token, execution.dispatch_lease_expires_at,
             execution.created_at
        from public.amazon_write_executions execution
        join public.amazon_write_approvals approval
          on approval.org_id = execution.org_id
         and approval.profile_id = execution.profile_id
         and approval.id = execution.approval_id
        join public.apply_batches batch
          on batch.org_id = execution.org_id
         and batch.profile_id = execution.profile_id
         and batch.id = execution.apply_batch_id
       where execution.org_id = ${input.orgId}
         and execution.profile_id = ${input.profileId}
         and execution.id = ${input.executionId}
       for update of execution
    `;
    if (!execution) throw new Error('Amazon write execution does not exist in this profile');
    if (['awaiting_sync', 'succeeded', 'partial', 'refused', 'failed', 'conflict'].includes(execution.status)) {
      return {
        executionId: execution.id, applyBatchId: execution.apply_batch_id,
        approvalMode: execution.mode, inversePreapproved: execution.inverse_preapproved,
        expiresAt: toDate(execution.expires_at), status: execution.status,
        requested: execution.requested_count, rows: [], replayed: true, recoveryObservation: false,
        direction: execution.direction,
      };
    }
    if (execution.batch_status !== 'staged') {
      await refuseExecutionRows(sql, execution.id, 'apply batch is no longer staged');
      return {
        executionId: execution.id, applyBatchId: execution.apply_batch_id,
        approvalMode: execution.mode, inversePreapproved: execution.inverse_preapproved,
        expiresAt: toDate(execution.expires_at), status: 'refused',
        requested: execution.requested_count, rows: [], replayed: false,
        recoveryObservation: false, direction: execution.direction,
      };
    }
    if (execution.mode !== 'bounded_live_test'
      || execution.authorization_id !== input.authorizationId
      || execution.authorization_sha256 !== input.authorizationSha256) {
      await refuseExecutionRows(sql, execution.id, 'execution is not bound to the active bounded authorization');
      return {
        executionId: execution.id, applyBatchId: execution.apply_batch_id,
        approvalMode: execution.mode, inversePreapproved: execution.inverse_preapproved,
        expiresAt: toDate(execution.expires_at), status: 'refused',
        requested: execution.requested_count, rows: [], replayed: false, recoveryObservation: false,
        direction: execution.direction,
      };
    }
    if (execution.requested_count > input.maxRowsPerExecution) {
      await refuseExecutionRows(sql, execution.id, 'execution exceeds the bounded row budget');
      return {
        executionId: execution.id, applyBatchId: execution.apply_batch_id,
        approvalMode: execution.mode, inversePreapproved: execution.inverse_preapproved,
        expiresAt: toDate(execution.expires_at), status: 'refused',
        requested: execution.requested_count, rows: [], replayed: false, recoveryObservation: false,
        direction: execution.direction,
      };
    }
    if (execution.direction === 'forward' && execution.inverse_preapproved) {
      const [reservation] = await sql<{ id: string }[]>`
        select id from public.amazon_write_inverse_reservations
         where org_id = ${input.orgId} and profile_id = ${input.profileId}
           and forward_execution_id = ${execution.id}
           and authorization_id = ${input.authorizationId}
           and authorization_sha256 = ${input.authorizationSha256}
         for update
      `;
      if (!reservation) {
        await refuseExecutionRows(sql, execution.id, 'preapproved inverse reservation is missing');
        return {
          executionId: execution.id, applyBatchId: execution.apply_batch_id,
          approvalMode: execution.mode, inversePreapproved: execution.inverse_preapproved,
          expiresAt: toDate(execution.expires_at), status: 'refused',
          requested: execution.requested_count, rows: [], replayed: false,
          recoveryObservation: false, direction: execution.direction,
        };
      }
    }
    const [authorizationUse] = await sql<{ count: number }[]>`
      select (
        (select count(*) from public.amazon_write_executions used_execution
          join public.amazon_write_approvals used_approval on used_approval.id = used_execution.approval_id
         where used_approval.authorization_id = ${input.authorizationId}
           and used_approval.authorization_sha256 = ${input.authorizationSha256})
        +
        (select count(*) from public.amazon_write_inverse_reservations reservation
         where reservation.authorization_id = ${input.authorizationId}
           and reservation.authorization_sha256 = ${input.authorizationSha256}
           and reservation.inverse_execution_id is null)
      )::int as count
    `;
    if ((authorizationUse?.count ?? 0) > input.maxTotalExecutions) {
      await refuseExecutionRows(sql, execution.id, 'bounded authorization execution budget is exhausted');
      return {
        executionId: execution.id, applyBatchId: execution.apply_batch_id,
        approvalMode: execution.mode, inversePreapproved: execution.inverse_preapproved,
        expiresAt: toDate(execution.expires_at), status: 'refused',
        requested: execution.requested_count, rows: [], replayed: false, recoveryObservation: false,
        direction: execution.direction,
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
        requested: execution.requested_count, rows: [], replayed: false, recoveryObservation: false,
        direction: execution.direction,
      };
    }
    const stored = await sql<StoredWriteRow[]>`
      select write_row.id, write_row.apply_row_id, write_row.action,
             write_row.row_status::text as row_status,
             write_row.observation_status::text as observation_status,
             write_row.attempt_count
        from public.amazon_write_rows write_row
        join public.apply_rows apply_row on apply_row.id = write_row.apply_row_id
       where write_row.org_id = ${input.orgId} and write_row.profile_id = ${input.profileId}
         and write_row.execution_id = ${input.executionId}
       order by apply_row.artifact_ordinal
       for update of write_row
    `;
    if (stored.length !== execution.requested_count) {
      throw new Error(`Amazon write execution requested ${execution.requested_count} rows but loaded ${stored.length}`);
    }
    if (execution.status === 'running') {
      const leaseExpiresAt = toDateOrNull(execution.dispatch_lease_expires_at);
      if (leaseExpiresAt !== null && leaseExpiresAt.getTime() > input.now.getTime()) {
        return {
          executionId: execution.id, applyBatchId: execution.apply_batch_id,
          approvalMode: execution.mode, inversePreapproved: execution.inverse_preapproved,
          expiresAt: toDate(execution.expires_at), status: execution.status,
          requested: execution.requested_count, rows: [], replayed: true, recoveryObservation: false,
          direction: execution.direction,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((leaseExpiresAt.getTime() - input.now.getTime()) / 1_000),
          ),
        };
      }
      if (stored.some((row) => row.row_status === 'dispatched')) {
        await sql`
          update public.amazon_write_executions
             set status = 'awaiting_sync', dispatch_lease_token = null,
                 dispatch_lease_expires_at = null
           where id = ${execution.id}
        `;
        return {
          executionId: execution.id, applyBatchId: execution.apply_batch_id,
          approvalMode: execution.mode, inversePreapproved: execution.inverse_preapproved,
          expiresAt: toDate(execution.expires_at), status: 'awaiting_sync',
          requested: execution.requested_count, rows: [], replayed: true, recoveryObservation: true,
          direction: execution.direction,
        };
      }
    }
    if (execution.direction === 'forward') {
      const [earlierCycle] = await sql<{ id: string }[]>`
        select prior.id
          from public.amazon_write_executions prior
          join public.amazon_write_approvals prior_approval
            on prior_approval.id = prior.approval_id
          left join public.amazon_write_inverse_reservations reservation
            on reservation.forward_execution_id = prior.id
          left join public.amazon_write_executions inverse
            on inverse.id = reservation.inverse_execution_id
         where prior.org_id = ${input.orgId}
           and prior.profile_id = ${input.profileId}
           and prior.direction = 'forward'
           and prior.id <> ${execution.id}
           and (prior.created_at, prior.id) <
               (${toDate(execution.created_at).toISOString()}::timestamptz, ${execution.id}::uuid)
           and (
             prior.status in ('queued', 'running', 'awaiting_sync', 'conflict')
             or (
               prior.status in ('succeeded', 'partial')
               and prior.succeeded_count > 0
               and coalesce(inverse.status::text, 'missing') <> 'succeeded'
             )
           )
         order by prior.created_at
         limit 1
         for share of prior
      `;
      if (earlierCycle) {
        throw new Error('an earlier bounded Amazon write cycle is still unresolved for this profile');
      }
    }
    const [active] = await sql<{ count: number }[]>`
      select count(*)::int as count from public.amazon_write_executions
       where status = 'running' and id <> ${execution.id}
         and dispatch_lease_expires_at > ${input.now.toISOString()}
    `;
    if ((active?.count ?? 0) >= input.maxConcurrentMutations) {
      throw new Error('Amazon write concurrency gate is occupied');
    }
    const unresolved = stored.filter((row) => row.row_status === 'pending' || row.row_status === 'retryable');
    if (unresolved.length === 0) {
      return {
        executionId: execution.id, applyBatchId: execution.apply_batch_id,
        approvalMode: execution.mode, inversePreapproved: execution.inverse_preapproved,
        expiresAt: toDate(execution.expires_at), status: execution.status,
        requested: execution.requested_count, rows: [], replayed: true, recoveryObservation: false,
        direction: execution.direction,
      };
    }
    const actions = unresolved.map((row) => ({ row, action: AmazonWriteAction.parse(row.action) }));
    const conflicts = await currentAmazonWriteConflicts(sql, {
      orgId: input.orgId,
      profileId: input.profileId,
      actions: actions.map(({ row, action }) => ({ id: row.id, action })),
    });
    if (conflicts.length > 0) {
      const conflictCount = new Set(conflicts).size;
      await refuseExecutionRows(sql, input.executionId, `current synchronized state changed for ${conflictCount} row(s)`);
      return {
        executionId: execution.id, applyBatchId: execution.apply_batch_id,
        approvalMode: execution.mode, inversePreapproved: execution.inverse_preapproved,
        expiresAt: toDate(execution.expires_at), status: 'refused',
        requested: execution.requested_count, rows: [], replayed: false, recoveryObservation: false,
        direction: execution.direction,
      };
    }
    await sql`
      update public.amazon_write_executions
         set status = 'running', started_at = coalesce(started_at, ${input.now.toISOString()}),
             dispatch_lease_token = ${input.dispatchLeaseToken},
             dispatch_lease_expires_at = ${input.dispatchLeaseExpiresAt.toISOString()}
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
      recoveryObservation: false,
      direction: execution.direction,
    };
  });
}

/** Recheck a targeted provider refresh before any mutation request is emitted. */
export async function recheckAmazonWriteCurrentState(
  handle: AmazonWriteQueryHandle,
  input: {
    orgId: string;
    profileId: string;
    executionId: string;
    leaseToken: string;
    rowIds: readonly string[];
  },
): Promise<boolean> {
  return handle.sql.begin(async (sql) => {
    const [execution] = await sql<{ id: string }[]>`
      select id from public.amazon_write_executions
       where org_id = ${input.orgId} and profile_id = ${input.profileId}
         and id = ${input.executionId} and status = 'running'
         and dispatch_lease_token = ${input.leaseToken}
         and dispatch_lease_expires_at > clock_timestamp()
       for update
    `;
    if (!execution) throw new Error('Amazon write freshness gate is unavailable');
    const stored = await sql<{ id: string; action: unknown }[]>`
      select id, action from public.amazon_write_rows
       where org_id = ${input.orgId} and profile_id = ${input.profileId}
         and execution_id = ${input.executionId}
         and id = any(${[...input.rowIds]}::uuid[])
         and row_status in ('pending', 'retryable')
       for update
    `;
    if (stored.length !== input.rowIds.length) {
      throw new Error('Amazon write freshness gate did not lock every offered row');
    }
    const conflicts = await currentAmazonWriteConflicts(sql, {
      orgId: input.orgId,
      profileId: input.profileId,
      actions: stored.map((row) => ({ id: row.id, action: AmazonWriteAction.parse(row.action) })),
    });
    if (conflicts.length === 0) return true;
    await refuseExecutionRows(
      sql,
      execution.id,
      `targeted Amazon refresh changed synchronized state for ${conflicts.length} row(s)`,
    );
    return false;
  });
}

/** Persist intent before the provider call so a process crash recovers by observing first. */
export async function markAmazonWriteRowsDispatched(
  handle: AmazonWriteQueryHandle,
  input: {
    orgId: string;
    profileId: string;
    executionId: string;
    leaseToken: string;
    rowIds: readonly string[];
    callId: string;
    providerOperation: AmazonWriteAction['actionType'];
    requestFingerprint: string;
    requestedEntityIds: readonly string[];
    authorizationId: string;
    authorizationSha256: string;
    leaseExpiresAt: Date;
    minimumExecutionExpiresAt: Date;
  },
): Promise<boolean> {
  if (input.rowIds.length === 0 || new Set(input.rowIds).size !== input.rowIds.length) {
    throw new Error('Amazon write dispatch requires unique rows');
  }
  if (input.requestedEntityIds.length === 0
    || new Set(input.requestedEntityIds).size !== input.requestedEntityIds.length) {
    throw new Error('Amazon provider dispatch requires unique entity identities');
  }
  return handle.sql.begin(async (sql) => {
    const [execution] = await sql<{
      id: string;
      inverse_preapproved: boolean;
      direction: 'forward' | 'inverse';
    }[]>`
      select execution.id, approval.inverse_preapproved,
             execution.direction::text as direction
        from public.amazon_write_executions execution
        join public.amazon_write_approvals approval on approval.id = execution.approval_id
        join public.apply_batches batch on batch.id = execution.apply_batch_id
       where execution.org_id = ${input.orgId} and execution.profile_id = ${input.profileId}
         and execution.id = ${input.executionId} and execution.status = 'running'
         and execution.dispatch_lease_token = ${input.leaseToken}
         and execution.dispatch_lease_expires_at > clock_timestamp()
         and approval.mode = 'bounded_live_test'
         and approval.authorization_id = ${input.authorizationId}
         and approval.authorization_sha256 = ${input.authorizationSha256}
         and approval.approved_at <= clock_timestamp()
         and approval.expires_at > clock_timestamp()
         and approval.expires_at >= ${input.minimumExecutionExpiresAt.toISOString()}
         and batch.status = 'staged'
       for update of execution
    `;
    if (!execution) throw new Error('Amazon write final dispatch gate is unavailable');
    if (execution.direction === 'forward' && execution.inverse_preapproved) {
      const [reservation] = await sql<{ id: string }[]>`
        select id from public.amazon_write_inverse_reservations
         where org_id = ${input.orgId} and profile_id = ${input.profileId}
           and forward_execution_id = ${execution.id}
           and authorization_id = ${input.authorizationId}
           and authorization_sha256 = ${input.authorizationSha256}
         for update
      `;
      if (!reservation) throw new Error('Amazon write inverse reservation changed before dispatch');
    }
    const stored = await sql<{ id: string; action: unknown }[]>`
      select write_row.id, write_row.action from public.amazon_write_rows write_row
      join public.apply_rows apply_row on apply_row.id = write_row.apply_row_id
       where write_row.org_id = ${input.orgId} and write_row.profile_id = ${input.profileId}
         and write_row.execution_id = ${input.executionId}
         and write_row.id = any(${[...input.rowIds]}::uuid[])
         and write_row.row_status in ('pending', 'retryable')
       order by apply_row.artifact_ordinal
       for update of write_row
    `;
    if (stored.length !== input.rowIds.length) {
      throw new Error(`Amazon write dispatch offered ${input.rowIds.length} rows but locked ${stored.length}`);
    }
    const actions = stored.map((row) => ({ id: row.id, action: AmazonWriteAction.parse(row.action) }));
    if (actions.some(({ action }) => action.actionType !== input.providerOperation)) {
      throw new Error('Amazon write dispatch mixes provider operations');
    }
    const storedEntityIds = [...new Set(actions.map(({ action }) => action.amazonEntityId))];
    if (!isDeepStrictEqual(storedEntityIds, [...input.requestedEntityIds])) {
      throw new Error('Amazon write dispatch entity identities do not match the locked rows');
    }
    const conflicts = await currentAmazonWriteConflicts(sql, {
      orgId: input.orgId, profileId: input.profileId, actions,
    });
    if (conflicts.length > 0) {
      await refuseExecutionRows(
        sql,
        execution.id,
        `Amazon write final dispatch conflict for ${conflicts.length} row(s)`,
      );
      return false;
    }
    await sql`
      insert into public.amazon_write_provider_call_events
        (org_id, profile_id, execution_id, call_id, event_type, provider_operation,
         request_fingerprint, requested_entity_ids, requested_count, accepted_count,
         failed_count, api_call_count, outcome, occurred_at)
      values (${input.orgId}, ${input.profileId}, ${input.executionId}, ${input.callId},
              'dispatch', ${input.providerOperation}, ${input.requestFingerprint},
              ${json([...input.requestedEntityIds])}::jsonb, ${input.requestedEntityIds.length},
              0, 0, 1, 'dispatched', clock_timestamp())
    `;
    const rows = await sql<{ id: string }[]>`
      update public.amazon_write_rows
         set row_status = 'dispatched', dispatch_token = ${input.callId},
             dispatched_at = clock_timestamp()
       where execution_id = ${input.executionId}
         and id = any(${[...input.rowIds]}::uuid[])
         and row_status in ('pending', 'retryable')
      returning id
    `;
    if (rows.length !== input.rowIds.length) throw new Error('Amazon write dispatch transition was incomplete');
    await sql`
      insert into public.sync_jobs
        (org_id, profile_id, job_type, payload, run_after, dedupe_key)
      values (${input.orgId}, ${input.profileId}, 'amazon.observe',
              ${json({ type: 'amazon.observe', orgId: input.orgId, profileId: input.profileId,
                executionId: input.executionId, generation: input.callId, attempt: 0 })}::jsonb,
              clock_timestamp() + interval '15 seconds',
              ${`amazon.observe:${input.executionId}:${input.callId}:0`})
      on conflict (org_id, dedupe_key) where dedupe_key is not null do nothing
    `;
    await sql`
      update public.amazon_write_executions
         set dispatch_lease_expires_at = ${input.leaseExpiresAt.toISOString()}
       where id = ${input.executionId}
    `;
    return true;
  });
}

/** Re-open only a request that Amazon explicitly rejected before mutation. */
export async function releaseAmazonWriteExecutionForRetry(
  handle: AmazonWriteQueryHandle,
  input: {
    orgId: string;
    profileId: string;
    executionId: string;
    leaseToken: string;
    callId: string;
    callEvidence: AmazonWriteProviderCallEvidence;
    rowIds: readonly string[];
  },
): Promise<void> {
  await handle.sql.begin(async (sql) => {
    const callEvidence = AmazonWriteProviderCallEvidence.parse(input.callEvidence);
    const [execution] = await sql<{ id: string }[]>`
      select id from public.amazon_write_executions
       where org_id = ${input.orgId} and profile_id = ${input.profileId}
         and id = ${input.executionId} and status = 'running'
         and dispatch_lease_token = ${input.leaseToken}
       for update
    `;
    if (!execution) throw new Error('running Amazon write execution is unavailable for retry release');
    const [call] = await sql<{
      provider_operation: AmazonWriteAction['actionType'];
      request_fingerprint: string;
      requested_entity_ids: string[];
      requested_count: number;
    }[]>`
      select provider_operation::text as provider_operation, request_fingerprint,
             requested_entity_ids, requested_count
        from public.amazon_write_provider_call_events
       where org_id = ${input.orgId} and profile_id = ${input.profileId}
         and execution_id = ${input.executionId} and call_id = ${input.callId}
         and event_type = 'dispatch'
       for share
    `;
    if (!call || call.requested_count !== callEvidence.requested) {
      throw new Error('Amazon write retry result does not match its durable provider call');
    }
    await sql`
      insert into public.amazon_write_provider_call_events
        (org_id, profile_id, execution_id, call_id, event_type, provider_operation,
         request_fingerprint, requested_entity_ids, requested_count, accepted_count,
         failed_count, api_call_count, outcome, code, message, occurred_at)
      values (${input.orgId}, ${input.profileId}, ${input.executionId}, ${input.callId},
              'result', ${call.provider_operation}, ${call.request_fingerprint},
              ${json(call.requested_entity_ids)}::jsonb, ${call.requested_count},
              ${callEvidence.accepted}, ${callEvidence.failed}, 0, ${callEvidence.outcome},
              ${callEvidence.code}, ${callEvidence.message}, clock_timestamp())
      on conflict (call_id, event_type) do nothing
    `;
    const released = await sql<{ id: string }[]>`
      update public.amazon_write_rows
         set row_status = 'retryable', dispatch_token = null
       where execution_id = ${execution.id}
         and id = any(${[...input.rowIds]}::uuid[])
         and row_status = 'dispatched' and dispatch_token = ${input.callId}
      returning id
    `;
    if (released.length !== input.rowIds.length) {
      throw new Error('Amazon write retry release does not match the durable dispatch group');
    }
    await sql`
      update public.amazon_write_executions
         set status = 'queued', dispatch_lease_token = null, dispatch_lease_expires_at = null
       where id = ${execution.id}
    `;
  });
}

async function refuseExecutionRows(sql: QuerySql, executionId: string, reason: string): Promise<void> {
  const rows = await sql<{ id: string }[]>`
    update public.amazon_write_rows
       set row_status = case when attempt_count = 0
             then 'refused'::public.amazon_write_row_status
             else 'failed'::public.amazon_write_row_status end,
           refusal_reason = ${reason}
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
    callId: string;
    callEvidence: AmazonWriteProviderCallEvidence;
    attemptedAt: Date;
    outcomes: readonly AmazonWriteRowOutcome[];
  },
): Promise<RecordedAmazonWriteOutcomes> {
  if (input.outcomes.length === 0) throw new Error('Amazon write outcome list is empty');
  return handle.sql.begin(async (sql) => {
    const callEvidence = AmazonWriteProviderCallEvidence.parse(input.callEvidence);
    const [execution] = await sql<{ id: string; requested_count: number }[]>`
      select id, requested_count from public.amazon_write_executions
       where org_id = ${input.orgId} and profile_id = ${input.profileId}
         and id = ${input.executionId}
       for update
    `;
    if (!execution) throw new Error('Amazon write execution does not exist in this profile');
    const unique = new Set(input.outcomes.map((outcome) => outcome.writeRowId));
    if (unique.size !== input.outcomes.length) throw new Error('Amazon write outcomes repeat a row');

    const [call] = await sql<{
      provider_operation: AmazonWriteAction['actionType'];
      request_fingerprint: string;
      requested_entity_ids: string[];
      requested_count: number;
    }[]>`
      select provider_operation::text as provider_operation, request_fingerprint,
             requested_entity_ids, requested_count
        from public.amazon_write_provider_call_events
       where org_id = ${input.orgId} and profile_id = ${input.profileId}
         and execution_id = ${input.executionId} and call_id = ${input.callId}
         and event_type = 'dispatch'
       for share
    `;
    if (!call || call.requested_count !== callEvidence.requested) {
      throw new Error('Amazon write result does not match its durable provider call');
    }
    const outcomeRows = await sql<{ id: string; action: unknown }[]>`
      select id, action from public.amazon_write_rows
       where org_id = ${input.orgId} and profile_id = ${input.profileId}
         and execution_id = ${input.executionId}
         and id = any(${[...unique]}::uuid[])
         and row_status = 'dispatched' and dispatch_token = ${input.callId}
       for update
    `;
    if (outcomeRows.length !== input.outcomes.length) {
      throw new Error('Amazon write result rows do not match the durable provider call');
    }
    const actionByRow = new Map(outcomeRows.map((row) => [
      row.id, AmazonWriteAction.parse(row.action),
    ] as const));
    for (const outcome of input.outcomes) {
      const evidence = AmazonWriteProviderEvidence.parse(outcome.evidence);
      const action = actionByRow.get(outcome.writeRowId);
      if (!action) throw new Error(`Amazon write result names unknown row ${outcome.writeRowId}`);
      if (evidence.outcome === 'accepted'
        && evidence.providerEntityId !== action.amazonEntityId) {
        throw new Error('Amazon write provider identity does not match its locked action');
      }
    }
    await sql`
      insert into public.amazon_write_provider_call_events
        (org_id, profile_id, execution_id, call_id, event_type, provider_operation,
         request_fingerprint, requested_entity_ids, requested_count, accepted_count,
         failed_count, api_call_count, outcome, code, message, occurred_at)
      values (${input.orgId}, ${input.profileId}, ${input.executionId}, ${input.callId},
              'result', ${call.provider_operation}, ${call.request_fingerprint},
              ${json(call.requested_entity_ids)}::jsonb, ${call.requested_count},
              ${callEvidence.accepted}, ${callEvidence.failed}, 0, ${callEvidence.outcome},
              ${callEvidence.code}, ${callEvidence.message}, clock_timestamp())
      on conflict (call_id, event_type) do nothing
    `;

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
           and row_status = 'dispatched' and dispatch_token = ${input.callId}
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
           count(*) filter (where attempt_count > 0 or row_status = 'dispatched')::int as attempted,
           count(*) filter (where row_status = 'accepted')::int as succeeded,
           count(*) filter (where row_status = 'failed')::int as failed,
           count(*) filter (where row_status = 'refused')::int as refused,
           count(*) filter (where row_status in ('pending', 'retryable'))::int as retryable,
           count(*) filter (where row_status in ('ambiguous', 'dispatched'))::int as ambiguous,
           count(*) filter (
             where row_status in ('accepted', 'ambiguous', 'dispatched') and observation_status = 'pending'
           )::int as observation_pending,
           count(*) filter (
             where provider_evidence->>'outcome' in ('accepted', 'ambiguous') or row_status = 'dispatched'
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
           completed_at = case when ${status} in ('failed', 'refused', 'partial') then now() else null end
           ,dispatch_lease_token = case when ${status} = 'running' then dispatch_lease_token else null end
           ,dispatch_lease_expires_at = case when ${status} = 'running' then dispatch_lease_expires_at else null end
     where id = ${executionId}
  `;
  if ((status === 'failed' || status === 'refused') && counts.succeeded === 0) {
    const [execution] = await sql<{
      id: string; org_id: string; profile_id: string; direction: 'forward' | 'inverse';
    }[]>`
      select id, org_id, profile_id, direction::text as direction
        from public.amazon_write_executions where id = ${executionId}
    `;
    if (execution?.direction === 'forward') {
      await enqueueNextAmazonWriteCycle(sql, {
        orgId: execution.org_id,
        profileId: execution.profile_id,
        completedForwardExecutionId: execution.id,
        runAt: new Date(),
      });
    }
  }
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

async function enqueueNextAmazonWriteCycle(
  sql: QuerySql,
  input: {
    orgId: string;
    profileId: string;
    completedForwardExecutionId: string;
    runAt: Date;
  },
): Promise<boolean> {
  const [completed] = await sql<{ created_at: Date | string }[]>`
    select created_at from public.amazon_write_executions
     where org_id = ${input.orgId} and profile_id = ${input.profileId}
       and id = ${input.completedForwardExecutionId} and direction = 'forward'
  `;
  if (!completed) return false;
  const [next] = await sql<{ id: string }[]>`
    select id from public.amazon_write_executions
     where org_id = ${input.orgId} and profile_id = ${input.profileId}
       and direction = 'forward' and status = 'queued'
       and (created_at, id) >
           (${toDate(completed.created_at).toISOString()}::timestamptz,
            ${input.completedForwardExecutionId}::uuid)
     order by created_at, id
     limit 1
     for share
  `;
  if (!next) return false;
  const inserted = await sql<{ id: string }[]>`
    insert into public.sync_jobs
      (org_id, profile_id, job_type, payload, run_after, dedupe_key)
    values (${input.orgId}, ${input.profileId}, 'amazon.apply',
            ${json({ type: 'amazon.apply', orgId: input.orgId, profileId: input.profileId,
              executionId: next.id })}::jsonb,
            ${input.runAt.toISOString()},
            ${`amazon.apply:${next.id}:released:${input.completedForwardExecutionId}`})
    on conflict (org_id, dedupe_key) where dedupe_key is not null do nothing
    returning id
  `;
  return inserted.length === 1;
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
  rowStatus: string;
}

export async function listAmazonWriteObservationRows(
  handle: AmazonWriteQueryHandle,
  input: { orgId: string; profileId: string; executionId: string; generation: string },
): Promise<AmazonWriteObservationRow[]> {
  const generation = Uuid.parse(input.generation);
  const rows = await handle.sql<{ id: string; action: unknown; row_status: string }[]>`
    select write_row.id, write_row.action, write_row.row_status::text as row_status
      from public.amazon_write_rows write_row
      join public.apply_rows apply_row on apply_row.id = write_row.apply_row_id
     where write_row.org_id = ${input.orgId} and write_row.profile_id = ${input.profileId}
       and write_row.execution_id = ${input.executionId}
       and write_row.dispatch_token = ${generation}
       and (
         (write_row.row_status in ('accepted', 'ambiguous', 'dispatched')
          and write_row.observation_status = 'pending')
         or (write_row.observation_status = 'conflict'
             and (write_row.row_status = 'accepted'
                  or write_row.provider_evidence->>'outcome' = 'ambiguous'))
       )
     order by apply_row.artifact_ordinal
  `;
  return rows.map((row) => ({
    writeRowId: row.id,
    action: AmazonWriteAction.parse(row.action),
    rowStatus: row.row_status,
  }));
}

export interface AmazonWriteObservation {
  writeRowId: string;
  state: 'observed' | 'pending' | 'not_applied' | 'conflict';
  currentValue: ApplyValue | null;
}

export interface RecordedAmazonWriteObservation {
  status: AmazonWriteExecutionStatus;
  accounting: AmazonWriteAccounting;
  pending: number;
  inverseReady: boolean;
  retryApply: boolean;
  applyRequeued: boolean;
  observationRequeued: boolean;
  inverseExecutionId: string | null;
}

async function materializeReservedAmazonWriteInverse(
  sql: QuerySql,
  input: {
    orgId: string;
    profileId: string;
    forwardExecutionId: string;
    observedAt: Date;
  },
): Promise<string | null> {
  const [reservation] = await sql<{
    id: string;
    inverse_execution_id: string | null;
    authorization_id: string;
    authorization_sha256: string;
    apply_batch_id: string;
    approval_id: string;
    approved_by: string;
    approved_at: Date | string;
    expires_at: Date | string;
    opt_group: string;
  }[]>`
    select reservation.id, reservation.inverse_execution_id,
           reservation.authorization_id, reservation.authorization_sha256,
           execution.apply_batch_id, execution.approval_id,
           approval.approved_by, approval.approved_at, approval.expires_at,
           batch.opt_group
      from public.amazon_write_inverse_reservations reservation
      join public.amazon_write_executions execution
        on execution.id = reservation.forward_execution_id
      join public.amazon_write_approvals approval on approval.id = execution.approval_id
      join public.apply_batches batch on batch.id = execution.apply_batch_id
     where reservation.org_id = ${input.orgId}
       and reservation.profile_id = ${input.profileId}
       and reservation.forward_execution_id = ${input.forwardExecutionId}
     for update of reservation
  `;
  if (!reservation) return null;
  if (reservation.inverse_execution_id !== null) return reservation.inverse_execution_id;

  const stored = await sql<{
    inverse_action: unknown;
    entity_name: string | null;
    clicks: number | null;
    revenue: number | null;
  }[]>`
    select write_row.inverse_action, apply_row.entity_name,
           apply_row.clicks::float8 as clicks, apply_row.revenue::float8 as revenue
      from public.amazon_write_rows write_row
      join public.apply_rows apply_row on apply_row.id = write_row.apply_row_id
     where write_row.org_id = ${input.orgId}
       and write_row.profile_id = ${input.profileId}
       and write_row.execution_id = ${input.forwardExecutionId}
       and write_row.row_status = 'accepted'
       and write_row.observation_status = 'observed'
     order by apply_row.artifact_ordinal
     for share of write_row, apply_row
  `;
  if (stored.length === 0) return null;
  const reservedActions = stored.map((row) => AmazonWriteAction.parse(row.inverse_action));
  const artifactRows: ApplyRow[] = reservedActions.map((action, index) => ({
    entityType: action.actionType === 'sp_campaign_placement' ? 'placement'
      : action.actionType === 'sp_keyword_bid' ? 'keyword' : 'target',
    entityId: action.amazonEntityId,
    field: action.field,
    old: action.expectedValue,
    new: action.requestedValue,
    ...(stored[index]?.entity_name === null ? {} : { name: stored[index]?.entity_name }),
    ...(stored[index]?.clicks === null ? {} : { clicks: stored[index]?.clicks }),
    ...(stored[index]?.revenue === null ? {} : { revenue: stored[index]?.revenue }),
  }));
  const artifactSha256 = createHash('sha256').update(serializeApplyRows(artifactRows)).digest('hex');
  const [batch] = await sql<{ id: string }[]>`
    insert into public.apply_batches
      (org_id, profile_id, tag, opt_group, lever, note, status, source_batch_id,
       exported_at, artifact_sha256, exported_proposals, reversible_rows, unsupported_rows,
       created_by)
    values (${input.orgId}, ${input.profileId},
            ${`amazon-inverse:${input.forwardExecutionId}`}, ${reservation.opt_group}, 'revert',
            'Preapproved exact inverse of synchronized Amazon write results', 'staged',
            ${reservation.apply_batch_id}, ${input.observedAt.toISOString()}, ${artifactSha256},
            ${artifactRows.length}, ${artifactRows.length}, 0, ${reservation.approved_by})
    returning id
  `;
  if (!batch) throw new Error('reserved Amazon inverse batch was not created');

  const inverseApplyRowIds: string[] = [];
  for (const [index, row] of artifactRows.entries()) {
    const [inserted] = await sql<{ id: string }[]>`
      insert into public.apply_rows
        (batch_id, org_id, profile_id, entity_type, entity_id, entity_name,
         field, old_value, new_value, lever, clicks, revenue)
      values (${batch.id}, ${input.orgId}, ${input.profileId}, ${row.entityType},
              ${row.entityId}, ${row.name ?? null}, ${row.field}, ${json(row.old)}::jsonb,
              ${json(row.new)}::jsonb, 'revert', ${row.clicks ?? null}, ${row.revenue ?? null})
      returning id
    `;
    if (!inserted) throw new Error(`reserved Amazon inverse omitted row ${index}`);
    inverseApplyRowIds.push(inserted.id);
  }
  const inverseActions = reservedActions.map((action, index) => AmazonWriteAction.parse({
    ...action,
    applyRowId: inverseApplyRowIds[index],
  }));
  const inverseOfInverse = materializeInverseActions(inverseActions);
  const [approval] = await sql<{ id: string }[]>`
    insert into public.amazon_write_approvals
      (org_id, profile_id, apply_batch_id, mode, preview_sha256, approved_count,
       approved_by, approved_at, expires_at, inverse_preapproved, authorization_id,
       authorization_sha256)
    values (${input.orgId}, ${input.profileId}, ${batch.id}, 'bounded_live_test',
            ${artifactSha256}, ${artifactRows.length}, ${reservation.approved_by},
            ${toDate(reservation.approved_at).toISOString()},
            ${toDate(reservation.expires_at).toISOString()}, false,
            ${reservation.authorization_id}, ${reservation.authorization_sha256})
    returning id
  `;
  if (!approval) throw new Error('reserved Amazon inverse approval was not recorded');
  const idempotencyKey = createHash('sha256').update(JSON.stringify([
    'openspell.amazon-write-inverse.v1', input.orgId, input.profileId,
    input.forwardExecutionId, artifactSha256, reservation.authorization_id,
    reservation.authorization_sha256,
  ])).digest('hex');
  const [execution] = await sql<{ id: string }[]>`
    insert into public.amazon_write_executions
      (org_id, profile_id, apply_batch_id, approval_id, idempotency_key,
       direction, source_execution_id, requested_count)
    values (${input.orgId}, ${input.profileId}, ${batch.id}, ${approval.id},
            ${idempotencyKey}, 'inverse', ${input.forwardExecutionId}, ${artifactRows.length})
    returning id
  `;
  if (!execution) throw new Error('reserved Amazon inverse execution was not recorded');
  const written = await sql<{ id: string }[]>`
    insert into public.amazon_write_rows
      (org_id, profile_id, execution_id, apply_row_id, action_type, action,
       expected_value, requested_value, inverse_value, inverse_action)
    select ${input.orgId}, ${input.profileId}, ${execution.id}, offered.apply_row_id::uuid,
           offered.action_type::public.amazon_write_action_type, offered.action::jsonb,
           offered.expected_value::jsonb, offered.requested_value::jsonb,
           offered.inverse_value::jsonb, offered.inverse_action::jsonb
      from unnest(
        ${inverseApplyRowIds}::text[],
        ${inverseActions.map((action) => action.actionType)}::text[],
        ${inverseActions.map((action) => json(action))}::text[],
        ${inverseActions.map((action) => json(action.expectedValue))}::text[],
        ${inverseActions.map((action) => json(action.requestedValue))}::text[],
        ${inverseActions.map((action) => json(action.inverseValue))}::text[],
        ${inverseOfInverse.map((action) => json(action))}::text[]
      ) offered(apply_row_id, action_type, action, expected_value, requested_value,
                inverse_value, inverse_action)
    returning id
  `;
  if (written.length !== artifactRows.length) {
    throw new Error(`reserved Amazon inverse wrote ${written.length} of ${artifactRows.length} rows`);
  }
  await sql`
    update public.amazon_write_inverse_reservations
       set inverse_execution_id = ${execution.id}, materialized_at = ${input.observedAt.toISOString()}
     where id = ${reservation.id} and inverse_execution_id is null
  `;
  await sql`
    insert into public.sync_jobs
      (org_id, profile_id, job_type, payload, run_after, dedupe_key)
    values (${input.orgId}, ${input.profileId}, 'amazon.apply',
            ${json({ type: 'amazon.apply', orgId: input.orgId, profileId: input.profileId,
              executionId: execution.id })}::jsonb,
            ${input.observedAt.toISOString()}, ${`amazon.apply:${execution.id}:reserved-inverse`})
    on conflict (org_id, dedupe_key) where dedupe_key is not null do nothing
  `;
  return execution.id;
}

export async function recordAmazonWriteObservations(
  handle: AmazonWriteQueryHandle,
  input: {
    orgId: string;
    profileId: string;
    executionId: string;
    generation: string;
    observedAt: Date;
    attempt: number;
    nextObservationAt: Date | null;
    observations: readonly AmazonWriteObservation[];
  },
): Promise<RecordedAmazonWriteObservation> {
  const generation = Uuid.parse(input.generation);
  return handle.sql.begin(async (sql) => {
    const [execution] = await sql<{
      id: string; apply_batch_id: string; requested_count: number;
      succeeded_count: number; failed_count: number; refused_count: number;
      direction: 'forward' | 'inverse'; source_execution_id: string | null;
    }[]>`
      select id, apply_batch_id, requested_count, succeeded_count, failed_count, refused_count,
             direction::text as direction, source_execution_id
        from public.amazon_write_executions
       where org_id = ${input.orgId} and profile_id = ${input.profileId}
         and id = ${input.executionId}
       for update
    `;
    if (!execution) throw new Error('Amazon write execution does not exist in this profile');
    const offered = await sql<{
      id: string;
      apply_row_id: string;
      action: unknown;
      row_status: string;
      attempt_count: number;
      dispatch_token: string | null;
    }[]>`
      select id, apply_row_id, action, row_status::text as row_status,
             attempt_count, dispatch_token
        from public.amazon_write_rows
       where org_id = ${input.orgId} and profile_id = ${input.profileId}
         and execution_id = ${input.executionId}
         and dispatch_token = ${generation}
         and (
           (row_status in ('accepted', 'ambiguous', 'dispatched') and observation_status = 'pending')
           or (observation_status = 'conflict'
               and (row_status = 'accepted' or provider_evidence->>'outcome' = 'ambiguous'))
         )
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
      if (observation.state === 'not_applied' && input.attempt < 5) {
        throw new Error('Amazon write cannot retry before the complete observation window');
      }
      const recoveryEvidence = row.row_status === 'dispatched'
        ? AmazonWriteProviderEvidence.parse({
            outcome: 'ambiguous', providerEntityId: null,
            code: 'RECOVERED_BY_SYNC', message: 'provider dispatch recovered through targeted synchronization',
          })
        : null;
      if (recoveryEvidence !== null) {
        const requestFingerprint = createHash('sha256')
          .update(`${execution.id}:${row.id}:${row.dispatch_token ?? 'missing'}:observe-first`)
          .digest('hex');
        await sql`
          insert into public.amazon_write_attempts
            (org_id, profile_id, execution_id, write_row_id, attempt_number,
             request_fingerprint, outcome, provider_evidence, attempted_at)
          values (${input.orgId}, ${input.profileId}, ${execution.id}, ${row.id},
                  ${row.attempt_count + 1}, ${requestFingerprint}, 'ambiguous',
                  ${json(recoveryEvidence)}::jsonb, ${input.observedAt.toISOString()})
          on conflict (request_fingerprint) do nothing
        `;
      }
      if (observation.state === 'pending') {
        await sql`
          update public.amazon_write_rows set current_observed_value = ${json(observation.currentValue)}::jsonb
           where id = ${row.id}
        `;
        continue;
      }
      if (observation.state === 'not_applied') {
        const reset = await sql<{ id: string }[]>`
          update public.amazon_write_rows
             set row_status = 'retryable', observation_status = 'pending',
                 current_observed_value = ${json(observation.currentValue)}::jsonb,
                 dispatch_token = null, observed_at = ${input.observedAt.toISOString()},
                 attempt_count = ${row.attempt_count + 1},
                 provider_evidence = ${json(recoveryEvidence)}::jsonb
           where id = ${row.id} and row_status = 'dispatched'
          returning id
        `;
        if (reset.length !== 1) throw new Error(`Amazon observation cannot safely retry row ${row.id}`);
        continue;
      }
      const updated = await sql<{ id: string }[]>`
        update public.amazon_write_rows
           set row_status = case
                 when row_status in ('ambiguous', 'dispatched') and ${observation.state} = 'observed'
                   then 'accepted'::public.amazon_write_row_status
                 when row_status = 'dispatched' and ${observation.state} = 'conflict'
                   then 'ambiguous'::public.amazon_write_row_status
                 else row_status
               end,
               observation_status = ${observation.state}::public.amazon_write_observation_status,
               current_observed_value = ${json(observation.currentValue)}::jsonb,
               observed_at = ${input.observedAt.toISOString()},
               attempt_count = case when row_status = 'dispatched'
                 then ${row.attempt_count + 1} else attempt_count end,
               provider_evidence = case when row_status = 'dispatched'
                 then ${json(recoveryEvidence)}::jsonb else provider_evidence end
         where id = ${row.id} and observation_status in ('pending', 'conflict')
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
      attempted: number; succeeded: number; failed: number; refused: number; retryable: number;
      ambiguous: number; resync_requested: number;
    }[]>`
      select count(*) filter (where observation_status = 'observed')::int as observed,
             count(*) filter (where observation_status = 'conflict')::int as conflicts,
             count(*) filter (
               where row_status in ('accepted', 'ambiguous', 'dispatched') and observation_status = 'pending'
             )::int as pending,
             count(*) filter (where attempt_count > 0 or row_status = 'dispatched')::int as attempted,
             count(*) filter (where row_status = 'accepted')::int as succeeded,
             count(*) filter (where row_status = 'failed')::int as failed,
             count(*) filter (where row_status in ('ambiguous', 'dispatched'))::int as ambiguous,
             count(*) filter (where row_status = 'refused')::int as refused,
             count(*) filter (where row_status in ('pending', 'retryable'))::int as retryable,
             count(*) filter (
               where provider_evidence->>'outcome' in ('accepted', 'ambiguous') or row_status = 'dispatched'
             )::int as resync_requested
        from public.amazon_write_rows where execution_id = ${execution.id}
    `;
    if (!counts) throw new Error('Amazon write observation accounting is missing');
    const fullyObserved = counts.observed === execution.requested_count
      && counts.failed === 0 && counts.refused === 0;
    const inverseReady = counts.succeeded > 0
      && counts.observed === counts.succeeded
      && counts.pending === 0
      && counts.ambiguous === 0
      && counts.retryable === 0;
    const status: AmazonWriteExecutionStatus = counts.retryable > 0 ? 'queued'
      : fullyObserved ? 'succeeded'
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
             inverse_ready_at = case when ${inverseReady} then ${input.observedAt.toISOString()}::timestamptz else null end,
             completed_at = case when ${status} in ('succeeded', 'partial', 'failed', 'refused')
               then ${input.observedAt.toISOString()}::timestamptz else null end,
             dispatch_lease_token = null, dispatch_lease_expires_at = null
       where id = ${execution.id}
    `;
    // Scheduling is call-generation scoped. Other provider groups and later
    // redispatches own independent observation windows and outbox rows.
    const applyRequeued = input.observations.some((row) => row.state === 'not_applied');
    if (applyRequeued) {
      await sql`
        insert into public.sync_jobs
          (org_id, profile_id, job_type, payload, run_after, dedupe_key)
        values (${input.orgId}, ${input.profileId}, 'amazon.apply',
                ${json({ type: 'amazon.apply', orgId: input.orgId, profileId: input.profileId,
                  executionId: execution.id })}::jsonb,
                ${input.observedAt.toISOString()},
                ${`amazon.apply:${execution.id}:recovery:${generation}:${input.attempt}`})
        on conflict (org_id, dedupe_key) where dedupe_key is not null do nothing
      `;
    }
    const [generationCounts] = await sql<{ pending: number; conflicts: number }[]>`
      select count(*) filter (where observation_status = 'pending')::int as pending,
             count(*) filter (where observation_status = 'conflict')::int as conflicts
        from public.amazon_write_rows
       where execution_id = ${execution.id}
         and dispatch_token = ${generation}
         and row_status in ('accepted', 'ambiguous', 'dispatched')
    `;
    if (!generationCounts) throw new Error('Amazon observation generation accounting is missing');
    const observationRequeued = (generationCounts.pending > 0 && input.attempt < 5)
      || (generationCounts.conflicts > 0 && input.attempt === 5);
    if (observationRequeued) {
      if (input.nextObservationAt === null) {
        throw new Error('Amazon observation recovery requires a durable next run');
      }
      const nextAttempt = input.attempt + 1;
      await sql`
        insert into public.sync_jobs
          (org_id, profile_id, job_type, payload, run_after, dedupe_key)
        values (${input.orgId}, ${input.profileId}, 'amazon.observe',
                ${json({ type: 'amazon.observe', orgId: input.orgId, profileId: input.profileId,
                  executionId: execution.id, generation,
                  attempt: nextAttempt })}::jsonb,
                ${input.nextObservationAt.toISOString()},
                ${`amazon.observe:${execution.id}:${generation}:${nextAttempt}`})
        on conflict (org_id, dedupe_key) where dedupe_key is not null do nothing
      `;
    }
    if (fullyObserved) {
      await sql`
        update public.apply_batches
           set status = 'applied', applied_at = ${input.observedAt.toISOString()},
               applied_on = ${input.observedAt.toISOString()}::timestamptz::date
         where id = ${execution.apply_batch_id} and status = 'staged'
      `;
    }
    const inverseExecutionId = inverseReady
      ? await materializeReservedAmazonWriteInverse(sql, {
          orgId: input.orgId,
          profileId: input.profileId,
          forwardExecutionId: execution.id,
          observedAt: input.observedAt,
        })
      : null;
    if (status === 'succeeded'
      && execution.direction === 'inverse'
      && execution.source_execution_id !== null) {
      await enqueueNextAmazonWriteCycle(sql, {
        orgId: input.orgId,
        profileId: input.profileId,
        completedForwardExecutionId: execution.source_execution_id,
        runAt: input.observedAt,
      });
    }
    return {
      status,
      accounting: await readAccounting(sql, execution.id),
      pending: counts.pending,
      inverseReady,
      retryApply: counts.retryable > 0,
      applyRequeued,
      observationRequeued,
      inverseExecutionId,
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

export interface AmazonWriteInverseBatch {
  batchId: string;
  sourceBatchId: string;
  rows: ApplyRow[];
  artifactSha256: string;
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
  if (!header || !['succeeded', 'partial'].includes(header.status) || readyAt === null) {
    throw new Error('Amazon write inverse is blocked until every accepted value is synchronized');
  }
  const rows = await handle.sql<{ inverse_action: unknown }[]>`
    select write_row.inverse_action from public.amazon_write_rows write_row
    join public.apply_rows apply_row on apply_row.id = write_row.apply_row_id
     where write_row.org_id = ${input.orgId} and write_row.profile_id = ${input.profileId}
       and write_row.execution_id = ${input.executionId}
       and write_row.row_status = 'accepted' and write_row.observation_status = 'observed'
     order by apply_row.artifact_ordinal
  `;
  const actions = rows.map((row) => AmazonWriteAction.parse(row.inverse_action));
  if (actions.length === 0) throw new Error('Amazon write inverse has no synchronized successful rows');
  return {
    executionId: input.executionId,
    sourceApplyBatchId: header.apply_batch_id,
    inverseReadyAt: readyAt,
    inversePreapproved: header.inverse_preapproved,
    actions,
  };
}

/**
 * Materialize the synchronized successful subset as a normal staged apply
 * batch. It still requires the ordinary approval and execution transaction;
 * this function only creates the immutable, executable inverse artifact.
 */
export async function createAmazonWriteInverseBatch(
  handle: AmazonWriteQueryHandle,
  input: {
    orgId: string;
    profileId: string;
    executionId: string;
    tag: string;
    note: string;
    actorId?: string | null;
  },
): Promise<AmazonWriteInverseBatch> {
  const tag = input.tag.trim();
  const note = input.note.trim();
  if (tag.length === 0) throw new Error('Amazon write inverse requires a batch tag');
  if (note.length === 0) throw new Error('Amazon write inverse requires a note');

  return handle.sql.begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${
      `amazon-write-inverse:${input.orgId}:${input.profileId}:${input.executionId}`
    }, 0))`;
    const [header] = await sql<{
      apply_batch_id: string;
      opt_group: string;
      inverse_ready_at: Date | string | null;
      status: AmazonWriteExecutionStatus;
    }[]>`
      select execution.apply_batch_id, batch.opt_group, execution.inverse_ready_at,
             execution.status::text as status
        from public.amazon_write_executions execution
        join public.apply_batches batch on batch.id = execution.apply_batch_id
       where execution.org_id = ${input.orgId}
         and execution.profile_id = ${input.profileId}
         and execution.id = ${input.executionId}
       for update of execution, batch
    `;
    if (!header || !['succeeded', 'partial'].includes(header.status)
      || header.inverse_ready_at === null) {
      throw new Error('Amazon write inverse is blocked until every accepted value is synchronized');
    }
    const [existing] = await sql<{ id: string }[]>`
      select id from public.apply_batches
       where source_batch_id = ${header.apply_batch_id} and status <> 'abandoned'
       for update
    `;
    if (existing) throw new Error('This Amazon write already has an active inverse batch');

    const stored = await sql<{
      write_row_id: string;
      inverse_action: unknown;
      entity_name: string | null;
    }[]>`
      select write_row.id as write_row_id, write_row.inverse_action, apply_row.entity_name
        from public.amazon_write_rows write_row
        join public.apply_rows apply_row on apply_row.id = write_row.apply_row_id
       where write_row.org_id = ${input.orgId}
         and write_row.profile_id = ${input.profileId}
         and write_row.execution_id = ${input.executionId}
         and write_row.row_status = 'accepted'
         and write_row.observation_status = 'observed'
       order by apply_row.artifact_ordinal
       for share of write_row, apply_row
    `;
    const actions = stored.map((row) => AmazonWriteAction.parse(row.inverse_action));
    if (actions.length === 0) throw new Error('Amazon write inverse has no synchronized successful rows');
    const targets = actions.map((action, index) => ({
      key: stored[index]?.write_row_id ?? action.applyRowId,
      entityType: action.actionType === 'sp_campaign_placement' ? 'placement' as const
        : action.actionType === 'sp_keyword_bid' ? 'keyword' as const : 'target' as const,
      entityId: action.amazonEntityId,
      field: action.field,
    }));
    await lockCurrentApplyStates({ sql }, { orgId: input.orgId, profileId: input.profileId, targets });
    const current = await resolveCurrentApplyStates(
      { sql }, { orgId: input.orgId, profileId: input.profileId, targets },
    );
    const currentByKey = new Map(current.map((row) => [row.key, row] as const));
    actions.forEach((action, index) => {
      const key = targets[index]?.key;
      const state = key === undefined ? undefined : currentByKey.get(key);
      if (!state?.supported || !state.present || !sameNumber(state.currentValue, action.expectedValue)) {
        throw new Error(`Amazon write inverse row ${action.applyRowId} conflicts with synchronized state`);
      }
    });

    const placementIds = [...new Set(actions
      .filter((action) => action.actionType === 'sp_campaign_placement')
      .map((action) => action.amazonEntityId))];
    if (placementIds.length > 0) {
      const contexts = await sql<{ amazon_id: string; campaign_write_context: CampaignWriteContext | null }[]>`
        select amazon_id, campaign_write_context from public.campaigns
         where org_id = ${input.orgId} and profile_id = ${input.profileId}
           and amazon_id = any(${placementIds}::text[])
         for share
      `;
      const contextById = new Map(contexts.map((row) => [row.amazon_id, row.campaign_write_context] as const));
      for (const campaignId of placementIds) {
        const expected = actions.find((action) =>
          action.actionType === 'sp_campaign_placement' && action.amazonEntityId === campaignId,
        );
        if (expected?.actionType !== 'sp_campaign_placement'
          || !isDeepStrictEqual(
            contextById.get(campaignId) ?? null,
            expected.campaignContext.providerState,
          )) {
          throw new Error(`Amazon write inverse campaign ${campaignId} conflicts with complete synchronized provider state`);
        }
      }
    }

    const rows: ApplyRow[] = actions.map((action, index) => ({
      entityType: action.actionType === 'sp_campaign_placement' ? 'placement'
        : action.actionType === 'sp_keyword_bid' ? 'keyword' : 'target',
      entityId: action.amazonEntityId,
      field: action.field,
      old: action.expectedValue,
      new: action.requestedValue,
      ...(stored[index]?.entity_name ? { name: stored[index].entity_name } : {}),
    }));
    const artifactSha256 = createHash('sha256').update(serializeApplyRows(rows)).digest('hex');
    const [batch] = await sql<{ id: string }[]>`
      insert into public.apply_batches
        (org_id, profile_id, tag, opt_group, lever, note, status, source_batch_id,
         exported_at, artifact_sha256, exported_proposals, reversible_rows,
         unsupported_rows, created_by)
      values (${input.orgId}, ${input.profileId}, ${tag}, ${header.opt_group}, 'revert',
              ${note}, 'staged', ${header.apply_batch_id}, now(), ${artifactSha256},
              ${rows.length}, ${rows.length}, 0, ${input.actorId ?? null}::uuid)
      returning id
    `;
    if (!batch) throw new Error('Amazon write inverse batch was not created');
    const inserted = await sql<{ id: string }[]>`
      insert into public.apply_rows
        (batch_id, org_id, profile_id, artifact_ordinal, entity_type, entity_id, entity_name,
         field, old_value, new_value, lever)
      select ${batch.id}, ${input.orgId}, ${input.profileId},
             offered.artifact_ordinal,
             offered.entity_type::public.apply_entity_type, offered.entity_id,
             offered.entity_name, offered.field, offered.old_value::jsonb,
             offered.new_value::jsonb, 'revert'
        from unnest(
          ${rows.map((row) => row.entityType)}::text[],
          ${rows.map((row) => row.entityId)}::text[],
          ${rows.map((row) => row.name ?? null)}::text[],
          ${rows.map((row) => row.field)}::text[],
          ${rows.map((row) => json(row.old))}::text[],
          ${rows.map((row) => json(row.new))}::text[]
        ) with ordinality offered(entity_type, entity_id, entity_name, field, old_value, new_value,
                                   artifact_ordinal)
      returning id
    `;
    if (inserted.length !== rows.length) {
      throw new Error(`Amazon write inverse offered ${rows.length} rows but wrote ${inserted.length}`);
    }
    return { batchId: batch.id, sourceBatchId: header.apply_batch_id, rows, artifactSha256 };
  });
}
