/**
 * The Streamable HTTP endpoint.
 *
 * Stateless: one MCP server and one transport per request, both bound to the
 * org the presented key belongs to and discarded when the response ends. There
 * is no session to hijack, no server object that outlives an authorization
 * check, and no path by which a second request inherits the first request's
 * scope.
 *
 * Authentication happens here, before any MCP machinery exists. A request with
 * no key, an unknown key, a revoked key or an expired key is a 401 and never
 * reaches a tool.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createDb } from '@wizard-ads/db';
import type { DbHandle } from '@wizard-ads/db';
import { AuthError } from './errors.js';
import { verifyApiKey } from './keys.js';
import {
  createMcpServer,
  PRODUCT_NAME,
  SERVER_NAME,
  SERVER_VERSION,
} from './server.js';
import type { McpConfig } from './config.js';

export const MCP_PATH = '/mcp';
const MAX_BODY_BYTES = 2_000_000;

export interface RunningServer {
  http: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

export interface StartOptions {
  config: McpConfig;
  /** An existing handle (tests own their database); otherwise one is opened here. */
  handle?: DbHandle;
  /** Override only for an embedding host or a health-path unit test. */
  readinessProbe?: () => Promise<void>;
}

export async function startHttpServer(options: StartOptions): Promise<RunningServer> {
  const { config } = options;
  const owned = options.handle === undefined;
  const handle =
    options.handle ??
    createDb({
      connectionString: config.connectionString,
      max: config.poolSize,
      statementTimeoutSeconds: config.statementTimeoutSeconds,
    });
  const readinessProbe = options.readinessProbe ?? (async () => {
    await handle.sql`select 1`;
  });

  const http = createServer((req, res) => {
    void handle_(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        respond(res, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: 'internal error' },
          id: null,
        });
      }
      console.error('[mcp] unhandled request error', error);
    });
  });

  async function handle_(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/healthz') {
      try {
        await readinessProbe();
        respond(res, 200, healthPayload(config, 'ready'));
      } catch {
        respond(res, 503, healthPayload(config, 'not_ready'));
      }
      return;
    }
    if (url.pathname !== MCP_PATH) {
      respond(res, 404, { error: 'not found' });
      return;
    }
    if (req.method !== 'POST') {
      // Stateless transport: no server-initiated stream to open and no session
      // to delete. Saying so beats an empty 200 that a client waits on.
      res.setHeader('Allow', 'POST');
      respond(res, 405, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'this endpoint is stateless: use POST' },
        id: null,
      });
      return;
    }

    let key;
    try {
      key = await verifyApiKey(handle, bearerToken(req));
    } catch (error) {
      const status = error instanceof AuthError ? error.status : 401;
      const reason = error instanceof AuthError ? error.reason : 'unauthorized';
      res.setHeader('WWW-Authenticate', 'Bearer realm="openspell"');
      respond(res, status, {
        jsonrpc: '2.0',
        error: { code: -32001, message: reason },
        id: null,
      });
      return;
    }

    const body = await readBody(req);
    const orgSlug = await readOrgSlug(handle, key.orgId);

    const server = createMcpServer({
      handle,
      config,
      scope: { orgId: key.orgId, profileIds: key.profileIds },
      keyId: key.id,
      orgSlug,
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const port = await listen(http, config.port, config.host);

  return {
    http,
    port,
    url: `http://127.0.0.1:${port}${MCP_PATH}`,
    close: async () => {
      await new Promise<void>((resolve) => http.close(() => resolve()));
      if (owned) await handle.close();
    },
  };
}

function healthPayload(config: McpConfig, status: 'ready' | 'not_ready') {
  return {
    status,
    service: SERVER_NAME,
    product: PRODUCT_NAME,
    version: SERVER_VERSION,
    revision: publicRevision(config.revision),
    checks: { database: status === 'ready' ? 'ready' : 'not_ready' },
  } as const;
}

function publicRevision(value: string | undefined): string {
  return value !== undefined && /^[0-9a-f]{7,64}$/.test(value) ? value : 'unknown';
}

function bearerToken(req: IncomingMessage): string {
  const header = req.headers['authorization'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !/^Bearer /i.test(value)) throw new AuthError(401, 'missing bearer token');
  return value.slice('Bearer '.length).trim();
}

async function readOrgSlug(handle: DbHandle, orgId: string): Promise<string> {
  const rows = await handle.sql<{ slug: string }[]>`select slug from public.orgs where id = ${orgId}`;
  return rows[0]?.slug ?? 'unknown-org';
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return undefined;
  return JSON.parse(text) as unknown;
}

function respond(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server did not bind a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}
