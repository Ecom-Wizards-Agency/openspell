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

describe('SP-API configuration', () => {
  const base = { DATABASE_URL: 'postgres://synthetic.invalid/db' };
  const appId = ['synthetic', 'app-id'].join('-');
  const appKey = ['synthetic', 'app-key'].join('-');

  it('stays disabled when both LWA application values are absent', () => {
    const config = configFromEnv(base);
    expect(config.spApiClientId).toBeUndefined();
    expect(config.spApiClientSecret).toBeUndefined();
    expect(config.spApiReportMinIntervalMs).toBe(1_000);
  });

  it('requires the pair and validates the provider interval', () => {
    expect(() => configFromEnv({ ...base, SP_API_LWA_CLIENT_ID: appId }))
      .toThrow(/configured together/);
    expect(() => configFromEnv({
      ...base,
      SP_API_LWA_CLIENT_ID: appId,
      SP_API_LWA_CLIENT_SECRET: appKey,
      SP_API_REPORT_MIN_INTERVAL_MS: '0',
    })).toThrow(/positive integer/);
  });

  it('trims configured application values without rendering them', () => {
    const config = configFromEnv({
      ...base,
      SP_API_LWA_CLIENT_ID: ` ${appId} `,
      SP_API_LWA_CLIENT_SECRET: ` ${appKey} `,
      SP_API_REPORT_MIN_INTERVAL_MS: '2500',
    });
    expect(config.spApiClientId).toBe(appId);
    expect(config.spApiClientSecret).toBe(appKey);
    expect(config.spApiReportMinIntervalMs).toBe(2_500);
  });
});

describe('Amazon write configuration', () => {
  const base = { DATABASE_URL: 'postgres://synthetic.invalid/db' };

  it('is fail-closed unless the deployment flag is exactly true', () => {
    expect(configFromEnv(base).amazonWritesEnabled).toBe(false);
    expect(configFromEnv({ ...base, OPEN_SPELL_AMAZON_WRITES_ENABLED: 'TRUE' }).amazonWritesEnabled)
      .toBe(false);
    expect(configFromEnv({ ...base, OPEN_SPELL_AMAZON_WRITES_ENABLED: 'true' }).amazonWritesEnabled)
      .toBe(true);
  });

  it('trims the gitignored authorization path without providing a tracked default', () => {
    expect(configFromEnv(base).amazonWriteAuthorizationPath).toBeUndefined();
    expect(configFromEnv({ ...base, AMAZON_WRITE_AUTHORIZATION_PATH: '  _local/write.json  ' })
      .amazonWriteAuthorizationPath).toBe('_local/write.json');
  });
});
