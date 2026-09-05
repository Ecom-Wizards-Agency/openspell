import { createHash } from 'node:crypto';
import { serializeApplyRows, type ApplyRow } from '@wizard-ads/shared';
import { SpWriteActor, SpWritePreview, SpWritePreviewRequest } from '@wizard-ads/shared/sp-write-application';
import {
  SpWritePreviewEvidence, serializeSpWritePreviewGuardrails, serializeSpWritePreviewProvenance,
} from '@wizard-ads/shared/sp-write-preview-evidence';
import {
  SpCanonicalDecimal,
  SpWriteAction,
  SpWritePlan,
  SpWriteProviderScope,
  orderSpWriteActions,
  serializeSpWriteActionFingerprint,
  serializeSpWritePlanFingerprint,
  spWritePlanBinding,
  verifySpWritePlanFingerprints,
} from '@wizard-ads/shared/sp-writes';
import type { DbHandle, QuerySql } from '../client.js';
import { loadSpWritePreviewEvidence, recordSpWritePreviewEvidence } from './sp-write-preview-evidence.js';
import { SpWriteApplicationError } from './sp-write-errors.js';
import { toDate } from './pg-time.js';

// Preview freshness is an application protocol limit, not a tenant bid cap.
const PREVIEW_LIFETIME_MS = 15 * 60_000;
const ZERO_HASH = '0'.repeat(64);
const hasher = { algorithm: 'sha256' as const, digest: sha256 };

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Decimal text normalization never passes through binary floating point. */
function decimal(value: string | null): string {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new SpWriteApplicationError('unsupported_source');
  }
  const [integer = '', fraction = ''] = value.split('.');
  const whole = integer.replace(/^0+(?=\d)/, '');
  const tail = fraction.replace(/0+$/, '');
  const parsed = SpCanonicalDecimal.safeParse(tail ? `${whole}.${tail}` : whole);
  if (!parsed.success) throw new SpWriteApplicationError('unsupported_source');
  return parsed.data;
}

function actionId(planId: string, rowId: string): string {
  const bytes = createHash('sha256').update(JSON.stringify(['openspell.sp-write-action-id.v1', planId, rowId])).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = bytes.subarray(0, 16).toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

async function requireOperator(sql: QuerySql, actor: SpWriteActor): Promise<void> {
  const rows = await sql<{ allowed: boolean }[]>`
    select exists(select 1 from public.org_members
                   where org_id = ${actor.orgId}::uuid and user_id = ${actor.userId}::uuid
                     and role in ('owner', 'admin')) as allowed
  `;
  if (rows.length !== 1 || rows[0]?.allowed !== true) {
    throw new SpWriteApplicationError('authorization_refused');
  }
}

async function existingPreview(
  sql: QuerySql, actor: SpWriteActor, request: SpWritePreviewRequest,
): Promise<SpWritePreview | null> {
  const recorded = await loadSpWritePreviewEvidence(sql, {
    orgId: actor.orgId, profileId: request.profileId, planId: request.requestId,
  });
  if (recorded === null) return null;
  const { plan, evidence } = recorded;
  if (evidence.schemaVersion !== 'openspell.sp-write-preview-evidence.v1') {
    throw new SpWriteApplicationError('unsupported_source');
  }
  if (plan.source.kind !== 'apply_batch' || plan.source.applyBatchId !== request.applyBatchId) {
    throw new SpWriteApplicationError('identity_conflict');
  }
  return SpWritePreview.parse({ plan, binding: spWritePlanBinding(plan), evidence });
}

interface BatchSnapshot {
  tag: string;
  grant_id: string;
  grant_version: string;
  status: string;
  source_batch_id: string | null;
  artifact_sha256: string | null;
  reversible_rows: number;
  unsupported_rows: number;
  exported_proposals: number;
  opt_group: string;
  lever: string;
  note: string;
  exported_at: string;
  amazon_profile_id: string;
  connection_id: string;
  region: string;
  marketplace_id: string;
  currency_code: string;
  api_dialect: string;
}

interface SourceRow {
  id: string;
  entity_type: string;
  entity_id: string;
  entity_name: string | null;
  field: string;
  old_value: string | null;
  new_value: string | null;
  old_json: string;
  new_json: string;
  clicks: string | null;
  revenue: string | null;
  current_bid: string | null;
  ad_product: string | null;
  deleted_at: Date | string | null;
  entity_state: string | null;
  synced_at: Date | string | null;
  recommendation_id: string | null;
  proposal_revision_id: string | null;
  run_id: string | null;
  strategy_snapshot: string | null;
  strategy_goal: string | null;
  group_id: string | null;
  group_snapshot: string | null;
}

// Compatibility only: reproduce the existing export serializer, refusing any
// numeric source it cannot round-trip exactly. Plan money never uses this value.
function exportScalar(raw: string): ApplyRow['old'] {
  const value: unknown = JSON.parse(raw);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value) && decimal(String(value)) === decimal(raw)) return value;
  throw new SpWriteApplicationError('unsupported_source');
}

function exportNumber(raw: string): number {
  const value = exportScalar(raw);
  if (typeof value !== 'number') throw new SpWriteApplicationError('unsupported_source');
  return value;
}

async function buildPlan(
  sql: QuerySql, actor: SpWriteActor, request: SpWritePreviewRequest,
): Promise<{ plan: SpWritePlan; evidence: SpWritePreviewEvidence }> {
  const batches = await sql<BatchSnapshot[]>`
    select b.tag, g.grant_id::text, g.version_id::text as grant_version,
           b.status::text, b.source_batch_id::text, b.artifact_sha256,
           b.reversible_rows, b.unsupported_rows, b.exported_proposals,
           b.opt_group, b.lever, b.note,
           to_char(b.exported_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as exported_at,
           p.amazon_profile_id, p.connection_id::text, p.region::text,
           g.marketplace_id, p.currency_code, g.api_dialect
      from public.apply_batches b
      join public.ad_profiles p on p.org_id = b.org_id and p.id = b.profile_id
      join public.ads_connections c on c.org_id = p.org_id and c.id = p.connection_id
      join public.sp_write_profile_grant_heads h on h.org_id = p.org_id and h.profile_id = p.id
      join public.sp_write_profile_grant_versions g
        on g.org_id = h.org_id and g.profile_id = h.profile_id
       and g.grant_id = h.grant_id and g.version_id = h.version_id
     where b.org_id = ${actor.orgId}::uuid and b.profile_id = ${request.profileId}::uuid
       and b.id = ${request.applyBatchId}::uuid
       and b.source_kind = 'legacy_export'
       and p.sync_enabled and c.status = 'active' and g.enabled
       and g.amazon_profile_id = p.amazon_profile_id and g.connection_id = p.connection_id
       and g.region = p.region and g.currency_code = p.currency_code and g.api_dialect = 'sp_v3'
  `;
  if (batches.length !== 1) throw new SpWriteApplicationError('not_found');
  const batch = batches[0]!;
  if (batch.status !== 'staged' || batch.source_batch_id !== null
    || batch.artifact_sha256 === null || !/^[a-f0-9]{64}$/.test(batch.artifact_sha256)
    || batch.unsupported_rows !== 0 || batch.reversible_rows < 1 || batch.reversible_rows > 500
    || batch.exported_proposals !== batch.reversible_rows) {
    throw new SpWriteApplicationError('unsupported_source');
  }
  const rows = await sql<SourceRow[]>`
    select r.id::text, r.entity_type::text, r.entity_id, r.entity_name, r.field,
           r.old_value #>> '{}' as old_value, r.new_value #>> '{}' as new_value,
           r.old_value::text as old_json, r.new_value::text as new_json,
           r.clicks::text, r.revenue::text,
           k.bid::text as current_bid, k.ad_product::text, k.deleted_at,
           k.state::text as entity_state, k.synced_at,
           r.recommendation_id::text, r.proposal_revision_id::text, rec.run_id::text, run.strategy_snapshot::text,
           run.strategy_goal, run.group_id::text, run.group_snapshot::text
      from public.apply_rows r
      left join public.keywords k
        on k.org_id = r.org_id and k.profile_id = r.profile_id and k.amazon_id = r.entity_id
      left join public.recommendations rec
        on rec.org_id = r.org_id and rec.profile_id = r.profile_id and rec.id = r.recommendation_id
      left join public.recommendation_runs run
        on run.org_id = rec.org_id and run.profile_id = rec.profile_id and run.id = rec.run_id
     where r.org_id = ${actor.orgId}::uuid and r.profile_id = ${request.profileId}::uuid
       and r.batch_id = ${request.applyBatchId}::uuid
     order by rec.created_at, rec.id
  `;
  if (rows.length !== batch.reversible_rows) throw new SpWriteApplicationError('source_changed');
  const scope = SpWriteProviderScope.parse({
    amazonProfileId: batch.amazon_profile_id, connectionId: batch.connection_id,
    region: batch.region, marketplaceId: batch.marketplace_id,
    currencyCode: batch.currency_code, apiDialect: batch.api_dialect,
  });
  const actions = rows.map((row) => {
    if (row.entity_type !== 'keyword' || row.field !== 'bid' || row.ad_product !== 'SP'
      || row.deleted_at !== null || row.synced_at === null
      || !['enabled', 'paused'].includes(row.entity_state ?? '')
      || row.recommendation_id === null || row.run_id === null
      || row.strategy_snapshot === null || row.strategy_goal === null) {
      throw new SpWriteApplicationError('unsupported_source');
    }
    const expected = decimal(row.old_value);
    const requested = decimal(row.new_value);
    if (expected !== decimal(row.current_bid)) throw new SpWriteApplicationError('source_changed');
    if (requested === expected || requested === '0') throw new SpWriteApplicationError('unsupported_source');
    const action = SpWriteAction.parse({
      actionId: actionId(request.requestId, row.id), routeKey: 'sp.v3.keywords.update',
      entity: { keywordId: row.entity_id }, sources: [{ kind: 'apply_row', applyRowId: row.id, changeKey: 'keyword.bid' }],
      changes: { bid: {
        expected: { amount: expected, currencyCode: scope.currencyCode },
        requested: { amount: requested, currencyCode: scope.currencyCode },
      } }, fingerprint: ZERO_HASH,
    });
    return SpWriteAction.parse({ ...action, fingerprint: sha256(serializeSpWriteActionFingerprint(action)) });
  });
  const artifactText = serializeApplyRows(rows.map((row): ApplyRow => ({
    entityType: 'keyword', entityId: row.entity_id, field: row.field,
    old: exportScalar(row.old_json), new: exportScalar(row.new_json),
    ...(row.entity_name === null ? {} : { name: row.entity_name }),
    ...(row.clicks === null ? {} : { clicks: exportNumber(row.clicks) }),
    ...(row.revenue === null ? {} : { revenue: exportNumber(row.revenue) }),
  })));
  if (sha256(artifactText) !== batch.artifact_sha256) throw new SpWriteApplicationError('source_changed');
  const evidence = SpWritePreviewEvidence.parse({
    schemaVersion: 'openspell.sp-write-preview-evidence.v1', planId: request.requestId,
    guardrails: {
      profileGrantId: batch.grant_id, profileGrantVersion: batch.grant_version,
      providerScope: scope, maximumProviderRows: 500, requireCurrentValueMatch: true,
      policies: rows.map((row) => ({
        applyRowId: row.id, recommendationId: row.recommendation_id, runId: row.run_id,
        strategySnapshotText: row.strategy_snapshot, strategyGoal: row.strategy_goal,
        groupId: row.group_id, groupSnapshotText: row.group_snapshot,
      })),
    },
    provenance: {
      applyBatchId: request.applyBatchId, artifactText, artifactSha256: batch.artifact_sha256,
      exportedAt: batch.exported_at, tag: batch.tag,
      optGroup: batch.opt_group, lever: batch.lever, note: batch.note,
      rows: rows.map((row) => ({ applyRowId: row.id, recommendationId: row.recommendation_id, runId: row.run_id,
        ...(row.proposal_revision_id === null ? {} : { proposalRevisionId: row.proposal_revision_id }),
      })),
    },
  });
  const nowRows = await sql<{ now: Date | string }[]>`select clock_timestamp() as now`;
  if (nowRows.length !== 1) throw new SpWriteApplicationError('outcome_unknown');
  const now = toDate(nowRows[0]!.now);
  const plan = SpWritePlan.parse({
    schemaVersion: 'openspell.sp-write-plan.v1', id: request.requestId,
    orgId: actor.orgId, profileId: request.profileId, providerScope: scope, direction: 'forward',
    source: {
      kind: 'apply_batch', applyBatchId: request.applyBatchId,
      guardrailSnapshotFingerprint: sha256(serializeSpWritePreviewGuardrails(evidence)),
      provenanceSnapshotFingerprint: sha256(serializeSpWritePreviewProvenance(evidence)),
    },
    generatedAt: now.toISOString(), frozenAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PREVIEW_LIFETIME_MS).toISOString(),
    actions: orderSpWriteActions(actions),
    counts: {
      logicalChanges: rows.length, providerRows: rows.length, uniqueEntities: rows.length,
      byRoute: {
        'sp.v3.campaigns.update': 0, 'sp.v3.ad_groups.update': 0,
        'sp.v3.keywords.update': rows.length, 'sp.v3.targets.update': 0, 'sp.v3.product_ads.update': 0,
      },
    }, fingerprint: ZERO_HASH,
  });
  return { plan: verifySpWritePlanFingerprints({ ...plan, fingerprint: sha256(serializeSpWritePlanFingerprint(plan)) }, hasher), evidence };
}

/** Create or recover the immutable preview; no approval, enqueue or provider I/O. */
export async function previewSpWrite(
  handle: Pick<DbHandle, 'sql'>, rawActor: SpWriteActor, rawRequest: SpWritePreviewRequest,
): Promise<SpWritePreview> {
  const actor = SpWriteActor.parse(rawActor);
  const request = SpWritePreviewRequest.parse(rawRequest);
  const snapshot = await handle.sql.begin('isolation level repeatable read read only', async (sql) => {
    await requireOperator(sql, actor);
    const existing = await existingPreview(sql, actor, request);
    if (existing !== null) return { existing: true, preview: existing };
    const { plan, evidence } = await buildPlan(sql, actor, request);
    return { existing: false, preview: SpWritePreview.parse({ plan, binding: spWritePlanBinding(plan), evidence }) };
  });
  if (snapshot.existing) return snapshot.preview;
  try {
    if (snapshot.preview.evidence?.schemaVersion !== 'openspell.sp-write-preview-evidence.v1') {
      throw new SpWriteApplicationError('invalid_request');
    }
    await recordSpWritePreviewEvidence(handle, snapshot.preview.plan, snapshot.preview.evidence);
    return snapshot.preview;
  } catch (error) {
    // Collision or a lost insert response may already have committed this preview.
    // Recovery only reads the exact tenant/source identity; it never inserts a new plan.
    if (!(error instanceof SpWriteApplicationError)) throw error;
    await requireOperator(handle.sql, actor);
    const existing = await existingPreview(handle.sql, actor, request);
    if (existing !== null) return existing;
    throw error;
  }
}
