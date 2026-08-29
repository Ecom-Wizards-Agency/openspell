/**
 * Human decisions and immutable offline exports for contextual negatives.
 *
 * The shared proposal schema remains authoritative. This module only enriches
 * it with database review metadata and hides the locking, audit, snapshot, and
 * count-reconciliation rules behind two operations.
 */
import { createHash } from 'node:crypto';
import {
  ContextualNegativeProposal,
  type ContextualNegativeProposal as ContextualNegativeProposalType,
} from '@wizard-ads/shared';
import type { DbHandle } from '../client.js';

export type ContextualNegativeQueryHandle = Pick<DbHandle, 'sql'>;
export type ContextualNegativeDecision = 'accepted' | 'dismissed' | 'proposed';

export type ContextualNegativeProposalRecord = Omit<ContextualNegativeProposalType, 'id'> & {
  id: string;
  decidedAt: Date | null;
  decidedBy: string | null;
  decisionNote: string | null;
  exportId: string | null;
  exportedAt: Date | null;
};

export interface ContextualNegativeExportSummary {
  id: string;
  profileId: string;
  marketplaceId: string;
  note: string;
  rowCount: number;
  artifactSha256: string;
  createdBy: string | null;
  createdAt: Date;
}

export type ContextualNegativeExportItem = Omit<ContextualNegativeProposalType, 'id' | 'status'> & {
  proposalId: string;
  ordinal: number;
  decisionNote: string | null;
  snapshotSha256: string;
};

export interface ContextualNegativeExportArtifact extends ContextualNegativeExportSummary {
  items: ContextualNegativeExportItem[];
}

export interface ContextualNegativeDecisionResult {
  offered: number;
  matched: number;
  updated: number;
  unchanged: number;
  refused: { id: string; status: 'exported' }[];
}

export interface ContextualNegativeExportResult {
  exportId: string;
  offered: number;
  matched: number;
  accepted: number;
  exported: number;
  skipped: { id: string; status: ContextualNegativeProposalType['status'] }[];
  artifactSha256: string;
}

type DateValue = Date | string;

interface ProposalRow {
  id: string;
  profile_id: string;
  marketplace_id: string;
  campaign_id: string;
  ad_group_id: string;
  search_term: string;
  normalized_query: string;
  category: ContextualNegativeProposalType['category'];
  source_group_role: ContextualNegativeProposalType['sourceGroupRole'];
  match_type: ContextualNegativeProposalType['matchType'];
  reason: string;
  status: ContextualNegativeProposalType['status'];
  decided_at: DateValue | null;
  decided_by: string | null;
  decision_note: string | null;
  export_id: string | null;
  exported_at: DateValue | null;
}

interface ExportRow {
  id: string;
  profile_id: string;
  marketplace_id: string;
  note: string;
  row_count: number;
  artifact_sha256: string;
  created_by: string | null;
  created_at: DateValue;
}

interface ExportItemRow {
  proposal_id: string;
  ordinal: number;
  profile_id: string;
  marketplace_id: string;
  campaign_id: string;
  ad_group_id: string;
  search_term: string;
  normalized_query: string;
  category: ContextualNegativeProposalType['category'];
  source_group_role: ContextualNegativeProposalType['sourceGroupRole'];
  match_type: ContextualNegativeProposalType['matchType'];
  reason: string;
  decision_note: string | null;
  snapshot_sha256: string;
}

function toDate(value: DateValue): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid database timestamp: ${String(value)}`);
  return date;
}

function proposalFromRow(row: ProposalRow): ContextualNegativeProposalRecord {
  const proposal = ContextualNegativeProposal.parse({
    id: row.id,
    profileId: row.profile_id,
    marketplaceId: row.marketplace_id,
    campaignId: row.campaign_id,
    adGroupId: row.ad_group_id,
    searchTerm: row.search_term,
    normalizedQuery: row.normalized_query,
    category: row.category,
    sourceGroupRole: row.source_group_role,
    matchType: row.match_type,
    reason: row.reason,
    status: row.status,
  });
  if (proposal.id === undefined) throw new Error('Contextual proposal read-back has no id');
  return {
    ...proposal,
    id: proposal.id,
    decidedAt: row.decided_at === null ? null : toDate(row.decided_at),
    decidedBy: row.decided_by,
    decisionNote: row.decision_note,
    exportId: row.export_id,
    exportedAt: row.exported_at === null ? null : toDate(row.exported_at),
  };
}

function exportSummaryFromRow(row: ExportRow): ContextualNegativeExportSummary {
  return {
    id: row.id,
    profileId: row.profile_id,
    marketplaceId: row.marketplace_id,
    note: row.note,
    rowCount: Number(row.row_count),
    artifactSha256: row.artifact_sha256,
    createdBy: row.created_by,
    createdAt: toDate(row.created_at),
  };
}

function exportItemFromRow(row: ExportItemRow): ContextualNegativeExportItem {
  const proposal = ContextualNegativeProposal.parse({
    id: row.proposal_id,
    profileId: row.profile_id,
    marketplaceId: row.marketplace_id,
    campaignId: row.campaign_id,
    adGroupId: row.ad_group_id,
    searchTerm: row.search_term,
    normalizedQuery: row.normalized_query,
    category: row.category,
    sourceGroupRole: row.source_group_role,
    matchType: row.match_type,
    reason: row.reason,
    status: 'exported',
  });
  if (proposal.id === undefined) throw new Error('Contextual export item has no proposal id');
  const { id: proposalId, status: _status, ...snapshot } = proposal;
  return {
    ...snapshot,
    proposalId,
    ordinal: Number(row.ordinal),
    decisionNote: row.decision_note,
    snapshotSha256: row.snapshot_sha256,
  };
}

function json(value: unknown): string {
  const output = JSON.stringify(value);
  if (output === undefined) throw new Error('Value must be JSON-serializable');
  return output;
}

function snapshotPayload(item: Omit<ContextualNegativeExportItem, 'snapshotSha256'>): object {
  return {
    proposalId: item.proposalId,
    profileId: item.profileId,
    marketplaceId: item.marketplaceId,
    campaignId: item.campaignId,
    adGroupId: item.adGroupId,
    searchTerm: item.searchTerm,
    normalizedQuery: item.normalizedQuery,
    category: item.category,
    sourceGroupRole: item.sourceGroupRole,
    matchType: item.matchType,
    reason: item.reason,
    decisionNote: item.decisionNote,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function snapshotHash(item: Omit<ContextualNegativeExportItem, 'snapshotSha256'>): string {
  return sha256(`${json(snapshotPayload(item))}\n`);
}

/** The canonical row stream whose hash is stored on the export header. */
export function serializeContextualNegativeSnapshotRows(
  items: readonly ContextualNegativeExportItem[],
): string {
  return `${json(items.map((item) => snapshotPayload(item)))}\n`;
}

export async function listContextualNegativeProposals(
  handle: ContextualNegativeQueryHandle,
  input: { orgId: string; profileId: string; marketplaceId: string },
): Promise<ContextualNegativeProposalRecord[]> {
  const rows = await handle.sql<ProposalRow[]>`
    select p.id, p.profile_id, p.marketplace_id, p.campaign_id, p.ad_group_id,
           p.search_term, p.normalized_query, p.category, p.source_group_role,
           p.match_type, p.reason, p.status, p.decided_at, p.decided_by,
           decision.decision_note, exported.export_id, exported.exported_at
      from public.contextual_negative_proposals p
      left join lateral (
        select a.payload ->> 'note' as decision_note
          from public.audit_log a
         where a.org_id = p.org_id
           and a.target_type = 'contextual_negative_proposal'
           and a.target_id = p.id::text
           and a.action like 'query_negative.%'
         order by a.created_at desc, a.id desc
         limit 1
      ) decision on true
      left join lateral (
        select i.export_id, e.created_at as exported_at
          from public.contextual_negative_export_items i
          join public.contextual_negative_exports e on e.id = i.export_id
         where i.org_id = p.org_id and i.profile_id = p.profile_id
           and i.proposal_id = p.id
         limit 1
      ) exported on true
     where p.org_id = ${input.orgId}
       and p.profile_id = ${input.profileId}
       and p.marketplace_id = ${input.marketplaceId}
     order by case p.status
                when 'proposed' then 0
                when 'accepted' then 1
                when 'dismissed' then 2
                else 3
              end,
              p.created_at, p.id
  `;
  const proposals = rows.map(proposalFromRow);
  if (proposals.length !== rows.length) throw new Error('Contextual proposal parse count mismatch');
  return proposals;
}

export async function listContextualNegativeExports(
  handle: ContextualNegativeQueryHandle,
  input: { orgId: string; profileId: string; marketplaceId: string; limit?: number },
): Promise<ContextualNegativeExportSummary[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  const rows = await handle.sql<ExportRow[]>`
    select id, profile_id, marketplace_id, note, row_count,
           artifact_sha256, created_by, created_at
      from public.contextual_negative_exports
     where org_id = ${input.orgId}
       and profile_id = ${input.profileId}
       and marketplace_id = ${input.marketplaceId}
     order by created_at desc, id desc
     limit ${limit}
  `;
  return rows.map(exportSummaryFromRow);
}

export async function decideContextualNegativeProposals(
  handle: ContextualNegativeQueryHandle,
  input: {
    orgId: string;
    profileId: string;
    marketplaceId: string;
    proposalIds: readonly string[];
    decision: ContextualNegativeDecision;
    actorId?: string | null;
    note?: string | null;
  },
): Promise<ContextualNegativeDecisionResult> {
  const ids = [...new Set(input.proposalIds)];
  const note = (input.note ?? '').trim();
  if (input.decision === 'dismissed' && note.length === 0) {
    throw new Error('A dismissal needs a note: record why this proposal is not being taken.');
  }
  if (ids.length === 0) {
    return { offered: 0, matched: 0, updated: 0, unchanged: 0, refused: [] };
  }

  return await handle.sql.begin(async (sql) => {
    const rows = await sql<{ id: string; status: ContextualNegativeProposalType['status'] }[]>`
      select id, status
        from public.contextual_negative_proposals
       where org_id = ${input.orgId}
         and profile_id = ${input.profileId}
         and marketplace_id = ${input.marketplaceId}
         and id = any (${ids}::uuid[])
       order by id
       for update
    `;
    const refused = rows
      .filter((row) => row.status === 'exported')
      .map((row) => ({ id: row.id, status: 'exported' as const }));
    const unchanged = rows.filter((row) => row.status === input.decision).length;
    const changed = rows.filter(
      (row) => row.status !== 'exported' && row.status !== input.decision,
    );
    const changedIds = changed.map((row) => row.id);
    const decidedAt = input.decision === 'proposed' ? null : new Date().toISOString();
    const updated = changedIds.length === 0
      ? []
      : await sql<{ id: string }[]>`
          update public.contextual_negative_proposals
             set status = ${input.decision},
                 decided_at = ${decidedAt}::timestamptz,
                 decided_by = ${input.decision === 'proposed' ? null : input.actorId ?? null}::uuid,
                 updated_at = now()
           where org_id = ${input.orgId}
             and profile_id = ${input.profileId}
             and marketplace_id = ${input.marketplaceId}
             and id = any (${changedIds}::uuid[])
             and status <> 'exported'
           returning id
        `;
    if (updated.length !== changedIds.length) {
      throw new Error(`Offered ${changedIds.length} proposal decisions, updated ${updated.length}`);
    }

    if (updated.length > 0) {
      const fromStatusById = new Map(changed.map((row) => [row.id, row.status] as const));
      const payloads = updated.map((row) => {
        const fromStatus = fromStatusById.get(row.id);
        if (fromStatus === undefined) throw new Error(`Updated unselected proposal ${row.id}`);
        return json({ fromStatus, toStatus: input.decision, note });
      });
      const audits = await sql<{ id: number }[]>`
        insert into public.audit_log
          (org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
        select ${input.orgId}, 'user', ${input.actorId ?? null},
               ${`query_negative.${input.decision}`}, 'contextual_negative_proposal',
               decision.target, decision.payload::jsonb, 'web'
          from unnest(${updated.map((row) => row.id)}::text[], ${payloads}::text[])
               as decision(target, payload)
        returning id
      `;
      if (audits.length !== updated.length) {
        throw new Error(`Updated ${updated.length} proposal decisions, audited ${audits.length}`);
      }
    }

    return {
      offered: ids.length,
      matched: rows.length,
      updated: updated.length,
      unchanged,
      refused,
    };
  });
}

export async function exportAcceptedContextualNegatives(
  handle: ContextualNegativeQueryHandle,
  input: {
    orgId: string;
    profileId: string;
    marketplaceId: string;
    proposalIds?: readonly string[] | null;
    actorId?: string | null;
    note: string;
  },
): Promise<ContextualNegativeExportResult> {
  const note = input.note.trim();
  if (note.length === 0) throw new Error('An export needs a note.');
  const ids = input.proposalIds && input.proposalIds.length > 0
    ? [...new Set(input.proposalIds)]
    : null;

  return await handle.sql.begin(async (sql) => {
    const rows = await sql<(ProposalRow & { created_at: DateValue })[]>`
      select p.id, p.profile_id, p.marketplace_id, p.campaign_id, p.ad_group_id,
             p.search_term, p.normalized_query, p.category, p.source_group_role,
             p.match_type, p.reason, p.status, p.decided_at, p.decided_by,
             decision.decision_note, null::uuid as export_id,
             null::timestamptz as exported_at, p.created_at
        from public.contextual_negative_proposals p
        left join lateral (
          select a.payload ->> 'note' as decision_note
            from public.audit_log a
           where a.org_id = p.org_id
             and a.target_type = 'contextual_negative_proposal'
             and a.target_id = p.id::text
             and a.action = 'query_negative.accepted'
           order by a.created_at desc, a.id desc
           limit 1
        ) decision on true
       where p.org_id = ${input.orgId}
         and p.profile_id = ${input.profileId}
         and p.marketplace_id = ${input.marketplaceId}
         and (${ids}::uuid[] is null or p.id = any (${ids}::uuid[]))
         and (${ids}::uuid[] is not null or p.status = 'accepted')
       order by p.campaign_id, p.ad_group_id, p.normalized_query, p.id
       for update of p
    `;
    const acceptedRows = rows.filter((row) => row.status === 'accepted');
    if (acceptedRows.length === 0) throw new Error('No accepted proposals to export.');

    const itemsWithoutHashes = acceptedRows.map((row, index) => {
      const record = proposalFromRow(row);
      return {
        proposalId: record.id,
        ordinal: index + 1,
        profileId: record.profileId,
        marketplaceId: record.marketplaceId,
        campaignId: record.campaignId,
        adGroupId: record.adGroupId,
        searchTerm: record.searchTerm,
        normalizedQuery: record.normalizedQuery,
        category: record.category,
        sourceGroupRole: record.sourceGroupRole,
        matchType: record.matchType,
        reason: record.reason,
        decisionNote: record.decisionNote,
      } satisfies Omit<ContextualNegativeExportItem, 'snapshotSha256'>;
    });
    const items: ContextualNegativeExportItem[] = itemsWithoutHashes.map((item) => ({
      ...item,
      snapshotSha256: snapshotHash(item),
    }));
    const artifactSha256 = sha256(serializeContextualNegativeSnapshotRows(items));

    const [created] = await sql<{ id: string }[]>`
      insert into public.contextual_negative_exports
        (org_id, profile_id, marketplace_id, note, row_count,
         artifact_sha256, created_by)
      values (${input.orgId}, ${input.profileId}, ${input.marketplaceId}, ${note},
              ${items.length}, ${artifactSha256}, ${input.actorId ?? null}::uuid)
      returning id
    `;
    const exportId = created?.id;
    if (exportId === undefined) throw new Error('Failed to create contextual negative export.');

    const inserted = await sql<{ proposal_id: string }[]>`
      insert into public.contextual_negative_export_items
        (export_id, ordinal, org_id, profile_id, proposal_id, marketplace_id,
         campaign_id, ad_group_id, search_term, normalized_query, category,
         source_group_role, match_type, reason, decision_note, snapshot_sha256)
      select ${exportId}, item.ordinal::integer, ${input.orgId}, ${input.profileId},
             item.proposal_id::uuid, item.marketplace_id, item.campaign_id,
             item.ad_group_id, item.search_term, item.normalized_query,
             item.category::public.query_category, item.source_group_role,
             item.match_type, item.reason, item.decision_note, item.snapshot_sha256
        from unnest(
               ${items.map((item) => String(item.ordinal))}::text[],
               ${items.map((item) => item.proposalId)}::text[],
               ${items.map((item) => item.marketplaceId)}::text[],
               ${items.map((item) => item.campaignId)}::text[],
               ${items.map((item) => item.adGroupId)}::text[],
               ${items.map((item) => item.searchTerm)}::text[],
               ${items.map((item) => item.normalizedQuery)}::text[],
               ${items.map((item) => item.category)}::text[],
               ${items.map((item) => item.sourceGroupRole)}::text[],
               ${items.map((item) => item.matchType)}::text[],
               ${items.map((item) => item.reason)}::text[],
               ${items.map((item) => item.decisionNote)}::text[],
               ${items.map((item) => item.snapshotSha256)}::text[]
             ) as item(
               ordinal, proposal_id, marketplace_id, campaign_id, ad_group_id,
               search_term, normalized_query, category, source_group_role,
               match_type, reason, decision_note, snapshot_sha256
             )
      returning proposal_id
    `;
    if (inserted.length !== items.length) {
      throw new Error(`Offered ${items.length} contextual export items, wrote ${inserted.length}`);
    }

    const stamped = await sql<{ id: string }[]>`
      update public.contextual_negative_proposals
         set status = 'exported', updated_at = now()
       where org_id = ${input.orgId}
         and profile_id = ${input.profileId}
         and marketplace_id = ${input.marketplaceId}
         and id = any (${items.map((item) => item.proposalId)}::uuid[])
         and status = 'accepted'
       returning id
    `;
    if (stamped.length !== items.length) {
      throw new Error(`Exported ${items.length} contextual proposals, stamped ${stamped.length}`);
    }

    const [readBack] = await sql<{ row_count: number; item_count: number }[]>`
      select e.row_count, count(i.proposal_id)::int as item_count
        from public.contextual_negative_exports e
        left join public.contextual_negative_export_items i
          on i.org_id = e.org_id and i.export_id = e.id
       where e.org_id = ${input.orgId} and e.id = ${exportId}
       group by e.row_count
    `;
    if (readBack?.row_count !== items.length || readBack.item_count !== items.length) {
      throw new Error(
        `Contextual export expected ${items.length} rows; ledger reports ` +
          `${String(readBack?.row_count ?? 0)} and stores ${String(readBack?.item_count ?? 0)}`,
      );
    }

    const [audit] = await sql<{ id: number }[]>`
      insert into public.audit_log
        (org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
      values (${input.orgId}, 'user', ${input.actorId ?? null},
              'query_negative.exported', 'contextual_negative_export', ${exportId},
              ${json({ note, rows: items.length, artifactSha256 })}::text::jsonb, 'web')
      returning id
    `;
    if (audit === undefined) throw new Error('Contextual negative export audit was not written');

    const skipped = rows
      .filter((row) => row.status !== 'accepted')
      .map((row) => ({ id: row.id, status: row.status }));
    return {
      exportId,
      offered: ids?.length ?? rows.length,
      matched: rows.length,
      accepted: acceptedRows.length,
      exported: stamped.length,
      skipped,
      artifactSha256,
    };
  });
}

export async function getContextualNegativeExport(
  handle: ContextualNegativeQueryHandle,
  input: { orgId: string; exportId: string },
): Promise<ContextualNegativeExportArtifact | null> {
  const headers = await handle.sql<ExportRow[]>`
    select id, profile_id, marketplace_id, note, row_count,
           artifact_sha256, created_by, created_at
      from public.contextual_negative_exports
     where org_id = ${input.orgId} and id = ${input.exportId}
  `;
  const header = headers[0];
  if (header === undefined) return null;
  const rows = await handle.sql<ExportItemRow[]>`
    select proposal_id, ordinal, profile_id, marketplace_id, campaign_id,
           ad_group_id, search_term, normalized_query, category,
           source_group_role, match_type, reason, decision_note, snapshot_sha256
      from public.contextual_negative_export_items
     where org_id = ${input.orgId} and export_id = ${input.exportId}
     order by ordinal
  `;
  const items = rows.map(exportItemFromRow);
  const summary = exportSummaryFromRow(header);
  if (items.length !== summary.rowCount) {
    throw new Error(`Contextual export declares ${summary.rowCount} rows but stores ${items.length}`);
  }
  for (const item of items) {
    const { snapshotSha256, ...withoutHash } = item;
    const actual = snapshotHash(withoutHash);
    if (actual !== snapshotSha256) {
      throw new Error(`Contextual export item ${item.proposalId} failed its snapshot hash`);
    }
  }
  const actualArtifactHash = sha256(serializeContextualNegativeSnapshotRows(items));
  if (actualArtifactHash !== summary.artifactSha256) {
    throw new Error('Contextual export failed its artifact hash');
  }
  return { ...summary, items };
}
