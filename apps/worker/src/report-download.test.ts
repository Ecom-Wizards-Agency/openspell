import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbAdsApiClient } from './ads-api.js';
import {
  gunzipJson,
  type ReportDownloadLimits,
} from './parsers.js';

const generous: ReportDownloadLimits = {
  maxCompressedBytes: 1_024,
  maxDecompressedBytes: 4_096,
  idleTimeoutMs: 1_000,
  totalTimeoutMs: 5_000,
};

async function* bytes(value: Uint8Array): AsyncGenerator<Uint8Array> {
  yield value;
}

function never(): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
      return: async () => ({ done: true, value: undefined }),
    }),
  };
}

function downloadClient(body: ReadableStream<Uint8Array>): DbAdsApiClient {
  return new DbAdsApiClient({
    resolveConnectionId: async () => null,
    listConnectionIds: async () => [],
    getRefreshToken: async () => null,
    createClient: () => { throw new Error('unused'); },
    fetch: async () => new Response(body),
  });
}

function consumeRows(rows: unknown[]): (chunk: readonly unknown[]) => void {
  return (chunk) => rows.push(...chunk);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('bounded report download', () => {
  it('inflates and accounts a valid bounded JSON document', async () => {
    const compressed = gzipSync(JSON.stringify([{ row: 1 }, { row: 2 }]));
    const rows: unknown[] = [];

    await expect(gunzipJson(bytes(compressed), generous, {
      consumeRows: consumeRows(rows),
    })).resolves.toEqual({
      rowsParsed: 2,
      bytesDownloaded: compressed.byteLength,
    });
    expect(rows).toEqual([{ row: 1 }, { row: 2 }]);
  });

  it('delivers a larger parsed array only in bounded acknowledged chunks', async () => {
    const expected = Array.from({ length: 300 }, (_, row) => ({ row }));
    const compressed = gzipSync(JSON.stringify(expected));
    const rows: unknown[] = [];
    const chunkSizes: number[] = [];

    await expect(gunzipJson(bytes(compressed), generous, {
      consumeRows: async (chunk) => {
        chunkSizes.push(chunk.length);
        rows.push(...chunk);
      },
    })).resolves.toMatchObject({ rowsParsed: expected.length });
    expect(rows).toEqual(expected);
    expect(chunkSizes.length).toBeGreaterThan(1);
    expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(128);
  });

  it('refuses a single parsed row above the structural-clone chunk bound', async () => {
    const document = JSON.stringify([{ row: 'x'.repeat(300 * 1_024) }]);
    const compressed = gzipSync(document);

    await expect(gunzipJson(bytes(compressed), {
      ...generous,
      maxDecompressedBytes: Buffer.byteLength(document) + 1,
    }, { consumeRows: () => undefined })).rejects.toMatchObject({
      kind: 'parsed_row_bytes',
    });
  });

  it('refuses an array whose object count could amplify parent heap', async () => {
    const document = JSON.stringify(Array.from({ length: 100_001 }, () => null));
    const compressed = gzipSync(document);

    await expect(gunzipJson(bytes(compressed), {
      ...generous,
      maxDecompressedBytes: Buffer.byteLength(document) + 1,
    }, { consumeRows: () => undefined })).rejects.toMatchObject({
      kind: 'parsed_rows',
    });
  });

  it('refuses compressed input above the wire-byte ceiling', async () => {
    const compressed = gzipSync(JSON.stringify([{ row: 'value' }]));

    await expect(gunzipJson(bytes(compressed), {
      ...generous,
      maxCompressedBytes: compressed.byteLength - 1,
    }, { consumeRows: () => undefined })).rejects.toMatchObject({
      name: 'ReportDownloadLimitError',
      kind: 'compressed_bytes',
    });
  });

  it('refuses inflated input above the retained-byte ceiling', async () => {
    const document = JSON.stringify([{ row: 'value'.repeat(20) }]);
    const compressed = gzipSync(document);

    await expect(gunzipJson(bytes(compressed), {
      ...generous,
      maxDecompressedBytes: Buffer.byteLength(document) - 1,
    }, { consumeRows: () => undefined })).rejects.toMatchObject({
      name: 'ReportDownloadLimitError',
      kind: 'decompressed_bytes',
    });
  });

  it('interrupts a source that stops producing chunks', async () => {
    vi.useFakeTimers();
    const result = gunzipJson(never(), {
      ...generous,
      idleTimeoutMs: 50,
      totalTimeoutMs: 500,
    }, { consumeRows: () => undefined, cancellationTimeoutMs: 50 });
    const rejection = expect(result).rejects.toMatchObject({
      name: 'ReportDownloadLimitError',
      kind: 'idle_timeout',
    });

    await vi.advanceTimersByTimeAsync(50);
    await rejection;
  });

  it('enforces the total deadline independently of the idle deadline', async () => {
    vi.useFakeTimers();
    const result = gunzipJson(never(), {
      ...generous,
      idleTimeoutMs: 500,
      totalTimeoutMs: 50,
    }, { consumeRows: () => undefined, cancellationTimeoutMs: 50 });
    const rejection = expect(result).rejects.toMatchObject({
      name: 'ReportDownloadLimitError',
      kind: 'total_timeout',
    });

    await vi.advanceTimersByTimeAsync(50);
    await rejection;
  });

  it('aborts and proves cancellation of a real ReadableStream on idle timeout', async () => {
    let cancelCalls = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(gzipSync('['));
      },
      cancel() {
        cancelCalls += 1;
      },
    });
    const api = downloadClient(stream);
    const outer = new AbortController();
    const source = await api.downloadReport('https://reports.invalid/idle', outer.signal);

    await expect(gunzipJson(source, {
      ...generous,
      idleTimeoutMs: 20,
      totalTimeoutMs: 500,
    }, {
      signal: outer.signal,
      abortSource: (reason) => outer.abort(reason),
      consumeRows: () => undefined,
      cancellationTimeoutMs: 100,
    })).rejects.toMatchObject({ kind: 'idle_timeout' });
    expect(outer.signal.aborted).toBe(true);
    expect(cancelCalls).toBe(1);
  });

  it('fails closed when real ReadableStream cancellation never settles', async () => {
    let cancelCalls = 0;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelCalls += 1;
        return new Promise<void>(() => undefined);
      },
    });
    const api = downloadClient(stream);
    const outer = new AbortController();
    const source = await api.downloadReport('https://reports.invalid/hanging-cancel', outer.signal);

    await expect(gunzipJson(source, {
      ...generous,
      idleTimeoutMs: 20,
      totalTimeoutMs: 500,
    }, {
      signal: outer.signal,
      abortSource: (reason) => outer.abort(reason),
      consumeRows: () => undefined,
      cancellationTimeoutMs: 20,
    })).rejects.toMatchObject({ kind: 'source_cancellation' });
    expect(cancelCalls).toBe(1);
  });

  it('preserves a real ReadableStream cancellation rejection as source failure', async () => {
    let cancelCalls = 0;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelCalls += 1;
        return Promise.reject(new Error('synthetic transport cancellation rejection'));
      },
    });
    const api = downloadClient(stream);
    const outer = new AbortController();
    const source = await api.downloadReport('https://reports.invalid/rejecting-cancel', outer.signal);

    await expect(gunzipJson(source, {
      ...generous,
      idleTimeoutMs: 20,
      totalTimeoutMs: 500,
    }, {
      signal: outer.signal,
      abortSource: (reason) => outer.abort(reason),
      consumeRows: () => undefined,
      cancellationTimeoutMs: 100,
    })).rejects.toMatchObject({
      name: 'ReportDownloadLimitError',
      kind: 'source_cancellation',
    });
    expect(cancelCalls).toBe(1);
  });

  it.each([
    ['throws synchronously', () => { throw new Error('synthetic return throw'); }],
    ['returns a rejected promise', () => Promise.reject(new Error('synthetic return rejection'))],
    ['returns a non-done result', () => Promise.resolve({ done: false, value: new Uint8Array() })],
  ] as const)('normalizes an iterator that %s', async (_case, close) => {
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
        return: close,
      }),
    };

    await expect(gunzipJson(source, {
      ...generous,
      idleTimeoutMs: 20,
      totalTimeoutMs: 500,
    }, {
      consumeRows: () => undefined,
      cancellationTimeoutMs: 100,
    })).rejects.toMatchObject({
      name: 'ReportDownloadLimitError',
      kind: 'source_cancellation',
    });
  });

  it('lets a concurrent bounded download finish while another is cancelling', async () => {
    const blocked = gunzipJson(never(), {
      ...generous,
      idleTimeoutMs: 40,
      totalTimeoutMs: 500,
    }, { consumeRows: () => undefined, cancellationTimeoutMs: 50 });
    const blockedRejection = expect(blocked).rejects.toMatchObject({ kind: 'idle_timeout' });
    const compressed = gzipSync(JSON.stringify([{ row: 'independent' }]));
    const rows: unknown[] = [];

    await expect(gunzipJson(bytes(compressed), generous, {
      consumeRows: consumeRows(rows),
    })).resolves.toMatchObject({ rowsParsed: 1 });
    expect(rows).toEqual([{ row: 'independent' }]);
    await blockedRejection;
  });

  it('rejects non-positive or non-integral limits before reading the source', async () => {
    await expect(gunzipJson(bytes(gzipSync('[]')), {
      ...generous,
      maxCompressedBytes: 0,
    }, { consumeRows: () => undefined })).rejects.toBeInstanceOf(RangeError);
    await expect(gunzipJson(bytes(gzipSync('[]')), {
      ...generous,
      totalTimeoutMs: 1.5,
    }, { consumeRows: () => undefined })).rejects.toBeInstanceOf(RangeError);
  });
});
