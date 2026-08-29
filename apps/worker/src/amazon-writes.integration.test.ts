import { createHash } from 'node:crypto';
import {
  approveAmazonWriteExecution,
  claimSyncJobs,
  finishSyncJob,
  requeueStaleSyncJobs,
  type ClaimedJob,
} from '@wizard-ads/db';
import {
  createTestDatabase,
  databaseAvailable,
  asUser,
  type TestDatabase,
} from '@wizard-ads/db/testing';
import {
  serializeApplyRows,
  type BoundedAmazonWriteAuthorization,
  type EntityRow,
} from '@wizard-ads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type SpWriteClient } from './ads-api.js';
import {
  boundedAmazonWriteAuthorizationFingerprint,
  GuardedAmazonWriteRuntime,
  PostgresAmazonWriteStore,
} from './amazon-writes.js';
import { PostgresWorkerStore } from './store.js';

const available = await databaseAvailable();
const OWNER_ID = '11111111-1111-4111-8111-111111111111';

describe.skipIf(!available)('guarded Amazon write forward and inverse flow', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('worker_amazon_write_flow');
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('observes an ambiguous post-dispatch crash without resending, then executes the exact inverse', async () => {
    const [seeded] = await database.sql<{ org_id: string }[]>`
      select app.seed_tenant_fixture('worker-amazon-write-flow', ${OWNER_ID}, 'owner') as org_id
    `;
    if (!seeded) throw new Error('synthetic tenant fixture was not created');
    const [tenant] = await database.sql<{ org_id: string; profile_id: string }[]>`
      select org.id as org_id, profile.id as profile_id
        from public.orgs org
        join public.ad_profiles profile on profile.org_id = org.id
       where org.id = ${seeded.org_id}
       limit 1
    `;
    if (!tenant) throw new Error('synthetic tenant fixture is missing');
    // The catalog-completeness fixture deliberately includes a pending write
    // cycle for RLS coverage. This scenario owns the only active synthetic
    // cycle for its profile, so settle that fixture row before creating it.
    await database.sql`
      update public.amazon_write_executions execution
         set status = 'refused', completed_at = coalesce(completed_at, now()),
             dispatch_lease_token = null, dispatch_lease_expires_at = null
        from public.apply_batches batch
       where batch.id = execution.apply_batch_id
         and execution.org_id = ${tenant.org_id}
         and execution.profile_id = ${tenant.profile_id}
         and batch.tag like 'worker-amazon-write-flow-%'
    `;
    await database.sql`
      update public.ad_profiles set account_name = 'Synthetic account'
       where id = ${tenant.profile_id}
    `;
    const workerStore = new PostgresWorkerStore(database);
    const profile = await workerStore.profile(tenant.profile_id);
    if (!profile.accountName || !profile.countryCode) {
      throw new Error('synthetic profile needs an account label and marketplace');
    }
    await database.sql`
      update public.keywords set bid = 0.90, synced_at = now()
       where org_id = ${tenant.org_id} and profile_id = ${tenant.profile_id}
         and amazon_id = 'kw-1'
    `;

    const artifactRows = [{
      entityType: 'keyword' as const,
      entityId: 'kw-1',
      field: 'bid',
      old: 0.9,
      new: 0.91,
    }];
    const artifactSha256 = createHash('sha256')
      .update(serializeApplyRows(artifactRows))
      .digest('hex');
    const [batch] = await database.sql<{ id: string }[]>`
      insert into public.apply_batches
        (org_id, profile_id, tag, opt_group, lever, note, artifact_sha256,
         exported_proposals, reversible_rows, unsupported_rows)
      values (${tenant.org_id}, ${tenant.profile_id}, 'worker-write-flow', 'rank',
              'push', 'synthetic', ${artifactSha256}, 1, 1, 0)
      returning id
    `;
    if (!batch) throw new Error('synthetic apply batch was not created');
    await database.sql`
      insert into public.apply_rows
        (batch_id, org_id, profile_id, entity_type, entity_id, field, old_value, new_value)
      values (${batch.id}, ${tenant.org_id}, ${tenant.profile_id}, 'keyword', 'kw-1',
              'bid', '0.9'::jsonb, '0.91'::jsonb)
    `;

    const now = new Date();
    const authorization: BoundedAmazonWriteAuthorization = {
      schema: 'openspell.amazon-write-authorization.v1',
      authorization_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      expires_at: new Date(now.getTime() + 86_400_000).toISOString(),
      profiles: [{
        org_id: tenant.org_id,
        profile_id: tenant.profile_id,
        amazon_profile_id: profile.amazonProfileId,
        connection_id: profile.connectionId ?? '',
        region: profile.region,
        account_label: profile.accountName,
        marketplace: profile.countryCode,
        allowed_entities: [{
          action_type: 'sp_keyword_bid', amazon_entity_id: 'kw-1', field: 'bid',
        }],
      }],
      allowed_tests: {
        bid: { enabled: true, max_absolute_delta: 0.01, require_immediate_inverse: true },
        placement: { enabled: false, max_absolute_percentage_points: 1, require_immediate_inverse: true },
        cadence: { enabled: false, max_executions: 0, disable_after_test: true, require_immediate_inverse: true },
      },
      constraints: {
        max_concurrent_mutations: 1,
        max_rows_per_execution: 1,
        max_total_executions: 2,
        require_current_value_match: true,
        require_amazon_acceptance: true,
        require_sync_observation_before_inverse: true,
        stop_on_conflict: true,
      },
    };
    const approved = await asUser(database, OWNER_ID, (sql) => approveAmazonWriteExecution(database, { sql }, {
      orgId: tenant.org_id,
      profileId: tenant.profile_id,
      applyBatchId: batch.id,
      approvalMode: 'bounded_live_test',
      expiresAt: authorization.expires_at,
      previewSha256: artifactSha256,
      expectedCount: 1,
      authorizationId: authorization.authorization_id,
      authorizationSha256: boundedAmazonWriteAuthorizationFingerprint(authorization),
      authorizationSnapshot: authorization,
      inversePreapproved: true,
    }));

    let visibleProviderBid = 0.9;
    const writeValues: number[] = [];
    const providerKeywordRow = (bid: number): EntityRow => ({
      entityType: 'keyword', profileId: tenant.profile_id, amazonId: 'kw-1',
      adProduct: 'SP', name: 'synthetic keyword', state: 'enabled',
      campaignId: 'c-1', adGroupId: 'ag-1', keywordText: 'synthetic keyword',
      matchType: 'exact', bid,
    });
    const provider: SpWriteClient = {
      updateSpKeywordBids: vi.fn(async (_profile, items) => {
        expect(items).toHaveLength(1);
        const item = items[0];
        if (!item) throw new Error('synthetic keyword mutation is missing');
        writeValues.push(item.bid);
        return {
          evidence: [{
            outcome: 'accepted' as const, providerEntityId: item.keywordId,
            code: null, message: null,
          }],
          apiCalls: 1,
        };
      }),
      updateSpTargetBids: vi.fn(async () => { throw new Error('unexpected target mutation'); }),
      updateSpCampaignPlacements: vi.fn(async () => { throw new Error('unexpected placement mutation'); }),
      observeSpWriteEntities: vi.fn(async (_profile, request) => {
        expect(request).toEqual({ keywordIds: ['kw-1'], targetIds: [], campaignIds: [] });
        const row = providerKeywordRow(visibleProviderBid);
        return { rows: [row], requested: 1, returned: 1, apiCalls: 1 };
      }),
    };
    const store = new PostgresAmazonWriteStore(database, workerStore);
    const persistOutcome = store.recordOutcomes.bind(store);
    let failFirstForwardOutcome = true;
    store.recordOutcomes = async (input) => {
      if (input.executionId === approved.executionId && failFirstForwardOutcome) {
        failFirstForwardOutcome = false;
        throw new Error('synthetic post-provider ledger outage');
      }
      return persistOutcome(input);
    };
    const runtime = new GuardedAmazonWriteRuntime({
      store,
      provider,
      enabled: true,
      loadAuthorization: async () => authorization,
    });

    const generationFor = async (executionId: string) => {
      const [observation] = await database.sql<{ generation: string }[]>`
        select payload->>'generation' as generation from public.sync_jobs
         where org_id = ${tenant.org_id}
           and dedupe_key like ${`amazon.observe:${executionId}:%:0`}
         order by created_at desc limit 1
      `;
      if (!observation?.generation) throw new Error('observation generation is missing');
      return observation.generation;
    };
    const completeObservationJob = async (executionId: string, generation: string, attempt: number) => {
      await database.sql`
        update public.sync_jobs set status = 'succeeded', finished_at = now()
         where org_id = ${tenant.org_id}
           and dedupe_key = ${`amazon.observe:${executionId}:${generation}:${attempt}`}
      `;
    };
    let staleObserverClaim: ClaimedJob | null = null;

    await expect(runtime.apply({
      type: 'amazon.apply', orgId: tenant.org_id, profileId: tenant.profile_id,
      executionId: approved.executionId,
    }, profile)).rejects.toThrow(/ledger outage/i);
    const firstGeneration = await generationFor(approved.executionId);
    for (let attempt = 0; attempt <= 5; attempt += 1) {
      if (attempt === 5) {
        visibleProviderBid = 0.91;
        const promoted = await store.syncEntities(
          profile,
          [providerKeywordRow(visibleProviderBid)],
          new Date(),
        );
        expect(promoted).toMatchObject({ listed: 1, upserted: 1, changes: 0 });
        const [beforeClassification] = await database.sql<{
          batch_status: string; legacy_links: number;
        }[]>`
          select batch.status::text as batch_status,
                 (select count(*)::int from public.entity_changes change
                   join public.apply_rows apply_row on apply_row.id = change.apply_row_id
                  where apply_row.batch_id = ${batch.id} and change.source = 'sync') as legacy_links
            from public.apply_batches batch where batch.id = ${batch.id}
        `;
        expect(beforeClassification).toEqual({ batch_status: 'staged', legacy_links: 0 });
        await database.sql`
          update public.amazon_write_executions
             set dispatch_lease_expires_at = clock_timestamp() - interval '1 second'
           where id = ${approved.executionId}
        `;
      }
      const observation = {
        type: 'amazon.observe', orgId: tenant.org_id, profileId: tenant.profile_id,
        executionId: approved.executionId, generation: firstGeneration, attempt,
      } as const;
      if (attempt < 5) {
        await expect(runtime.observe(observation, profile)).resolves.toMatchObject({
          status: 'running', requeued: true,
        });
      } else {
        const attemptDedupe = `amazon.observe:${approved.executionId}:${firstGeneration}:${attempt}`;
        await database.sql`
          update public.sync_jobs set run_after = now()
           where org_id = ${tenant.org_id} and dedupe_key = ${attemptDedupe}
        `;
        const [originalClaim] = await claimSyncJobs(
          database,
          'synthetic-stale-observer',
          1,
          ['amazon.observe'],
        );
        if (!originalClaim || originalClaim.dedupeKey !== attemptDedupe) {
          throw new Error('exact stale observer job was not claimed');
        }
        staleObserverClaim = originalClaim;
        await database.sql`
          update public.sync_jobs set claimed_at = now() - interval '2 hours'
           where id = ${originalClaim.id}
        `;
        expect(await requeueStaleSyncJobs(database, '30 minutes')).toBe(1);
        const [replacementClaim] = await claimSyncJobs(
          database,
          'synthetic-replacement-observer',
          1,
          ['amazon.observe'],
        );
        if (!replacementClaim || replacementClaim.id !== originalClaim.id) {
          throw new Error('replacement observer did not reclaim the exact queue row');
        }
        expect(replacementClaim.claimToken).not.toBe(originalClaim.claimToken);
        await expect(runtime.observe(observation, profile)).resolves.toMatchObject({
          status: 'succeeded', inverseReady: true,
        });
        await finishSyncJob(database, replacementClaim.id, 'succeeded', {
          claimToken: replacementClaim.claimToken,
          result: { status: 'succeeded', inverseReady: true },
        });
        expect(provider.updateSpKeywordBids).toHaveBeenCalledTimes(1);
      }
      if (attempt < 5) {
        await completeObservationJob(approved.executionId, firstGeneration, attempt);
      }
    }
    const [inverse] = await database.sql<{ inverse_execution_id: string | null }[]>`
      select inverse_execution_id from public.amazon_write_inverse_reservations
       where forward_execution_id = ${approved.executionId}
    `;
    if (!inverse?.inverse_execution_id) throw new Error('reserved inverse was not materialized');

    const staleRow: EntityRow = {
      entityType: 'keyword', profileId: tenant.profile_id, amazonId: 'kw-1',
      adProduct: 'SP', name: 'synthetic stale keyword', state: 'enabled',
      campaignId: 'c-1', adGroupId: 'ag-1', keywordText: 'synthetic stale keyword',
      matchType: 'exact', bid: 0.9,
    };
    const stalePromotion = await workerStore.syncEntities(profile, [staleRow], {
      observedAt: new Date(now.getTime() - 60_000),
    });
    expect(stalePromotion).toMatchObject({ listed: 1, upserted: 0 });
    if (!staleObserverClaim) throw new Error('stale observer claim was not captured');
    await expect(finishSyncJob(database, staleObserverClaim.id, 'succeeded', {
      claimToken: staleObserverClaim.claimToken,
      result: { status: 'stale-result-must-not-win' },
    })).rejects.toThrow(/stale|claim token/i);
    const [staleEvidence] = await database.sql<{ stale_changes: number }[]>`
      select count(*)::int as stale_changes from public.entity_changes
       where org_id = ${tenant.org_id} and profile_id = ${tenant.profile_id}
         and entity_type = 'keyword' and amazon_id = 'kw-1' and field = 'bid'
         and old_value = '0.91'::jsonb and new_value = '0.9'::jsonb
    `;
    expect(staleEvidence?.stale_changes).toBe(0);
    const [beforeInverse] = await database.sql<{
      bid: number; forward_status: string; inverse_status: string;
    }[]>`
      select keyword.bid::float8 as bid, forward_batch.status::text as forward_status,
             inverse_batch.status::text as inverse_status
        from public.amazon_write_executions forward
        join public.apply_batches forward_batch on forward_batch.id = forward.apply_batch_id
        join public.amazon_write_executions inverse_execution
          on inverse_execution.source_execution_id = forward.id
        join public.apply_batches inverse_batch on inverse_batch.id = inverse_execution.apply_batch_id
        join public.keywords keyword
          on keyword.profile_id = forward.profile_id and keyword.amazon_id = 'kw-1'
       where forward.id = ${approved.executionId}
    `;
    expect(beforeInverse).toEqual({ bid: 0.91, forward_status: 'applied', inverse_status: 'staged' });
    const [forwardEvidence] = await database.sql<{ apply_evidence: number; sync_evidence: number }[]>`
      select
        count(*) filter (where source = 'apply')::int as apply_evidence,
        count(*) filter (where source = 'sync')::int as sync_evidence
        from public.entity_changes
       where apply_batch_id = ${batch.id}
    `;
    expect(forwardEvidence).toEqual({ apply_evidence: 1, sync_evidence: 0 });

    await expect(runtime.apply({
      type: 'amazon.apply', orgId: tenant.org_id, profileId: tenant.profile_id,
      executionId: inverse.inverse_execution_id,
    }, profile)).resolves.toMatchObject({ status: 'awaiting_sync', amazonApiCalls: 2 });
    const inverseGeneration = await generationFor(inverse.inverse_execution_id);
    visibleProviderBid = 0.9;
    const inverseObserved = await runtime.observe({
      type: 'amazon.observe', orgId: tenant.org_id, profileId: tenant.profile_id,
      executionId: inverse.inverse_execution_id, generation: inverseGeneration, attempt: 0,
    }, profile);
    expect(inverseObserved).toMatchObject({
      status: 'succeeded', inverseReady: true, amazonApiCalls: 1,
    });
    const [lifecycle] = await database.sql<{
      forward_status: string; inverse_status: string; current_bid: number;
      forward_requested: number; forward_succeeded: number; forward_ambiguous: number;
      forward_resynchronized: number;
      inverse_requested: number; inverse_succeeded: number; inverse_resynchronized: number;
    }[]>`
      select forward_batch.status::text as forward_status,
             inverse_batch.status::text as inverse_status,
             keyword.bid::float8 as current_bid,
             forward.requested_count as forward_requested,
             forward.succeeded_count as forward_succeeded,
             forward.ambiguous_count as forward_ambiguous,
             forward.resynchronized_count as forward_resynchronized,
             inverse_execution.requested_count as inverse_requested,
             inverse_execution.succeeded_count as inverse_succeeded,
             inverse_execution.resynchronized_count as inverse_resynchronized
        from public.amazon_write_executions forward
        join public.apply_batches forward_batch on forward_batch.id = forward.apply_batch_id
        join public.amazon_write_executions inverse_execution
          on inverse_execution.source_execution_id = forward.id
        join public.apply_batches inverse_batch on inverse_batch.id = inverse_execution.apply_batch_id
        join public.keywords keyword
          on keyword.org_id = forward.org_id and keyword.profile_id = forward.profile_id
         and keyword.amazon_id = 'kw-1'
       where forward.id = ${approved.executionId}
    `;
    expect(lifecycle).toEqual({
      forward_status: 'reverted',
      inverse_status: 'applied',
      current_bid: 0.9,
      forward_requested: 1,
      forward_succeeded: 0,
      forward_ambiguous: 1,
      forward_resynchronized: 1,
      inverse_requested: 1,
      inverse_succeeded: 1,
      inverse_resynchronized: 1,
    });
    expect(writeValues).toEqual([0.91, 0.9]);
    expect(visibleProviderBid).toBe(0.9);
    expect(provider.updateSpKeywordBids).toHaveBeenCalledTimes(2);
    // Two pre-dispatch exact refreshes plus six forward and one inverse observations.
    expect(provider.observeSpWriteEntities).toHaveBeenCalledTimes(9);
  });
});
