import type { FetchLike } from '../types.js';

export interface RecordedResponse {
  status: number;
  json: unknown;
  gzip?: boolean;
}

export interface FixtureServer {
  fetch: FetchLike;
  requests: URL[];
}

export function createFixtureServer(sequence: readonly RecordedResponse[]): FixtureServer {
  if (sequence.length === 0) throw new Error('fixture sequence cannot be empty');
  const requests: URL[] = [];
  let cursor = 0;
  return {
    requests,
    fetch: async (input) => {
      requests.push(new URL(input));
      const item = sequence[Math.min(cursor, sequence.length - 1)];
      cursor += 1;
      if (!item) throw new Error('fixture response missing');
      const text = JSON.stringify(item.json);
      if (item.gzip) {
        const { gzipSync } = await import('node:zlib');
        return new Response(gzipSync(text), {
          status: item.status,
          headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
        });
      }
      return new Response(text, { status: item.status, headers: { 'content-type': 'application/json' } });
    },
  };
}
