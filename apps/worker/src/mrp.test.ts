import { describe, expect, it } from 'vitest';
import type { NewProductEconomics, ProductEconomicsLoadCounts } from '@wizard-ads/db';
import {
  MrpAuthError,
  MrpToolCallError,
  MrpTransportError,
} from '@wizard-ads/mrp-api';
import type {
  MrpProductMetrics,
  MrpProductMetricsInput,
  MrpSeller,
} from '@wizard-ads/mrp-api';
import type { EconomicsSyncJob } from '@wizard-ads/shared';
import {
  createMrpEconomicsHandler,
  incompleteMrpPeriodReason,
  lastCompleteProfileDay,
  mapMrpProductMetrics,
  marketplaceIdForCountry,
  matchMrpSellersToProfiles,
} from './mrp.js';
import type {
  MrpAsinSelection,
  MrpEconomicsSyncStore,
  MrpSyncProfile,
  MrpSyncScope,
} from './mrp.js';
import { PermanentJobError } from './worker.js';

const ORG_ID = '44444444-4444-4444-8444-444444444444';
const PROFILE_ID = '45454545-4545-4545-8545-454545454545';
const CONNECTION_ID = '46464646-4646-4646-8646-464646464646';
const ENDPOINT = 'https://mrp.example.test/mcp';
const AUTH_VALUE = ['synthetic', 'worker', 'credential'].join('-');
const NOW = new Date('2026-08-27T08:15:00.000Z');
const CAPTURED_ON = '2026-08-26';
const PAYLOAD: EconomicsSyncJob = {
  type: 'economics.sync',
  orgId: ORG_ID,
  profileId: PROFILE_ID,
};

const SELLER: MrpSeller = {
  number: 1,
  name: 'Example Labs',
  sellerId: 123450001,
  sellingPartnerId: 'PARTNER-ONE',
  region: 'North America',
  access: 'owned',
};

function profile(overrides: Partial<MrpSyncProfile> = {}): MrpSyncProfile {
  return {
    id: PROFILE_ID,
    accountName: 'examplelabs',
    region: 'NA',
    countryCode: 'US',
    currencyCode: 'USD',
    timezone: 'UTC',
    syncEnabled: true,
    ...overrides,
  };
}

function metrics(overrides: Partial<MrpProductMetrics> = {}): MrpProductMetrics {
  return {
    product: {
      asin: 'B0TEST4409',
      salePrice: 39.99,
      cogs: 10,
      fbaFees: 5,
      referralFees: 6,
      otherFees: 1,
      margin: 17.99,
      ltvRevenue: null,
      ltvOrders: null,
      repeatRate: null,
      currency: 'USD',
      details: {
        sales: { revenue: 399.9 },
        profitability: { profit: 17.99 },
        advertising: { ppc_spend: 42.5 },
      },
    },
    period: {
      from: CAPTURED_ON,
      to: CAPTURED_ON,
      days: 1,
      complete: true,
      dataAvailableThrough: {
        orders: CAPTURED_ON,
        advertising: CAPTURED_ON,
        traffic: CAPTURED_ON,
      },
      incompleteSources: [],
      note: null,
    },
    ...overrides,
  };
}

class FakeStore implements MrpEconomicsSyncStore {
  resolved: MrpSyncScope | null = {
    connection: {
      id: CONNECTION_ID,
      config: { url: ENDPOINT, max_asins: 2 },
    },
    targetProfile: profile(),
    profiles: [profile()],
  };
  storedSecret: string | null = AUTH_VALUE;
  selection: MrpAsinSelection = {
    asins: ['B0TEST4409', 'B0TEST4410'],
    total: 3,
  };
  advertisedRequests: { orgId: string; profileId: string; limit: number }[] = [];
  loaded: readonly NewProductEconomics[] = [];
  success: {
    orgId: string;
    connectionId: string;
    syncedAt: Date;
    note: string | null;
  } | null = null;
  failures: {
    orgId: string;
    connectionId: string;
    lastError: string;
    disable: boolean;
  }[] = [];

  async scope(): Promise<MrpSyncScope | null> {
    return this.resolved;
  }

  async secret(): Promise<string | null> {
    return this.storedSecret;
  }

  async advertisedAsins(args: {
    orgId: string;
    profileId: string;
    limit: number;
  }): Promise<MrpAsinSelection> {
    this.advertisedRequests.push(args);
    return this.selection;
  }

  async load(rows: readonly NewProductEconomics[]): Promise<ProductEconomicsLoadCounts> {
    this.loaded = rows;
    return { offered: rows.length, written: rows.length };
  }

  async succeeded(args: {
    orgId: string;
    connectionId: string;
    syncedAt: Date;
    note: string | null;
  }): Promise<void> {
    this.success = args;
  }

  async failed(args: {
    orgId: string;
    connectionId: string;
    lastError: string;
    disable: boolean;
  }): Promise<void> {
    this.failures.push(args);
  }
}

describe('MRP seller/profile mapping', () => {
  it('normalizes case/spaces and prefers a sync-enabled profile in the seller region', () => {
    const profiles = [
      profile({ id: 'profile-eu', region: 'EU', countryCode: 'DE', syncEnabled: true }),
      profile({ id: 'profile-na-off', accountName: 'Example Labs', syncEnabled: false }),
      profile({ id: 'profile-na-on', accountName: 'ExampleLabs', syncEnabled: true }),
    ];
    const matches = matchMrpSellersToProfiles([SELLER], profiles, {});
    expect(matches).toEqual([
      expect.objectContaining({ profileId: 'profile-na-on', source: 'name' }),
    ]);
  });

  it('lets config.seller_map override normalized name and region matching', () => {
    const designated = profile({
      id: 'profile-override',
      accountName: 'Different Name',
      region: 'EU',
      countryCode: 'DE',
      syncEnabled: false,
    });
    const matches = matchMrpSellersToProfiles(
      [SELLER],
      [designated],
      { [designated.id]: SELLER.sellerId },
    );
    expect(matches).toEqual([
      expect.objectContaining({
        profileId: designated.id,
        seller: SELLER,
        source: 'config',
      }),
    ]);
    expect(matchMrpSellersToProfiles(
      [SELLER],
      [profile()],
      { [PROFILE_ID]: 999999999 },
    )).toEqual([]);
  });
});

describe('MRP window, marketplace, and row decisions', () => {
  it('uses the last complete profile day and maps major marketplace ids', () => {
    expect(lastCompleteProfileDay('Asia/Bangkok', new Date('2026-08-27T18:00:00Z')))
      .toBe('2026-08-27');
    expect(marketplaceIdForCountry('US')).toBe('ATVPDKIKX0DER');
    expect(marketplaceIdForCountry('gb')).toBe('A1F83G8C2ARO7P');
    expect(marketplaceIdForCountry('JP')).toBe('A1VC38T7YXB528');
    expect(marketplaceIdForCountry('XX')).toBeNull();
  });

  it('rejects provider-marked partial or unloaded periods', () => {
    expect(incompleteMrpPeriodReason(metrics().period, CAPTURED_ON)).toBeNull();
    expect(incompleteMrpPeriodReason({
      ...metrics().period,
      complete: false,
      note: 'Still loading',
    }, CAPTURED_ON)).toBe('Still loading');
    expect(incompleteMrpPeriodReason({
      ...metrics().period,
      dataAvailableThrough: { orders: '2026-08-25', advertising: null },
    }, CAPTURED_ON)).toMatch(/orders=2026-08-25.*advertising=unloaded/);
  });

  it('maps column-compatible economics and preserves raw sales/profit/PPC details', () => {
    const row = mapMrpProductMetrics({
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      capturedOn: CAPTURED_ON,
      loadedAt: NOW,
    }, metrics());
    expect(row).toMatchObject({
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      asin: 'B0TEST4409',
      capturedOn: CAPTURED_ON,
      salePrice: 39.99,
      cogs: 10,
      fbaFees: 5,
      referralFees: 6,
      otherFees: 1,
      margin: 17.99,
      currency: 'USD',
      source: 'mrp',
      details: {
        sales: { revenue: 399.9 },
        profitability: { profit: 17.99 },
        advertising: { ppc_spend: 42.5 },
      },
    });
    expect(row.loadedAt).toBe(NOW);
  });
});

describe('MRP economics.sync handler', () => {
  it('caps enumeration, calls one ASIN at a time, and continues past a product failure', async () => {
    const store = new FakeStore();
    const calls: MrpProductMetricsInput[] = [];
    const handler = createMrpEconomicsHandler(store, {
      now: () => NOW,
      clientFactory: () => ({
        fetchSellers: async () => ({
          toolName: 'get_sellers',
          sellers: [SELLER],
          ignoredLines: 1,
        }),
        fetchProductMetrics: async (input) => {
          calls.push(input);
          if (input.asin === 'B0TEST4410') {
            throw new MrpToolCallError('No metrics available yet');
          }
          return { toolName: 'get_product_metrics', metrics: metrics() };
        },
      }),
    });

    await expect(handler(PAYLOAD)).resolves.toMatchObject({
      provider: 'mrp',
      sellerToolName: 'get_sellers',
      productToolName: 'get_product_metrics',
      profileMatched: true,
      sellerMatchSource: 'name',
      sellerId: SELLER.sellerId,
      marketplaceId: 'ATVPDKIKX0DER',
      asinsAvailable: 3,
      asinsSelected: 2,
      asinsSkippedByCap: 1,
      productCallsSucceeded: 1,
      productsSkippedIncomplete: 0,
      productCallsFailed: 1,
      rowsLoaded: 1,
      capturedOn: CAPTURED_ON,
      notes: [
        expect.stringContaining('skipped by config.max_asins=2'),
        expect.stringContaining('B0TEST4410'),
      ],
    });
    expect(store.advertisedRequests).toEqual([
      { orgId: ORG_ID, profileId: PROFILE_ID, limit: 2 },
    ]);
    expect(calls).toEqual([
      {
        asin: 'B0TEST4409',
        sellerIds: [SELLER.sellerId],
        marketplaceIds: ['ATVPDKIKX0DER'],
        dateFrom: CAPTURED_ON,
        dateTo: CAPTURED_ON,
      },
      {
        asin: 'B0TEST4410',
        sellerIds: [SELLER.sellerId],
        marketplaceIds: ['ATVPDKIKX0DER'],
        dateFrom: CAPTURED_ON,
        dateTo: CAPTURED_ON,
      },
    ]);
    expect(store.loaded).toHaveLength(1);
    expect(store.success).toMatchObject({
      orgId: ORG_ID,
      connectionId: CONNECTION_ID,
      syncedAt: NOW,
      note: expect.stringMatching(/max_asins.*B0TEST4410/),
    });
    expect(store.failures).toEqual([]);
  });

  it('skips a provider-declared partial period without loading a row', async () => {
    const store = new FakeStore();
    store.selection = { asins: ['B0TEST4409'], total: 1 };
    const partial = metrics({
      period: {
        ...metrics().period,
        complete: false,
        note: 'Orders still loading',
      },
    });
    const handler = createMrpEconomicsHandler(store, {
      now: () => NOW,
      clientFactory: () => ({
        fetchSellers: async () => ({
          toolName: 'get_sellers',
          sellers: [SELLER],
          ignoredLines: 0,
        }),
        fetchProductMetrics: async () => ({
          toolName: 'get_product_metrics',
          metrics: partial,
        }),
      }),
    });
    await expect(handler(PAYLOAD)).resolves.toMatchObject({
      productsSkippedIncomplete: 1,
      rowsLoaded: 0,
      notes: [expect.stringMatching(/skipped unloaded period.*Orders still loading/)],
    });
    expect(store.loaded).toEqual([]);
  });

  it('defaults config.max_asins to 25 and records an empty mirror as a skip', async () => {
    const store = new FakeStore();
    if (!store.resolved) throw new Error('test scope missing');
    store.resolved.connection.config = { url: ENDPOINT };
    store.selection = { asins: [], total: 0 };
    const handler = createMrpEconomicsHandler(store, {
      now: () => NOW,
      clientFactory: () => ({
        fetchSellers: async () => ({
          toolName: 'get_sellers',
          sellers: [SELLER],
          ignoredLines: 0,
        }),
        fetchProductMetrics: async () => {
          throw new Error('must not fetch a product');
        },
      }),
    });
    await expect(handler(PAYLOAD)).resolves.toMatchObject({
      asinsAvailable: 0,
      asinsSelected: 0,
      rowsLoaded: 0,
      notes: [expect.stringContaining('no active advertised ASINs')],
    });
    expect(store.advertisedRequests[0]?.limit).toBe(25);
  });

  it('records an unmatched profile note and skips enumeration without failing the job', async () => {
    const store = new FakeStore();
    if (!store.resolved) throw new Error('test scope missing');
    store.resolved.targetProfile = profile({ accountName: 'No Seller' });
    store.resolved.profiles = [store.resolved.targetProfile];
    const handler = createMrpEconomicsHandler(store, {
      now: () => NOW,
      clientFactory: () => ({
        fetchSellers: async () => ({
          toolName: 'get_sellers',
          sellers: [SELLER],
          ignoredLines: 0,
        }),
        fetchProductMetrics: async () => {
          throw new Error('must not fetch a product');
        },
      }),
    });
    await expect(handler(PAYLOAD)).resolves.toMatchObject({
      profileMatched: false,
      asinsSelected: 0,
      rowsLoaded: 0,
      notes: [expect.stringContaining('no MRP seller matched')],
    });
    expect(store.advertisedRequests).toEqual([]);
    expect(store.success?.note).toMatch(/no MRP seller matched/);
  });

  it('fails the whole job on auth and transport failures only', async () => {
    const authStore = new FakeStore();
    const authHandler = createMrpEconomicsHandler(authStore, {
      clientFactory: () => ({
        fetchSellers: async () => {
          throw new MrpAuthError('rejected', 401);
        },
        fetchProductMetrics: async () => {
          throw new Error('must not fetch a product');
        },
      }),
    });
    await expect(authHandler(PAYLOAD)).rejects.toBeInstanceOf(PermanentJobError);
    expect(authStore.failures[0]).toMatchObject({ disable: true });

    const transportStore = new FakeStore();
    transportStore.selection = { asins: ['B0TEST4409'], total: 1 };
    const transport = new MrpTransportError('offline');
    const transportHandler = createMrpEconomicsHandler(transportStore, {
      clientFactory: () => ({
        fetchSellers: async () => ({
          toolName: 'get_sellers',
          sellers: [SELLER],
          ignoredLines: 0,
        }),
        fetchProductMetrics: async () => {
          throw transport;
        },
      }),
    });
    await expect(transportHandler(PAYLOAD)).rejects.toBe(transport);
    expect(transportStore.failures[0]).toMatchObject({
      disable: false,
      lastError: expect.stringMatching(/could not be reached/),
    });
  });

  it('fails permanently before constructing a client when config or Vault is incomplete', async () => {
    const configStore = new FakeStore();
    if (!configStore.resolved) throw new Error('test scope missing');
    configStore.resolved.connection.config = {};
    const configHandler = createMrpEconomicsHandler(configStore, {
      clientFactory: () => {
        throw new Error('client must not be constructed');
      },
    });
    await expect(configHandler(PAYLOAD)).rejects.toThrow(/config\.url/);
    expect(configStore.failures[0]).toMatchObject({ disable: true });

    const secretStore = new FakeStore();
    secretStore.storedSecret = null;
    const secretHandler = createMrpEconomicsHandler(secretStore, {
      clientFactory: () => {
        throw new Error('client must not be constructed');
      },
    });
    await expect(secretHandler(PAYLOAD)).rejects.toThrow(/personal access token/i);
    expect(secretStore.failures[0]).toMatchObject({ disable: true });
  });
});
