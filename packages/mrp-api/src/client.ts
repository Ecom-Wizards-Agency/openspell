import { z } from 'zod';
import {
  MrpAuthError,
  MrpConfigError,
  MrpHttpError,
  MrpProtocolError,
  MrpTransportError,
  MrpToolCallError,
} from './errors.js';
import { parseProductMetrics, parseSellers } from './parser.js';
import type {
  FetchLike,
  MrpClientOptions,
  MrpInitializeResult,
  MrpProductMetricsInput,
  MrpProductMetricsResult,
  MrpSellersResult,
  MrpTool,
} from './types.js';

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'wizard-ads', version: '0.0.0' } as const;

const rpcErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
}).passthrough();

const rpcEnvelopeSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  result: z.unknown().optional(),
  error: rpcErrorSchema.optional(),
}).passthrough();

const initializeSchema = z.object({
  protocolVersion: z.string(),
  serverInfo: z.object({ name: z.string(), version: z.string().optional() }).passthrough().optional(),
}).passthrough();

const toolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const toolsListSchema = z.object({ tools: z.array(toolSchema) }).passthrough();
const callResultSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
  content: z.array(z.object({
    type: z.string(),
    text: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();

interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
}

function endpoint(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new MrpConfigError('MRP endpoint must be an absolute URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new MrpConfigError('MRP endpoint must use HTTP or HTTPS');
  }
  return parsed.toString();
}

function sseData(text: string): unknown[] {
  const events: unknown[] = [];
  for (const block of text.replace(/\r\n/g, '\n').split(/\n\n+/)) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      throw new MrpProtocolError('MRP SSE response contains malformed JSON');
    }
  }
  return events;
}

function decodedBodies(text: string, contentType: string): unknown[] {
  if (contentType.toLowerCase().includes('text/event-stream') || /^\s*(?:event:|data:)/m.test(text)) {
    return sseData(text);
  }
  try {
    return [JSON.parse(text)];
  } catch {
    throw new MrpProtocolError('MRP response body is not JSON or SSE');
  }
}

function errorText(value: z.infer<typeof callResultSchema>): string | null {
  for (const part of value.content ?? []) {
    if (part.type === 'text' && part.text?.trim()) return part.text.replace(/\s+/g, ' ').trim();
  }
  return null;
}

function extractedToolPayload(value: unknown): unknown {
  const result = callResultSchema.safeParse(value);
  if (!result.success) throw new MrpProtocolError('MRP tools/call returned a malformed result');
  if (result.data.isError) {
    throw new MrpToolCallError(errorText(result.data) ?? 'MRP tool reported an error');
  }
  if (result.data.structuredContent !== undefined) return result.data.structuredContent;

  const payloads: unknown[] = [];
  for (const part of result.data.content ?? []) {
    if (part.type !== 'text' || part.text === undefined) continue;
    try {
      payloads.push(JSON.parse(part.text));
    } catch {
      payloads.push(part.text);
    }
  }
  if (payloads.length === 0) throw new MrpProtocolError('MRP tools/call returned no text or structured content');
  return payloads.length === 1 ? payloads[0] : payloads;
}

/** A minimal stateful MCP client: one endpoint, one token, one HTTP session. */
export class MrpClient {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly fetch: FetchLike;
  private nextId = 1;
  private sessionId: string | null = null;
  private negotiatedProtocol: string | null = null;

  constructor(options: MrpClientOptions) {
    this.endpoint = endpoint(options.endpoint);
    if (!options.token.trim()) throw new MrpConfigError('MRP token cannot be empty');
    this.token = options.token;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const request: RpcRequest = { jsonrpc: '2.0', id: this.nextId++, method, params };
    const headers: Record<string, string> = {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
    };
    if (this.sessionId !== null) headers['mcp-session-id'] = this.sessionId;
    if (this.negotiatedProtocol !== null) headers['mcp-protocol-version'] = this.negotiatedProtocol;

    let response: Response;
    try {
      response = await this.fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
      });
    } catch (cause) {
      throw new MrpTransportError('MRP MCP request could not reach the configured server', { cause });
    }
    if (response.status === 401 || response.status === 403) {
      throw new MrpAuthError('MRP rejected the personal access token', response.status);
    }
    if (!response.ok) throw new MrpHttpError(`MRP MCP request failed with HTTP ${response.status}`, response.status);

    const returnedSession = response.headers.get('mcp-session-id');
    if (returnedSession) this.sessionId = returnedSession;
    const text = await response.text();
    if (!text.trim()) throw new MrpProtocolError(`MRP ${method} returned an empty response`);
    const bodies = decodedBodies(text, response.headers.get('content-type') ?? '');
    for (const body of bodies) {
      const envelope = rpcEnvelopeSchema.safeParse(body);
      if (!envelope.success || envelope.data.id !== request.id) continue;
      if (envelope.data.error) {
        const message = `MRP ${method} failed with JSON-RPC ${envelope.data.error.code}: ${envelope.data.error.message}`;
        if (method === 'tools/call') throw new MrpToolCallError(message);
        throw new MrpProtocolError(message);
      }
      if (!Object.prototype.hasOwnProperty.call(envelope.data, 'result')) {
        throw new MrpProtocolError(`MRP ${method} response has no result`);
      }
      return envelope.data.result;
    }
    throw new MrpProtocolError(`MRP ${method} response did not contain JSON-RPC id ${request.id}`);
  }

  async initialize(): Promise<MrpInitializeResult> {
    const raw = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    const parsed = initializeSchema.safeParse(raw);
    if (!parsed.success) throw new MrpProtocolError('MRP initialize returned a malformed result');
    this.negotiatedProtocol = parsed.data.protocolVersion;
    return {
      protocolVersion: parsed.data.protocolVersion,
      serverName: parsed.data.serverInfo?.name ?? null,
      serverVersion: parsed.data.serverInfo?.version ?? null,
    };
  }

  async listTools(): Promise<MrpTool[]> {
    const raw = await this.request('tools/list', {});
    const parsed = toolsListSchema.safeParse(raw);
    if (!parsed.success) throw new MrpProtocolError('MRP tools/list returned a malformed result');
    return parsed.data.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? null,
      inputSchema: tool.inputSchema ?? {},
    }));
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!name.trim()) throw new MrpConfigError('MRP tool name cannot be empty');
    return extractedToolPayload(await this.request('tools/call', { name, arguments: args }));
  }

  private async ensureInitialized(): Promise<void> {
    if (this.negotiatedProtocol === null) await this.initialize();
  }

  async fetchSellers(): Promise<MrpSellersResult> {
    await this.ensureInitialized();
    const toolName = 'get_sellers';
    const parsed = parseSellers(await this.callTool(toolName));
    return { toolName, ...parsed };
  }

  async fetchProductMetrics(input: MrpProductMetricsInput): Promise<MrpProductMetricsResult> {
    await this.ensureInitialized();
    const toolName = 'get_product_metrics';
    const asin = input.asin.trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) throw new MrpConfigError(`Invalid MRP ASIN ${JSON.stringify(input.asin)}`);
    if (input.sellerIds.length === 0 || input.sellerIds.some((id) => !Number.isSafeInteger(id))) {
      throw new MrpConfigError('MRP product metrics requires at least one integer seller id');
    }
    if (input.marketplaceIds.length === 0 || input.marketplaceIds.some((id) => !id.trim())) {
      throw new MrpConfigError('MRP product metrics requires at least one marketplace id');
    }
    const payload = await this.callTool(toolName, {
      asin,
      seller_ids: input.sellerIds,
      marketplace_ids: input.marketplaceIds,
      date_from: input.dateFrom,
      date_to: input.dateTo,
    });
    return { toolName, metrics: parseProductMetrics(payload, asin) };
  }
}
