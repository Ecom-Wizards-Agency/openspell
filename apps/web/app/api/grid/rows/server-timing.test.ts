import { describe, expect, it } from 'vitest';
import { GRID_SERVER_TIMING_SPANS, GridServerTiming } from './server-timing';

describe('GridServerTiming', () => {
  it('emits only the fixed route stages and a total', () => {
    const readings = [100, 112.345, 120, 144.444, 145, 150, 151];
    const timing = new GridServerTiming(() => readings.shift() ?? 151);

    for (const span of GRID_SERVER_TIMING_SPANS) timing.mark(span);

    expect(timing.header()).toBe(
      'actor;dur=12.35, role;dur=7.66, profile;dur=24.44, rows;dur=0.56, ' +
        'serialize;dur=5.00, total;dur=51.00',
    );
  });

  it('clamps a non-monotonic clock rather than emitting a negative duration', () => {
    const readings = [10, 9, 8];
    const timing = new GridServerTiming(() => readings.shift() ?? 8);
    timing.mark('actor');

    expect(timing.header()).toBe('actor;dur=0.00, total;dur=0.00');
  });
});
