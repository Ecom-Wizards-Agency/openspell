import { describe, expect, it } from 'vitest';
import {
  configFromEnv,
  workerHealthHostFromEnv,
  workerJobTypesFromEnv,
  workerRevisionFromEnv,
} from './config.js';

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

describe('worker deployment role', () => {
  const base = { DATABASE_URL: 'postgres://synthetic.invalid/db' };

  it('preserves the general all-queue startup defaults', () => {
    expect(configFromEnv(base)).toMatchObject({
      deploymentRole: 'general',
      claimProtocol: 'legacy',
      revision: 'unknown',
      jobTypes: undefined,
      startsBackgroundPasses: true,
      unifiedReporting: { enabled: false, profileIds: [] },
    });
  });

  it('requires and canonicalizes the exact Evo report allowlist', () => {
    expect(configFromEnv({
      ...base,
      NODE_ENV: 'production',
      WORKER_DEPLOYMENT_ROLE: 'evo-report-lane',
      WORKER_JOB_TYPES: 'report.fetch,creative.sync,report.request,report.poll',
      OPENSPELL_WORKER_REVISION: 'ABCDEF1234567',
    })).toMatchObject({
      deploymentRole: 'evo-report-lane',
      claimProtocol: 'fenced',
      revision: 'abcdef1234567',
      jobTypes: ['creative.sync', 'report.request', 'report.poll', 'report.fetch'],
      startsBackgroundPasses: false,
      unifiedReporting: { enabled: false, profileIds: [] },
    });
  });

  it('fails startup closed when Unified Reporting would select a five-type fenced lane', () => {
    const profileId = '11111111-2222-4333-8444-555555555555';
    expect(() => configFromEnv({
      ...base,
      WORKER_DEPLOYMENT_ROLE: 'evo-report-lane',
      WORKER_JOB_TYPES:
        'report.unified.advance,report.fetch,creative.sync,report.request,report.poll',
      OPENSPELL_EVO_REPORT_LANE_READY: '1',
      OPENSPELL_UNIFIED_REPORTING_DUAL_RUN_READY: '1',
      OPENSPELL_UNIFIED_REPORTING_PROFILE_ALLOWLIST: profileId,
    })).toThrow(/incompatible with fenced report custody/);
  });

  it.each([
    undefined,
    'report.request,report.poll,report.fetch',
    'creative.sync,report.request,report.poll,report.fetch,entity.sync',
  ])('fails production startup for an absent, partial, or foreign Evo allowlist: %j', (jobTypes) => {
    expect(() => configFromEnv({
      ...base,
      NODE_ENV: 'production',
      WORKER_DEPLOYMENT_ROLE: 'evo-report-lane',
      ...(jobTypes === undefined ? {} : { WORKER_JOB_TYPES: jobTypes }),
    })).toThrow(/WORKER_JOB_TYPES must exactly match/);
  });
});

describe('worker revision metadata', () => {
  it('accepts only a sanitized Git object id and never echoes a rejected value', () => {
    expect(workerRevisionFromEnv({ OPENSPELL_WORKER_REVISION: ' ABCDEF1 ' }))
      .toBe('abcdef1');
    expect(workerRevisionFromEnv({})).toBe('unknown');
    const rejected = 'release/private-host-detail';
    expect(() => workerRevisionFromEnv({ OPENSPELL_WORKER_REVISION: rejected }))
      .toThrowError('OPENSPELL_WORKER_REVISION must be a 7-64 character hexadecimal Git object id');
  });
});

describe('worker health listener', () => {
  it('preserves the existing default and accepts literal loopback interfaces', () => {
    expect(workerHealthHostFromEnv(undefined)).toBe('0.0.0.0');
    expect(workerHealthHostFromEnv(' 127.0.0.1 ')).toBe('127.0.0.1');
    expect(workerHealthHostFromEnv('::1')).toBe('::1');
  });

  it('refuses hostnames and arbitrary values', () => {
    expect(() => workerHealthHostFromEnv('localhost')).toThrow(/literal IPv4 or IPv6/);
    expect(() => workerHealthHostFromEnv('private-host-detail')).toThrow(/literal IPv4 or IPv6/);
  });

  it('threads an explicit listener address into worker configuration', () => {
    expect(configFromEnv({
      DATABASE_URL: 'postgres://synthetic.invalid/db',
      WORKER_HEALTH_HOST: '127.0.0.1',
    }).healthHost).toBe('127.0.0.1');
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
