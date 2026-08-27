import { describe, expect, it } from 'vitest';
import { MrpAuthError, MrpProtocolError } from './errors.js';
import { MrpClient } from './client.js';
import { createMcpFixtureServer, rpcResult, sseResponse } from './__fixtures__/server.js';
import { INITIALIZED, SYNTHETIC_PRODUCTS, TOOLS } from './__fixtures__/payloads.js';

const ENDPOINT = 'https://mrp.example.test/mcp';
const AUTH_VALUE = ['synthetic', 'personal', 'access'].join('-');

describe('MrpClient JSON-RPC fixture sequence', () => {
  it('initializes, carries the MCP session, discovers a tool, calls it, and parses rows', async () => {
    const server = createMcpFixtureServer([
      {
        status: 200,
        headers: { 'mcp-session-id': 'synthetic-session' },
        json: rpcResult(1, INITIALIZED),
      },
      { status: 200, json: rpcResult(2, TOOLS) },
      {
        status: 200,
        json: rpcResult(3, { structuredContent: SYNTHETIC_PRODUCTS }),
      },
    ]);
    const client = new MrpClient({ endpoint: ENDPOINT, token: AUTH_VALUE, fetch: server.fetch });

    const result = await client.fetchProductEconomics();

    expect(result.toolName).toBe('get_product_economics');
    expect(result.products).toHaveLength(2);
    expect(result.products[0]).toMatchObject({
      asin: 'B0TEST4401',
      salePrice: 39.99,
      cogs: 11.25,
      fbaFees: 4.75,
      margin: 0.4185,
      ltvRevenue: 71.2,
      ltvOrders: 1.8,
      repeatRate: 0.24,
      currency: 'USD',
      capturedOn: '2026-08-26',
      details: { contribution_profit: 16.74 },
    });
    expect(server.requests.map((request) => request.json['method'])).toEqual([
      'initialize',
      'tools/list',
      'tools/call',
    ]);
    expect(server.requests[0]?.headers['authorization']).toBe(`Bearer ${AUTH_VALUE}`);
    expect(server.requests[0]?.headers['mcp-session-id']).toBeUndefined();
    expect(server.requests[1]?.headers['mcp-session-id']).toBe('synthetic-session');
    expect(server.requests[1]?.headers['mcp-protocol-version']).toBe('2025-06-18');
    expect(server.requests[2]?.json['params']).toEqual({
      name: 'get_product_economics',
      arguments: {},
    });
  });

  it('parses SSE responses and JSON text tool content defensively', async () => {
    const server = createMcpFixtureServer([
      sseResponse(1, INITIALIZED),
      sseResponse(2, TOOLS),
      sseResponse(3, {
        content: [{ type: 'text', text: JSON.stringify(SYNTHETIC_PRODUCTS) }],
      }),
    ]);
    const result = await new MrpClient({
      endpoint: ENDPOINT,
      token: AUTH_VALUE,
      fetch: server.fetch,
    }).fetchProductEconomics();
    expect(result.products.map((product) => product.asin)).toEqual(['B0TEST4401', 'B0TEST4402']);
  });

  it('raises a typed, credential-free auth failure', async () => {
    const server = createMcpFixtureServer([{ status: 401, text: 'not authorized' }]);
    const client = new MrpClient({ endpoint: ENDPOINT, token: AUTH_VALUE, fetch: server.fetch });
    const error = await client.initialize().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(MrpAuthError);
    expect(String(error)).not.toContain(AUTH_VALUE);
  });

  it('rejects a malformed tools/call result instead of reporting an empty sync', async () => {
    const server = createMcpFixtureServer([
      { status: 200, json: rpcResult(1, INITIALIZED) },
      { status: 200, json: rpcResult(2, TOOLS) },
      { status: 200, json: rpcResult(3, { content: 'not-an-array' }) },
    ]);
    const client = new MrpClient({ endpoint: ENDPOINT, token: AUTH_VALUE, fetch: server.fetch });
    await expect(client.fetchProductEconomics()).rejects.toBeInstanceOf(MrpProtocolError);
    expect(server.requests).toHaveLength(3);
  });
});
