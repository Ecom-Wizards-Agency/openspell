/**
 * Recommendation runs, the review decisions taken on them, and the export
 * bridge that turns accepted proposals into a staged-apply batch (WP-07).
 *
 * Three things here are deliberate and worth reading before changing anything.
 *
 * **The note lives in `audit_log`, not on the row.** `public.recommendations`
 * has no note column and this package does not add migrations. That turned out
 * to be the better shape anyway: the recon (`tools/recon/04-optimizer.md` §5)
 * records that every mutating action in the incumbent demands a note "required
 * for audit logs", and a note that lives in the audit log is a history rather
 * than a single last-writer-wins string. `listRecommendations` reads the most
 * recent one back with a lateral join, so the UI still shows "dismissed
 * because ...", and every earlier decision is still there.
 *
 * **An export is an `apply_batches` row, not a file side effect.** The staged
 * apply ledger already exists (migration 0008, a port of `batches.py`'s own
 * rules), so exporting writes the batch and its rows, stamps
 * `recommendations.export_batch_id`, and moves the proposals to `exported`.
 * The downloadable files are then a pure rendering of stored rows: the same
 * export can be fetched again as JSON or as a workbook without re-deciding
 * anything, and the tag is the join between our record and the Python flow's.
 *
 * **Counts are asserted, never assumed** (program rule 4): the export refuses
 * to report success unless the rows it wrote equal the proposals it claimed,
 * and unless every proposal it touched actually changed status.
 */
import { createHash } from 'node:crypto';
import { OptimizationGroup, serializeApplyRows } from '@wizard-ads/shared';
import type { ApplyRow, RecommendationInputs } from '@wizard-ads/shared';
import type { DbHandle } from '../client.js';
import { lockCurrentApplyStates, resolveCurrentApplyStates } from './apply-state.js';
import type { JsonValue } from './goto.js';
import { toDate, toDateOrNull } from './pg-time.js';

export type RecommendationQueryHandle = Pick<DbHandle, 'sql'>;

export const RECOMMENDATION_STATUSES = [
  'proposed',
  'accepted',
  'dismissed',
  'exported',
  'applied',
  'superseded',
] as const;
export type RecommendationStatusName = (typeof RECOMMENDATION_STATUSES)[number];

export const RECOMMENDATION_REASONS = [
  'high_acos',
  'high_spend_no_sales',
  'low_acos',
  'low_visibility',
  'flag',
  'pacing',
] as const;
export type RecommendationReasonName = (typeof RECOMMENDATION_REASONS)[number];

/**
 * A decision a human can take in the review surface. `proposed` is here as a
 * target so an over-eager dismissal can be walked back before an export; the
 * two terminal-ish states (`exported`, `applied`) are not, because something
 * outside this system has already acted on them.
 */
export const RECOMMENDATION_DECISIONS = ['accepted', 'dismissed', 'proposed'] as const;
export type RecommendationDecision = (typeof RECOMMENDATION_DECISIONS)[number];

/** Statuses a decision may move *from*. Everything else refuses. */
const DECIDABLE_FROM: readonly string[] = ['proposed', 'accepted', 'dismissed'];

export interface RecommendationRecord {
  id: string;
  runId: string;
  orgId: string;
  profileId: string;
  reason: RecommendationReasonName;
  entityType: string;
  entityId: string;
  entityName: string | null;
  adProduct: string | null;
  campaignId: string | null;
  adGroupId: string | null;
  /** Resolved from the entity mirror, so a proposal reads as a sentence. */
  campaignName: string | null;
  adGroupName: string | null;
  /**
   * The campaign's portfolio, and whether the mirror knows the campaign at all.
   * Both exist for the bulksheet writer: omitting a portfolio id on a campaign
   * update row silently removes the campaign from its portfolio, so an unknown
   * campaign must be refused rather than exported with a blank.
   */
  campaignPortfolioId: string | null;
  campaignKnown: boolean;
  field: string;
  currentValue: JsonValue;
  proposedValue: JsonValue;
  inputs: RecommendationInputs;
  status: RecommendationStatusName;
  decidedBy: string | null;
  decidedAt: Date | null;
  exportBatchId: string | null;
  exportBatchTag: string | null;
  /** The most recent decision note from the audit log, when there is one. */
  decisionNote: string | null;
  createdAt: Date;
}

export interface RecommendationRunSummary {
  id: string;
  orgId: string;
  profileId: string;
  status: string;
  lookbackDays: number;
  windowStart: string | null;
  windowEnd: string | null;
  engineVersion: string | null;
  proposalsCount: number;
  createdAt: Date;
  finishedAt: Date | null;
  groupId: string | null;
  groupRole: OptimizationGroup['role'] | null;
  groupSnapshot: OptimizationGroup | null;
  dueAt: Date | null;
  /** Live counts per status, so "exported N of M accepted" needs no second query. */
  counts: Record<RecommendationStatusName, number>;
}

export interface RecommendationRunDetail extends RecommendationRunSummary {
  /**
   * The doctrine document as it was when the run happened. The strategy /
   * objective dimension in the UI is resolved against this and nothing else:
   * re-reading today's `profile_strategy` would explain a six-week-old
   * proposal with thresholds it never saw.
   */
  strategySnapshot: JsonValue | null;
}

interface RecommendationRow {
  id: string;
  run_id: string;
  org_id: string;
  profile_id: string;
  reason: string;
  entity_type: string;
  entity_id: string;
  entity_name: string | null;
  ad_product: string | null;
  campaign_id: string | null;
  ad_group_id: string | null;
  campaign_name: string | null;
  ad_group_name: string | null;
  campaign_portfolio_id: string | null;
  campaign_known: boolean;
  field: string;
  current_value: JsonValue;
  proposed_value: JsonValue;
  inputs: RecommendationInputs;
  status: string;
  decided_by: string | null;
  decided_at: Date | string | null;
  export_batch_id: string | null;
  export_batch_tag: string | null;
  decision_note: string | null;
  created_at: Date | string;
}

function toRecord(row: RecommendationRow): RecommendationRecord {
  return {
    id: row.id,
    runId: row.run_id,
    orgId: row.org_id,
    profileId: row.profile_id,
    reason: row.reason as RecommendationReasonName,
    entityType: row.entity_type,
    entityId: row.entity_id,
    entityName: row.entity_name,
    adProduct: row.ad_product,
    campaignId: row.campaign_id,
    adGroupId: row.ad_group_id,
    campaignName: row.campaign_name,
    adGroupName: row.ad_group_name,
    campaignPortfolioId: row.campaign_portfolio_id,
    campaignKnown: row.campaign_known,
    field: row.field,
    currentValue: row.current_value,
    proposedValue: row.proposed_value,
    inputs: row.inputs,
    status: row.status as RecommendationStatusName,
    decidedBy: row.decided_by,
    decidedAt: toDateOrNull(row.decided_at),
    exportBatchId: row.export_batch_id,
    exportBatchTag: row.export_batch_tag,
    decisionNote: row.decision_note,
    createdAt: toDate(row.created_at),
  };
}

/**
 * Serialize a document for binding as text.
 *
 * Bound `::text::jsonb`, never `::jsonb`, for the reason `goto.ts` documents at
 * length: against a bare `::jsonb` postgres.js applies its own stringifier on
 * top of ours and the document is encoded twice, which a Drizzle-attached
 * handle hides and the plain web handle does not.
 */
function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value ?? null);
  if (serialized === undefined) throw new Error('Value must be JSON-serializable');
  return serialized;
}

function zeroCounts(): Record<RecommendationStatusName, number> {
  return {
    proposed: 0,
    accepted: 0,
    dismissed: 0,
    exported: 0,
    applied: 0,
    superseded: 0,
  };
}

interface RunRow {
  id: string;
  org_id: string;
  profile_id: string;
  status: string;
  lookback_days: number;
  window_start: string | null;
  window_end: string | null;
  engine_version: string | null;
  proposals_count: number;
  created_at: Date | string;
  finished_at: Date | string | null;
  group_id: string | null;
  group_role: OptimizationGroup['role'] | null;
  group_snapshot: unknown;
  due_at: Date | string | null;
  counts: Record<string, number> | null;
}

function toRunSummary(row: RunRow): RecommendationRunSummary {
  const counts = zeroCounts();
  for (const [status, value] of Object.entries(row.counts ?? {})) {
    if ((RECOMMENDATION_STATUSES as readonly string[]).includes(status)) {
      counts[status as RecommendationStatusName] = Number(value);
    }
  }
  const groupSnapshot = row.group_snapshot === null
    ? null
    : OptimizationGroup.parse(row.group_snapshot);
  if (groupSnapshot !== null && groupSnapshot.id !== row.group_id) {
    throw new Error('recommendation run group snapshot does not match group_id');
  }
  return {
    id: row.id,
    orgId: row.org_id,
    profileId: row.profile_id,
    status: row.status,
    lookbackDays: row.lookback_days,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    engineVersion: row.engine_version,
    proposalsCount: row.proposals_count,
    createdAt: toDate(row.created_at),
    finishedAt: toDateOrNull(row.finished_at),
    groupId: row.group_id,
    groupRole: row.group_role,
    groupSnapshot,
    dueAt: toDateOrNull(row.due_at),
    counts,
  };
}

/**
 * Runs for an org, newest first. `profileId` narrows to one profile; omitting
 * it is the cross-profile view the incumbent does not have.
 */
export async function listRecommendationRuns(
  handle: RecommendationQueryHandle,
  options: { orgId: string; profileId?: string | null; limit?: number },
): Promise<RecommendationRunSummary[]> {
  const limit = options.limit ?? 20;
  const rows = await handle.sql<RunRow[]>`
    select r.id, r.org_id, r.profile_id, r.status::text as status, r.lookback_days,
           r.window_start::text as window_start, r.window_end::text as window_end,
           r.engine_version, r.proposals_count, r.created_at, r.finished_at,
           r.group_id, r.group_role::text as group_role, r.group_snapshot, r.due_at,
           (
             select jsonb_object_agg(s.status, s.count)
               from (
                 select status::text as status, count(*)::int as count
                   from public.recommendations c
                  where c.run_id = r.id
                  group by status
               ) s
           ) as counts
      from public.recommendation_runs r
     where r.org_id = ${options.orgId}
       and (${options.profileId ?? null}::uuid is null or r.profile_id = ${options.profileId ?? null}::uuid)
     order by coalesce(r.finished_at, r.created_at) desc
     limit ${limit}
  `;
  return rows.map(toRunSummary);
}

/** One run plus the doctrine snapshot it was computed under. */
export async function getRecommendationRun(
  handle: RecommendationQueryHandle,
  options: { orgId: string; runId: string },
): Promise<RecommendationRunDetail | null> {
  const rows = await handle.sql<(RunRow & { strategy_snapshot: JsonValue | null })[]>`
    select r.id, r.org_id, r.profile_id, r.status::text as status, r.lookback_days,
           r.window_start::text as window_start, r.window_end::text as window_end,
           r.engine_version, r.proposals_count, r.created_at, r.finished_at,
           r.group_id, r.group_role::text as group_role, r.group_snapshot, r.due_at,
           r.strategy_snapshot,
           (
             select jsonb_object_agg(s.status, s.count)
               from (
                 select status::text as status, count(*)::int as count
                   from public.recommendations c
                  where c.run_id = r.id
                  group by status
               ) s
           ) as counts
      from public.recommendation_runs r
     where r.org_id = ${options.orgId} and r.id = ${options.runId}
  `;
  const row = rows[0];
  if (!row) return null;
  return { ...toRunSummary(row), strategySnapshot: row.strategy_snapshot };
}

/**
 * Every proposal in a run, with the campaign and ad-group names resolved and
 * the latest decision note attached.
 *
 * No pagination, on purpose and for the same reason the grid has none
 * (`tools/recon/02-data-grid.md` §6): QA-ing a preview means sorting the whole
 * set by spend and scanning it. `limit` exists as a safety valve, not as a page
 * size.
 */
export async function listRecommendations(
  handle: RecommendationQueryHandle,
  options: {
    orgId: string;
    runId?: string | null;
    profileId?: string | null;
    statuses?: readonly string[] | null;
    reasons?: readonly string[] | null;
    /** Only the proposals stamped with this export batch. */
    exportBatchId?: string | null;
    limit?: number;
  },
): Promise<RecommendationRecord[]> {
  const statuses = options.statuses && options.statuses.length > 0 ? [...options.statuses] : null;
  const reasons = options.reasons && options.reasons.length > 0 ? [...options.reasons] : null;
  const rows = await handle.sql<RecommendationRow[]>`
    select c.id, c.run_id, c.org_id, c.profile_id, c.reason::text as reason,
           c.entity_type::text as entity_type, c.entity_id, c.entity_name,
           c.ad_product::text as ad_product, c.campaign_id, c.ad_group_id,
           camp.name as campaign_name, ag.name as ad_group_name,
           camp.portfolio_amazon_id as campaign_portfolio_id,
           (camp.id is not null) as campaign_known,
           c.field, c.current_value, c.proposed_value, c.inputs, c.status::text as status,
           c.decided_by, c.decided_at, c.export_batch_id, batch.tag as export_batch_tag,
           note.payload ->> 'note' as decision_note,
           c.created_at
      from public.recommendations c
      -- A campaign-level proposal may carry its id only in entity_id, so resolve
      -- through both rather than leaving the campaign unknown and refusing the
      -- export row later for a reason that is not true.
      left join public.campaigns camp
        on camp.profile_id = c.profile_id
       and camp.amazon_id = coalesce(
             c.campaign_id,
             case when c.entity_type = 'campaign' then c.entity_id end
           )
      left join public.ad_groups ag
        on ag.profile_id = c.profile_id and ag.amazon_id = c.ad_group_id
      left join public.apply_batches batch on batch.id = c.export_batch_id
      left join lateral (
        select a.payload
          from public.audit_log a
         where a.org_id = c.org_id
           and a.target_type = 'recommendation'
           and a.target_id = c.id::text
           and a.payload ? 'note'
         order by a.created_at desc, a.id desc
         limit 1
      ) note on true
     where c.org_id = ${options.orgId}
       and (${options.runId ?? null}::uuid is null or c.run_id = ${options.runId ?? null}::uuid)
       and (${options.profileId ?? null}::uuid is null or c.profile_id = ${options.profileId ?? null}::uuid)
       and (${options.exportBatchId ?? null}::uuid is null
            or c.export_batch_id = ${options.exportBatchId ?? null}::uuid)
       and (${statuses}::text[] is null or c.status::text = any (${statuses}::text[]))
       and (${reasons}::text[] is null or c.reason::text = any (${reasons}::text[]))
     order by c.created_at, c.id
     limit ${options.limit ?? 20000}
  `;
  return rows.map(toRecord);
}

export interface DecisionResult {
  updated: number;
  /** Ids the transition refused, with why. An export already happened on these. */
  refused: { id: string; status: string }[];
}

/**
 * Accept, dismiss, or re-open proposals, and record the note.
 *
 * A dismissal without a note is refused outright: "why did we not do this" is
 * the question somebody asks six weeks later, and an empty string is not an
 * answer. Acceptance notes are optional but recorded when present.
 */
export async function decideRecommendations(
  handle: RecommendationQueryHandle,
  options: {
    orgId: string;
    ids: readonly string[];
    decision: RecommendationDecision;
    actorId?: string | null;
    note?: string | null;
  },
): Promise<DecisionResult> {
  const note = (options.note ?? '').trim();
  if (options.decision === 'dismissed' && note.length === 0) {
    throw new Error('A dismissal needs a note: record why this proposal is not being taken.');
  }
  const ids = [...new Set(options.ids)];
  if (ids.length === 0) return { updated: 0, refused: [] };

  const decided = options.decision === 'proposed' ? null : new Date().toISOString();
  const updated = await handle.sql<{ id: string }[]>`
    update public.recommendations
       set status = ${options.decision}::public.recommendation_status,
           decided_by = ${options.actorId ?? null}::uuid,
           decided_at = ${decided}::timestamptz
     where org_id = ${options.orgId}
       and id = any (${ids}::uuid[])
       and status::text = any (${[...DECIDABLE_FROM]}::text[])
     returning id
  `;

  const changed = new Set(updated.map((row) => row.id));
  const refusedRows =
    changed.size === ids.length
      ? []
      : await handle.sql<{ id: string; status: string }[]>`
          select id, status::text as status
            from public.recommendations
           where org_id = ${options.orgId}
             and id = any (${ids.filter((id) => !changed.has(id))}::uuid[])
        `;

  // One statement, not one per row: a bulk decision over a filtered preview is
  // the interaction this surface exists for, and four thousand round trips is
  // not an audit trail, it is a timeout.
  if (updated.length > 0) {
    await handle.sql`
      insert into public.audit_log
        (org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
      select ${options.orgId}, 'user', ${options.actorId ?? null},
             ${`recommendation.${options.decision}`}, 'recommendation', target,
             ${serializeJson({ note })}::text::jsonb, 'web'
        from unnest(${updated.map((row) => row.id)}::text[]) as target
    `;
  }

  return { updated: updated.length, refused: refusedRows.map((row) => ({ id: row.id, status: row.status })) };
}

/**
 * Which proposals the update bridge can carry.
 *
 * `batches.py` addresses keywords, targets, campaigns, ad groups and
 * placements; a `negative` proposal is a *create*, not an old-to-new change,
 * so it has no place in an old/new ledger and is exported through the
 * workbook's create rows instead. Saying that out loud beats silently dropping
 * the row.
 */
const APPLY_ENTITY_TYPES: Record<string, ApplyRow['entityType'] | undefined> = {
  keyword: 'keyword',
  target: 'target',
  campaign: 'campaign',
  ad_group: 'ad_group',
};

export function applyEntityTypeFor(entityType: string): ApplyRow['entityType'] | null {
  return APPLY_ENTITY_TYPES[entityType] ?? null;
}

/** A proposal that the rows-JSON bridge cannot carry, and the reason. */
export interface ExportSkip {
  id: string;
  entityType: string;
  field: string;
  reason: string;
}

export interface ExportBatchResult {
  batchId: string;
  tag: string;
  /** Proposals moved to `exported`. */
  exported: number;
  /** Accepted proposals in the run at export time, exported or not. */
  accepted: number;
  rows: ApplyRow[];
  /** Accepted proposals the update ledger cannot carry (negative creates). */
  skipped: ExportSkip[];
}

function toNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function applyValue(value: JsonValue): ApplyRow['old'] {
  if (value === null) return null;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  // An object or array in a value column is a contract violation upstream, not
  // something to coerce into a plausible scalar.
  throw new Error('A staged value must be a scalar; got a structured value');
}

function sameApplyValue(left: ApplyRow['old'], right: ApplyRow['old']): boolean {
  return typeof left === typeof right && Object.is(left, right);
}

/**
 * Turn accepted proposals into a staged-apply batch.
 *
 * One batch is one opt group and one lever, exactly as `batches.py` requires,
 * and the note is mandatory there too. The whole thing runs in one transaction:
 * a batch whose rows were written but whose proposals still say `accepted`
 * would be a ledger that lies.
 */
export async function exportAcceptedRecommendations(
  handle: RecommendationQueryHandle,
  options: {
    orgId: string;
    profileId: string;
    runId: string;
    /** Restrict to these proposals; omit for every accepted proposal in the run. */
    ids?: readonly string[] | null;
    tag: string;
    optGroup: string;
    lever: string;
    note: string;
    actorId?: string | null;
  },
): Promise<ExportBatchResult> {
  const note = options.note.trim();
  if (note.length === 0) {
    throw new Error('An export needs a note: it is the note the staged apply carries to Amazon.');
  }
  const tag = options.tag.trim();
  if (tag.length === 0) throw new Error('An export needs a batch tag.');

  return await handle.sql.begin(async (sql) => {
    const ids = options.ids && options.ids.length > 0 ? [...new Set(options.ids)] : null;
    const candidates = await sql<
      {
        id: string;
        entity_type: string;
        entity_id: string;
        entity_name: string | null;
        field: string;
        current_value: JsonValue;
        proposed_value: JsonValue;
        inputs: RecommendationInputs;
      }[]
    >`
      select id, entity_type::text as entity_type, entity_id, entity_name, field,
             current_value, proposed_value, inputs
        from public.recommendations
       where org_id = ${options.orgId}
         and profile_id = ${options.profileId}
         and run_id = ${options.runId}
         and status = 'accepted'
         and (${ids}::uuid[] is null or id = any (${ids}::uuid[]))
       order by created_at, id
    `;

    const [acceptedRow] = await sql<{ count: number }[]>`
      select count(*)::int as count
        from public.recommendations
       where org_id = ${options.orgId} and run_id = ${options.runId} and status = 'accepted'
    `;
    const accepted = acceptedRow?.count ?? 0;

    const rows: ApplyRow[] = [];
    const rowRecommendationIds: string[] = [];
    const exportedIds: string[] = [];
    const skipped: ExportSkip[] = [];

    const applyStateTargets = candidates.flatMap((candidate) => {
      const entityType = applyEntityTypeFor(candidate.entity_type);
      return entityType === null
        ? []
        : [{ key: candidate.id, entityType, entityId: candidate.entity_id, field: candidate.field }];
    });
    await lockCurrentApplyStates({ sql }, {
      orgId: options.orgId,
      profileId: options.profileId,
      targets: applyStateTargets,
    });
    const currentStates = await resolveCurrentApplyStates({ sql }, {
      orgId: options.orgId,
      profileId: options.profileId,
      targets: applyStateTargets,
    });
    const currentStateByRecommendation = new Map(
      currentStates.map((state) => [state.key, state] as const),
    );

    for (const candidate of candidates) {
      const entityType = applyEntityTypeFor(candidate.entity_type);
      if (entityType === null) {
        // Still exported — it leaves the tool in this batch and ships as a
        // create row in the workbook — but it gets no `apply_rows` entry,
        // because an old-to-new ledger has nothing to say about a create.
        skipped.push({
          id: candidate.id,
          entityType: candidate.entity_type,
          field: candidate.field,
          reason:
            'a negative is created, not changed: it ships as a create row in the workbook and ' +
            'is absent from the rows JSON, which is an old-to-new ledger',
        });
        exportedIds.push(candidate.id);
        continue;
      }
      const currentState = currentStateByRecommendation.get(candidate.id);
      if (currentState === undefined || !currentState.supported) {
        throw new Error(
          `Cannot export ${candidate.entity_type}:${candidate.entity_id}.${candidate.field}: ` +
            'the current-state adapter does not support this field.',
        );
      }
      if (!currentState.present) {
        throw new Error(
          `Cannot export ${candidate.entity_type}:${candidate.entity_id}.${candidate.field}: ` +
            'the entity is missing or deleted in the synchronized mirror.',
        );
      }
      const expectedCurrent = applyValue(candidate.current_value);
      if (!sameApplyValue(currentState.currentValue, expectedCurrent)) {
        throw new Error(
          `Cannot export ${candidate.entity_type}:${candidate.entity_id}.${candidate.field}: ` +
            'the synchronized value changed after this recommendation was calculated. Refresh recommendations first.',
        );
      }
      const row: ApplyRow = {
        entityType,
        entityId: candidate.entity_id,
        field: candidate.field,
        old: applyValue(candidate.current_value),
        new: applyValue(candidate.proposed_value),
      };
      if (candidate.entity_name !== null) row.name = candidate.entity_name;
      const clicks = toNumberOrUndefined(candidate.inputs?.clicks);
      if (clicks !== undefined) row.clicks = clicks;
      // batches.py's off-formula check reads `revenue`; the engine carries RPC
      // and the click count, so revenue is rpc x clicks and never a guess.
      const rpc = toNumberOrUndefined(candidate.inputs?.rpc);
      if (rpc !== undefined && clicks !== undefined) row.revenue = Number((rpc * clicks).toFixed(4));
      rows.push(row);
      rowRecommendationIds.push(candidate.id);
      exportedIds.push(candidate.id);
    }

    if (exportedIds.length === 0) throw new Error('No accepted proposals to export.');

    const artifactSha256 = createHash('sha256')
      .update(serializeApplyRows(rows))
      .digest('hex');
    const [batch] = await sql<{ id: string }[]>`
      insert into public.apply_batches
        (org_id, profile_id, tag, opt_group, lever, note, status, created_by,
         exported_at, artifact_sha256, exported_proposals, reversible_rows, unsupported_rows)
      values (${options.orgId}, ${options.profileId}, ${tag}, ${options.optGroup},
              ${options.lever}, ${note}, 'staged', ${options.actorId ?? null}::uuid,
              now(), ${artifactSha256}, ${exportedIds.length}, ${rows.length}, ${skipped.length})
      returning id
    `;
    const batchId = batch?.id;
    if (batchId === undefined) throw new Error('Failed to create the export batch.');

    // One statement for the whole batch: a four-thousand-row export is the case
    // this has to survive, and `unnest` keeps the order the rows were built in.
    const inserted =
      rows.length === 0
        ? []
        : await sql<{ id: string }[]>`
            insert into public.apply_rows
              (batch_id, org_id, profile_id, recommendation_id, artifact_ordinal, entity_type, entity_id,
               entity_name, field, old_value, new_value, lever, clicks, revenue)
            select ${batchId}, ${options.orgId}, ${options.profileId}, r.recommendation_id::uuid,
                   r.artifact_ordinal,
                   r.entity_type::public.apply_entity_type, r.entity_id, r.entity_name,
                   r.field, r.old_value::jsonb, r.new_value::jsonb,
                   ${options.lever}, r.clicks::bigint, r.revenue::numeric
              from unnest(
                     ${rowRecommendationIds}::text[],
                     ${rows.map((row) => row.entityType)}::text[],
                     ${rows.map((row) => row.entityId)}::text[],
                     ${rows.map((row) => row.name ?? null)}::text[],
                     ${rows.map((row) => row.field)}::text[],
                     ${rows.map((row) => serializeJson(row.old))}::text[],
                     ${rows.map((row) => serializeJson(row.new))}::text[],
                     ${rows.map((row) => (row.clicks === undefined ? null : String(row.clicks)))}::text[],
                     ${rows.map((row) => (row.revenue === undefined ? null : String(row.revenue)))}::text[]
                   ) with ordinality as r(recommendation_id, entity_type, entity_id, entity_name, field,
                          old_value, new_value, clicks, revenue, artifact_ordinal)
            returning id
          `;
    // Program rule 4: count outputs against inputs rather than trusting the
    // absence of an exception.
    if (inserted.length !== rows.length) {
      throw new Error(`Offered ${rows.length} apply rows, wrote ${inserted.length}`);
    }

    const stamped = await sql<{ id: string }[]>`
      update public.recommendations
         set status = 'exported', export_batch_id = ${batchId}
       where org_id = ${options.orgId}
         and id = any (${exportedIds}::uuid[])
         and status = 'accepted'
       returning id
    `;
    if (stamped.length !== exportedIds.length) {
      throw new Error(`Exported ${exportedIds.length} proposals, stamped ${stamped.length}`);
    }

    await sql`
      insert into public.audit_log
        (org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
      values (${options.orgId}, 'user', ${options.actorId ?? null}, 'recommendation.exported',
              'apply_batch', ${batchId},
              ${serializeJson({
                note,
                tag,
                lever: options.lever,
                optGroup: options.optGroup,
                runId: options.runId,
                rows: rows.length,
                skipped: skipped.length,
              })}::text::jsonb, 'web')
    `;

    return { batchId, tag, exported: stamped.length, accepted, rows, skipped };
  });
}

export interface ExportBatchRecord {
  id: string;
  orgId: string;
  profileId: string;
  tag: string;
  optGroup: string;
  lever: string;
  note: string;
  status: string;
  createdAt: Date;
  rows: ApplyRow[];
  /** The proposals stamped with this batch, for the workbook's create rows. */
  proposals: RecommendationRecord[];
}

/** Re-read a batch so its files can be produced again without re-deciding. */
export async function getExportBatch(
  handle: RecommendationQueryHandle,
  options: { orgId: string; batchId: string },
): Promise<ExportBatchRecord | null> {
  const batches = await handle.sql<
    {
      id: string;
      org_id: string;
      profile_id: string;
      tag: string;
      opt_group: string;
      lever: string;
      note: string;
      status: string;
      created_at: Date | string;
    }[]
  >`
    select id, org_id, profile_id, tag, opt_group, lever, note, status::text as status, created_at
      from public.apply_batches
     where org_id = ${options.orgId} and id = ${options.batchId}
  `;
  const batch = batches[0];
  if (!batch) return null;

  const rowRecords = await handle.sql<
    {
      entity_type: string;
      entity_id: string;
      entity_name: string | null;
      field: string;
      old_value: JsonValue;
      new_value: JsonValue;
      clicks: string | number | null;
      revenue: string | number | null;
    }[]
  >`
    select entity_type::text as entity_type, entity_id, entity_name, field,
           old_value, new_value, clicks, revenue
      from public.apply_rows
     where org_id = ${options.orgId} and batch_id = ${options.batchId}
     order by artifact_ordinal
  `;

  const rows: ApplyRow[] = rowRecords.map((row) => {
    const out: ApplyRow = {
      entityType: row.entity_type as ApplyRow['entityType'],
      entityId: row.entity_id,
      field: row.field,
      old: applyValue(row.old_value),
      new: applyValue(row.new_value),
    };
    if (row.entity_name !== null) out.name = row.entity_name;
    if (row.clicks !== null) out.clicks = Number(row.clicks);
    if (row.revenue !== null) out.revenue = Number(row.revenue);
    return out;
  });

  const proposals = await listRecommendations(handle, {
    orgId: options.orgId,
    exportBatchId: options.batchId,
  });

  return {
    id: batch.id,
    orgId: batch.org_id,
    profileId: batch.profile_id,
    tag: batch.tag,
    optGroup: batch.opt_group,
    lever: batch.lever,
    note: batch.note,
    status: batch.status,
    createdAt: toDate(batch.created_at),
    rows,
    proposals,
  };
}

// ---------------------------------------------------------------------------
// N-gram explorer: proposals, never actions
// ---------------------------------------------------------------------------

export interface NegativeProposalInput {
  /** The search term or gram to negate. */
  searchTerm: string;
  campaignId: string;
  adGroupId: string | null;
  /** `negative_exact` or `negative_phrase`; the UI offers exact by default. */
  matchType: 'negative_exact' | 'negative_phrase';
  inputs: RecommendationInputs;
}

export interface NegativeProposalResult {
  runId: string;
  created: number;
}

/**
 * Record "propose as negative" clicks as real proposals.
 *
 * They land in their own run, marked with an engine version that says a human
 * asked for them rather than the weekly engine: a proposal whose provenance is
 * "an operator clicked a gram" must not be indistinguishable from one the
 * White Box formula produced.
 */
export async function createNegativeProposals(
  handle: RecommendationQueryHandle,
  options: {
    orgId: string;
    profileId: string;
    window: { start: string; end: string };
    lookbackDays: number;
    proposals: readonly NegativeProposalInput[];
    actorId?: string | null;
    engineVersion?: string;
  },
): Promise<NegativeProposalResult> {
  if (options.proposals.length === 0) throw new Error('No negative proposals supplied.');

  return await handle.sql.begin(async (sql) => {
    const [run] = await sql<{ id: string }[]>`
      insert into public.recommendation_runs
        (org_id, profile_id, status, lookback_days, window_start, window_end, engine_version,
         proposals_count, started_at, finished_at)
      values (${options.orgId}, ${options.profileId}, 'succeeded', ${options.lookbackDays},
              ${options.window.start}::date, ${options.window.end}::date,
              ${options.engineVersion ?? 'ngram-explorer'}, ${options.proposals.length},
              now(), now())
      returning id
    `;
    const runId = run?.id;
    if (runId === undefined) throw new Error('Failed to create the proposal run.');

    // A row at a time here, unlike the export: this set is bounded by what a
    // human selected in one panel, and the per-row insert keeps the column list
    // readable at the place the proposal's shape is decided.
    let created = 0;
    for (const proposal of options.proposals) {
      const inserted = await sql<{ id: string }[]>`
        insert into public.recommendations
          (run_id, org_id, profile_id, reason, entity_type, entity_id, ad_product, campaign_id,
           ad_group_id, entity_name, field, current_value, proposed_value, inputs, status)
        values (${runId}, ${options.orgId}, ${options.profileId}, 'flag', 'negative',
                ${`${proposal.adGroupId ?? proposal.campaignId}:${proposal.searchTerm}`},
                'SP', ${proposal.campaignId}, ${proposal.adGroupId},
                ${proposal.searchTerm}, 'negative_keyword', null,
                ${serializeJson(proposal.matchType)}::text::jsonb,
                ${serializeJson(proposal.inputs)}::text::jsonb,
                'proposed')
        returning id
      `;
      created += inserted.length;
    }
    if (created !== options.proposals.length) {
      throw new Error(`Offered ${options.proposals.length} negative proposals, wrote ${created}`);
    }

    await sql`
      insert into public.audit_log
        (org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
      values (${options.orgId}, 'user', ${options.actorId ?? null}, 'recommendation.proposed',
              'recommendation_run', ${runId},
              ${serializeJson({ proposals: created, source: 'ngram-explorer' })}::text::jsonb, 'web')
    `;

    return { runId, created };
  });
}
