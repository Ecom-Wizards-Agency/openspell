import { describe, expect, it } from 'vitest';
import type { NewProductEconomics, ProductEconomicsLoadCounts } from '@wizard-ads/db';
import { MrpAuthError } from '@wizard-ads/mrp-api';
import type { MrpProductEconomics } from '@wizard-ads/mrp-api';
import type { EconomicsSyncJob } from '@wizard-ads/shared';
import {
  createMrpEconomicsHandler,
  mapMrpProductEconomics,
} from './mrp.js';
import type {
  MrpConnection,
  MrpEconomicsSyncStore,
} from './mrp.js';
import { PermanentJobError } from './worker.js';

const ORG_ID = '44444444-4444-4444-8444-444444444444';
const PROFILE_ID = '45454545-4545-4545-8545-454545454545';
const CONNECTION_ID = '46464646-4646-4646-8646-464646464646';
const ENDPOINT = 'https://mrp.example.test/mcp';
const AUTH_VALUE = ['synthetic', 'worker', 'credential'].join('-');
const NOW = new Date('2026-08-27T08:15:00.000Z');
const PAYLOAD: EconomicsSyncJob = {
  type: 'economics.sync',
  orgId: ORG_ID,
  profileId: PROFILE_ID,
};

function product(overrides: Partial<MrpProductEconomics> = {}): MrpProductEconomics {
  return {
    asin: 'B0TEST4409',
    capturedOn: null,
    salePrice: 39.99,
    cogs: 10,
    fbaFees: 5,
    referralFees: 6,
    otherFees: 1,
    margin: 17.99,
    ltvRevenue: 60,
    ltvOrders: 1.5,
    repeatRate: 0.2,
    currency: 'USD',
    details: { cohort: 'synthetic' },
    ...overrides,
  };
}

class FakeStore implements MrpEconomicsSyncStore {
  resolved: MrpConnection | null = { id: CONNECTION_ID, config: { url: ENDPOINT } };
  storedSecret: string | null = AUTH_VALUE;
  loaded: readonly NewProductEconomics[] = [];
  success: { orgId: string; connectionId: string; syncedAt: Date } | null = null;
  failures: {
    orgId: string;
    connectionId: string;
    lastError: string;
    disable: boolean;
  }[] = [];

  async connection(): Promise<MrpConnection | null> {
    return this.resolved;
  }

  async secret(): Promise<string | null> {
    return this.storedSecret;
  }

  async load(rows: readonly NewProductEconomics[]): Promise<ProductEconomicsLoadCounts> {
    this.loaded = rows;
    return { offered: rows.length, written: rows.length };
  }

  async succeeded(args: { orgId: string; connectionId: string; syncedAt: Date }): Promise<void> {
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

describe('MRP worker mapper', () => {
  it('maps every client row and defaults only missing capture dates', () => {
    const rows = mapMrpProductEconomics({
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      capturedOn: '2026-08-27',
      loadedAt: NOW,
    }, [
      product(),
      product({ asin: 'B0TEST4410', capturedOn: '2026-08-26', salePrice: 20 }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      capturedOn: '2026-08-27',
      source: 'mrp',
      details: { cohort: 'synthetic' },
    });
    expect(rows[1]?.capturedOn).toBe('2026-08-26');
    expect(rows.every((row) => row.loadedAt === NOW)).toBe(true);
  });
});

describe('MRP economics.sync handler', () => {
  it('loads all products, records the resolved tool, and marks the connection synced', async () => {
    const store = new FakeStore();
    let receivedEndpoint = '';
    let receivedToken = '';
    const handler = createMrpEconomicsHandler(store, {
      now: () => NOW,
      clientFactory: (options) => {
        receivedEndpoint = options.endpoint;
        receivedToken = options.token;
        return {
          fetchProductEconomics: async () => ({
            toolName: 'get_product_economics',
            products: [product(), product({ asin: 'B0TEST4410' })],
          }),
        };
      },
    });

    await expect(handler(PAYLOAD)).resolves.toEqual({
      provider: 'mrp',
      toolName: 'get_product_economics',
      productsReceived: 2,
      rowsLoaded: 2,
      capturedOn: '2026-08-27',
    });
    expect(receivedEndpoint).toBe(ENDPOINT);
    expect(receivedToken).toBe(AUTH_VALUE);
    expect(store.loaded).toHaveLength(2);
    expect(store.success).toEqual({ orgId: ORG_ID, connectionId: CONNECTION_ID, syncedAt: NOW });
    expect(store.failures).toEqual([]);
  });

  it('fails permanently with an operator-facing lastError when config.url is absent', async () => {
    const store = new FakeStore();
    store.resolved = { id: CONNECTION_ID, config: {} };
    const handler = createMrpEconomicsHandler(store, {
      clientFactory: () => {
        throw new Error('client must not be constructed');
      },
    });

    await expect(handler(PAYLOAD)).rejects.toBeInstanceOf(PermanentJobError);
    expect(store.failures).toEqual([
      expect.objectContaining({
        connectionId: CONNECTION_ID,
        disable: true,
        lastError: expect.stringMatching(/config\.url/),
      }),
    ]);
  });

  it('turns an auth failure into a sanitized permanent connection error', async () => {
    const store = new FakeStore();
    const handler = createMrpEconomicsHandler(store, {
      clientFactory: () => ({
        fetchProductEconomics: async () => {
          throw new MrpAuthError(`rejected ${AUTH_VALUE}`, 401);
        },
      }),
    });
    const error = await handler(PAYLOAD).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(PermanentJobError);
    expect(String(error)).not.toContain(AUTH_VALUE);
    expect(store.failures[0]).toMatchObject({ disable: true });
    expect(store.failures[0]?.lastError).not.toContain(AUTH_VALUE);
  });

  it('fails before constructing a client when Vault has no token', async () => {
    const store = new FakeStore();
    store.storedSecret = null;
    const handler = createMrpEconomicsHandler(store, {
      clientFactory: () => {
        throw new Error('client must not be constructed');
      },
    });
    await expect(handler(PAYLOAD)).rejects.toThrow(/personal access token/i);
    expect(store.failures[0]).toMatchObject({ disable: true });
  });
});
