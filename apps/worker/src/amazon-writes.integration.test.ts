import { createHash } from 'node:crypto';
import {
  approveAmazonWriteExecution,
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
import type { SpWriteClient } from './ads-api.js';
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

  it('isolates observation generations across crash recovery, then executes and observes the exact inverse', async () => {
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
      inversePreapproved: true,
    }));

    let visibleProviderBid = 0.9;
    const writeValues: number[] = [];
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
        const row: EntityRow = {
          entityType: 'keyword', profileId: tenant.profile_id, amazonId: 'kw-1',
          adProduct: 'SP', name: 'synthetic keyword', state: 'enabled',
          campaignId: 'c-1', adGroupId: 'ag-1', keywordText: 'synthetic keyword',
          matchType: 'exact', bid: visibleProviderBid,
        };
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

    await expect(runtime.apply({
      type: 'amazon.apply', orgId: tenant.org_id, profileId: tenant.profile_id,
      executionId: approved.executionId,
    }, profile)).rejects.toThrow(/ledger outage/i);
    const firstGeneration = await generationFor(approved.executionId);
    for (let attempt = 0; attempt <= 5; attempt += 1) {
      const result = await runtime.observe({
        type: 'amazon.observe', orgId: tenant.org_id, profileId: tenant.profile_id,
        executionId: approved.executionId, generation: firstGeneration, attempt,
      }, profile);
      await completeObservationJob(approved.executionId, firstGeneration, attempt);
      if (attempt < 5) expect(result).toMatchObject({ status: 'awaiting_sync', requeued: true });
      else expect(result).toMatchObject({ status: 'queued', applyRequeued: true });
    }

    await expect(runtime.apply({
      type: 'amazon.apply', orgId: tenant.org_id, profileId: tenant.profile_id,
      executionId: approved.executionId,
    }, profile)).resolves.toMatchObject({ status: 'awaiting_sync', amazonApiCalls: 2 });
    const secondGeneration = await generationFor(approved.executionId);
    expect(secondGeneration).not.toBe(firstGeneration);
    const secondPending = await runtime.observe({
      type: 'amazon.observe', orgId: tenant.org_id, profileId: tenant.profile_id,
      executionId: approved.executionId, generation: secondGeneration, attempt: 0,
    }, profile);
    expect(secondPending).toMatchObject({ status: 'awaiting_sync', requeued: true });
    await completeObservationJob(approved.executionId, secondGeneration, 0);
    const [secondAttempt] = await database.sql<{ dedupe_key: string }[]>`
      select dedupe_key from public.sync_jobs
       where org_id = ${tenant.org_id}
         and dedupe_key = ${`amazon.observe:${approved.executionId}:${secondGeneration}:1`}
    `;
    expect(secondAttempt?.dedupe_key).toBe(
      `amazon.observe:${approved.executionId}:${secondGeneration}:1`,
    );
    visibleProviderBid = 0.91;
    const forwardObserved = await runtime.observe({
      type: 'amazon.observe', orgId: tenant.org_id, profileId: tenant.profile_id,
      executionId: approved.executionId, generation: secondGeneration, attempt: 1,
    }, profile);
    await completeObservationJob(approved.executionId, secondGeneration, 1);
    expect(forwardObserved).toMatchObject({ status: 'succeeded', inverseReady: true });
    const [inverse] = await database.sql<{ inverse_execution_id: string | null }[]>`
      select inverse_execution_id from public.amazon_write_inverse_reservations
       where forward_execution_id = ${approved.executionId}
    `;
    if (!inverse?.inverse_execution_id) throw new Error('reserved inverse was not materialized');

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
    expect(writeValues).toEqual([0.91, 0.91, 0.9]);
    expect(visibleProviderBid).toBe(0.9);
    expect(provider.updateSpKeywordBids).toHaveBeenCalledTimes(3);
    expect(provider.observeSpWriteEntities).toHaveBeenCalledTimes(12);
  });
});
