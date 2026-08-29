import { afterEach, describe, expect, it, vi } from 'vitest';
import { withServerTiming } from './server-timing';

describe('server loader timing', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('is disabled by default and does not inspect the result', async () => {
    vi.stubEnv('WIZARD_ADS_PERF_DIAGNOSTICS', '0');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const rowCountOf = vi.fn(() => 1);

    await expect(
      withServerTiming('grid.search_terms', async () => [{ value: 'synthetic' }], rowCountOf),
    ).resolves.toEqual([{ value: 'synthetic' }]);

    expect(rowCountOf).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('logs only the closed span name and numeric output dimensions', async () => {
    vi.stubEnv('WIZARD_ADS_PERF_DIAGNOSTICS', '1');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const output = [{ label: 'synthetic private value', amount: 12.5 }];

    await withServerTiming('optimizer.campaign_facts', async () => output, (rows) => rows.length);

    expect(info).toHaveBeenCalledTimes(1);
    const emitted = String(info.mock.calls[0]?.[0]);
    expect(emitted).not.toContain(output[0]?.label ?? 'unreachable');
    expect(JSON.parse(emitted)).toEqual({
      event: 'openspell.server_timing',
      span: 'optimizer.campaign_facts',
      status: 'ok',
      duration_ms: expect.any(Number),
      row_count: 1,
      serialized_bytes: new TextEncoder().encode(JSON.stringify(output)).byteLength,
    });
  });

  it('preserves loader errors without logging their messages', async () => {
    vi.stubEnv('WIZARD_ADS_PERF_DIAGNOSTICS', '1');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const failure = new Error('synthetic private failure detail');

    await expect(
      withServerTiming('optimizer.runs', async () => Promise.reject(failure), () => 0),
    ).rejects.toBe(failure);

    expect(info).toHaveBeenCalledTimes(1);
    const emitted = String(info.mock.calls[0]?.[0]);
    expect(emitted).not.toContain(failure.message);
    expect(JSON.parse(emitted)).toEqual({
      event: 'openspell.server_timing',
      span: 'optimizer.runs',
      status: 'error',
      duration_ms: expect.any(Number),
    });
  });

  it('never changes a successful loader result when diagnostics cannot serialize it', async () => {
    vi.stubEnv('WIZARD_ADS_PERF_DIAGNOSTICS', '1');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const output: { self?: unknown } = {};
    output.self = output;

    await expect(
      withServerTiming('grid.targets', async () => output, () => 1),
    ).resolves.toBe(output);

    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({
      status: 'ok',
      row_count: 1,
      serialized_bytes: null,
    });
  });
});
