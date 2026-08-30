import { describe, expect, it } from 'vitest';
import {
  finalizeTimedGridResponse,
  GRID_SERVER_TIMING_SPANS,
  GridServerTiming,
} from './server-timing';

describe('GridServerTiming', () => {
  it('emits only the fixed route stages and a total', () => {
    const readings = [100, 112.345, 120, 144.444, 145, 150, 150.5, 151];
    const timing = new GridServerTiming(() => readings.shift() ?? 151);

    for (const span of GRID_SERVER_TIMING_SPANS) timing.mark(span);

    expect(timing.header()).toBe(
      'actor;dur=12.35, role;dur=7.66, profile;dur=24.44, rows;dur=0.56, ' +
        'serialize;dur=5.00, close;dur=0.50, total;dur=51.00',
    );
  });

  it('clamps a non-monotonic clock rather than emitting a negative duration', () => {
    const readings = [10, 9, 8];
    const timing = new GridServerTiming(() => readings.shift() ?? 8);
    timing.mark('actor');

    expect(timing.header()).toBe('actor;dur=0.00, total;dur=0.00');
  });

  it('awaits teardown before finalizing the success header and total', async () => {
    let now = 0;
    let releaseClose: (() => void) | undefined;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const response = new Response('{}');
    const timing = new GridServerTiming(() => now);
    timing.mark('actor');

    const finalizing = finalizeTimedGridResponse(response, timing, async () => {
      await closeGate;
      now = 5_000;
    });
    expect(response.headers.has('server-timing')).toBe(false);

    releaseClose?.();
    await finalizing;

    expect(response.headers.get('server-timing')).toBe(
      'actor;dur=0.00, close;dur=5000.00, total;dur=5000.00',
    );
  });
});
