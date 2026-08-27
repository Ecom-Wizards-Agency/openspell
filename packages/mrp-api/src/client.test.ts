import { describe, expect, it } from 'vitest';
import {
  MrpAuthError,
  MrpProtocolError,
  MrpToolCallError,
  MrpTransportError,
} from './errors.js';
import { MrpClient } from './client.js';
import {
  createMcpFixtureServer,
  rpcError,
  rpcResult,
  sseResponse,
} from './__fixtures__/server.js';
import {
  INITIALIZED,
  SINGLE_ASIN_SCHEMA_ERROR,
  SYNTHETIC_PRODUCT_METRICS,
  SYNTHETIC_SELLERS_PROSE,
  TOOLS,
} from './__fixtures__/payloads.js';

const ENDPOINT = 'https://mrp.example.test/mcp';
const AUTH_VALUE = ['synthetic', 'personal', 'access'].join('-');
const PRODUCT_INPUT = {
  asin: 'B0TEST4401',
  sellerIds: [123450001],
  marketplaceIds: ['ATVPDKIKX0DER'],
  dateFrom: '2026-08-26',
  dateTo: '2026-08-26',
} as const;

describe('MrpClient live JSON-RPC fixture sequence', () => {
  it('carries one MCP session through prose sellers and a single-ASIN metrics call', async () => {
    const server = createMcpFixtureServer([
      {
        status: 200,
        headers: { 'mcp-session-id': 'synthetic-session' },
        json: rpcResult(1, INITIALIZED),
      },
      {
        status: 200,
        json: rpcResult(2, {
          content: [{ type: 'text', text: JSON.stringify({ result: SYNTHETIC_SELLERS_PROSE }) }],
        }),
      },
      {
        status: 200,
        json: rpcResult(3, {
          content: [{
            type: 'text',
            text: JSON.stringify({ result: JSON.stringify(SYNTHETIC_PRODUCT_METRICS) }),
          }],
        }),
      },
    ]);
    const client = new MrpClient({ endpoint: ENDPOINT, token: AUTH_VALUE, fetch: server.fetch });

    const sellers = await client.fetchSellers();
    const product = await client.fetchProductMetrics({
      ...PRODUCT_INPUT,
      sellerIds: [...PRODUCT_INPUT.sellerIds],
      marketplaceIds: [...PRODUCT_INPUT.marketplaceIds],
    });

    expect(sellers.toolName).toBe('get_sellers');
    expect(sellers.ignoredLines).toBe(1);
    expect(sellers.sellers).toHaveLength(2);
    expect(sellers.sellers[0]).toMatchObject({ sellerId: 123450001 });
    expect(product).toMatchObject({
      toolName: 'get_product_metrics',
      metrics: { product: { asin: 'B0TEST4401', margin: 0.4185 } },
    });
    expect(server.requests.map((request) => request.json['method'])).toEqual([
      'initialize',
      'tools/call',
      'tools/call',
    ]);
    expect(server.requests[0]?.headers['authorization']).toBe(`Bearer ${AUTH_VALUE}`);
    expect(server.requests[0]?.headers['mcp-session-id']).toBeUndefined();
    expect(server.requests[1]?.headers['mcp-session-id']).toBe('synthetic-session');
    expect(server.requests[1]?.headers['mcp-protocol-version']).toBe('2025-06-18');
    expect(server.requests[1]?.json['params']).toEqual({
      name: 'get_sellers',
      arguments: {},
    });
    expect(server.requests[2]?.json['params']).toEqual({
      name: 'get_product_metrics',
      arguments: {
        asin: 'B0TEST4401',
        seller_ids: [123450001],
        marketplace_ids: ['ATVPDKIKX0DER'],
        date_from: '2026-08-26',
        date_to: '2026-08-26',
      },
    });
  });

  it('parses SSE responses and raw prose text content defensively', async () => {
    const server = createMcpFixtureServer([
      sseResponse(1, INITIALIZED),
      sseResponse(2, {
        content: [{ type: 'text', text: SYNTHETIC_SELLERS_PROSE }],
      }),
    ]);
    const result = await new MrpClient({
      endpoint: ENDPOINT,
      token: AUTH_VALUE,
      fetch: server.fetch,
    }).fetchSellers();
    expect(result.sellers.map((seller) => seller.name)).toEqual(['Example Labs', 'Sample Island']);
  });

  it('surfaces the live single-ASIN schema rejection as a tool-call error', async () => {
    const server = createMcpFixtureServer([
      { status: 200, json: rpcResult(1, INITIALIZED) },
      (request) => {
        const id = request.json['id'];
        return {
          status: 200,
          json: rpcError(typeof id === 'number' ? id : 2, SINGLE_ASIN_SCHEMA_ERROR),
        };
      },
    ]);
    const client = new MrpClient({ endpoint: ENDPOINT, token: AUTH_VALUE, fetch: server.fetch });
    await client.initialize();
    await expect(client.callTool('get_product_metrics', {
      seller_ids: [123450001],
      marketplace_ids: ['ATVPDKIKX0DER'],
      date_from: '2026-08-26',
      date_to: '2026-08-26',
    })).rejects.toBeInstanceOf(MrpToolCallError);
  });

  it('raises typed, credential-free auth and transport failures', async () => {
    const authServer = createMcpFixtureServer([{ status: 401, text: 'not authorized' }]);
    const authClient = new MrpClient({ endpoint: ENDPOINT, token: AUTH_VALUE, fetch: authServer.fetch });
    const authError = await authClient.initialize().catch((failure: unknown) => failure);
    expect(authError).toBeInstanceOf(MrpAuthError);
    expect(String(authError)).not.toContain(AUTH_VALUE);

    const transportClient = new MrpClient({
      endpoint: ENDPOINT,
      token: AUTH_VALUE,
      fetch: async () => {
        throw new TypeError('synthetic network failure');
      },
    });
    await expect(transportClient.initialize()).rejects.toBeInstanceOf(MrpTransportError);
  });

  it('rejects a malformed tools/call result instead of reporting an empty sync', async () => {
    const server = createMcpFixtureServer([
      { status: 200, json: rpcResult(1, INITIALIZED) },
      { status: 200, json: rpcResult(2, { content: 'not-an-array' }) },
    ]);
    const client = new MrpClient({ endpoint: ENDPOINT, token: AUTH_VALUE, fetch: server.fetch });
    await expect(client.fetchSellers()).rejects.toBeInstanceOf(MrpProtocolError);
    expect(server.requests).toHaveLength(2);
  });

  it('still exposes tools/list for an operator smoke inspection', async () => {
    const server = createMcpFixtureServer([
      { status: 200, json: rpcResult(1, INITIALIZED) },
      { status: 200, json: rpcResult(2, TOOLS) },
    ]);
    const client = new MrpClient({ endpoint: ENDPOINT, token: AUTH_VALUE, fetch: server.fetch });
    await client.initialize();
    await expect(client.listTools()).resolves.toEqual([
      expect.objectContaining({ name: 'get_sellers' }),
      expect.objectContaining({ name: 'get_product_metrics' }),
    ]);
  });
});
