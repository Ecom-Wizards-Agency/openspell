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

export function createMcpFixtureServer(responses: readonly RecordedMcpResponse[]): McpFixtureServer {
  const requests: RecordedMcpRequest[] = [];
  let cursor = 0;
  const fetch: FetchLike = async (_input, init) => {
    const headers = new Headers(init?.headers);
    const recordedHeaders = Object.fromEntries(headers.entries());
    const json = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    requests.push({ headers: recordedHeaders, json });

    const response = responses[cursor++];
    if (!response) throw new Error(`no recorded MCP response for request ${cursor}`);
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

export function sseResponse(id: number, result: unknown): RecordedMcpResponse {
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    text: `event: message\ndata: ${JSON.stringify(rpcResult(id, result))}\n\n`,
  };
}
