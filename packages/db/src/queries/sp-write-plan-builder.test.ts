import { createHash, randomUUID } from 'node:crypto';
import { ApplyEntityType, serializeApplyRows, type ApplyRow } from '@wizard-ads/shared';
import { serializeSpWritePreviewGuardrails, serializeSpWritePreviewProvenance } from '@wizard-ads/shared/sp-write-preview-evidence';
import { serializeSpWritePlanFingerprint } from '@wizard-ads/shared/sp-writes';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { spWritePreviewEvidence } from '../schema/sp-writes.js';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { withAuthenticatedActor } from './authenticated-actor.js';
import { previewSpWrite } from './sp-write-plan-builder.js';
import { recordSpWritePreviewEvidence } from './sp-write-preview-evidence.js';
import { decideRecommendations, exportAcceptedRecommendations } from './recommendations.js';
import { reviseRecommendation } from './recommendation-revisions.js';

const available = await databaseAvailable();
const USER = '31313131-3131-4131-8131-313131313131';
const OTHER_USER = '42424242-4242-4242-8242-424242424242';

describe.skipIf(!available)('immutable SP keyword bid preview', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  let otherOrgId: string;
  let enabledVersion: string;
  let disabledVersion: string;
  let runId: string;

  beforeAll(async () => {
    database = await createTestDatabase('write_preview');
    const tenants = await database.sql<{ org_id: string; other_org_id: string }[]>`
      select app.seed_tenant_fixture('write-preview', ${USER}, 'owner') as org_id,
             app.seed_tenant_fixture('write-preview-other', ${OTHER_USER}, 'owner') as other_org_id
    `;
    orgId = tenants[0]!.org_id;
    otherOrgId = tenants[0]!.other_org_id;
    const profiles = await database.sql<{ id: string }[]>`select id::text from public.ad_profiles where org_id = ${orgId}`;
    profileId = profiles[0]!.id;
    const runs = await database.sql<{ id: string }[]>`select id::text from public.recommendation_runs where org_id = ${orgId} and profile_id = ${profileId}`;
    runId = runs[0]!.id;
    const original = await database.sql<{ version_id: string }[]>`
      select version_id::text from public.sp_write_profile_grant_heads where org_id = ${orgId} and profile_id = ${profileId}
    `;
    disabledVersion = original[0]!.version_id;
    enabledVersion = randomUUID();
    await database.sql`
      insert into public.sp_write_profile_grant_versions
        (grant_id, version_id, org_id, profile_id, enabled, amazon_profile_id,
         connection_id, region, marketplace_id, currency_code, api_dialect, created_by)
      select grant_id, ${enabledVersion}, org_id, profile_id, true, amazon_profile_id,
             connection_id, region, marketplace_id, currency_code, api_dialect, created_by
        from public.sp_write_profile_grant_versions where version_id = ${disabledVersion}
    `;
    await grantVersion(enabledVersion);
  }, 60_000);

  afterAll(async () => { await database?.drop(); });

  async function grantVersion(version: string) {
    await database.sql`update public.sp_write_profile_grant_heads set version_id = ${version}
      where org_id = ${orgId} and profile_id = ${profileId}`;
  }

  async function batch(options: { proposed?: string; entityType?: string; count?: number; secondRow?: boolean } = {}) {
    const batchId = randomUUID();
    const rowIds = [randomUUID(), ...(options.secondRow ? [randomUUID()] : [])];
    const recommendationIds = rowIds.map(() => randomUUID());
    const proposed = options.proposed ?? '0.700000';
    const entityType = ApplyEntityType.parse(options.entityType ?? 'keyword');
    const count = options.count ?? rowIds.length;
    const artifactRows: ApplyRow[] = rowIds.map(() => ({
      entityType, entityId: 'kw-1', field: 'bid', old: 0.9,
      new: JSON.parse(proposed) as ApplyRow['new'],
    }));
    const artifactSha256 = createHash('sha256').update(serializeApplyRows(artifactRows)).digest('hex');
    for (const recommendationId of recommendationIds) {
      await database.sql`
        insert into public.recommendations
          (id, run_id, org_id, profile_id, reason, entity_type, entity_id, field, current_value, proposed_value, inputs)
        values (${recommendationId}, ${runId}, ${orgId}, ${profileId}, 'high_acos',
                ${entityType}, 'kw-1', 'bid', '0.9'::jsonb, ${proposed}::jsonb, '{}'::jsonb)
      `;
    }
    await database.sql`
      insert into public.apply_batches
        (id, org_id, profile_id, tag, opt_group, lever, note, artifact_sha256,
         exported_proposals, reversible_rows, unsupported_rows, created_by)
      values (${batchId}, ${orgId}, ${profileId}, ${batchId}, 'synthetic', 'bid-down',
              'Synthetic exact preview', ${artifactSha256}, ${count}, ${count}, 0, ${USER})
    `;
    for (const [index, rowId] of rowIds.entries()) {
      const recommendationId = recommendationIds[index]!;
      await database.sql`
        insert into public.apply_rows
          (id, batch_id, org_id, profile_id, recommendation_id, entity_type, entity_id, field, old_value, new_value)
        values (${rowId}, ${batchId}, ${orgId}, ${profileId},
                ${recommendationId}, ${entityType}::public.apply_entity_type,
                'kw-1', 'bid', '0.9000'::jsonb, ${proposed}::jsonb)
      `;
      await database.sql`update public.recommendations set status = 'exported', export_batch_id = ${batchId}
        where id = ${recommendationId} and org_id = ${orgId}`;
    }
    return { batchId, rowIds };
  }

  async function storedCount(requestId: string): Promise<number> {
    const rows = await database.sql<{ count: number }[]>`
      select count(*)::int as count from public.sp_write_plans where plan_id = ${requestId}
    `;
    return rows[0]!.count;
  }

  it('reads exact decimal text and binds every real source row without approving or enqueueing', async () => {
    const source = await batch({ proposed: JSON.stringify('123456789012.123456') });
    const request = { requestId: randomUUID(), profileId, applyBatchId: source.batchId };
    const preview = await previewSpWrite(database, { orgId, userId: USER }, request);
    expect(preview.plan.actions).toHaveLength(source.rowIds.length);
    expect(preview.plan.actions[0]).toMatchObject({
      sources: [{ kind: 'apply_row', applyRowId: source.rowIds[0], changeKey: 'keyword.bid' }],
      changes: { bid: { expected: { amount: '0.9' }, requested: { amount: '123456789012.123456' } } },
    });
    expect(preview.binding.counts.providerRows).toBe(source.rowIds.length);
    expect(preview.evidence?.guardrails.profileGrantVersion).toBe(enabledVersion);
    expect(await storedCount(request.requestId)).toBe(1);
    const rows = await database.sql<{ approvals: number; wakes: number }[]>`
      select (select count(*)::int from public.sp_write_approval_requests where plan_id = ${request.requestId}) as approvals,
             (select count(*)::int from public.sp_write_outbox where plan_id = ${request.requestId}) as wakes
    `;
    expect(rows[0]).toEqual({ approvals: 0, wakes: 0 });
  });

  it('replays one immutable preview under concurrent identical requests', async () => {
    const source = await batch();
    const request = { requestId: randomUUID(), profileId, applyBatchId: source.batchId };
    const previews = await Promise.all([
      previewSpWrite(database, { orgId, userId: USER }, request),
      previewSpWrite(database, { orgId, userId: USER }, request),
    ]);
    expect(previews[0]).toEqual(previews[1]);
    expect(await storedCount(request.requestId)).toBe(1);
    expect(await previewSpWrite(database, { orgId, userId: USER }, request)).toEqual(previews[0]);
    const changed = await batch();
    await expect(previewSpWrite(database, { orgId, userId: USER }, {
      ...request, applyBatchId: changed.batchId,
    })).rejects.toMatchObject({ code: 'identity_conflict' });
  });

  it('refuses wrong tenants and memberships without disclosing a stored preview', async () => {
    const source = await batch();
    const request = { requestId: randomUUID(), profileId, applyBatchId: source.batchId };
    await expect(previewSpWrite(database, { orgId, userId: OTHER_USER }, request))
      .rejects.toMatchObject({ code: 'authorization_refused' });
    await expect(previewSpWrite(database, { orgId: otherOrgId, userId: OTHER_USER }, request))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(await storedCount(request.requestId)).toBe(0);
  });

  it('refuses a disabled grant and changed mirror state without staging a plan', async () => {
    const source = await batch();
    const request = { requestId: randomUUID(), profileId, applyBatchId: source.batchId };
    await grantVersion(disabledVersion);
    try {
      await expect(previewSpWrite(database, { orgId, userId: USER }, request))
        .rejects.toMatchObject({ code: 'not_found' });
    } finally { await grantVersion(enabledVersion); }
    await database.sql`update public.keywords set bid = 1.1 where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'kw-1'`;
    try {
      await expect(previewSpWrite(database, { orgId, userId: USER }, request))
        .rejects.toMatchObject({ code: 'source_changed' });
    } finally {
      await database.sql`update public.keywords set bid = 0.9 where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'kw-1'`;
    }
    expect(await storedCount(request.requestId)).toBe(0);
  });

  it('accounts for all rows and rejects unsupported, duplicate and imprecise input', async () => {
    for (const options of [
      { count: 2 }, { entityType: 'target' }, { secondRow: true },
      { proposed: '0.1234567' }, { proposed: '0' }, { proposed: '0.9' },
    ]) {
      const source = await batch(options);
      const request = { requestId: randomUUID(), profileId, applyBatchId: source.batchId };
      await expect(previewSpWrite(database, { orgId, userId: USER }, request)).rejects.toThrow();
      expect(await storedCount(request.requestId)).toBe(0);
    }
  });

  it('refuses an edited source and a syntactically valid but false export hash', async () => {
    const source = await batch();
    await database.sql`update public.apply_rows set new_value = '0.6'::jsonb where id = ${source.rowIds[0]!}`;
    const request = { requestId: randomUUID(), profileId, applyBatchId: source.batchId };
    await expect(previewSpWrite(database, { orgId, userId: USER }, request)).rejects.toMatchObject({ code: 'source_changed' });
    expect(await storedCount(request.requestId)).toBe(0);
    const other = await batch();
    await database.sql`update public.apply_batches set artifact_sha256 = ${'a'.repeat(64)} where id = ${other.batchId}`;
    await expect(previewSpWrite(database, { orgId, userId: USER }, {
      ...request, applyBatchId: other.batchId,
    })).rejects.toMatchObject({ code: 'source_changed' });
    expect(await storedCount(request.requestId)).toBe(0);
  });

  it('freezes a recommendation entity after export', async () => {
    const source = await batch();
    await expect(database.sql`update public.recommendations set entity_id = 'unrelated-keyword'
      where org_id = ${orgId} and export_batch_id = ${source.batchId}`).rejects.toThrow('source is frozen');
  });

  it('binds an edited proposal through decision, exact export bytes and the real SQL preview assertion', async () => {
    const [rec] = await database.sql<{ id: string }[]>`insert into public.recommendations
      (org_id,profile_id,run_id,reason,entity_type,entity_id,ad_product,field,current_value,proposed_value,inputs)
      values (${orgId},${profileId},${runId},'high_acos','keyword','kw-1','SP','bid','0.9'::jsonb,'0.7'::jsonb,'{}'::jsonb)
      returning id`;
    const revision = await reviseRecommendation(database, { orgId, userId: USER }, { requestId: randomUUID(),
      profileId, recommendationId: rec!.id, expectedRevisionId: null, proposedValue: '0.8123', note: 'Synthetic revised preview' });
    const refs = [{ recommendationId: rec!.id, revisionId: revision.revisionId }];
    await decideRecommendations(database, { orgId, actorId: USER, ids: [rec!.id], expectedRevisions: refs, decision: 'accepted' });
    const exported = await exportAcceptedRecommendations(database, { orgId, profileId, runId, ids: [rec!.id],
      expectedRevisions: refs, actorId: USER, tag: 'synthetic-revised-preview', optGroup: 'synthetic', lever: 'bid-down', note: 'Exact edited preview' });
    const request = { requestId: randomUUID(), profileId, applyBatchId: exported.batchId };
    const preview = await previewSpWrite(database, { orgId, userId: USER }, request);
    expect(preview.evidence!.provenance.rows).toEqual([{ applyRowId: expect.any(String), recommendationId: rec!.id,
      runId, proposalRevisionId: revision.revisionId }]);
    expect(preview.evidence!.provenance.artifactText).toBe(serializeApplyRows(exported.rows));
    expect(preview.plan.actions[0]).toMatchObject({ changes: { bid: {
      expected: { amount: '0.9' }, requested: { amount: '0.8123' },
    } } });
    const changed = structuredClone(preview.evidence!);
    delete changed.provenance.rows[0]!.proposalRevisionId;
    await expect(recordSpWritePreviewEvidence(database, preview.plan, changed)).rejects.toThrow();
    expect(await storedCount(request.requestId)).toBe(1);
  });

  it('rolls the plan and actions back when its evidence cannot be recorded', async () => {
    const source = await batch();
    const request = { requestId: randomUUID(), profileId, applyBatchId: source.batchId };
    await database.sql.unsafe(`
      create function app.test_reject_preview_insert() returns trigger language plpgsql as $$
      begin raise exception 'synthetic evidence storage fault'; end $$;
      create trigger test_reject_preview_insert before insert on public.sp_write_preview_evidence
      for each row execute function app.test_reject_preview_insert();
    `);
    try {
      await expect(previewSpWrite(database, { orgId, userId: USER }, request))
        .rejects.toMatchObject({ code: 'outcome_unknown' });
      const rows = await database.sql<{ plans: number; actions: number; evidence: number }[]>`
        select (select count(*)::int from public.sp_write_plans where plan_id = ${request.requestId}) as plans,
               (select count(*)::int from public.sp_write_plan_actions where plan_id = ${request.requestId}) as actions,
               (select count(*)::int from public.sp_write_preview_evidence where plan_id = ${request.requestId}) as evidence
      `;
      expect(rows[0]).toEqual({ plans: 0, actions: 0, evidence: 0 });
    } finally {
      await database.sql.unsafe('drop trigger test_reject_preview_insert on public.sp_write_preview_evidence; drop function app.test_reject_preview_insert()');
    }
    expect((await previewSpWrite(database, { orgId, userId: USER }, request)).plan.id).toBe(request.requestId);
    expect(await storedCount(request.requestId)).toBe(1);
  });

  it('preserves frozen evidence after source edits and protects its SQL boundary', async () => {
    const source = await batch();
    const request = { requestId: randomUUID(), profileId, applyBatchId: source.batchId };
    const preview = await previewSpWrite(database, { orgId, userId: USER }, request);
    await database.sql`update public.apply_rows set entity_name = 'Changed source label' where id = ${source.rowIds[0]!}`;
    expect(await previewSpWrite(database, { orgId, userId: USER }, request)).toEqual(preview);
    await expect(previewSpWrite(database, { orgId, userId: USER }, { ...request, requestId: randomUUID() }))
      .rejects.toMatchObject({ code: 'source_changed' });
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const [acl] = await database.sql<{ insert: boolean; update: boolean; delete: boolean; truncate: boolean; execute: boolean }[]>`
        select has_table_privilege(${role}, 'public.sp_write_preview_evidence', 'INSERT') as insert,
               has_table_privilege(${role}, 'public.sp_write_preview_evidence', 'UPDATE') as update,
               has_table_privilege(${role}, 'public.sp_write_preview_evidence', 'DELETE') as delete,
               has_table_privilege(${role}, 'public.sp_write_preview_evidence', 'TRUNCATE') as truncate,
               has_function_privilege(${role}, 'app.record_sp_write_preview(text,text,jsonb,text,text,text)', 'EXECUTE') as execute
      `;
      expect(acl).toEqual({ insert: false, update: false, delete: false, truncate: false, execute: role === 'service_role' });
    }
    const own = await withAuthenticatedActor(database, { orgId, userId: USER }, (sql) => sql`
      select plan_id from public.sp_write_preview_evidence where plan_id = ${request.requestId}
    `);
    const other = await withAuthenticatedActor(database, { orgId: otherOrgId, userId: OTHER_USER }, (sql) => sql`
      select plan_id from public.sp_write_preview_evidence where plan_id = ${request.requestId}
    `);
    expect(own).toHaveLength(1);
    expect(other).toHaveLength(0);
    await expect(database.sql`update public.sp_write_preview_evidence set artifact_text = artifact_text where plan_id = ${request.requestId}`)
      .rejects.toThrow(/immutable/i);
    await expect(database.sql`delete from public.sp_write_preview_evidence where plan_id = ${request.requestId}`)
      .rejects.toThrow(/immutable/i);
  });

  it('mirrors the migrated evidence columns and tenant plan constraint', async () => {
    const config = getTableConfig(spWritePreviewEvidence);
    const columns = await database.sql<{ name: string; not_null: boolean }[]>`
      select attname as name, attnotnull as not_null from pg_attribute
       where attrelid = 'public.sp_write_preview_evidence'::regclass and attnum > 0 and not attisdropped
       order by attnum
    `;
    expect(columns).toEqual(config.columns.map((column) => ({ name: column.name, not_null: column.notNull })));
    const constraints = await database.sql<{ name: string }[]>`
      select conname as name from pg_constraint where conrelid = 'public.sp_write_preview_evidence'::regclass order by conname
    `;
    expect(constraints.map((row) => row.name)).toEqual([
      'sp_write_preview_evidence_pkey', 'sp_write_preview_evidence_plan_fkey',
      'sp_write_preview_evidence_tenant_key', 'sp_write_preview_evidence_text_agrees',
    ]);
    expect(config.foreignKeys[0]?.reference().columns.map((column) => column.name)).toEqual(['org_id', 'profile_id', 'plan_id']);
  });

  it('locks run parents before recommendation children during concurrent deletion', async () => {
    const source = await batch();
    const request = { requestId: randomUUID(), profileId, applyBatchId: source.batchId };
    let releaseLock!: () => void;
    let beginRemoval!: () => void;
    const locked = new Promise<void>((resolve) => { releaseLock = resolve; });
    const remove = new Promise<void>((resolve) => { beginRemoval = resolve; });
    const deletion = database.sql.begin(async (sql) => {
      await sql`select id from public.recommendation_runs where id = ${runId} for update`;
      releaseLock();
      await remove;
      // Existing exported apply rows deliberately prevent deleting this run.
      await sql`delete from public.recommendation_runs where id = ${runId}`;
    }).then(() => 'deleted', (error: unknown) => (error as { code?: string }).code);
    await locked;
    const preview = previewSpWrite(database, { orgId, userId: USER }, request);
    try {
      await expect.poll(async () => {
        const [row] = await database.sql<{ waiting: boolean }[]>`
          select exists(select 1 from pg_stat_activity where datname = current_database()
            and pid <> pg_backend_pid() and wait_event_type = 'Lock'
            and query like '%app.record_sp_write_preview(%') as waiting
        `;
        return row?.waiting;
      }, { timeout: 3000, interval: 10 }).toBe(true);
    } finally { beginRemoval(); }
    expect(await deletion).toBe('23503');
    expect((await preview).plan.id).toBe(request.requestId);
  });

  it('checks current policy and grant facts even when supplied evidence has valid hashes', async () => {
    const source = await batch();
    const request = { requestId: randomUUID(), profileId, applyBatchId: source.batchId };
    const original = await previewSpWrite(database, { orgId, userId: USER }, request);
    for (const changedFact of ['goal', 'grant'] as const) {
      const { plan, evidence } = structuredClone(original);
      if (evidence === null || plan.source.kind !== 'apply_batch') throw new Error('missing forward evidence');
      plan.id = randomUUID();
      evidence.planId = plan.id;
      if (changedFact === 'goal') evidence.guardrails.policies[0]!.strategyGoal = 'different-goal';
      else evidence.guardrails.profileGrantVersion = disabledVersion;
      const digest = (value: string) => createHash('sha256').update(value).digest('hex');
      plan.source.guardrailSnapshotFingerprint = digest(serializeSpWritePreviewGuardrails(evidence));
      plan.source.provenanceSnapshotFingerprint = digest(serializeSpWritePreviewProvenance(evidence));
      plan.fingerprint = digest(serializeSpWritePlanFingerprint(plan));
      await expect(recordSpWritePreviewEvidence(database, plan, evidence)).rejects.toMatchObject({ code: 'source_changed' });
      expect(await storedCount(plan.id)).toBe(0);
    }
  });

  it('reconstructs the actual multi-row recommendation export with names and performance fields', async () => {
    const recommendationIds = [randomUUID(), randomUUID()];
    // Reverse source order deliberately differs from canonical keyword ordering.
    for (const [index, keywordId] of ['kw-export-z', 'kw-export-a'].entries()) {
      await database.sql`
        insert into public.keywords
          (org_id, profile_id, amazon_id, ad_product, state, campaign_id, ad_group_id, keyword_text, match_type, bid)
        values (${orgId}, ${profileId}, ${keywordId}, 'SP', 'enabled', 'c-1', 'ag-1', 'synthetic', 'exact', 0.9)
      `;
      await database.sql`
        insert into public.recommendations
          (id, run_id, org_id, profile_id, reason, entity_type, entity_id, entity_name, field, current_value, proposed_value, inputs, status)
        values (${recommendationIds[index]!}, ${runId}, ${orgId}, ${profileId}, 'high_acos',
          'keyword', ${keywordId}, 'Synthetic export keyword', 'bid', '0.9'::jsonb, '0.7'::jsonb,
          '{"clicks":12,"rpc":1.25}'::jsonb, 'accepted')
      `;
    }
    const exported = await exportAcceptedRecommendations(database, {
      orgId, profileId, runId, ids: recommendationIds, tag: randomUUID(), optGroup: 'synthetic',
      lever: 'bid-down', note: 'Synthetic application export proof', actorId: USER,
    });
    const preview = await previewSpWrite(database, { orgId, userId: USER }, {
      requestId: randomUUID(), profileId, applyBatchId: exported.batchId,
    });
    expect(preview.plan.counts.providerRows).toBe(2);
    expect(preview.evidence?.provenance.rows.map((row) => row.recommendationId)).toEqual(recommendationIds);
    expect(JSON.parse(preview.evidence!.provenance.artifactText)).toEqual([
      { entity_type: 'keyword', entity_id: 'kw-export-z', field: 'bid', old: 0.9, new: 0.7, name: 'Synthetic export keyword', clicks: 12, revenue: 15 },
      { entity_type: 'keyword', entity_id: 'kw-export-a', field: 'bid', old: 0.9, new: 0.7, name: 'Synthetic export keyword', clicks: 12, revenue: 15 },
    ]);
  });
});
