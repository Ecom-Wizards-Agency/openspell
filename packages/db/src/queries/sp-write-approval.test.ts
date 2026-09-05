import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SpWriteManualApprovalRequest } from '@wizard-ads/shared/sp-write-application';
import { SpWritePlan, serializeSpWritePlanFingerprint, spWritePlanBinding } from '@wizard-ads/shared/sp-writes';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { executeSyntheticKeywordWrite } from '../testing/sp-write-synthetic-execution.js';
import { withAuthenticatedActor } from './authenticated-actor.js';
import { approveAndQueueSpWrite } from './sp-write-approval.js';
import { readSpWriteOperation } from './sp-write-operation-read.js';
import { previewSpWriteInverse } from './sp-write-inverse-preview.js';
import { previewSpWrite } from './sp-write-plan-builder.js';
import { recordSpWritePreviewEvidence } from './sp-write-preview-evidence.js';
import { exportAcceptedRecommendations } from './recommendations.js';

const available = await databaseAvailable();
const USER = '31313131-3131-4131-8131-313131313131';
const OTHER_USER = '42424242-4242-4242-8242-424242424242';

describe.skipIf(!available)('authenticated SP write admission', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  let runId: string;
  let enabledVersion: string;
  let disabledVersion: string;

  beforeAll(async () => {
    database = await createTestDatabase('write_approval');
    const [tenant] = await database.sql<{ org_id: string }[]>`
      select app.seed_tenant_fixture('write-approval', ${USER}, 'owner') as org_id
    `;
    orgId = tenant!.org_id;
    await database.sql`select app.seed_tenant_fixture('write-approval-other', ${OTHER_USER}, 'owner')`;
    const [profile] = await database.sql<{ id: string }[]>`select id::text from public.ad_profiles where org_id = ${orgId}`;
    profileId = profile!.id;
    const [run] = await database.sql<{ id: string }[]>`select id::text from public.recommendation_runs where org_id = ${orgId} and profile_id = ${profileId}`;
    runId = run!.id;
    const [original] = await database.sql<{ version_id: string }[]>`
      select version_id::text from public.sp_write_profile_grant_heads where org_id = ${orgId} and profile_id = ${profileId}
    `;
    disabledVersion = original!.version_id;
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
    const environmentVersion = randomUUID();
    await database.sql`insert into public.sp_write_environment_gate_versions
      (version_id, enabled, max_unresolved_calls) values (${environmentVersion}, true, 1)`;
    await database.sql`insert into public.sp_write_environment_gate_head (singleton, version_id)
      values (true, ${environmentVersion})`;
  }, 60_000);

  afterAll(async () => { await database?.drop(); });

  async function grantVersion(version: string) {
    await database.sql`update public.sp_write_profile_grant_heads set version_id = ${version}
      where org_id = ${orgId} and profile_id = ${profileId}`;
  }

  async function confirmation(lifetimeMs?: number): Promise<SpWriteManualApprovalRequest> {
    const recommendationId = randomUUID();
    await database.sql`
      insert into public.recommendations
        (id, run_id, org_id, profile_id, reason, entity_type, entity_id, field, current_value, proposed_value, inputs, status)
      values (${recommendationId}, ${runId}, ${orgId}, ${profileId}, 'high_acos',
        'keyword', 'kw-1', 'bid', '0.9'::jsonb, '0.7'::jsonb, '{}'::jsonb, 'accepted')
    `;
    const exported = await exportAcceptedRecommendations(database, {
      orgId, profileId, runId, ids: [recommendationId], tag: randomUUID(), optGroup: 'synthetic',
      lever: 'bid-down', note: 'Synthetic confirmation', actorId: USER,
    });
    const preview = await previewSpWrite(database, { orgId, userId: USER }, {
      requestId: randomUUID(), profileId, applyBatchId: exported.batchId,
    });
    if (lifetimeMs !== undefined) {
      if (preview.evidence === null) throw new Error('forward preview missing source evidence');
      preview.plan.id = randomUUID();
      preview.evidence.planId = preview.plan.id;
      preview.plan.expiresAt = new Date(Date.now() + lifetimeMs).toISOString();
      preview.plan.fingerprint = createHash('sha256').update(serializeSpWritePlanFingerprint(preview.plan)).digest('hex');
      await recordSpWritePreviewEvidence(database, preview.plan, preview.evidence);
      preview.binding = spWritePlanBinding(preview.plan);
    }
    return { profileId, approval: {
      approvalRequestId: randomUUID(), plan: preview.binding, approvalMode: 'manual',
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
      boundedAuthorization: null, preapprovedInversePlan: null,
    } };
  }

  async function counts(planId: string) {
    const [row] = await database.sql<{ receipts: number; requests: number; wakes: number }[]>`
      select (select count(*)::int from public.sp_write_authorization_receipts where plan_id = ${planId}) as receipts,
             (select count(*)::int from public.sp_write_execution_requests where plan_id = ${planId}) as requests,
             (select count(*)::int from public.sp_write_outbox where plan_id = ${planId}) as wakes
    `;
    return row;
  }

  it('concurrently confirms and queues exactly one operation with the receipt execution identity', async () => {
    const request = await confirmation();
    const [first, second] = await Promise.all([
      approveAndQueueSpWrite(database, { orgId, userId: USER }, request),
      approveAndQueueSpWrite(database, { orgId, userId: USER }, request),
    ]);
    expect(first).toEqual(second);
    expect(first.kind).toBe('queued');
    expect(await counts(request.approval.plan.planId)).toEqual({ receipts: 1, requests: 1, wakes: 1 });
    const [wake] = await database.sql<{ outbox_id: string; execution_id: string }[]>`
      select outbox_id::text, execution_id::text from public.sp_write_outbox where plan_id = ${request.approval.plan.planId}
    `;
    expect(first.operation.executionId).toBe(wake!.execution_id);
    expect(first.operation.executionId).not.toBe(wake!.outbox_id);
    const detail = await readSpWriteOperation(database, { orgId, userId: USER }, { profileId, ...first.operation });
    expect(detail).toMatchObject({ operation: first.operation, admission: 'queued', original: null, inverses: [],
      snapshot: { status: 'queued', accounting: { approvedRows: 1, pendingDispatch: 1 } } });
    await expect(readSpWriteOperation(database, { orgId, userId: OTHER_USER }, { profileId, ...first.operation }))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(approveAndQueueSpWrite(database, { orgId, userId: USER }, {
      ...request, approval: { ...request.approval, approvalRequestId: randomUUID() },
    })).rejects.toMatchObject({ code: 'identity_conflict' });
  });

  it('refuses a changed source or grant atomically through the direct authenticated RPC', async () => {
    for (const change of ['source', 'grant'] as const) {
      const request = await confirmation();
      if (change === 'source') await database.sql`update public.keywords set bid = 1.1 where org_id = ${orgId} and amazon_id = 'kw-1'`;
      else await grantVersion(disabledVersion);
      try {
        await expect(withAuthenticatedActor(database, { orgId, userId: USER }, (sql) => sql`
          select app.approve_sp_write_cycle(${request.approval.plan.planId}::uuid, ${JSON.stringify(request.approval)})
        `)).rejects.toMatchObject({ code: '55000' });
        expect(await counts(request.approval.plan.planId)).toEqual({ receipts: 0, requests: 0, wakes: 0 });
      } finally {
        await database.sql`update public.keywords set bid = 0.9 where org_id = ${orgId} and amazon_id = 'kw-1'`;
        await grantVersion(enabledVersion);
      }
    }
    const [access] = await database.sql<{ allowed: boolean }[]>`
      select has_function_privilege('authenticated', 'app.approve_sp_write_cycle_internal(uuid,text)', 'EXECUTE') as allowed
    `;
    expect(access!.allowed).toBe(false);
  });

  it('binds replay to the approving actor and requires current membership', async () => {
    const request = await confirmation();
    await approveAndQueueSpWrite(database, { orgId, userId: USER }, request);
    await database.sql`insert into public.org_members (org_id, user_id, role) values (${orgId}, ${OTHER_USER}, 'admin')`;
    try {
      await expect(approveAndQueueSpWrite(database, { orgId, userId: OTHER_USER }, request))
        .rejects.toMatchObject({ code: 'identity_conflict' });
    } finally {
      await database.sql`delete from public.org_members where org_id = ${orgId} and user_id = ${OTHER_USER}`;
    }
    await expect(approveAndQueueSpWrite(database, { orgId, userId: OTHER_USER }, request))
      .rejects.toMatchObject({ code: 'authorization_refused' });
    expect(await counts(request.approval.plan.planId)).toEqual({ receipts: 1, requests: 1, wakes: 1 });
  });

  it('recovers a committed approval when its transaction response is lost', async () => {
    const request = await confirmation();
    let failed = false;
    const sql = new Proxy(database.sql, {
      get(target, property, receiver) {
        if (property !== 'begin') return Reflect.get(target, property, receiver);
        return async (...args: unknown[]) => {
          const value: unknown = await Reflect.apply(target.begin, target, args);
          if (!failed) { failed = true; throw new Error('synthetic lost commit response'); }
          return value;
        };
      },
    });
    const admission = await approveAndQueueSpWrite({ sql }, { orgId, userId: USER }, request);
    expect(failed).toBe(true);
    expect(admission.kind).toBe('queued');
    expect(await counts(request.approval.plan.planId)).toEqual({ receipts: 1, requests: 1, wakes: 1 });
  });

  it('recovers a lost enqueue response without confusing the outbox and execution identities', async () => {
    const request = await confirmation();
    let lost = 0;
    const sql = new Proxy(database.sql, {
      apply(target, receiver, args: unknown[]) {
        const query = Reflect.apply(target, receiver, args);
        const fragments = args[0];
        if (Array.isArray(fragments) && fragments.join('').includes('app.start_sp_write_execution')) {
          return Promise.resolve(query).then(() => { lost += 1; throw new Error('synthetic lost enqueue response'); });
        }
        return query;
      },
    });
    const admission = await approveAndQueueSpWrite({ sql }, { orgId, userId: USER }, request);
    expect(lost).toBe(1);
    expect(admission.kind).toBe('queued');
    expect(await counts(request.approval.plan.planId)).toEqual({ receipts: 1, requests: 1, wakes: 1 });
  });

  it('returns prior admission after its authority expires and the profile gate closes', async () => {
    const request = await confirmation(1200);
    const first = await approveAndQueueSpWrite(database, { orgId, userId: USER }, request);
    expect(first.kind).toBe('queued');
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(request.approval.plan.expiresAt) - Date.now()) + 30));
    await grantVersion(disabledVersion);
    try {
      expect(await approveAndQueueSpWrite(database, { orgId, userId: USER }, request)).toEqual(first);
      expect(await counts(request.approval.plan.planId)).toEqual({ receipts: 1, requests: 1, wakes: 1 });
    } finally { await grantVersion(enabledVersion); }
  });

  it('does not resume an older receipt when the versioned application entry is absent', async () => {
    const request = await confirmation();
    await withAuthenticatedActor(database, { orgId, userId: USER }, (sql) => sql`
      select app.approve_sp_write_cycle(${request.approval.plan.planId}::uuid, ${JSON.stringify(request.approval)})
    `);
    await database.sql.unsafe('alter function app.approve_sp_write_preview_v1(uuid,text) rename to test_absent_write_entry');
    try {
      await expect(approveAndQueueSpWrite(database, { orgId, userId: USER }, request))
        .rejects.toMatchObject({ code: 'outcome_unknown' });
      expect(await counts(request.approval.plan.planId)).toEqual({ receipts: 1, requests: 0, wakes: 0 });
      let masked = 0;
      const sql = new Proxy(database.sql, {
        get(target, property, receiver) {
          if (property !== 'begin') return Reflect.get(target, property, receiver);
          return async (...args: unknown[]) => {
            try { return await Reflect.apply(target.begin, target, args); }
            catch { masked += 1; throw new Error('synthetic lost missing-function response'); }
          };
        },
      });
      await expect(approveAndQueueSpWrite({ sql }, { orgId, userId: USER }, request))
        .rejects.toMatchObject({ code: 'outcome_unknown' });
      expect(masked).toBe(2);
      expect(await counts(request.approval.plan.planId)).toEqual({ receipts: 1, requests: 0, wakes: 0 });
    } finally {
      await database.sql.unsafe('alter function app.test_absent_write_entry(uuid,text) rename to approve_sp_write_preview_v1');
    }
    expect((await approveAndQueueSpWrite(database, { orgId, userId: USER }, request)).kind).toBe('queued');
  });

  it('keeps known approval recoverable when enqueue fails, then resumes the same operation', async () => {
    const request = await confirmation();
    await database.sql.unsafe(`
      create function app.test_reject_write_wake() returns trigger language plpgsql as $$
      begin raise exception 'synthetic queue failure'; end $$;
      create trigger test_reject_write_wake before insert on public.sp_write_outbox
      for each row execute function app.test_reject_write_wake();
    `);
    let first;
    try {
      first = await approveAndQueueSpWrite(database, { orgId, userId: USER }, request);
      expect(first.kind).toBe('approved_pending_start');
      expect(await counts(request.approval.plan.planId)).toEqual({ receipts: 1, requests: 0, wakes: 0 });
      const detail = await readSpWriteOperation(database, { orgId, userId: USER }, { profileId, ...first.operation });
      expect(detail.admission).toBe('approved_pending_start');
      expect(detail.snapshot.status).toBe('queued');
    } finally {
      await database.sql.unsafe('drop trigger test_reject_write_wake on public.sp_write_outbox; drop function app.test_reject_write_wake()');
    }
    const second = await approveAndQueueSpWrite(database, { orgId, userId: USER }, request);
    expect(second).toEqual({ ...first, kind: 'queued' });
    expect(await counts(request.approval.plan.planId)).toEqual({ receipts: 1, requests: 1, wakes: 1 });
  });

  it('records a complete synthetic change and a separately approved inverse with both history links', async () => {
    const request = await confirmation();
    const admission = await approveAndQueueSpWrite(database, { orgId, userId: USER }, request);
    const inverseRequest = { requestId: randomUUID(), profileId, original: admission.operation };
    await expect(previewSpWriteInverse(database, { orgId, userId: USER }, inverseRequest))
      .rejects.toMatchObject({ code: 'source_changed' });
    const queued = await readSpWriteOperation(database, { orgId, userId: USER }, { profileId, ...admission.operation });
    const [stored] = await database.sql<{ artifact: unknown }[]>`
      select artifact from public.sp_write_plans where plan_id = ${admission.operation.planId}
    `;
    await executeSyntheticKeywordWrite(database, SpWritePlan.parse(stored!.artifact), queued.receipt);
    try {
      const forward = await readSpWriteOperation(database, { orgId, userId: USER }, { profileId, ...admission.operation });
      expect(forward.snapshot).toMatchObject({ status: 'succeeded', accounting: {
        approvedRows: 1, providerAccepted: 1, observedRequested: 1, pendingObservation: 0,
      } });
      const [first, replay] = await Promise.all([
        previewSpWriteInverse(database, { orgId, userId: USER }, inverseRequest),
        previewSpWriteInverse(database, { orgId, userId: USER }, inverseRequest),
      ]);
      expect(first).toEqual(replay);
      expect(first.plan.actions[0]).toMatchObject({ changes: { bid: { expected: { amount: '0.7' }, requested: { amount: '0.9' } } } });
      expect(await counts(first.plan.id)).toEqual({ receipts: 0, requests: 0, wakes: 0 });
      const inverseConfirmation: SpWriteManualApprovalRequest = { profileId, approval: {
        ...request.approval, approvalRequestId: randomUUID(), plan: first.binding,
      } };
      for (const change of ['profile', 'connection', 'mirror'] as const) {
        if (change === 'profile') await database.sql`update public.ad_profiles set sync_enabled = false where id = ${profileId}`;
        if (change === 'connection') await database.sql`update public.ads_connections set status = 'revoked' where org_id = ${orgId}`;
        if (change === 'mirror') await database.sql`update public.keywords set bid = 0.8 where org_id = ${orgId} and amazon_id = 'kw-1'`;
        try {
          await expect(approveAndQueueSpWrite(database, { orgId, userId: USER }, inverseConfirmation))
            .rejects.toMatchObject({ code: 'source_changed' });
          expect(await counts(first.plan.id)).toEqual({ receipts: 0, requests: 0, wakes: 0 });
        } finally {
          await database.sql`update public.ad_profiles set sync_enabled = true where id = ${profileId}`;
          await database.sql`update public.ads_connections set status = 'active' where org_id = ${orgId}`;
          await database.sql`update public.keywords set bid = 0.7 where org_id = ${orgId} and amazon_id = 'kw-1'`;
        }
      }
      const inverseAdmission = await approveAndQueueSpWrite(database, { orgId, userId: USER }, inverseConfirmation);
      expect(inverseAdmission.operation.executionId).toBe(admission.operation.executionId);
      const inverseQueued = await readSpWriteOperation(database, { orgId, userId: USER }, { profileId, ...inverseAdmission.operation });
      expect(inverseQueued.original).toEqual(admission.operation);
      expect((await readSpWriteOperation(database, { orgId, userId: USER }, { profileId, ...admission.operation })).inverses)
        .toEqual([inverseAdmission.operation]);
      await executeSyntheticKeywordWrite(database, first.plan, inverseQueued.receipt);
      const inverse = await readSpWriteOperation(database, { orgId, userId: USER }, { profileId, ...inverseAdmission.operation });
      expect(inverse.snapshot).toMatchObject({ status: 'succeeded', accounting: { observedRequested: 1, providerAccepted: 1 } });
      expect(inverse.original).toEqual(admission.operation);
    } finally {
      await database.sql`update public.keywords set bid = 0.9 where org_id = ${orgId} and amazon_id = 'kw-1'`;
    }
  });

  it('permits an inverse after an ambiguous response when every changed value was subsequently observed', async () => {
    const request = await confirmation();
    const admission = await approveAndQueueSpWrite(database, { orgId, userId: USER }, request);
    const queued = await readSpWriteOperation(database, { orgId, userId: USER }, { profileId, ...admission.operation });
    const [stored] = await database.sql<{ artifact: unknown }[]>`
      select artifact from public.sp_write_plans where plan_id = ${admission.operation.planId}
    `;
    await executeSyntheticKeywordWrite(database, SpWritePlan.parse(stored!.artifact), queued.receipt, 'ambiguous');
    try {
      const observed = await readSpWriteOperation(database, { orgId, userId: USER }, { profileId, ...admission.operation });
      expect(observed.snapshot).toMatchObject({ status: 'observed_after_ambiguous', accounting: { providerAmbiguous: 1, observedRequested: 1 } });
      const inverse = await previewSpWriteInverse(database, { orgId, userId: USER }, {
        requestId: randomUUID(), profileId, original: admission.operation,
      });
      expect(inverse.plan.actions[0]).toMatchObject({ changes: { bid: { expected: { amount: '0.7' }, requested: { amount: '0.9' } } } });
    } finally {
      await database.sql`update public.keywords set bid = 0.9 where org_id = ${orgId} and amazon_id = 'kw-1'`;
    }
  });
});
