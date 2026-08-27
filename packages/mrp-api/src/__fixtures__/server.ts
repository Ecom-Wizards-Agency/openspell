import type { FetchLike } from '../types.js';

export interface RecordedMcpResponse {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
}

export interface RecordedMcpRequest {
  headers: Record<string, string>;
  json: Record<string, unknown>;
}

export interface McpFixtureServer {
  fetch: FetchLike;
  requests: RecordedMcpRequest[];
}

export type RecordedMcpResponder = RecordedMcpResponse | (
  (request: RecordedMcpRequest) => RecordedMcpResponse
);

export function createMcpFixtureServer(responses: readonly RecordedMcpResponder[]): McpFixtureServer {
  const requests: RecordedMcpRequest[] = [];
  let cursor = 0;
  const fetch: FetchLike = async (_input, init) => {
    const headers = new Headers(init?.headers);
    const recordedHeaders = Object.fromEntries(headers.entries());
    const json = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    requests.push({ headers: recordedHeaders, json });

    const responder = responses[cursor++];
    if (!responder) throw new Error(`no recorded MCP response for request ${cursor}`);
    const response = typeof responder === 'function' ? responder(requests.at(-1) as RecordedMcpRequest) : responder;
    const responseHeaders = new Headers(response.headers);
    if (response.text !== undefined) {
      return new Response(response.text, { status: response.status, headers: responseHeaders });
    }
    if (!responseHeaders.has('content-type')) responseHeaders.set('content-type', 'application/json');
    return new Response(JSON.stringify(response.json ?? null), {
      status: response.status,
      headers: responseHeaders,
    });
  };
  return { fetch, requests };
}

export const rpcResult = (id: number, result: unknown): unknown => ({
  jsonrpc: '2.0',
  id,
  result,
});

export const rpcError = (id: number, error: { code: number; message: string }): unknown => ({
  jsonrpc: '2.0',
  id,
  error,
});

export function sseResponse(id: number, result: unknown): RecordedMcpResponse {
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    text: `event: message\ndata: ${JSON.stringify(rpcResult(id, result))}\n\n`,
  };
}
