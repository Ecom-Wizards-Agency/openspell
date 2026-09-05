import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RecommendationRevisionRequest } from '@wizard-ads/shared/recommendation-revisions';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { asUser } from '../testing/rls.js';
import { reviseRecommendation } from './recommendation-revisions.js';
import { decideRecommendations, exportAcceptedRecommendations, getExportBatch, listRecommendationWindow } from './recommendations.js';

const available = await databaseAvailable();
const owner = 'dddddddd-dddd-4ddd-8ddd-dddddddddd01';
const analyst = 'dddddddd-dddd-4ddd-8ddd-dddddddddd02';
const viewer = 'dddddddd-dddd-4ddd-8ddd-dddddddddd03';

describe.skipIf(!available)('audited recommendation revisions', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  let runId: string;
  beforeAll(async () => {
    database = await createTestDatabase('recommendation_revisions');
    const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture('proposal-revisions', ${owner}, 'owner') as id`;
    orgId = org!.id;
    const [scope] = await database.sql<{ profile_id: string; id: string }[]>`
      select profile_id, id from public.recommendation_runs where org_id = ${orgId} limit 1`;
    profileId = scope!.profile_id; runId = scope!.id;
    for (const [user, role] of [[analyst, 'analyst'], [viewer, 'viewer']] as const) {
      await database.sql`select public.auth_user_stub(${user})`;
      await database.sql`insert into public.org_members (org_id,user_id,role) values (${orgId},${user},${role}::public.org_role)`;
    }
  }, 60_000);
  afterAll(async () => { await database?.drop(); });

  async function proposal(): Promise<RecommendationRevisionRequest> {
    const [row] = await database.sql<{ id: string }[]>`insert into public.recommendations
      (org_id,profile_id,run_id,reason,entity_type,entity_id,ad_product,field,current_value,proposed_value,inputs)
      values (${orgId},${profileId},${runId},'high_acos','keyword','kw-1','SP','bid','0.9'::jsonb,'0.7'::jsonb,'{}'::jsonb)
      returning id`;
    return { requestId: randomUUID(), profileId, recommendationId: row!.id,
      expectedRevisionId: null, proposedValue: '0.8123', note: 'Reviewed synthetic bid' };
  }
  async function counts(id: string) {
    const [row] = await database.sql`select
      (select count(*)::integer from public.recommendation_proposal_revisions where recommendation_id = ${id}) as revisions,
      (select count(*)::integer from public.audit_log where org_id = ${orgId} and target_id = ${id} and action = 'recommendation.revised') as audits,
      (select proposal_revision_id from public.recommendations where id = ${id}) as head`;
    return row!;
  }

  it('preserves engine values and resets prior review, with exact immutable retry after later editing', async () => {
    const request = await proposal();
    expect(await decideRecommendations(database, { orgId, actorId: analyst, ids: [request.recommendationId], decision: 'accepted' }))
      .toEqual({ updated: 1, refused: [] });
    const first = await reviseRecommendation(database, { orgId, userId: analyst }, request);
    const [record] = await database.sql`select proposed_value, status, decided_by, decided_at
      from public.recommendations where id = ${request.recommendationId}`;
    expect(record).toEqual({ proposed_value: 0.7, status: 'proposed', decided_by: null, decided_at: null });
    const second = await reviseRecommendation(database, { orgId, userId: analyst }, {
      ...request, requestId: randomUUID(), expectedRevisionId: first.revisionId, proposedValue: '0.6',
    });
    expect(await reviseRecommendation(database, { orgId, userId: analyst }, request)).toEqual(first);
    expect(await counts(request.recommendationId)).toEqual({ revisions: 2, audits: 2, head: second.revisionId });
    const { rows, population } = await listRecommendationWindow(database, { orgId, profileId, runId });
    expect(population.loaded).toBe(rows.length);
    expect(rows.find((row) => row.id === request.recommendationId)).toMatchObject({ proposedValue: '0.6', proposalRevisionId: second.revisionId });
    await expect(reviseRecommendation(database, { orgId, userId: analyst }, { ...request, note: 'Different reuse' }))
      .rejects.toMatchObject({ code: 'conflict' });
  });

  it('allows exactly one of two concurrent edits from the same head', async () => {
    const request = await proposal();
    const results = await Promise.allSettled([
      reviseRecommendation(database, { orgId, userId: owner }, request),
      reviseRecommendation(database, { orgId, userId: analyst }, { ...request, requestId: randomUUID(), proposedValue: '0.6' }),
    ]);
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((row) => row.status === 'rejected')).toHaveLength(1);
    expect(await counts(request.recommendationId)).toMatchObject({ revisions: 1, audits: 1 });
  });

  it('rolls back the revision, head and acceptance reset if its audit cannot be stored', async () => {
    const request = await proposal();
    await decideRecommendations(database, { orgId, actorId: owner, ids: [request.recommendationId], decision: 'accepted' });
    await database.sql.unsafe(`create function app.test_revision_audit_fault() returns trigger language plpgsql as $$
      begin if new.action = 'recommendation.revised' then raise exception 'synthetic audit failure'; end if; return new; end $$;
      create trigger test_revision_audit_fault before insert on public.audit_log
      for each row execute function app.test_revision_audit_fault();`);
    try { await expect(reviseRecommendation(database, { orgId, userId: owner }, request)).rejects.toMatchObject({ code: 'unavailable' }); }
    finally { await database.sql.unsafe('drop trigger test_revision_audit_fault on public.audit_log; drop function app.test_revision_audit_fault();'); }
    expect(await counts(request.recommendationId)).toEqual({ revisions: 0, audits: 0, head: null });
    const [row] = await database.sql`select status from public.recommendations where id = ${request.recommendationId}`;
    expect(row!.status).toBe('accepted');
  });

  it('rejects direct unauthorized updates, malformed whitespace notes, cross-tenant scope and viewer edits', async () => {
    const request = await proposal();
    await expect(reviseRecommendation(database, { orgId, userId: viewer }, request)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(reviseRecommendation(database, { orgId: randomUUID(), userId: owner }, request)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(asUser(database, owner, (sql) => sql`update public.recommendations set status = 'accepted' where id = ${request.recommendationId}`))
      .rejects.toThrow();
    for (const note of ['\n\t', '\u00a0', '\ufeff', ' spaced ', '🙂'.repeat(501)]) {
      await expect(asUser(database, owner, (sql) => sql`select app.revise_recommendation_v1(${orgId}::uuid,
        ${JSON.stringify({ ...request, note })}::text)`)).rejects.toThrow();
      await expect(asUser(database, owner, (sql) => sql`select app.decide_recommendations_v1(${orgId}::uuid,
        ${[request.recommendationId]}::uuid[], 'dismissed', ${note}::text, null)`)).rejects.toThrow();
    }
    await expect(asUser(database, owner, (sql) => sql`select app.revise_recommendation_v1(${orgId}::uuid,
      ${JSON.stringify({ ...request, requestId: 'd'.repeat(32) })}::text)`)).rejects.toThrow();
    expect(await counts(request.recommendationId)).toEqual({ revisions: 0, audits: 0, head: null });
  });

  it('keeps decision and audit atomic and refuses receipt replay after membership revocation', async () => {
    const request = await proposal();
    await database.sql.unsafe(`create function app.test_decision_audit_fault() returns trigger language plpgsql as $$
      begin if new.action = 'recommendation.accepted' then raise exception 'synthetic decision audit failure'; end if; return new; end $$;
      create trigger test_decision_audit_fault before insert on public.audit_log
      for each row execute function app.test_decision_audit_fault();`);
    try {
      await expect(decideRecommendations(database, { orgId, actorId: owner, ids: [request.recommendationId], decision: 'accepted' }))
        .rejects.toThrow('synthetic decision audit failure');
    } finally { await database.sql.unsafe('drop trigger test_decision_audit_fault on public.audit_log; drop function app.test_decision_audit_fault();'); }
    const [row] = await database.sql`select status from public.recommendations where id = ${request.recommendationId}`;
    expect(row!.status).toBe('proposed');
    await reviseRecommendation(database, { orgId, userId: analyst }, request);
    await database.sql`delete from public.org_members where org_id = ${orgId} and user_id = ${analyst}`;
    try { await expect(reviseRecommendation(database, { orgId, userId: analyst }, request)).rejects.toMatchObject({ code: 'forbidden' }); }
    finally { await database.sql`insert into public.org_members (org_id,user_id,role) values (${orgId},${analyst},'analyst')`; }
  });

  it('serializes an edit against export so only the reviewed revision can leave', async () => {
    const request = await proposal();
    const revision = await reviseRecommendation(database, { orgId, userId: owner }, request);
    const refs = [{ recommendationId: request.recommendationId, revisionId: revision.revisionId }];
    await decideRecommendations(database, { orgId, actorId: owner, ids: [request.recommendationId], expectedRevisions: refs, decision: 'accepted' });
    const results = await Promise.allSettled([
      reviseRecommendation(database, { orgId, userId: owner }, { ...request, requestId: randomUUID(),
        expectedRevisionId: revision.revisionId, proposedValue: '0.6' }),
      exportAcceptedRecommendations(database, { orgId, profileId, runId, actorId: owner, ids: [request.recommendationId],
        expectedRevisions: refs, tag: 'synthetic-racing-export', optGroup: 'synthetic', lever: 'bid', note: 'Synthetic concurrent export' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rows = await database.sql`select ar.proposal_revision_id, ar.new_value from public.apply_rows ar
      where ar.recommendation_id = ${request.recommendationId}`;
    if (results[1]!.status === 'fulfilled') {
      expect(rows).toEqual([{ proposal_revision_id: revision.revisionId, new_value: 0.8123 }]);
    } else expect(rows).toHaveLength(0);
  });

  it('counts missing and stale decisions, preserves analyst rights, and freezes exact numeric export bytes', async () => {
    const request = await proposal();
    const revision = await reviseRecommendation(database, { orgId, userId: owner }, request);
    const missing = randomUUID();
    const refused = await decideRecommendations(database, { orgId, actorId: analyst,
      ids: [request.recommendationId, missing], decision: 'accepted' });
    expect(refused.updated).toBe(0);
    expect(refused.refused).toEqual(expect.arrayContaining([
      { id: request.recommendationId, status: 'revision_changed' }, { id: missing, status: 'unavailable' },
    ]));
    expect(refused.refused).toHaveLength(2);
    const refs = [{ recommendationId: request.recommendationId, revisionId: revision.revisionId }];
    expect(await decideRecommendations(database, { orgId, actorId: analyst, ids: [request.recommendationId],
      expectedRevisions: refs, decision: 'accepted' })).toEqual({ updated: 1, refused: [] });
    const options = { orgId, profileId, runId, ids: [request.recommendationId], actorId: owner,
      tag: 'synthetic-revised-export', optGroup: 'synthetic', lever: 'bid', note: 'Reviewed exact synthetic export' };
    await expect(exportAcceptedRecommendations(database, options)).rejects.toMatchObject({ code: 'conflict' });
    await expect(exportAcceptedRecommendations(database, { ...options, ids: [request.recommendationId, missing] }))
      .rejects.toThrow('exact accepted selection');
    const batch = await exportAcceptedRecommendations(database, { ...options, expectedRevisions: refs });
    expect(batch.exported).toBe(1); expect(batch.rows).toHaveLength(1);
    expect(batch.rows[0]).toMatchObject({ old: 0.9, new: 0.8123 });
    const [row] = await database.sql`select proposal_revision_id, new_value::text as new_text from public.apply_rows where batch_id = ${batch.batchId}`;
    expect(row).toEqual({ proposal_revision_id: revision.revisionId, new_text: '0.8123' });
    const download = await getExportBatch(database, { orgId, batchId: batch.batchId });
    expect(download?.rows).toEqual(batch.rows);
    await expect(reviseRecommendation(database, { orgId, userId: owner }, { ...request,
      requestId: randomUUID(), expectedRevisionId: revision.revisionId, proposedValue: '0.6' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(database.sql`update public.recommendations set proposed_value = '0.5'::jsonb where id = ${request.recommendationId}`)
      .rejects.toThrow('source is frozen');
    await expect(database.sql`update public.recommendation_proposal_revisions set receipt = '{}'::jsonb where id = ${revision.revisionId}`)
      .rejects.toThrow('immutable');
  });
});
