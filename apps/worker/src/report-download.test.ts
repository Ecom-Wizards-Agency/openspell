import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('bounded report download', () => {
  it('inflates and accounts a valid bounded JSON document', async () => {
    const compressed = gzipSync(JSON.stringify([{ row: 1 }, { row: 2 }]));

    await expect(gunzipJson(bytes(compressed), generous)).resolves.toEqual({
      value: [{ row: 1 }, { row: 2 }],
      bytesDownloaded: compressed.byteLength,
    });
  });

  it('refuses compressed input above the wire-byte ceiling', async () => {
    const compressed = gzipSync(JSON.stringify([{ row: 'value' }]));

    await expect(gunzipJson(bytes(compressed), {
      ...generous,
      maxCompressedBytes: compressed.byteLength - 1,
    })).rejects.toMatchObject({
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
    })).rejects.toMatchObject({
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
    });
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
    });
    const rejection = expect(result).rejects.toMatchObject({
      name: 'ReportDownloadLimitError',
      kind: 'total_timeout',
    });

    await vi.advanceTimersByTimeAsync(50);
    await rejection;
  });

  it('rejects non-positive or non-integral limits before reading the source', async () => {
    await expect(gunzipJson(bytes(gzipSync('[]')), {
      ...generous,
      maxCompressedBytes: 0,
    })).rejects.toBeInstanceOf(RangeError);
    await expect(gunzipJson(bytes(gzipSync('[]')), {
      ...generous,
      totalTimeoutMs: 1.5,
    })).rejects.toBeInstanceOf(RangeError);
  });
});
