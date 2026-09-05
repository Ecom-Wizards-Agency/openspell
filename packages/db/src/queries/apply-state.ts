/** Current synchronized values for staged-apply rows. */
import type { ApplyEntityType, ApplyValue } from '@wizard-ads/shared';
import type { QuerySql } from '../client.js';
import { toDateOrNull } from './pg-time.js';

export interface ApplyStateQueryHandle {
  sql: QuerySql;
}

export interface ApplyStateTarget {
  key: string;
  entityType: ApplyEntityType;
  entityId: string;
  field: string;
}

export interface ResolvedApplyState extends ApplyStateTarget {
  supported: boolean;
  present: boolean;
  currentValue: ApplyValue | null;
  /** Exact scalar text from PostgreSQL, before JSON numeric decoding. */
  currentValueText: string | null;
  currentSyncedAt: Date | null;
}

/**
 * Hold shared locks on every current mirror row represented by the targets.
 * Export callers re-resolve values after this, preventing a concurrent sync
 * from changing the snapshot between validation and artifact creation.
 */
export async function lockCurrentApplyStates(
  handle: ApplyStateQueryHandle,
  input: { orgId: string; profileId: string; targets: readonly ApplyStateTarget[] },
): Promise<void> {
  const ids = (entityType: ApplyEntityType): string[] => [
    ...new Set(
      input.targets
        .filter((target) => target.entityType === entityType)
        .map((target) => target.entityId),
    ),
  ];
  const keywordIds = ids('keyword');
  const targetIds = ids('target');
  const campaignIds = [...ids('campaign'), ...ids('placement')];
  const adGroupIds = ids('ad_group');
  if (keywordIds.length > 0) {
    await handle.sql`select id from public.keywords where org_id = ${input.orgId} and profile_id = ${input.profileId} and amazon_id = any(${keywordIds}::text[]) for share`;
  }
  if (targetIds.length > 0) {
    await handle.sql`select id from public.targets where org_id = ${input.orgId} and profile_id = ${input.profileId} and amazon_id = any(${targetIds}::text[]) for share`;
  }
  if (campaignIds.length > 0) {
    await handle.sql`select id from public.campaigns where org_id = ${input.orgId} and profile_id = ${input.profileId} and amazon_id = any(${campaignIds}::text[]) for share`;
  }
  if (adGroupIds.length > 0) {
    await handle.sql`select id from public.ad_groups where org_id = ${input.orgId} and profile_id = ${input.profileId} and amazon_id = any(${adGroupIds}::text[]) for share`;
  }
}

interface ApplyStateRow {
  row_key: string;
  entity_type: ApplyEntityType;
  entity_id: string;
  field: string;
  supported: boolean;
  present: boolean;
  current_value: ApplyValue | null;
  current_value_text: string | null;
  current_synced_at: Date | string | null;
}

/**
 * Resolve all offered rows in one statement and assert the adapter returned
 * one classification per input. Unsupported fields are returned explicitly;
 * they are never silently treated as a JSON null.
 */
export async function resolveCurrentApplyStates(
  handle: ApplyStateQueryHandle,
  input: { orgId: string; profileId: string; targets: readonly ApplyStateTarget[] },
): Promise<ResolvedApplyState[]> {
  if (input.targets.length === 0) return [];

  const rows = await handle.sql<ApplyStateRow[]>`
    select offered.row_key, offered.entity_type::text as entity_type,
           offered.entity_id, offered.field,
           resolved.supported, resolved.present,
           resolved.current_value, resolved.current_value #>> '{}' as current_value_text, resolved.current_synced_at
      from unnest(
             ${input.targets.map((target) => target.key)}::text[],
             ${input.targets.map((target) => target.entityType)}::text[],
             ${input.targets.map((target) => target.entityId)}::text[],
             ${input.targets.map((target) => target.field)}::text[]
           ) as offered(row_key, entity_type, entity_id, field)
      cross join lateral app.resolve_apply_current_value(
        ${input.orgId}::uuid,
        ${input.profileId}::uuid,
        offered.entity_type::public.apply_entity_type,
        offered.entity_id,
        offered.field
      ) resolved
  `;

  if (rows.length !== input.targets.length) {
    throw new Error(
      `apply-state: offered ${input.targets.length} rows, resolved ${rows.length}`,
    );
  }

  return rows.map((row) => ({
    key: row.row_key,
    entityType: row.entity_type,
    entityId: row.entity_id,
    field: row.field,
    supported: row.supported,
    present: row.present,
    currentValue: row.current_value,
    currentValueText: row.current_value_text,
    currentSyncedAt: toDateOrNull(row.current_synced_at),
  }));
}
