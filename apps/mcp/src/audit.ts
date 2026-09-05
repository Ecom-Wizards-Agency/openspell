/**
 * The audit log.
 *
 * Every tool call writes one row, whether it succeeded, failed validation, or
 * hit a gated write stub. That completeness is the point: WP-13's claim that
 * the headless analyst never wrote anything is checked against this table, and
 * a log that only records successes cannot support a negative claim.
 *
 * Parameters are recorded verbatim. They contain profile ids, date ranges and
 * filters, which are the org's own data; they never contain a credential,
 * because the token is consumed at the HTTP layer and never reaches a tool.
 */
import type { DbHandle } from '@wizard-ads/db';
import { jsonText } from './json.js';

export type AuditOutcome = 'ok' | 'error' | 'gated' | 'attempted';

export interface AuditEntry {
  orgId: string;
  /** The key id. `actor_id` is text in the schema; a uuid is a valid text. */
  keyId: string;
  tool: string;
  params: unknown;
  outcome: AuditOutcome;
  /** Rows returned, bytes written, error code: enough to reconstruct what happened. */
  summary: Record<string, unknown>;
  durationMs: number;
  profileId?: string | null;
}

export async function writeAuditEntry(handle: DbHandle, entry: AuditEntry): Promise<void> {
  await handle.sql`
    insert into public.audit_log (org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
    values (
      ${entry.orgId},
      'mcp',
      ${entry.keyId},
      ${`mcp.${entry.tool}`},
      ${entry.profileId ? 'profile' : null},
      ${entry.profileId ?? null},
      ${jsonText({
        params: entry.params ?? null,
        outcome: entry.outcome,
        summary: entry.summary,
        durationMs: entry.durationMs,
      })}::jsonb,
      'mcp'
    )
  `;
}

/** Read back what a key did. Used by tests and by the operator's own key review. */
export async function readAuditEntries(
  handle: DbHandle,
  orgId: string,
  limit = 100,
): Promise<
  {
    action: string;
    actorType: string;
    actorId: string | null;
    targetId: string | null;
    payload: Record<string, unknown>;
    createdAt: Date;
  }[]
> {
  const rows = await handle.sql<
    {
      action: string;
      actor_type: string;
      actor_id: string | null;
      target_id: string | null;
      payload: Record<string, unknown>;
      created_at: Date;
    }[]
  >`
    select action, actor_type, actor_id, target_id, payload, created_at
    from public.audit_log
    where org_id = ${orgId}
    order by created_at desc, id desc
    limit ${limit}
  `;
  return rows.map((row) => ({
    action: row.action,
    actorType: row.actor_type,
    actorId: row.actor_id,
    targetId: row.target_id,
    payload: row.payload,
    createdAt: row.created_at,
  }));
}
