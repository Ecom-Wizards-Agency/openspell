import {
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from '@wizard-ads/db/testing';
import type { MarketingStreamBatchEnvelope, MarketingStreamLedgerEvent } from '@wizard-ads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMarketingStreamSqsConsumer,
  DbMarketingStreamRuntimeContextLoader,
  type MarketingStreamQueueClient,
  type MarketingStreamQueueMessage,
} from './marketing-stream-sqs.js';

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
