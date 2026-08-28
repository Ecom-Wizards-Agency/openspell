import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  DaypartingScheduleProposal,
  MarketingStreamHourlyFact,
  MarketingStreamLedgerEvent,
} from '@wizard-ads/shared';
import type { DbHandle } from '../client.js';
import { createTestDatabase, databaseAvailable } from '../testing/harness.js';
import type { TestDatabase } from '../testing/harness.js';
import {
  StaleMarketingStreamProjection,
  appendMarketingStreamEvents,
  marketingStreamScopeKey,
  persistDaypartingScheduleProposal,
  readMarketingStreamHourlyFacts,
  replaceMarketingStreamHourlyFacts,
  snapshotLatestMarketingStreamEvents,
} from './dayparting.js';

const available = await databaseAvailable();
const OWNER = '74747474-7474-4474-8474-747474747474';

describe('WP-62 projection validation without a database', () => {
  const unusable = {
    get sql(): never {
      throw new Error('validation touched the database');
    },
  } as unknown as DbHandle;

  it('refuses a fact that cites more source events than its scope snapshot', async () => {
    const scope = { adProduct: 'SP' as const, utcHour: '2026-06-01T10:00:00.000Z' };
    await expect(replaceMarketingStreamHourlyFacts(unusable, {
      orgId: '76767676-7676-4676-8676-767676767676',
      profileId: '77777777-7777-4777-8777-777777777777',
      scopes: [scope],
      expectedSourceEventIds: { [marketingStreamScopeKey(scope)]: ['event-one'] },
      facts: [hourlyFact('77777777-7777-4777-8777-777777777777', { sourceEvents: 2 })],
    })).rejects.toThrow(/cites 2 source events/);
  });
});

describe.skipIf(!available)('WP-62 Marketing Stream persistence', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  const firstHour = '2026-06-01T10:00:00.000Z';
  const secondHour = '2026-06-01T11:00:00.000Z';

  beforeAll(async () => {
    database = await createTestDatabase('wp62_dayparting');
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('dayparting-alpha', ${OWNER}, 'owner')
    `;
    orgId = org?.seed_tenant_fixture ?? '';
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId} limit 1
    `;
    profileId = profile?.id ?? '';
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('deduplicates redelivery, retains out-of-order revisions, and verifies canonical counts', async () => {
    const initial = [
      streamEvent(profileId, 'traffic-one', 'traffic', { impressions: 100, clicks: 10, cost: 5 }),
      streamEvent(profileId, 'conversion-one', 'conversion', { purchases: 2, sales: 20 }),
      streamEvent(profileId, 'budget-one', 'budget_usage', { budgetUsagePercent: 95 }),
    ];
    const appended = await appendMarketingStreamEvents(database, { orgId, profileId, events: initial });
    expect(appended).toMatchObject({
      offeredMessages: 3,
      insertedMessages: 3,
      duplicateMessages: 0,
      revisedMessages: 0,
    });
    expect(appended.affectedScopes).toEqual([{ adProduct: 'SP', utcHour: firstHour }]);

    const redelivery = await appendMarketingStreamEvents(database, { orgId, profileId, events: initial });
    expect(redelivery).toMatchObject({
      offeredMessages: 3,
      insertedMessages: 0,
      duplicateMessages: 3,
      revisedMessages: 0,
    });

    const scope = appended.affectedScopes[0]!;
    const original = await snapshotLatestMarketingStreamEvents(database, { orgId, profileId, scopes: [scope] });
    expect(original.events).toHaveLength(3);
    expect(original.sourceEventIds[marketingStreamScopeKey(scope)]).toHaveLength(3);

    const firstProjection = await replaceMarketingStreamHourlyFacts(database, {
      orgId,
      profileId,
      scopes: [scope],
      expectedSourceEventIds: original.sourceEventIds,
      facts: [hourlyFact(profileId, { sourceEvents: 3 })],
    });
    expect(firstProjection).toEqual({
      scopesReplaced: 1,
      factsDeleted: 0,
      factsInserted: 1,
      factsReadBack: 1,
    });

    const revisionTwo = streamEvent(profileId, 'conversion-one', 'conversion', { purchases: 3, sales: 30 }, {
      revision: 2,
      payloadHash: 'conversion-revision-two',
      receivedAt: '2026-06-03T00:00:00.000Z',
    });
    expect(await appendMarketingStreamEvents(database, { orgId, profileId, events: [revisionTwo] }))
      .toMatchObject({ insertedMessages: 1, revisedMessages: 1, duplicateMessages: 0 });

    await expect(replaceMarketingStreamHourlyFacts(database, {
      orgId,
      profileId,
      scopes: [scope],
      expectedSourceEventIds: original.sourceEventIds,
      facts: [hourlyFact(profileId, { sourceEvents: 3 })],
    })).rejects.toBeInstanceOf(StaleMarketingStreamProjection);

    const revisionOne = streamEvent(profileId, 'conversion-one', 'conversion', { purchases: 1, sales: 10 }, {
      revision: 1,
      payloadHash: 'conversion-revision-one',
      receivedAt: '2026-06-02T00:00:00.000Z',
    });
    expect(await appendMarketingStreamEvents(database, { orgId, profileId, events: [revisionOne] }))
      .toMatchObject({ insertedMessages: 1, revisedMessages: 1 });
    const latest = await snapshotLatestMarketingStreamEvents(database, { orgId, profileId, scopes: [scope] });
    expect(latest.events.find((event) => event.messageId === 'conversion-one')?.revision).toBe(2);

    const revisedProjection = await replaceMarketingStreamHourlyFacts(database, {
      orgId,
      profileId,
      scopes: [scope],
      expectedSourceEventIds: latest.sourceEventIds,
      facts: [hourlyFact(profileId, { purchases: 3, sales: 30, settlingState: 'revised', sourceEvents: 3 })],
    });
    expect(revisedProjection).toMatchObject({ factsDeleted: 1, factsInserted: 1, factsReadBack: 1 });
    expect(await readMarketingStreamHourlyFacts(database, { orgId, profileId, campaignId: 'campaign-one' }))
      .toEqual([hourlyFact(profileId, { purchases: 3, sales: 30, settlingState: 'revised', sourceEvents: 3 })]);
  });

  it('recomputes both old and new scopes when a latest revision moves hours', async () => {
    const moved = streamEvent(profileId, 'conversion-one', 'conversion', { purchases: 4, sales: 40 }, {
      eventTime: secondHour,
      receivedAt: '2026-06-03T01:00:00.000Z',
      revision: 3,
      payloadHash: 'conversion-revision-three',
    });
    const append = await appendMarketingStreamEvents(database, { orgId, profileId, events: [moved] });
    expect(append.affectedScopes).toEqual([
      { adProduct: 'SP', utcHour: firstHour },
      { adProduct: 'SP', utcHour: secondHour },
    ]);
    const current = await snapshotLatestMarketingStreamEvents(database, {
      orgId,
      profileId,
      scopes: append.affectedScopes,
    });
    expect(current.events.filter((event) => event.eventTime === firstHour).map((event) => event.messageId).sort())
      .toEqual(['budget-one', 'traffic-one']);
    expect(current.events.filter((event) => event.eventTime === secondHour).map((event) => event.messageId))
      .toEqual(['conversion-one']);

    const oldScope = append.affectedScopes[0]!;
    const newScope = append.affectedScopes[1]!;
    const replaced = await replaceMarketingStreamHourlyFacts(database, {
      orgId,
      profileId,
      scopes: append.affectedScopes,
      expectedSourceEventIds: current.sourceEventIds,
      facts: [
        hourlyFact(profileId, { utcHour: firstHour, purchases: 0, sales: 0, sourceEvents: 2 }),
        hourlyFact(profileId, {
          utcHour: secondHour,
          localHour: 11,
          impressions: 0,
          clicks: 0,
          cost: 0,
          purchases: 4,
          sales: 40,
          sourceEvents: 1,
        }),
      ],
    });
    expect(replaced).toMatchObject({ scopesReplaced: 2, factsDeleted: 1, factsInserted: 2, factsReadBack: 2 });
    expect(current.sourceEventIds[marketingStreamScopeKey(oldScope)]).toHaveLength(2);
    expect(current.sourceEventIds[marketingStreamScopeKey(newScope)]).toHaveLength(1);
  });

  it('persists a deterministic review-only proposal idempotently and scopes reads by tenant', async () => {
    const proposal: DaypartingScheduleProposal = {
      id: '75757575-7575-4575-8575-757575757575',
      profileId,
      campaignId: 'campaign-one',
      baselineLabel: 'Synthetic approved baseline',
      evidenceStart: '2026-06-01',
      evidenceEnd: '2026-06-07',
      settledHours: 24,
      blocks: [{ dayOfWeek: 1, startHour: 8, endHour: 10, adjustmentPercent: 10, confidence: 0.75 }],
      status: 'proposed',
    };
    expect(await persistDaypartingScheduleProposal(database, { orgId, proposal }))
      .toMatchObject({ status: 'inserted', proposal });
    expect(await persistDaypartingScheduleProposal(database, { orgId, proposal }))
      .toMatchObject({ status: 'already_present', proposal });
    expect(await readMarketingStreamHourlyFacts(database, {
      orgId: '00000000-0000-4000-8000-000000000000',
      profileId,
    })).toEqual([]);
  });
});

function streamEvent(
  profileId: string,
  messageId: string,
  dataset: MarketingStreamLedgerEvent['dataset'],
  metrics: Record<string, unknown>,
  overrides: Partial<MarketingStreamLedgerEvent> = {},
): MarketingStreamLedgerEvent {
  return {
    profileId,
    messageId,
    dataset,
    adProduct: 'SP',
    eventTime: '2026-06-01T10:00:00.000Z',
    receivedAt: '2026-06-01T10:05:00.000Z',
    revision: 0,
    payloadHash: `${messageId}-revision-zero`,
    rawPayload: { currencyCode: 'USD', metrics: [{ campaignId: 'campaign-one', ...metrics }] },
    ...overrides,
  };
}

function hourlyFact(
  profileId: string,
  overrides: Partial<MarketingStreamHourlyFact> = {},
): MarketingStreamHourlyFact {
  return {
    profileId,
    adProduct: 'SP',
    campaignId: 'campaign-one',
    utcHour: '2026-06-01T10:00:00.000Z',
    profileTimeZone: 'UTC',
    localDate: '2026-06-01',
    localHour: 10,
    localDayOfWeek: 1,
    currencyCode: 'USD',
    impressions: 100,
    clicks: 10,
    cost: 5,
    purchases: 2,
    sales: 20,
    budgetUsagePercent: 95,
    budgetCapped: true,
    settlingState: 'settled',
    sourceEvents: 3,
    ...overrides,
  };
}
