import { describe, expect, it } from 'vitest';
import { MAX_E2E_CPU_RATE, parseE2ECpuRate } from './e2e-cpu-rate.js';

describe('E2E CPU throttle contract', () => {
  it('leaves ordinary runs unthrottled and accepts the standard 1x to 10x range', () => {
    expect(parseE2ECpuRate(undefined)).toBeNull();
    expect(parseE2ECpuRate('1')).toBe(1);
    expect(parseE2ECpuRate(String(MAX_E2E_CPU_RATE))).toBe(10);
  });

  it.each(['0', '1.5', '11', '100', 'not-a-rate'])('rejects non-standard rate %s', (raw) => {
    expect(() => parseE2ECpuRate(raw)).toThrow('whole number from 1 to 10');
  });
});
