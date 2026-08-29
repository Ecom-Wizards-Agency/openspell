import { createHash } from 'node:crypto';
import {
  approveAmazonWriteExecution,
} from '@wizard-ads/db';
import {
  createTestDatabase,
  databaseAvailable,
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
  createPostgresAmazonWriteRuntime,
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

  it('applies, observes, reverses, and observes one exact bid with a fake provider', async () => {
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
    const approved = await approveAmazonWriteExecution(database, {
      orgId: tenant.org_id,
      profileId: tenant.profile_id,
      applyBatchId: batch.id,
      approvedBy: OWNER_ID,
      approvalMode: 'bounded_live_test',
      approvedAt: new Date(now.getTime() - 60_000).toISOString(),
      expiresAt: authorization.expires_at,
      previewSha256: artifactSha256,
      expectedCount: 1,
      authorizationId: authorization.authorization_id,
      authorizationSha256: boundedAmazonWriteAuthorizationFingerprint(authorization),
      inversePreapproved: true,
    });

    let providerBid = 0.9;
    const writeValues: number[] = [];
    const provider: SpWriteClient = {
      updateSpKeywordBids: vi.fn(async (_profile, items) => {
        expect(items).toHaveLength(1);
        const item = items[0];
        if (!item) throw new Error('synthetic keyword mutation is missing');
        providerBid = item.bid;
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
          matchType: 'exact', bid: providerBid,
        };
        return { rows: [row], requested: 1, returned: 1, apiCalls: 1 };
      }),
    };
    const runtime = createPostgresAmazonWriteRuntime({
      handle: database,
      workerStore,
      provider,
      enabled: true,
      loadAuthorization: async () => authorization,
    });

    await expect(runtime.apply({
      type: 'amazon.apply', orgId: tenant.org_id, profileId: tenant.profile_id,
      executionId: approved.executionId,
    }, profile)).resolves.toMatchObject({ status: 'awaiting_sync', amazonApiCalls: 1 });
    const forwardObserved = await runtime.observe({
      type: 'amazon.observe', orgId: tenant.org_id, profileId: tenant.profile_id,
      executionId: approved.executionId, attempt: 0,
    }, profile);
    expect(forwardObserved).toMatchObject({
      status: 'succeeded', inverseReady: true, amazonApiCalls: 1,
    });
    const [inverse] = await database.sql<{ inverse_execution_id: string | null }[]>`
      select inverse_execution_id from public.amazon_write_inverse_reservations
       where forward_execution_id = ${approved.executionId}
    `;
    if (!inverse?.inverse_execution_id) throw new Error('reserved inverse was not materialized');

    await expect(runtime.apply({
      type: 'amazon.apply', orgId: tenant.org_id, profileId: tenant.profile_id,
      executionId: inverse.inverse_execution_id,
    }, profile)).resolves.toMatchObject({ status: 'awaiting_sync', amazonApiCalls: 1 });
    const inverseObserved = await runtime.observe({
      type: 'amazon.observe', orgId: tenant.org_id, profileId: tenant.profile_id,
      executionId: inverse.inverse_execution_id, attempt: 0,
    }, profile);
    expect(inverseObserved).toMatchObject({
      status: 'succeeded', inverseReady: true, amazonApiCalls: 1,
    });
    expect(writeValues).toEqual([0.91, 0.9]);
    expect(providerBid).toBe(0.9);
    expect(provider.updateSpKeywordBids).toHaveBeenCalledTimes(2);
    expect(provider.observeSpWriteEntities).toHaveBeenCalledTimes(2);
  });
});
