import { describe, expect, it } from 'vitest';
import { workerJobTypesFromEnv } from './config.js';

describe('WORKER_JOB_TYPES', () => {
  it('uses the whole queue when absent', () => {
    expect(workerJobTypesFromEnv(undefined)).toBeUndefined();
  });

  it('parses, trims, and deduplicates a comma list', () => {
    expect(workerJobTypesFromEnv('keepa.sync, rank.sync,keepa.sync')).toEqual([
      'keepa.sync',
      'rank.sync',
    ]);
  });

  it.each(['', 'keepa.sync,', 'not-a-job'])('rejects an invalid configured list: %j', (value) => {
    expect(() => workerJobTypesFromEnv(value)).toThrow(/WORKER_JOB_TYPES/);
  });
});
