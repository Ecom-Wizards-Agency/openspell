import { describe, expect, it } from 'vitest';
import { configFromEnv, workerJobTypesFromEnv } from './config.js';

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

  it('recognizes approved feature jobs now represented by the database enum', () => {
    expect(workerJobTypesFromEnv('creative.sync,marketing_stream.normalize')).toEqual([
      'creative.sync',
      'marketing_stream.normalize',
    ]);
  });
});

describe('Marketing Stream configuration', () => {
  it('stays disabled when no queue URL is present and trims a configured URL', () => {
    const base = { DATABASE_URL: 'postgres://synthetic.invalid/db' };
    expect(configFromEnv(base).marketingStreamQueueUrl).toBeUndefined();
    expect(configFromEnv({
      ...base,
      MARKETING_STREAM_SQS_QUEUE_URL: '  https://sqs.example.invalid/queue  ',
    }).marketingStreamQueueUrl).toBe('https://sqs.example.invalid/queue');
  });
});
