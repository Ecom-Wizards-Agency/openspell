import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSpWriteAdapter, type SpWriteAdapter } from '@wizard-ads/ads-api/sp-write-adapter';
import { exportAcceptedRecommendations } from '@wizard-ads/db';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { approveAndQueueSpWrite, previewSpWrite, readSpWriteOperation } from '@wizard-ads/db/sp-write-application';
import { createSpWriteOutboxLedger, createSpWriteRuntimeLedger } from '@wizard-ads/db/sp-write-persistence';
import { listSpWriteProviderPlans, readSpWriteDatabaseTime, readSpWriteRecoveryResult } from '@wizard-ads/db/sp-write-worker';
import type { SpWriteAdmission, SpWritePreview } from '@wizard-ads/shared/sp-write-application';
import type { SpWriteObservation, SpWritePlan } from '@wizard-ads/shared/sp-writes';
import { hasher, makeReservationArtifacts, providerKey, remainingAttemptMs } from './artifacts.js';
import { createSpWriteOutboxLoop } from './loop.js';

const available = await databaseAvailable();
const OWNER = '31313131-3131-4131-8131-313131313131';

describe.skipIf(!available)('inert SP write worker with real ledger and fake HTTP provider', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  let preview: SpWritePreview;
  let admission: SpWriteAdmission;
  let gateId: string;
  let dispatchEnabled: boolean;
  let bid: number;
  let providerBids: Map<string, number>;
  let readFailure: boolean;
  let ambiguous: boolean;
  let puts: number;
  let reads: number;
  let credentialsPrepared: number;
  let adapter: SpWriteAdapter;
  let mirror: ReturnType<typeof vi.fn<(observation: SpWriteObservation) => Promise<boolean>>>;

  beforeEach(async (context) => {
    database = await createTestDatabase('sp_loop');
    const [tenant] = await database.sql<{ org_id: string }[]>`select app.seed_tenant_fixture('sp-loop', ${OWNER}, 'owner') as org_id`;
    orgId = tenant!.org_id;
    // The RLS fixture contains a completed, deliberately noncanonical history row.
    // Close its delivery through the real facade before admitting this test's new operation.
    const fixtureOutbox = createSpWriteOutboxLedger(database);
    const fixtureClaims = await fixtureOutbox.claimAvailable({ claimantId: 'synthetic-fixture-cleanup', kinds: ['observe_and_recover'], limit: 1 });
    expect(fixtureClaims.claimedCount).toBe(1);
    expect((await fixtureOutbox.completeClaim(fixtureClaims.claims[0]!)).kind).toBe('completed');
    const [profile] = await database.sql<{ id: string }[]>`select id::text from public.ad_profiles where org_id = ${orgId}`;
    profileId = profile!.id;
    const version = randomUUID();
    await database.sql`insert into public.sp_write_profile_grant_versions
      (grant_id, version_id, org_id, profile_id, enabled, amazon_profile_id, connection_id, region, marketplace_id, currency_code, api_dialect, created_by)
      select grant_id, ${version}, org_id, profile_id, true, amazon_profile_id, connection_id, region, 'ATVPDKIKX0DER', currency_code, api_dialect, created_by
      from public.sp_write_profile_grant_versions where org_id = ${orgId} and profile_id = ${profileId}`;
    await database.sql`update public.sp_write_profile_grant_heads set version_id = ${version} where org_id = ${orgId} and profile_id = ${profileId}`;
    gateId = randomUUID();
    await database.sql`insert into public.sp_write_environment_gate_versions (version_id, enabled, max_unresolved_calls) values (${gateId}, true, 1)`;
    await database.sql`insert into public.sp_write_environment_gate_head (singleton, version_id) values (true, ${gateId})`;
    const recIds: string[] = [];
    const [run] = await database.sql<{ id: string }[]>`select id::text from public.recommendation_runs where org_id = ${orgId} and profile_id = ${profileId}`;
    const rows = context.task.name.includes('101 rows') ? 101 : context.task.name.includes('mixed batch') ? 2 : 1;
    for (let index = 1; index <= rows; index += 1) {
      const keywordId = `kw-${index}`;
      if (index > 1) await database.sql`insert into public.keywords
        (org_id, profile_id, amazon_id, ad_product, state, campaign_id, ad_group_id, keyword_text, match_type, bid)
        select org_id, profile_id, ${keywordId}, ad_product, state, campaign_id, ad_group_id, ${keywordId}, match_type, bid
        from public.keywords where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'kw-1'`;
      const recId = randomUUID(); recIds.push(recId);
      await database.sql`insert into public.recommendations
        (id, run_id, org_id, profile_id, reason, entity_type, entity_id, field, current_value, proposed_value, inputs, status)
        values (${recId}, ${run!.id}, ${orgId}, ${profileId}, 'high_acos', 'keyword', ${keywordId}, 'bid', '0.9'::jsonb, '0.7'::jsonb, '{}'::jsonb, 'accepted')`;
    }
    const exported = await exportAcceptedRecommendations(database, { orgId, profileId, runId: run!.id, ids: recIds,
      tag: randomUUID(), optGroup: 'synthetic', lever: 'bid-down', note: 'Synthetic worker', actorId: OWNER });
    preview = await previewSpWrite(database, { orgId, userId: OWNER }, { requestId: randomUUID(), profileId, applyBatchId: exported.batchId });
    admission = await approveAndQueueSpWrite(database, { orgId, userId: OWNER }, { profileId, approval: {
      approvalRequestId: randomUUID(), plan: preview.binding, approvalMode: 'manual',
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1', boundedAuthorization: null, preapprovedInversePlan: null,
    } });
    dispatchEnabled = true; bid = 0.9; readFailure = false; ambiguous = false; puts = 0; reads = 0; credentialsPrepared = 0;
    providerBids = new Map();
    const clientId = 'synthetic-client'; const secret = ['synthetic', 'secret'].join('-'); const refresh = 'synthetic-refresh';
    adapter = createSpWriteAdapter({ region: 'NA', credentials: { clientId, clientSecret: secret, refreshToken: refresh },
      fetch: async (url, init = {}) => {
        if (url.endsWith('/auth/o2/token')) return new Response(JSON.stringify({ access_token: 'synthetic', expires_in: 3600 }));
        if (init.method === 'PUT') {
          puts += 1;
          const body = JSON.parse(String(init.body)) as { keywords: Array<{ keywordId: string; bid: number }> };
          expect(body.keywords.length).toBeGreaterThan(0);
          expect(body.keywords.length).toBeLessThanOrEqual(100);
          for (const row of body.keywords) providerBids.set(row.keywordId, row.bid);
          if (ambiguous) return new Response('{}', { status: 503 });
          return new Response(JSON.stringify({ keywords: { success: body.keywords.map((row, index) => ({ index, keywordId: row.keywordId })), error: [] } }), { status: 207 });
        }
        reads += 1;
        if (readFailure) return new Response('{}', { status: 200 });
        const body = JSON.parse(String(init.body)) as { keywordIdFilter: { include: string[] } };
        return new Response(JSON.stringify({ keywords: body.keywordIdFilter.include.map((keywordId) => ({ keywordId, bid: providerBids.get(keywordId) ?? bid, state: 'ENABLED' })) }));
      },
    }, { hasher });
    // Mirror persistence is a required capability; this synthetic probe deliberately does not
    // claim that a provider observation alone has updated the product's entity mirror.
    mirror = vi.fn(async () => true);
  }, 60_000);

  afterEach(async () => { await database?.drop(); });

  function loop(overrides: { prepareProviders?: (plans: readonly SpWritePlan[]) => Promise<ReadonlyMap<string, SpWriteAdapter>> } = {}) {
    return createSpWriteOutboxLoop({ database, claimantId: 'synthetic-write-worker',
      policy: () => ({ dispatchEnabled, reconcileEnabled: true, profileIds: [profileId] }),
      prepareProviders: overrides.prepareProviders ?? (async (plans) => {
        const [head] = await database.sql<{ count: number }[]>`select count(*)::int as count from app.sp_write_outbox_delivery_heads where state = 'leased'`;
        expect(head!.count).toBe(0);
        credentialsPrepared += plans.length;
        return new Map(plans.map((plan) => [providerKey(plan), adapter]));
      }), reconcileObservation: mirror,
    });
  }

  async function detail() {
    return readSpWriteOperation(database, { orgId, userId: OWNER }, { profileId, ...admission.operation });
  }

  async function closeGate() {
    const version = randomUUID();
    await database.sql`insert into public.sp_write_environment_gate_versions (version_id, enabled, max_unresolved_calls) values (${version}, false, 1)`;
    await database.sql`update public.sp_write_environment_gate_head set version_id = ${version}`;
  }

  it('sends one attempt, observes it, reconciles counts and never dispatches it again', async () => {
    expect((await listSpWriteProviderPlans(database, [profileId], true, true)).map((plan) => plan.id)).toEqual([preview.plan.id]);
    const worker = loop();
    expect(await worker.tick()).toEqual({ kind: 'completed', attemptedCalls: 1 });
    expect(puts).toBe(1); expect(credentialsPrepared).toBe(1);
    expect((await detail()).snapshot.accounting).toMatchObject({ approvedRows: 1, intentCommitted: 1, providerAccepted: 1, pendingObservation: 1 });
    expect(await worker.tick()).toEqual({ kind: 'completed', attemptedCalls: 0 });
    expect((await detail()).snapshot).toMatchObject({ status: 'succeeded', accounting: { observedRequested: 1, pendingObservation: 0 } });
    expect(mirror).toHaveBeenCalledTimes(1);
    expect(await worker.tick()).toEqual({ kind: 'idle', attemptedCalls: 0 });
    expect(puts).toBe(1); expect(reads).toBe(2);
  });

  it.each(['environment', 'profile', 'sync'] as const)('makes zero provider calls when %s authority closes after approval', async (kind) => {
    if (kind === 'environment') await closeGate();
    if (kind === 'profile') await database.sql`delete from public.sp_write_profile_grant_heads where org_id = ${orgId} and profile_id = ${profileId}`;
    if (kind === 'sync') {
      await database.sql`update public.ad_profiles set sync_enabled = false where org_id = ${orgId} and id = ${profileId}`;
    }
    expect(await loop().tick()).toEqual({ kind: 'deferred', attemptedCalls: 0 });
    expect(puts).toBe(0); expect(reads).toBe(0); expect(credentialsPrepared).toBe(0);
    expect((await detail()).snapshot.accounting.pendingDispatch).toBe(1);
  });

  it('records a stale Amazon value refusal without a mutation attempt', async () => {
    bid = 1.1;
    expect(await loop().tick()).toEqual({ kind: 'completed', attemptedCalls: 0 });
    expect(puts).toBe(0); expect(reads).toBe(1);
    expect((await detail()).snapshot).toMatchObject({ status: 'refused', accounting: { refusedBeforeDispatch: 1, intentCommitted: 0 } });
  });

  it('finishes the unchanged row in a mixed batch after another row is refused', async () => {
    providerBids.set('kw-1', 1.1);
    const worker = loop();
    expect(await worker.tick()).toEqual({ kind: 'completed', attemptedCalls: 1 });
    expect(providerBids.get('kw-1')).toBe(1.1);
    expect(providerBids.get('kw-2')).toBe(0.7);
    expect(await worker.tick()).toEqual({ kind: 'completed', attemptedCalls: 0 });
    expect((await detail()).snapshot.accounting).toMatchObject({ approvedRows: 2, refusedBeforeDispatch: 1, providerAccepted: 1, observedRequested: 1, pendingDispatch: 0 });
    expect(puts).toBe(1);
  });

  it('reconciles all 101 rows over two exact provider calls', async () => {
    const worker = loop();
    expect(await worker.tick()).toEqual({ kind: 'completed', attemptedCalls: 2 });
    expect(providerBids.size).toBe(101);
    expect(await worker.tick()).toEqual({ kind: 'completed', attemptedCalls: 0 });
    expect(await worker.tick()).toEqual({ kind: 'completed', attemptedCalls: 0 });
    expect((await detail()).snapshot).toMatchObject({ status: 'succeeded', accounting: { approvedRows: 101, providerCallsCommitted: 2, providerAccepted: 101, observedRequested: 101, pendingDispatch: 0, pendingObservation: 0 } });
    expect(mirror).toHaveBeenCalledTimes(101);
    expect(await worker.tick()).toEqual({ kind: 'idle', attemptedCalls: 0 });
    expect(puts).toBe(2);
  });

  it('keeps accepted work observable after both dispatch switches close', async () => {
    const worker = loop();
    expect((await worker.tick()).attemptedCalls).toBe(1);
    dispatchEnabled = false; await closeGate();
    expect(await worker.tick()).toEqual({ kind: 'completed', attemptedCalls: 0 });
    expect((await detail()).snapshot.status).toBe('succeeded');
    expect(puts).toBe(1);
  });

  it('observes an ambiguous response without retrying the mutation', async () => {
    ambiguous = true;
    const worker = loop();
    expect(await worker.tick()).toEqual({ kind: 'completed', attemptedCalls: 1 });
    expect(await worker.tick()).toEqual({ kind: 'completed', attemptedCalls: 0 });
    expect((await detail()).snapshot.status).toBe('observed_after_ambiguous');
    expect(puts).toBe(1);
  });

  it('leaves failed reads pending without recording a missing entity', async () => {
    const worker = loop();
    expect((await worker.tick()).attemptedCalls).toBe(1);
    readFailure = true;
    expect(await worker.tick()).toEqual({ kind: 'fault', attemptedCalls: 0 });
    expect((await detail()).snapshot.accounting).toMatchObject({ observationMissing: 0, pendingObservation: 1 });
    expect(mirror).not.toHaveBeenCalled();
    expect(puts).toBe(1);
  });

  it('does not complete delivery when mirror evidence is unavailable', async () => {
    mirror.mockResolvedValue(false);
    const worker = loop();
    expect((await worker.tick()).attemptedCalls).toBe(1);
    expect(await worker.tick()).toEqual({ kind: 'deferred', attemptedCalls: 0 });
    const [row] = await database.sql<{ state: string }[]>`select head.state::text from app.sp_write_outbox_delivery_heads head
      join public.sp_write_outbox source using (outbox_id) where source.kind = 'observe_and_recover' and source.plan_id = ${preview.plan.id}`;
    expect(row!.state).toBe('available');
    expect(puts).toBe(1);
  });

  it('keeps a slow preparation single-flight and stopping prevents a later claim', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const worker = loop({ prepareProviders: async () => { entered(); await gate; return new Map(); } });
    const first = worker.tick(); await started;
    expect(await worker.tick()).toEqual({ kind: 'busy', attemptedCalls: 0 });
    worker.stop(); release();
    expect(await first).toEqual({ kind: 'fault', attemptedCalls: 0 });
    expect(await worker.tick()).toEqual({ kind: 'disabled', attemptedCalls: 0 });
    const [head] = await database.sql<{ count: number }[]>`select count(*)::int as count from app.sp_write_outbox_delivery_events event
      join public.sp_write_outbox source using (outbox_id) where event_kind = 'claimed' and source.plan_id = ${preview.plan.id}`;
    expect(head!.count).toBe(0); expect(puts).toBe(0);
  });

  it('waits for both real deadlines and recovers a lost provider response without another mutation', async () => {
    const runtime = createSpWriteRuntimeLedger(database);
    const outbox = createSpWriteOutboxLedger(database);
    const batch = await outbox.claimAvailable({ claimantId: 'synthetic-reserver', kinds: ['dispatch'], limit: 1 });
    const claim = batch.claims[0];
    if (claim?.kind !== 'dispatch') throw new Error('claim absent');
    const evidence = await runtime.loadVerifiedExecution(claim);
    if (evidence === null) throw new Error('evidence absent');
    const call = adapter.preparePlan(evidence.plan)[0]!;
    const lease = await runtime.acquireDispatchLease({ claim, routeKey: call.routeKey, leaseSeconds: 71 });
    if (lease.kind !== 'acquired') throw new Error('lease absent');
    const items = await adapter.observeCurrent({ plan: evidence.plan, call });
    const artifacts = makeReservationArtifacts(evidence, call, lease.leaseId, items, await readSpWriteDatabaseTime(database));
    const reservation = await runtime.reserveProviderCall({ claim, ...artifacts });
    if (reservation.kind !== 'dispatch_once') throw new Error('reservation absent');
    expect(remainingAttemptMs(reservation.ticket, 0)).toBeGreaterThan(0);
    expect(remainingAttemptMs(reservation.ticket, 5000)).toBe(0);
    expect(remainingAttemptMs(reservation.ticket, -1)).toBe(0);
    expect(await readSpWriteRecoveryResult(database, artifacts.intent)).toBeNull();
    // Amazon accepted the fake HTTP request, then the process lost its result before persistence.
    await adapter.executeOneAttempt({ plan: preview.plan, intent: artifacts.intent, resultId: reservation.ticket.resultId });
    expect(puts).toBe(1);
    const retry = await runtime.reserveProviderCall({ claim, ...artifacts });
    expect(retry.kind).toBe('closed_without_dispatch');
    expect((await outbox.completeClaim(claim)).kind).toBe('completed');
    dispatchEnabled = false;
    expect(await loop().tick()).toEqual({ kind: 'idle', attemptedCalls: 0 });
    const deadline = Date.now() + 80_000;
    while (await readSpWriteRecoveryResult(database, artifacts.intent) === null) {
      if (Date.now() >= deadline) throw new Error('synthetic recovery deadline did not open');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const unavailable = loop({ prepareProviders: async () => { throw new Error('synthetic missing credential store'); } });
    expect(await unavailable.tick()).toEqual({ kind: 'fault', attemptedCalls: 0 });
    expect((await detail()).snapshot.accounting).toMatchObject({ providerCallsCompleted: 1, providerAmbiguous: 1, pendingObservation: 1 });
    // Respect the real delivery backoff before another process supplies the observation.
    const worker = loop();
    let observed = false;
    const observationDeadline = Date.now() + 20_000;
    while (Date.now() < observationDeadline) {
      const tick = await worker.tick();
      if (tick.kind === 'completed') { observed = true; break; }
      expect(tick.kind).toBe('idle');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(observed).toBe(true);
    expect((await detail()).snapshot.status).toBe('observed_after_ambiguous');
    expect(puts).toBe(1);
  }, 110_000);
});
