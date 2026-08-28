import { describe, expect, it } from 'vitest';
import type {
  MarketingStreamHourlyFact,
  MarketingStreamLedgerEvent,
} from '@wizard-ads/shared';
import type { MarketingStreamSnapshot, StoredMarketingStreamEvent } from '@wizard-ads/db';
import {
  exportDaypartingSchedule,
  mergeAdjacentDaypartingBlocks,
  normalizeMarketingStreamSnapshot,
  processMarketingStreamBatch,
  proposeDaypartingSchedule,
  type MarketingStreamStore,
} from './dayparting.js';

const PROFILE = '71717171-7171-4171-8171-717171717171';
const ORG = '72727272-7272-4272-8272-727272727272';

describe('Marketing Stream normalization', () => {
  it('normalizes SP, SB and SD traffic, conversion and budget events with countable sources', () => {
    const events: StoredMarketingStreamEvent[] = [];
    for (const [productIndex, adProduct] of (['SP', 'SB', 'SD'] as const).entries()) {
      const campaignId = `campaign-${adProduct.toLowerCase()}`;
      events.push(
        storedEvent(events.length, {
          messageId: `${adProduct}-traffic`,
          dataset: 'traffic',
          adProduct,
          rawPayload: { currencyCode: 'USD', metrics: [{ campaignId, impressions: 100, clicks: 10, cost: 5 }] },
        }),
        storedEvent(events.length + 1, {
          messageId: `${adProduct}-conversion`,
          dataset: 'conversion',
          adProduct,
          rawPayload: { currencyCode: 'USD', metrics: [{ campaignId, purchases: productIndex + 1, sales: 20 }] },
        }),
        storedEvent(events.length + 2, {
          messageId: `${adProduct}-budget`,
          dataset: 'budget_usage',
          adProduct,
          rawPayload: { currencyCode: 'USD', metrics: [{ campaignId, budgetUsagePercent: 95 }] },
        }),
      );
    }
    const scopes = (['SP', 'SB', 'SD'] as const).map((adProduct) => ({
      adProduct,
      utcHour: '2026-08-01T10:00:00.000Z',
    }));
    const normalized = normalizeMarketingStreamSnapshot(snapshot(scopes, events), {
      profileTimeZone: 'America/Los_Angeles',
      currencyCode: 'USD',
      settlingWindowHours: 48,
      budgetCappedAtPercent: 90,
      now: new Date('2026-08-10T00:00:00Z'),
    });
    expect(normalized.refusals).toEqual([]);
    expect(normalized.facts).toHaveLength(3);
    expect(normalized.facts.map((fact) => fact.adProduct)).toEqual(['SP', 'SB', 'SD']);
    expect(normalized.facts.every((fact) => fact.sourceEvents === 3)).toBe(true);
    expect(normalized.facts.every((fact) => fact.budgetCapped)).toBe(true);
    expect(normalized.facts.every((fact) => fact.settlingState === 'settled')).toBe(true);
    expect(normalized.facts.find((fact) => fact.adProduct === 'SD')).toMatchObject({
      impressions: 100,
      clicks: 10,
      cost: 5,
      purchases: 3,
      sales: 20,
      budgetUsagePercent: 95,
      localDate: '2026-08-01',
      localHour: 3,
      localDayOfWeek: 6,
    });
  });

  it('retains both UTC hours across the DST fall-back while deriving the repeated local hour', () => {
    const scopes = [
      { adProduct: 'SP' as const, utcHour: '2026-11-01T05:00:00.000Z' },
      { adProduct: 'SP' as const, utcHour: '2026-11-01T06:00:00.000Z' },
    ];
    const events = scopes.map((scope, index) => storedEvent(index, {
      messageId: `dst-${index}`,
      eventTime: scope.utcHour,
      rawPayload: { metrics: [{ campaignId: 'campaign-dst', impressions: 10, clicks: 1, cost: 1 }] },
    }));
    const normalized = normalizeMarketingStreamSnapshot(snapshot(scopes, events), {
      profileTimeZone: 'America/New_York',
      currencyCode: 'USD',
      settlingWindowHours: 1,
      budgetCappedAtPercent: 100,
      now: new Date('2026-11-03T00:00:00Z'),
    });
    expect(normalized.facts.map((fact) => fact.utcHour)).toEqual(scopes.map((scope) => scope.utcHour));
    expect(normalized.facts.map((fact) => [fact.localDate, fact.localHour, fact.localDayOfWeek])).toEqual([
      ['2026-11-01', 1, 0],
      ['2026-11-01', 1, 0],
    ]);
  });

  it('marks recent hours settling and old, newly revised hours revised', () => {
    const scopes = [
      { adProduct: 'SP' as const, utcHour: '2026-08-19T23:00:00.000Z' },
      { adProduct: 'SP' as const, utcHour: '2026-08-01T10:00:00.000Z' },
    ];
    const events = [
      storedEvent(0, { messageId: 'recent', eventTime: scopes[0]!.utcHour }),
      storedEvent(1, {
        messageId: 'revised',
        eventTime: scopes[1]!.utcHour,
        receivedAt: '2026-08-19T23:30:00Z',
        revision: 2,
      }),
    ];
    const normalized = normalizeMarketingStreamSnapshot(snapshot(scopes, events), {
      profileTimeZone: 'UTC',
      currencyCode: 'USD',
      settlingWindowHours: 48,
      budgetCappedAtPercent: 100,
      now: new Date('2026-08-20T00:00:00Z'),
    });
    expect(normalized.facts.map((fact) => fact.settlingState)).toEqual(['settling', 'revised']);
  });

  it('refuses an unknown payload without deleting the contaminated scope', () => {
    const scopes = [
      { adProduct: 'SP' as const, utcHour: '2026-08-01T10:00:00.000Z' },
      { adProduct: 'SB' as const, utcHour: '2026-08-01T10:00:00.000Z' },
    ];
    const normalized = normalizeMarketingStreamSnapshot(snapshot(scopes, [
      storedEvent(0, { messageId: 'good' }),
      storedEvent(1, { messageId: 'unknown', adProduct: 'SB', rawPayload: { rows: [] } }),
    ]), {
      profileTimeZone: 'UTC',
      currencyCode: 'USD',
      settlingWindowHours: 1,
      budgetCappedAtPercent: 100,
      now: new Date('2026-08-10T00:00:00Z'),
    });
    expect(normalized.refusals).toHaveLength(1);
    expect(normalized.scopes).toEqual([scopes[0]]);
    expect(normalized.facts).toHaveLength(1);
  });

  it('counts invalid ledger messages and verifies normalized writes', async () => {
    const scope = { adProduct: 'SP' as const, utcHour: '2026-08-01T10:00:00.000Z' };
    const event = ledgerEvent();
    const calls: string[] = [];
    const store: MarketingStreamStore = {
      append: async ({ events }) => {
        calls.push('append');
        expect(events).toHaveLength(1);
        return { offeredMessages: 1, insertedMessages: 1, duplicateMessages: 0, revisedMessages: 0, affectedScopes: [scope] };
      },
      snapshot: async () => (calls.push('snapshot'), snapshot([scope], [storedEvent(0)])),
      replace: async ({ facts }) => (calls.push('replace'), {
        scopesReplaced: 1,
        factsDeleted: 0,
        factsInserted: facts.length,
        factsReadBack: facts.length,
      }),
      persistProposal: async ({ proposal }) => ({ status: 'inserted', proposal }),
    };
    const result = await processMarketingStreamBatch(store, {
      orgId: ORG,
      profileId: PROFILE,
      events: [event, { bad: true }],
      policy: {
        profileTimeZone: 'UTC',
        currencyCode: 'USD',
        settlingWindowHours: 1,
        budgetCappedAtPercent: 100,
        now: new Date('2026-08-10T00:00:00Z'),
      },
    });
    expect(calls).toEqual(['append', 'snapshot', 'replace']);
    expect(result.counts).toEqual({
      receivedMessages: 2,
      duplicateMessages: 0,
      revisedMessages: 0,
      refusedMessages: 1,
      normalizedRows: 1,
    });
    expect(result.refusals[0]).toMatchObject({ index: 1, messageId: null });
  });
});

describe('dayparting proposals', () => {
  it('shrinks against the explicit baseline, excludes unsettled hours, and merges adjacent blocks', () => {
    const facts = [
      hourlyFact({ utcHour: '2026-08-03T08:00:00Z', localHour: 8, clicks: 20, purchases: 4 }),
      hourlyFact({ utcHour: '2026-08-03T09:00:00Z', localHour: 9, clicks: 20, purchases: 4 }),
      hourlyFact({ utcHour: '2026-08-03T10:00:00Z', localHour: 10, clicks: 20, purchases: 0 }),
      hourlyFact({
        utcHour: '2026-08-03T11:00:00Z',
        localHour: 11,
        clicks: 20,
        purchases: 4,
        settlingState: 'settling',
      }),
    ];
    const proposal = proposeDaypartingSchedule(facts, {
      baselineLabel: 'Approved campaign baseline',
      metric: 'conversion_rate',
      baselineValue: 0.1,
      priorWeight: 10,
      minimumCellWeight: 10,
      minimumAdjustmentPercent: -50,
      maximumAdjustmentPercent: 50,
      adjustmentStepPercent: 10,
    });
    expect(proposal.settledHours).toBe(3);
    expect(proposal.blocks).toEqual([
      { dayOfWeek: 1, startHour: 8, endHour: 10, adjustmentPercent: 50, confidence: 0.666667 },
      { dayOfWeek: 1, startHour: 10, endHour: 11, adjustmentPercent: -50, confidence: 0.666667 },
    ]);
  });

  it('uses the lower confidence when equivalent adjacent hours merge', () => {
    expect(mergeAdjacentDaypartingBlocks([
      { dayOfWeek: 2, startHour: 4, endHour: 5, adjustmentPercent: 20, confidence: 0.8 },
      { dayOfWeek: 2, startHour: 5, endHour: 6, adjustmentPercent: 20, confidence: 0.6 },
    ])).toEqual([
      { dayOfWeek: 2, startHour: 4, endHour: 6, adjustmentPercent: 20, confidence: 0.6 },
    ]);
  });

  it('exports the shared proposal contract as review-only JSON and CSV', () => {
    const proposal = proposeDaypartingSchedule([
      hourlyFact({ utcHour: '2026-08-03T08:00:00Z', localHour: 8, clicks: 20, purchases: 4 }),
    ], {
      baselineLabel: 'Baseline, reviewed',
      metric: 'conversion_rate',
      baselineValue: 0.1,
      priorWeight: 10,
      minimumCellWeight: 1,
      minimumAdjustmentPercent: -50,
      maximumAdjustmentPercent: 50,
      adjustmentStepPercent: 10,
    });
    const exported = exportDaypartingSchedule(proposal);
    expect(JSON.parse(exported.json)).toEqual(proposal);
    expect(exported.csv.split('\n')).toHaveLength(3);
    expect(exported.csv).toContain('"Baseline, reviewed"');
    expect(exported.csv).not.toMatch(/apply|push|updated amazon/i);
  });
});

function snapshot(
  scopes: MarketingStreamSnapshot['scopes'],
  events: StoredMarketingStreamEvent[],
): MarketingStreamSnapshot {
  return {
    orgId: ORG,
    profileId: PROFILE,
    scopes,
    events,
    sourceEventIds: Object.fromEntries(scopes.map((scope) => [
      `${scope.adProduct}|${scope.utcHour}`,
      events.filter((event) => event.adProduct === scope.adProduct && event.eventTime === scope.utcHour).map((event) => event.id),
    ])),
  };
}

function ledgerEvent(overrides: Partial<MarketingStreamLedgerEvent> = {}): MarketingStreamLedgerEvent {
  return {
    profileId: PROFILE,
    messageId: 'message-one',
    dataset: 'traffic',
    adProduct: 'SP',
    eventTime: '2026-08-01T10:00:00.000Z',
    receivedAt: '2026-08-01T10:05:00.000Z',
    revision: 0,
    payloadHash: 'synthetic-hash',
    rawPayload: { metrics: [{ campaignId: 'campaign-one', impressions: 10, clicks: 1, cost: 1 }] },
    ...overrides,
  };
}

function storedEvent(
  index: number,
  overrides: Partial<MarketingStreamLedgerEvent> = {},
): StoredMarketingStreamEvent {
  return { id: `73737373-7373-4373-8373-${String(index).padStart(12, '0')}`, orgId: ORG, ...ledgerEvent(overrides) };
}

function hourlyFact(overrides: Partial<MarketingStreamHourlyFact> = {}): MarketingStreamHourlyFact {
  return {
    profileId: PROFILE,
    adProduct: 'SP',
    campaignId: 'campaign-one',
    utcHour: '2026-08-03T08:00:00.000Z',
    profileTimeZone: 'UTC',
    localDate: '2026-08-03',
    localHour: 8,
    localDayOfWeek: 1,
    currencyCode: 'USD',
    impressions: 100,
    clicks: 10,
    cost: 5,
    purchases: 1,
    sales: 20,
    budgetUsagePercent: null,
    budgetCapped: false,
    settlingState: 'settled',
    sourceEvents: 2,
    ...overrides,
  };
}
