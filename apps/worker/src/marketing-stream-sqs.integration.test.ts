import {
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from '@wizard-ads/db/testing';
import { markMarketingStreamProjectionBlocked } from '@wizard-ads/db';
import type {
  MarketingStreamBatchEnvelope,
  MarketingStreamLedgerEvent,
  MarketingStreamNormalizeJob,
} from '@wizard-ads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMarketingStreamSqsConsumer,
  DbMarketingStreamProfileScopeResolver,
  DbMarketingStreamRuntimeContextLoader,
  MarketingStreamSqsConsumer,
  type MarketingStreamQueueClient,
  type MarketingStreamQueueMessage,
} from './marketing-stream-sqs.js';
import { DbMarketingStreamStore } from './dayparting.js';
import {
  createMarketingStreamNormalizeHandler,
  requeueMarketingStreamBlockedProfile,
} from './marketing-stream-normalize.js';
import { PostgresWorkerStore } from './store.js';

const available = await databaseAvailable();
const USER = '76767676-7676-4676-8676-767676767676';

describe.skipIf(!available)('Marketing Stream SQS against migrated PostgreSQL', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;

  beforeAll(async () => {
    database = await createTestDatabase('marketing_stream_sqs');
    const [fixture] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('marketing-stream-sqs', ${USER}, 'owner')
    `;
    if (!fixture) throw new Error('fixture did not return tenant scope');
    orgId = fixture.seed_tenant_fixture;
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId} limit 1
    `;
    if (!profile) throw new Error('fixture did not return a profile');
    profileId = profile.id;
    await database.sql`
      update public.ad_profiles
         set timezone = 'America/New_York', currency_code = 'USD'
       where org_id = ${orgId} and id = ${profileId}
    `;
    const strategy = {
      schema: 'wizard-ads.tenant-strategy.v1',
      pacing: {},
      opt_groups: {},
      rank_lifecycle: {},
      staged_apply: {},
      bids: {},
      sv_bands: {},
      caps: {},
      pat_split: {},
      naming: {},
      dayparting: {
        settling_window_hours: 8,
        budget_capped_at_percent: 85,
      },
    };
    await database.sql`
      update public.profile_strategy
         set doc = ${JSON.stringify(strategy)}::text::jsonb
       where org_id = ${orgId} and profile_id is null
    `;
    await database.sql`
      insert into public.profile_strategy
        (org_id, profile_id, schema_version, doc, source)
      values (
        ${orgId}, ${profileId}, 'wizard-ads.tenant-strategy.v1',
        ${JSON.stringify({ dayparting: { settling_window_hours: 12 } })}::text::jsonb,
        'synthetic-test'
      )
      on conflict (org_id, profile_id)
      do update set doc = excluded.doc
    `;
    await database.sql`delete from public.marketing_stream_hourly_facts where profile_id = ${profileId}`;
    await database.sql`delete from public.marketing_stream_events where profile_id = ${profileId}`;
  }, 60_000);

  afterAll(async () => { await database?.drop(); }, 30_000);

  it('loads profile identity and layered tenant policy without defaults', async () => {
    const loader = new DbMarketingStreamRuntimeContextLoader(database);
    await expect(loader.load({ orgId, profileId })).resolves.toEqual({
      profileTimeZone: 'America/New_York',
      currencyCode: 'USD',
      settlingWindowHours: 12,
      budgetCappedAtPercent: 85,
    });
  });

  it('acks only after durable counts and keeps revisions correct across redelivery and out-of-order arrival', async () => {
    const queue = new MutableQueue();
    const consumer = createMarketingStreamSqsConsumer({
      handle: database,
      queueUrl: 'https://sqs.example.invalid/synthetic',
      queue,
      logger: { info: () => {}, error: () => {} },
    });

    // Revision 1 arrives before revision 0. The raw ledger keeps both, while
    // the canonical fact must continue to reflect the newest revision.
    queue.messages = [delivery(envelope(orgId, profileId, [
      event(profileId, {
        messageId: 'traffic-one',
        revision: 1,
        payloadHash: 'traffic-revision-one',
        rawPayload: {
          currencyCode: 'USD',
          metrics: [{ campaignId: 'campaign-one', impressions: 100, clicks: 12, cost: 6 }],
        },
      }),
      event(profileId, {
        messageId: 'conversion-one',
        dataset: 'conversion',
        payloadHash: 'conversion-zero',
        rawPayload: {
          currencyCode: 'USD',
          metrics: [{ campaignId: 'campaign-one', purchases: 2, sales: 30 }],
        },
      }),
      event(profileId, {
        messageId: 'budget-one',
        dataset: 'budget_usage',
        payloadHash: 'budget-zero',
        rawPayload: {
          currencyCode: 'USD',
          metrics: [{ campaignId: 'campaign-one', budgetUsagePercent: 90 }],
        },
      }),
    ]))];
    expect(await consumer.pollOnce()).toBe(1);
    expect(queue.deleted).toEqual(['receipt-1']);
    await expect(counts(database, profileId)).resolves.toEqual({ ledger: 3, facts: 1 });
    await expect(fact(database, profileId)).resolves.toMatchObject({
      impressions: 100,
      clicks: 12,
      purchases: 2,
      sales: 30,
      budget_capped: true,
      profile_timezone: 'America/New_York',
    });

    // An older revision arrives later. It is retained for provenance but the
    // latest-revision projection does not regress.
    queue.messages = [delivery(envelope(orgId, profileId, [
      event(profileId, {
        messageId: 'traffic-one',
        revision: 0,
        receivedAt: '2026-08-01T10:04:00.000Z',
        payloadHash: 'traffic-revision-zero',
        rawPayload: {
          currencyCode: 'USD',
          metrics: [{ campaignId: 'campaign-one', impressions: 50, clicks: 2, cost: 1 }],
        },
      }),
    ]), 2)];
    await consumer.pollOnce();
    await expect(counts(database, profileId)).resolves.toEqual({ ledger: 4, facts: 1 });
    await expect(fact(database, profileId)).resolves.toMatchObject({ impressions: 100, clicks: 12 });

    // Redelivery is counted as a duplicate and remains safe to acknowledge.
    await consumer.pollOnce();
    await expect(counts(database, profileId)).resolves.toEqual({ ledger: 4, facts: 1 });
    expect(queue.deleted).toEqual(['receipt-1', 'receipt-2', 'receipt-2']);
  });

  it('runs provider binding through ledger, durable job, projection, and settling transition', async () => {
    await database.sql`delete from public.sync_jobs where profile_id = ${profileId}`;
    await database.sql`delete from public.marketing_stream_projection_blocks where profile_id = ${profileId}`;
    await database.sql`delete from public.marketing_stream_hourly_facts where profile_id = ${profileId}`;
    await database.sql`delete from public.marketing_stream_events where profile_id = ${profileId}`;
    await database.sql`
      update public.ad_profiles
         set timezone = 'UTC', currency_code = 'USD'
       where org_id = ${orgId} and id = ${profileId}
    `;
    const [trafficBinding] = await database.sql<{
      advertiser_id: string;
      marketplace_id: string;
    }[]>`
      select advertiser_id, marketplace_id
        from public.marketing_stream_subscription_bindings
       where org_id = ${orgId} and profile_id = ${profileId}
         and provider_dataset_id = 'sp-traffic'
    `;
    if (!trafficBinding) throw new Error('missing synthetic traffic binding');
    await database.sql`
      insert into public.marketing_stream_subscription_bindings (
        org_id, profile_id, subscription_id, provider_dataset_id,
        advertiser_id, marketplace_id
      ) values (
        ${orgId}, ${profileId}, 'provider-budget-subscription', 'budget-usage',
        ${trafficBinding.advertiser_id}, ${trafficBinding.marketplace_id}
      )
    `;

    let runtimeNow = new Date('2026-08-30T10:20:00.000Z');
    const queue = new MutableQueue();
    const workerStore = new PostgresWorkerStore(database, { info: () => {} });
    const consumer = new MarketingStreamSqsConsumer({
      queueUrl: 'https://sqs.example.invalid/synthetic',
      queue,
      store: new DbMarketingStreamStore(database),
      contexts: new DbMarketingStreamRuntimeContextLoader(database),
      profiles: new DbMarketingStreamProfileScopeResolver(database),
      scheduler: {
        enqueue: ({ orgId: jobOrg, profileId: jobProfile, messageIds, runAt, dedupeKey }) =>
          workerStore.enqueue({
            type: 'marketing_stream.normalize',
            orgId: jobOrg,
            profileId: jobProfile,
            messageIds: [...messageIds],
          }, runAt, dedupeKey),
      },
      now: () => runtimeNow,
      logger: { info: () => {}, error: () => {} },
    });
    const traffic = providerTraffic(trafficBinding.advertiser_id, trafficBinding.marketplace_id);
    const budget = providerBudget(trafficBinding.advertiser_id, trafficBinding.marketplace_id, 88, '10:10');
    queue.messages = [providerDelivery(traffic, 10), providerDelivery(budget, 11)];
    await expect(consumer.pollOnce()).resolves.toBe(2);
    expect(queue.deleted).toEqual(['provider-receipt-10', 'provider-receipt-11']);
    await expect(providerCounts(database, profileId)).resolves.toEqual({ ledger: 2, facts: 0, jobs: 1 });

    // Exact provider redelivery is identity-stable and cannot add ledger or job rows.
    runtimeNow = new Date('2026-08-30T10:21:00.000Z');
    queue.messages = [providerDelivery(traffic, 12), providerDelivery(budget, 13)];
    await consumer.pollOnce();
    await expect(providerCounts(database, profileId)).resolves.toEqual({ ledger: 2, facts: 0, jobs: 1 });

    // A later lower budget observation has no provider idempotency key, but its
    // immutable observation identity is distinct and the latest value wins.
    runtimeNow = new Date('2026-08-30T10:40:00.000Z');
    queue.messages = [providerDelivery(
      providerBudget(trafficBinding.advertiser_id, trafficBinding.marketplace_id, 63, '10:31'),
      14,
    )];
    await consumer.pollOnce();
    await expect(providerCounts(database, profileId)).resolves.toEqual({ ledger: 3, facts: 0, jobs: 2 });

    let normalizationNow = new Date('2026-08-30T10:40:00.000Z');
    const handler = createMarketingStreamNormalizeHandler({
      handle: database,
      queue: workerStore,
      now: () => normalizationNow,
    });
    const normalJobs = await database.sql<{ payload: MarketingStreamNormalizeJob }[]>`
      select payload
        from public.sync_jobs
       where profile_id = ${profileId} and job_type = 'marketing_stream.normalize'
       order by created_at
    `;
    expect(normalJobs).toHaveLength(2);
    for (const row of normalJobs) {
      await expect(handler(row.payload)).resolves.toMatchObject({
        sourceRows: 3,
        refusedRows: 0,
        replacedScopes: 1,
        insertedFacts: 1,
        readBackFacts: 1,
        transitionScheduled: true,
      });
    }
    await expect(providerCounts(database, profileId)).resolves.toEqual({ ledger: 3, facts: 1, jobs: 3 });
    await expect(providerFact(database, profileId)).resolves.toMatchObject({
      impressions: 20,
      clicks: 4,
      budget_usage_percent: 63,
      budget_capped: false,
      settling_state: 'settling',
      source_events: 3,
    });

    const [transition] = await database.sql<{
      payload: MarketingStreamNormalizeJob;
      run_after: Date | string;
    }[]>`
      select payload, run_after
        from public.sync_jobs
       where profile_id = ${profileId}
         and dedupe_key like 'marketing-stream:transition:%'
    `;
    if (!transition) throw new Error('missing synthetic settling transition');
    normalizationNow = new Date(new Date(transition.run_after).getTime() + 1_000);
    await expect(handler(transition.payload)).resolves.toMatchObject({
      sourceRows: 3,
      insertedFacts: 1,
      transitionScheduled: false,
    });
    await expect(providerFact(database, profileId)).resolves.toMatchObject({ settling_state: 'settled' });
    expect(consumer.status()).toMatchObject({
      rawRowsInserted: 3,
      rawRowsDuplicated: 2,
      normalizeJobsOffered: 3,
      normalizeJobsCreated: 2,
      normalizeJobsAlreadyPresent: 1,
      failed: 0,
    });
  });

  it('revives a dead operator recovery job and drains 256 then remaining durable scopes', async () => {
    await database.sql`delete from public.sync_jobs where profile_id = ${profileId}`;
    await database.sql`delete from public.marketing_stream_projection_blocks where profile_id = ${profileId}`;
    await database.sql`delete from public.marketing_stream_hourly_facts where profile_id = ${profileId}`;
    await database.sql`delete from public.marketing_stream_events where profile_id = ${profileId}`;

    const events = Array.from({ length: 300 }, (_, index): MarketingStreamLedgerEvent => {
      const eventTime = new Date(Date.UTC(2026, 0, 1, index)).toISOString();
      return event(profileId, {
        messageId: `recovery-message-${index}`,
        eventTime,
        receivedAt: new Date(new Date(eventTime).getTime() + 60_000).toISOString(),
        payloadHash: `recovery-hash-${index}`,
        rawPayload: {
          currencyCode: 'USD',
          metrics: [{ campaignId: 'recovery-campaign', impressions: 1, clicks: 0, cost: 0 }],
        },
      });
    });
    const streamStore = new DbMarketingStreamStore(database);
    await expect(streamStore.append({ orgId, profileId, events })).resolves.toMatchObject({
      offeredMessages: 300,
      insertedMessages: 300,
      duplicateMessages: 0,
      revisedMessages: 0,
    });
    const scopes = events.map((item) => ({ adProduct: item.adProduct, utcHour: item.eventTime }));
    const block = await markMarketingStreamProjectionBlocked(database, {
      orgId,
      profileId,
      scopes,
      blockedAt: new Date('2026-08-30T11:00:00.000Z'),
      retryAttempt: 24,
      retryLimit: 24,
      reason: 'synthetic missing-policy recovery',
    });
    expect(block).toMatchObject({ pendingScopeCount: 300, alertState: 'alerted' });
    expect(block.scopes).toHaveLength(256);

    const created = await requeueMarketingStreamBlockedProfile({
      handle: database, orgId, profileId, runAt: new Date('2026-08-30T11:01:00.000Z'),
    });
    expect(created).toMatchObject({ action: 'created', pendingScopes: 300 });
    await database.sql`
      update public.sync_jobs
         set status = 'dead', attempts = 9, finished_at = now(), last_error = 'synthetic dead recovery'
       where id = ${created.jobId}
    `;
    const revived = await requeueMarketingStreamBlockedProfile({
      handle: database, orgId, profileId, runAt: new Date('2026-08-30T11:02:00.000Z'),
    });
    expect(revived).toMatchObject({
      action: 'revived', jobId: created.jobId, blockToken: created.blockToken, pendingScopes: 300,
    });
    const [revivedJob] = await database.sql<{
      payload: MarketingStreamNormalizeJob;
      status: string;
      attempts: number;
      last_error: string | null;
    }[]>`
      select payload, status::text as status, attempts, last_error
        from public.sync_jobs where id = ${created.jobId}
    `;
    expect(revivedJob).toMatchObject({ status: 'queued', attempts: 0, last_error: null });

    const workerStore = new PostgresWorkerStore(database, { info: () => {} });
    const handler = createMarketingStreamNormalizeHandler({
      handle: database,
      queue: workerStore,
      now: () => new Date('2026-08-30T11:03:00.000Z'),
    });
    await expect(handler(revivedJob!.payload)).resolves.toMatchObject({
      recoveredBlockedScopes: 256,
      remainingBlockedScopes: 44,
      recoveryCreated: true,
      insertedFacts: 256,
      readBackFacts: 256,
    });
    const [continuation] = await database.sql<{ payload: MarketingStreamNormalizeJob }[]>`
      select payload from public.sync_jobs
       where profile_id = ${profileId} and dedupe_key like '%:44'
    `;
    if (!continuation) throw new Error('missing recovery continuation');
    await expect(handler(continuation.payload)).resolves.toMatchObject({
      recoveredBlockedScopes: 44,
      remainingBlockedScopes: 0,
      blockedProjectionCleared: true,
      recoveryCreated: false,
      insertedFacts: 44,
      readBackFacts: 44,
    });
    const [counts] = await database.sql<{ facts: number; pending: number; blocks: number }[]>`
      select
        (select count(*)::int from public.marketing_stream_hourly_facts where profile_id = ${profileId}) as facts,
        (select count(*)::int from public.marketing_stream_projection_block_scopes where profile_id = ${profileId}) as pending,
        (select count(*)::int from public.marketing_stream_projection_blocks where profile_id = ${profileId}) as blocks
    `;
    expect(counts).toEqual({ facts: 300, pending: 0, blocks: 0 });
  });
});

class MutableQueue implements MarketingStreamQueueClient {
  messages: MarketingStreamQueueMessage[] = [];
  deleted: string[] = [];
  async receive(): Promise<MarketingStreamQueueMessage[]> { return this.messages; }
  async delete(_queueUrl: string, receiptHandle: string): Promise<void> { this.deleted.push(receiptHandle); }
  destroy(): void {}
}

function envelope(
  orgId: string,
  profileId: string,
  events: MarketingStreamLedgerEvent[],
): MarketingStreamBatchEnvelope {
  return {
    schema: 'wizard-ads.marketing-stream-batch.v1',
    orgId,
    profileId,
    events,
  };
}

function event(
  profileId: string,
  overrides: Partial<MarketingStreamLedgerEvent>,
): MarketingStreamLedgerEvent {
  return {
    profileId,
    messageId: 'message-one',
    dataset: 'traffic',
    adProduct: 'SP',
    eventTime: '2026-08-01T10:00:00.000Z',
    receivedAt: '2026-08-01T10:05:00.000Z',
    revision: 0,
    payloadHash: 'synthetic-hash',
    rawPayload: { metrics: [] },
    ...overrides,
  };
}

function delivery(value: MarketingStreamBatchEnvelope, index = 1): MarketingStreamQueueMessage {
  return {
    messageId: `sqs-${index}`,
    receiptHandle: `receipt-${index}`,
    body: JSON.stringify(value),
    approximateReceiveCount: index,
  };
}

async function counts(database: TestDatabase, profileId: string) {
  const [row] = await database.sql<{ ledger: number; facts: number }[]>`
    select
      (select count(*)::int from public.marketing_stream_events where profile_id = ${profileId}) as ledger,
      (select count(*)::int from public.marketing_stream_hourly_facts where profile_id = ${profileId}) as facts
  `;
  return row;
}

async function fact(database: TestDatabase, profileId: string) {
  const [row] = await database.sql<{
    impressions: number;
    clicks: number;
    purchases: number;
    sales: number;
    budget_capped: boolean;
    profile_timezone: string;
  }[]>`
    select impressions::int, clicks::int, purchases::int, sales::float8,
           budget_capped, profile_timezone
      from public.marketing_stream_hourly_facts
     where profile_id = ${profileId}
  `;
  return row;
}

function providerTraffic(advertiserId: string, marketplaceId: string): Record<string, unknown> {
  return {
    idempotency_id: 'provider-native-traffic-one',
    dataset_id: 'sp-traffic',
    marketplace_id: marketplaceId,
    currency: 'USD',
    advertiser_id: advertiserId,
    campaign_id: 'provider-campaign-one',
    ad_group_id: 'provider-ad-group-one',
    ad_id: 'provider-ad-one',
    time_window_start: '2026-08-30T10:00:00Z',
    clicks: 4,
    impressions: 20,
    cost: 7.5,
  };
}

function providerBudget(
  advertiserId: string,
  marketplaceId: string,
  usage: number,
  minute: string,
): Record<string, unknown> {
  return {
    dataset_id: 'budget-usage',
    marketplace_id: marketplaceId,
    advertiser_id: advertiserId,
    budget_scope_id: 'provider-campaign-one',
    budget_scope_type: 'CAMPAIGN',
    advertising_product_type: 'sp',
    budget: 100,
    budget_usage_percentage: usage,
    usage_updated_timestamp: `2026-08-30T${minute}:00Z`,
  };
}

function providerDelivery(value: Record<string, unknown>, index: number): MarketingStreamQueueMessage {
  return {
    messageId: `provider-sqs-${index}`,
    receiptHandle: `provider-receipt-${index}`,
    body: JSON.stringify({ Type: 'Notification', Message: JSON.stringify(value) }),
    approximateReceiveCount: 1,
  };
}

async function providerCounts(database: TestDatabase, profileId: string) {
  const [row] = await database.sql<{ ledger: number; facts: number; jobs: number }[]>`
    select
      (select count(*)::int from public.marketing_stream_events where profile_id = ${profileId}) as ledger,
      (select count(*)::int from public.marketing_stream_hourly_facts where profile_id = ${profileId}) as facts,
      (select count(*)::int from public.sync_jobs where profile_id = ${profileId}) as jobs
  `;
  return row;
}

async function providerFact(database: TestDatabase, profileId: string) {
  const [row] = await database.sql<{
    impressions: number;
    clicks: number;
    budget_usage_percent: number;
    budget_capped: boolean;
    settling_state: string;
    source_events: number;
  }[]>`
    select impressions::int, clicks::int, budget_usage_percent::float8,
           budget_capped, settling_state::text, source_events::int
      from public.marketing_stream_hourly_facts
     where profile_id = ${profileId} and campaign_id = 'provider-campaign-one'
  `;
  return row;
}
